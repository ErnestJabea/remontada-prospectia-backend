// End-to-end API validation on an ephemeral database. Source data is never copied.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config();
const sourceName = process.env.DB_NAME || 'nexus_crm';
const isolatedName = 'remontada_verify_' + crypto.randomBytes(6).toString('hex');
const fixtureReportCode = 'VERIFY-' + isolatedName;
const fixturePdf = path.join(__dirname,'uploads','reports','pdf','rapport-'+fixtureReportCode+'.pdf');
let adminConnection, pool, server, origin;
let passed = 0;
const password = 'Workflow-fixture-2026!';
async function check(name, callback) { await callback(); passed++; console.log('PASS ' + name); }
async function main() {
  adminConnection = await mysql.createConnection({host:process.env.DB_HOST || 'localhost',port:Number(process.env.DB_PORT)||3306,user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'root',database:sourceName});
  await adminConnection.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',[isolatedName]);
  const [tables] = await adminConnection.query('SHOW FULL TABLES WHERE Table_type = ?',['BASE TABLE']);
  const definitions = [];
  for (const row of tables) {
    const name = Object.values(row)[0];
    const [[definition]] = await adminConnection.query('SHOW CREATE TABLE ??',[name]);
    definitions.push(definition['Create Table']);
  }
  await adminConnection.query('USE ??',[isolatedName]);
  await adminConnection.query('SET FOREIGN_KEY_CHECKS=0');
  for (const definition of definitions) await adminConnection.query(definition.replace(/AUTO_INCREMENT=\d+/g,'AUTO_INCREMENT=1'));
  await adminConnection.query('SET FOREIGN_KEY_CHECKS=1');
  process.env.DB_NAME = isolatedName;
  process.env.NODE_ENV = 'test';
  process.env.LOG_DEV_OTP = 'false';
  process.env.API_RATE_LIMIT_DISABLED = 'true';
  process.env.ALLOWED_ORIGINS = 'http://localhost:5174';
  process.env.FRONTEND_ORIGINS = '';
  pool = require('./db');
  await require('./migrate_workflow_integrity')();
  await require('./migrate_notifications')();
  const hash = await require('bcryptjs').hash(password,12);
  await pool.query("INSERT INTO crm_ref_countries (id,code,name,name_en) VALUES (1,'CM','Pays test','Test country')");
  await pool.query("INSERT INTO crm_ref_regions (id,code,name,name_en,country_id) VALUES (1,'R1','Région test','Test region',1)");
  await pool.query("INSERT INTO crm_ref_departments (id,code,name,name_en,region_id) VALUES (1,'D1','Département test','Test department',1)");
  await pool.query("INSERT INTO crm_ref_cities (id,department_id,name,name_en) VALUES (1,1,'Ville A','City A'),(2,1,'Ville B','City B')");
  for (const [id,role] of [[1,'SYSTEM'],[2,'DIRECTION'],[3,'COMMERCIAL'],[4,'COMMERCIAL'],[5,'ADMIN']]) {
    await pool.query('INSERT INTO users (id,username,password,full_name,email,role,is_active,is_verified,base_city_id,mfa_enabled) VALUES (?,?,?,?,?,?,1,1,1,0)',[id,'fixture'+id,hash,'Fixture '+id,'fixture'+id+'@example.test',role]);
  }
  await pool.query("INSERT INTO crm_institutions (id,name,type,region_id,department_id,city_id,created_by,is_active) VALUES (1,'Institution test','PROSPECT',1,1,1,3,1),(2,'Institution éloignée','PROSPECT',1,1,2,4,1)");
  await pool.query("INSERT INTO objectif_domaines (id,code,name,active) VALUES (1,'TEST','Domaine test',1)");
  await pool.query("INSERT INTO kpis (id,code,name,domain_id,type,unit,calculation_source,active) VALUES (1,'QTY','Quantitatif',1,'QUANTITATIVE','visites','MANUAL',1),(2,'QLTY','Qualitatif',1,'QUALITATIVE','appréciation','MANUAL',1)");
  await pool.query("INSERT INTO crm_objectives (id,title,code,status,created_by,responsible_id,domain_id,kpi_id,objective_nature,target_value,start_date,end_date,period_type) VALUES (1,'Objectif test','OBJ-TEST','IN_PROGRESS',2,3,1,1,'QUANTITATIVE',10,CURRENT_DATE,DATE_ADD(CURRENT_DATE,INTERVAL 30 DAY),'MONTHLY')");
  const mail = require('./utils/mailer');
  const otps = new Map();
  mail.sendOTPEmail = async (email,username,otp) => {otps.set(username,String(otp));return true;};
  mail.sendInitialPasswordSetupEmail = async () => true;
  mail.sendPasswordResetEmail = async () => true;
  server = require('./server').listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  origin = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  async function call(path, session, method='GET', body, expected=200) {
    const headers = {'Content-Type':'application/json',Origin:'http://localhost:5174'};
    if (session?.cookie) headers.Cookie = session.cookie;
    if (session?.token) headers.Authorization = 'Bearer '+session.token;
    const response = await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const data = await response.json().catch(()=>({}));
    assert.equal(response.status,expected,method+' '+path+' '+JSON.stringify(data));
    return {data,response};
  }
  async function login(id,mobile=false) {
    const response = await call('/auth/login',null,'POST',{username:'fixture'+id,password,clientType:mobile?'mobile_pwa':'web_portal'});
    if (mobile) {
      const verified=await call('/auth/verify-mfa',null,'POST',{ticket:response.data.ticket,otp:otps.get('fixture'+id),deviceId:'device-'+id,deviceName:'Fixture'});
      return {token:verified.data.token,refreshToken:verified.data.refreshToken};
    }
    return {cookie:response.response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
  }
  const admin=await login(5),manager=await login(2),commercial=await login(3,true),other=await login(4,true);
  await check('authentication and live role restrictions',async()=>{
    await call('/missions',null,'GET',undefined,401);
    await call('/security/login-history',commercial,'GET',undefined,403);
    await call('/security/login-history',manager,'GET',undefined,403);
    await call('/auth/me',commercial);
  });
  await check('institutions and contacts ownership',async()=>{
    const created=await call('/institutions',commercial,'POST',{name:'Institution créée',type:'PROSPECT',region_id:1,department_id:1,city_id:1},201);
    await call('/institutions/'+created.data.id,other,'PUT',{name:'Écriture interdite',type:'PROSPECT',region_id:1,department_id:1,city_id:1},403);
    await call('/institutions/'+created.data.id+'/contacts',commercial,'POST',{first_name:'Contact',last_name:'Test',job_title:'Direction',influence_level:'DECIDEUR'},201);
    await call('/institutions/'+created.data.id,commercial);
  });
  await check('quantitative and qualitative proposals through correction and validation',async()=>{
    const start=new Date().toISOString().slice(0,10),end=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
    for(const kpi of [1,2]){
      const payload={client_request_id:crypto.randomUUID(),title:'Objectif '+kpi,description:'Fixture',domain_id:1,kpi_id:kpi,period_type:'MONTHLY',start_date:start,end_date:end,target_value:10,target_qlty:'Obtenir un accord écrit',qualitative_criteria:['Accord signé'],moyens:[],formations:[]};
      const created=await call('/objectives/proposals',commercial,'POST',payload,201);
      const id=created.data.id || created.data.objective?.id;
      assert.ok(id,'ID objectif');
      await call('/objectives/'+id,other,'GET',undefined,403);
      await call('/objectives/'+id+'/submit',commercial,'POST',{});
      await call('/objectives/'+id+'/validate',manager,'POST',{action:'CORRECTION',comments:'Préciser'});
      await call('/objectives/'+id+'/proposal',commercial,'PUT',payload);
      await call('/objectives/'+id+'/submit',commercial,'POST',{});
      await call('/objectives/'+id+'/validate',manager,'POST',{action:'VALIDATE'});
      for (const viewer of [manager, commercial]) {
        const detail = (await call('/objectives/'+id,viewer)).data;
        assert.equal(detail.status,'VALIDATED','Validated objective detail must update immediately');
        assert.equal(detail.creation_source,'FIELD');
        const list = (await call('/objectives',viewer)).data;
        assert.equal(list.find(item=>item.id===id)?.status,'VALIDATED','Validated objective list must update immediately');
      }
      await call('/objectives/'+id+'/assign',manager,'POST',{affectations:[{type:'COMMERCIAL',target_id:4,value_allocated:1}]},409);
      const [[row]]=await pool.query('SELECT responsible_id,objective_nature FROM crm_objectives WHERE id=?',[id]);
      assert.equal(row.responsible_id,3);assert.equal(row.objective_nature,kpi===1?'QUANTITATIVE':'QUALITATIVE');
    }
  });
  await check('backoffice objective validation retains assignment distinction',async()=>{
    await pool.query("UPDATE crm_objectives SET status='SUBMITTED' WHERE id=1");
    await call('/objectives/1/validate',manager,'POST',{action:'VALIDATE'});
    const detail=(await call('/objectives/1',manager)).data;
    assert.equal(detail.status,'ASSIGNED');assert.equal(detail.creation_source,'BACKOFFICE');
    await pool.query("UPDATE crm_objectives SET status='IN_PROGRESS' WHERE id=1");
  });
  let missionId, reportId;
  await check('mission draft, correction, validation, start, completion and automatic report',async()=>{
    const created=await call('/missions',commercial,'POST',{objective_id:1,institution_id:1,title:'Mission test',scheduled_date:new Date().toISOString().slice(0,19).replace('T',' '),primary_commercial_id:4,targets:[{institution_id:1,visit_order:1}]},201);
    missionId=created.data.id;
    assert.equal(created.data.travel_scope,'IN_CITY');
    await call('/missions/'+missionId+'/actions',commercial,'POST',{action:'SUBMIT'});
    await call('/missions/'+missionId+'/actions',other,'POST',{action:'VALIDATE_GATE1'},403);
    await call('/missions/'+missionId+'/actions',manager,'POST',{action:'REQUEST_COMPLETION',reason:'Compléter'});
    await call('/missions/'+missionId+'/actions',commercial,'POST',{action:'SUBMIT'});
    await call('/missions/'+missionId+'/actions',manager,'POST',{action:'VALIDATE_GATE1'});
    await call('/missions/'+missionId+'/actions',commercial,'POST',{action:'START',check_in_latitude:1000},400);
    await call('/missions/'+missionId+'/actions',commercial,'POST',{action:'START',check_in_latitude:0,check_in_longitude:0});
    const workflow=require('./services/reportWorkflow'),generate=workflow.generateFromMission;
    workflow.generateFromMission=async()=>{throw new Error('Injected report failure for rollback verification');};
    try {
      await call('/missions/'+missionId+'/actions',commercial,'POST',{action:'COMPLETE'},500);
      const [[unchanged]]=await pool.query('SELECT status FROM crm_missions WHERE id=?',[missionId]);
      assert.equal(unchanged.status,'IN_PROGRESS');
    } finally {workflow.generateFromMission=generate;}
    await call('/missions/'+missionId+'/actions',commercial,'POST',{action:'COMPLETE'});
    const [[report]]=await pool.query('SELECT id FROM crm_reports WHERE mission_id=?',[missionId]);reportId=report.id;
    await pool.query('UPDATE crm_reports SET code=? WHERE id=?',[fixtureReportCode,reportId]);
  });
  await check('report completion, submission, correction, monitoring, validation and archive',async()=>{
    const workflow=require('./services/reportWorkflow');
    const actor={id:3,role:'COMMERCIAL',full_name:'Fixture 3'},direction={id:2,role:'DIRECTION'};
    await assert.rejects(workflow.submit(reportId,actor));
    await pool.query("UPDATE crm_reports SET executive_summary='Synthèse',results='Résultats',institution_id=1 WHERE id=?",[reportId]);
    await call('/reports/'+reportId+'/submit',commercial,'POST',{});
    const monitoring=(await call('/analytics/reports',admin)).data;
    assert.equal(monitoring.stockMetrics[1].value,1);
    await call('/reports/'+reportId+'/request-correction',manager,'POST',{comment:'Préciser'});
    await call('/reports/'+reportId+'/submit',commercial,'POST',{});
    await call('/reports/'+reportId+'/validate',manager,'POST',{});
    const [[mission]]=await pool.query('SELECT status FROM crm_missions WHERE id=?',[missionId]);assert.equal(mission.status,'CLOSED');
    await workflow.archive(reportId,direction);
    await call('/reports/'+reportId,commercial);
    const pdf = await fetch(origin+'/reports/'+reportId+'/download-pdf',{headers:{Authorization:'Bearer '+commercial.token}});
    assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  });
  let opportunityId;
  await check('cross-owner mission and objective links are refused',async()=>{
    await call('/reports',other,'POST',{mission_id:missionId,objective_id:1,executive_summary:'Interdit'},403);
    await call('/opportunities',other,'POST',{mission_id:missionId,institution_id:1,title:'Interdit',need_description:'Besoin',estimated_amount:100},403);
    await call('/missions',other,'POST',{objective_id:1,institution_id:1,title:'Interdit',scheduled_date:new Date().toISOString().slice(0,10),targets:[{institution_id:1,visit_order:1}]},403);
  });
  await check('opportunity full pipeline and atomic rollback',async()=>{
    opportunityId=(await call('/opportunities',commercial,'POST',{institution_id:1,title:'Affaire test',need_description:'Besoin test',estimated_amount:10000,priority:'HIGH'},201)).data.id;
    const workflow=require('./services/OpportunityWorkflowService'),actor={id:3,role:'COMMERCIAL',full_name:'Fixture'},direction={id:2,role:'DIRECTION'};
    await workflow.submit(opportunityId,actor);
    await workflow.requestCorrection(opportunityId,direction,'Compléter');
    await workflow.submit(opportunityId,actor);
    await workflow.validate(opportunityId,direction);
    await workflow.startAnalysis(opportunityId,actor);
    await assert.rejects(workflow.createActionPlan(opportunityId,actor,[{title:'Valide',action_type:'CALL'},{title:''}]));
    const [[row]]=await pool.query('SELECT status FROM crm_opportunities WHERE id=?',[opportunityId]);assert.equal(row.status,'IN_ANALYSIS');
    const [[count]]=await pool.query('SELECT COUNT(*) AS n FROM crm_opportunity_actions WHERE opportunity_id=?',[opportunityId]);assert.equal(count.n,0);
    await workflow.createActionPlan(opportunityId,actor,[{title:'Appeler',action_type:'CALL'}]);
    await workflow.moveToProposal(opportunityId,actor,{final_amount:12000});
    await workflow.moveToNegotiation(opportunityId,actor);
    await workflow.moveToDecision(opportunityId,actor);
    await workflow.markAsWon(opportunityId,direction,{final_amount:12000});
    await workflow.archive(opportunityId,direction);
  });
  await check('offline references, submission, receipt replay and comments',async()=>{
    const local='prospect_local_'+crypto.randomUUID(),oppLocal='opp_local_'+crypto.randomUUID();
    const actions=[{id:'sync_'+crypto.randomUUID(),type:'prospect',action:'create',payload:{id:local,name:'Prospect hors ligne',type:'PROSPECT',region_id:1,department_id:1,city_id:1}}, {id:'sync_'+crypto.randomUUID(),type:'opportunity',action:'create',payload:{id:oppLocal,institution_id:local,title:'Affaire hors ligne',need_description:'Besoin',estimated_amount:200,priority:'HIGH',status:'SUBMITTED'}}];
    const first=(await call('/sync/push',commercial,'POST',{actions})).data;
    assert.deepEqual(first.results.map(r=>r.status),['success','success'],JSON.stringify(first));
    const replay=(await call('/sync/push',commercial,'POST',{actions})).data;
    assert.deepEqual(replay.results,first.results);
    const later={id:'sync_'+crypto.randomUUID(),type:'opportunity',action:'create',payload:{id:'opp_later_'+crypto.randomUUID(),institution_id:local,title:'Affaire ultérieure',need_description:'Besoin',estimated_amount:100,status:'DETECTED'}};
    const laterResult=(await call('/sync/push',commercial,'POST',{actions:[later]})).data.results[0];
    assert.equal(laterResult.status,'success','References from a previous request remain resolvable');
    const update={id:'sync_'+crypto.randomUUID(),type:'opportunity',action:'update',payload:{id:laterResult.serverId,status:'SUBMITTED'}};
    assert.equal((await call('/sync/push',commercial,'POST',{actions:[update]})).data.results[0].status,'success');
    const [[history]]=await pool.query("SELECT COUNT(*) AS n FROM crm_opportunity_stage_histories WHERE opportunity_id=? AND new_status='SUBMITTED'",[laterResult.serverId]);
    assert.equal(history.n,1);
    const id=first.results[1].serverId;
    const [[row]]=await pool.query('SELECT status FROM crm_opportunities WHERE id=?',[id]);assert.equal(row.status,'SUBMITTED');
    const comment={id:'sync_'+crypto.randomUUID(),type:'opportunity',action:'add_comment',payload:{id,comment:'Commentaire terrain'}};
    assert.equal((await call('/sync/push',commercial,'POST',{actions:[comment]})).data.results[0].status,'success');
    const denied=(await call('/sync/push',other,'POST',{actions:[{...comment,id:'sync_'+crypto.randomUUID()}]})).data;
    assert.equal(denied.results[0].status,'error');
    await call('/sync/push',commercial,'POST',{actions:Array(101).fill(comment)},413);
  });
  await check('mission, report and opportunity attachment upload, download, ownership and delete',async()=>{
    const bytes=await fs.readFile(fixturePdf);
    for (const [resource,id,table,fk] of [['missions',missionId,'crm_mission_attachments','mission_id'],['reports',reportId,'crm_report_attachments','report_id'],['opportunities',opportunityId,'crm_opportunity_attachments','opportunity_id']]) {
      const form=new FormData();form.append('files',new Blob([bytes],{type:'application/pdf'}),'fixture-'+isolatedName+'.pdf');
      const upload=await fetch(origin+'/'+resource+'/'+id+'/attachments',{method:'POST',headers:{Authorization:'Bearer '+commercial.token},body:form});
      assert.equal(upload.status,201,resource+' '+await upload.text());
      const [[attachment]]=await pool.query(`SELECT id FROM ${table} WHERE ${fk}=?`,[id]);
      const url=origin+'/'+resource+'/'+id+'/attachments/'+attachment.id+'/download';
      assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+other.token}})).status,403);
      const downloaded=await fetch(url,{headers:{Authorization:'Bearer '+commercial.token}});
      assert.equal(downloaded.status,200,resource+' download');
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
      await call('/'+resource+'/'+id+'/attachments/'+attachment.id,commercial,'DELETE');
      assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+commercial.token}})).status,404);
    }
  });
  await check('all monitoring modules, referentials, users, notifications and permissions',async()=>{
    for(const module of ['dashboard','objectives','missions','institutions','opportunities','reports','commerciaux','referentials','security','permissions']) await call('/analytics/'+module,admin);
    for(const endpoint of ['/referentials/regions','/users','/notifications','/permissions/catalogue','/permissions/job-descriptions']) await call(endpoint,admin);
  });
  await check('reference hierarchy create, edit, dependency refusal and delete',async()=>{
    await call('/referentials/countries',commercial,'POST',{code:'ZZ',name:'Interdit'},403);
    const country=(await call('/referentials/countries',admin,'POST',{code:'ZZ',name:'Pays temporaire'},201)).data.id;
    await call('/referentials/countries/'+country,admin,'PUT',{name:'Pays modifié'});
    const region=(await call('/referentials/regions',admin,'POST',{code:'ZZR',name:'Région temporaire',country_id:country},201)).data.id;
    await call('/referentials/countries/'+country,admin,'DELETE',undefined,400);
    await call('/referentials/regions/'+region,admin,'DELETE');
    await call('/referentials/countries/'+country,admin,'DELETE');
    await call('/referentials/countries/'+country,admin,'DELETE',undefined,404);
  });
  await check('commercial provisioning and notification ownership',async()=>{
    const created=(await call('/users',admin,'POST',{username:'newfixture',password,full_name:'Nouveau commercial',email:'newfixture@example.test',role:'COMMERCIAL',base_city_id:1},201)).data.id;
    await call('/users/'+created,admin);
    const [[setup]]=await pool.query('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL',[created]);assert.equal(setup.n,1);
    const notifications=(await call('/notifications',commercial)).data;assert.ok(notifications.length);
    const notification=notifications.find(item=>!item.is_read);assert.ok(notification);
    await call('/notifications/'+notification.id+'/read',other,'POST',{});
    const [[unread]]=await pool.query('SELECT is_read FROM crm_notifications WHERE id=?',[notification.id]);assert.equal(unread.is_read,0);
    await call('/notifications/'+notification.id+'/read',commercial,'POST',{});
    const [[read]]=await pool.query('SELECT is_read FROM crm_notifications WHERE id=?',[notification.id]);assert.equal(read.is_read,1);
  });
  await check('job permissions deny direct and offline mutation without changing roles',async()=>{
    await pool.query("INSERT INTO job_descriptions(id,title,role_category) VALUES(1,'Lecture seule','COMMERCIAL')");
    await pool.query("INSERT INTO job_feature_permissions(job_description_id,module_id,feature_id,can_view,can_create,can_update,can_delete,can_view_all,can_reorganize) VALUES(1,'crm','opportunities',1,0,0,0,0,0)");
    await pool.query('UPDATE users SET job_description_id=1 WHERE id=4');
    await call('/opportunities',other);
    await call('/objectives/domains',other,'GET',undefined,403);
    await call('/objectives/kpis',other,'GET',undefined,403);
    await pool.query("INSERT INTO job_feature_permissions(job_description_id,module_id,feature_id,can_view,can_create,can_update,can_delete,can_view_all,can_reorganize) VALUES(1,'crm','objectives',1,1,0,0,0,0)");
    await call('/objectives/domains',other);
    await call('/objectives/kpis',other);
    await call('/objectives/domains',other,'POST',{code:'DENIED',name:'Interdit'},403);
    await call('/objectives/kpis/1',other,'PUT',{name:'Interdit'},403);
    await call('/opportunities',other,'POST',{institution_id:1,title:'Interdit',need_description:'Besoin',estimated_amount:10},403);
    const denied=(await call('/sync/push',other,'POST',{actions:[{id:'sync_'+crypto.randomUUID(),type:'opportunity',action:'create',payload:{institution_id:1,title:'Interdit',need_description:'Besoin',estimated_amount:10}}]})).data;
    assert.equal(denied.results[0].status,'error');
    const profile=(await call('/auth/me',other)).data.user;
    assert.equal(profile.job_description_id,1);assert.equal(profile.jobPermissions.find(p=>p.feature_id==='opportunities').can_create,0);
    await call('/permissions/job-descriptions/1/feature',admin,'PUT',{module_id:'crm',feature_id:'opportunities',can_view:true,can_create:true,can_update:false,can_delete:false,can_view_all:false,can_reorganize:false});
    const permissions=(await call('/permissions/job-descriptions/1',admin)).data.permissions;
    assert.equal(permissions.find(p=>p.feature_id==='opportunities').can_create,1);
    await pool.query('UPDATE users SET job_description_id=NULL WHERE id=4');
  });
  await check('objective realtime stream, transactional outbox, retry and push ownership',async()=>{
    const {notifyUser}=require('./utils/notifications');
    const {deliverPending,validSubscription}=require('./utils/notificationDelivery');
    const webpush=require('web-push');
    const originalPush=webpush.sendNotification,originalMail=mail.sendNotificationEmail;
    const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:Buffer.alloc(65,1).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}};
    assert.equal(validSubscription({...subscription,endpoint:'http://127.0.0.1/private'}),false);
    await call('/notifications/subscriptions',commercial,'POST',subscription);
    await call('/notifications/subscriptions',other,'DELETE',{endpoint:subscription.endpoint});
    const [[owned]]=await pool.query('SELECT COUNT(*) n FROM notification_push_subscriptions WHERE user_id=3');assert.equal(owned.n,1);
    await call('/notifications/subscriptions',commercial,'POST',{...subscription,endpoint:'https://127.0.0.1/private'},400);
    await pool.query("UPDATE notification_deliveries SET status='skipped'");
    const [[before]]=await pool.query('SELECT COUNT(*) n FROM notification_deliveries');
    await assert.rejects(pool.withTransaction(async()=>{await notifyUser(3,'Rollback','Not delivered','OBJECTIVE_VALIDATED',1);throw new Error('rollback');}));
    const [[after]]=await pool.query('SELECT COUNT(*) n FROM notification_deliveries');assert.equal(after.n,before.n);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try {
      const stream=await fetch(origin+'/notifications/stream',{headers:{Authorization:'Bearer '+commercial.token},signal:controller.signal});
      assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);
      const reader=stream.body.getReader(),decoder=new TextDecoder();let buffer='';
      async function event() {
        while(true) {
          let end;
          while((end=buffer.indexOf('\n\n'))!==-1) {
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            if(frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
          }
          const chunk=await reader.read();assert.equal(chunk.done,false);buffer+=decoder.decode(chunk.value,{stream:true});
        }
      }
      const initial=await event();assert.ok(initial.notifications.every(n=>n.user_id===3));
      await notifyUser(4,'Other user','Private','OBJECTIVE_VALIDATED',1);
      await notifyUser(3,'Realtime fixture','Updated','OBJECTIVE_VALIDATED',1);
      const updated=await event();assert.ok(updated.notifications.some(n=>n.title==='Realtime fixture'));assert.ok(updated.notifications.every(n=>n.user_id===3));
    } finally {clearTimeout(timer);controller.abort();}
    let mails=0,pushes=0,fail=true;
    mail.sendNotificationEmail=async()=>{mails++;if(fail)throw Object.assign(new Error('Temporary SMTP failure'),{code:'ETIMEDOUT'});};
    webpush.sendNotification=async()=>{pushes++;return {statusCode:201};};
    try {
      await deliverPending();
      const [[retry]]=await pool.query("SELECT COUNT(*) n FROM notification_deliveries WHERE channel='email' AND status='pending' AND attempts=1");assert.equal(retry.n,2);
      assert.equal(pushes,1);
      fail=false;await pool.query("UPDATE notification_deliveries SET next_attempt_at=NOW() WHERE status='pending'");
      await deliverPending();assert.equal(mails,4);
      const [[sent]]=await pool.query("SELECT COUNT(*) n FROM notification_deliveries WHERE status='sent'");assert.equal(sent.n,3);
      await pool.query('UPDATE users SET settings=? WHERE id=3',[JSON.stringify({notifications:{email:false,push:false}})]);
      await notifyUser(3,'Disabled','No external delivery','OBJECTIVE_CLOSED',1);await deliverPending();assert.equal(mails,4);assert.equal(pushes,1);
      await pool.query('UPDATE users SET settings=NULL WHERE id=3');
      webpush.sendNotification=async()=>{throw {statusCode:410};};
      await notifyUser(3,'Expired subscription','Cleanup','OBJECTIVE_CLOSED',1);await deliverPending();
      const [[remaining]]=await pool.query('SELECT COUNT(*) n FROM notification_push_subscriptions');assert.equal(remaining.n,0);
    } finally {webpush.sendNotification=originalPush;mail.sendNotificationEmail=originalMail;}
  });
  await check('refresh is single-use under concurrency and logout revokes access',async()=>{
    const session=await login(4,true);
    const responses=await Promise.all([1,2].map(()=>fetch(origin+'/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:session.refreshToken})})));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
    await call('/auth/logout',session,'POST',{refreshToken:session.refreshToken});
    await call('/auth/me',session,'GET',undefined,401);
  });
  await check('password changes revoke existing access',async()=>{
    await call('/users/4/password',admin,'PUT',{newPassword:'Changed-fixture-2026!'});
    await call('/auth/me',other,'GET',undefined,401);
  });
  console.log('RESULT '+passed+' scenarios passed on isolated schema '+isolatedName);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve));
  if(pool) {
    for(const table of ['crm_mission_attachments','crm_report_attachments','crm_opportunity_attachments']) {
      const [rows]=await pool.query(`SELECT file_path FROM ${table}`).catch(()=>[[]]);
      for(const row of rows) require('./utils/uploadSecurity').deleteStoredUpload(row.file_path);
    }
    await pool.end();
  }
  await fs.unlink(fixturePdf).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(adminConnection){
    if(/^remontada_verify_[a-f0-9]{12}$/.test(isolatedName) && isolatedName!==sourceName) await adminConnection.query('DROP DATABASE IF EXISTS ??',[isolatedName]);
    await adminConnection.end();
  }
});
