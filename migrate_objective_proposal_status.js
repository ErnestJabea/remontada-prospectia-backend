const pool=require('./db');
async function migrate(){
 return pool.withTransaction(async()=>{
  const [rows]=await pool.query(`SELECT o.id FROM crm_objectives o WHERE o.status='ASSIGNED'
    AND EXISTS(SELECT 1 FROM objectif_historiques h WHERE h.objective_id=o.id AND h.action='CREATE_PROPOSAL')
    AND NOT EXISTS(SELECT 1 FROM objectif_historiques h WHERE h.objective_id=o.id AND h.action='ASSIGN') FOR UPDATE`);
  if(!rows.length)return 0;
  const [[system]]=await pool.query("SELECT id FROM users WHERE role='SYSTEM' AND is_active=1 ORDER BY id LIMIT 1");
  if(!system)throw new Error('Compte système requis pour tracer la correction.');
  for(const row of rows){
    await pool.query("UPDATE crm_objectives SET status='VALIDATED' WHERE id=?",[row.id]);
    await pool.query(`INSERT INTO objectif_historiques(objective_id,user_id,action,old_value,new_value,comments)
      VALUES(?,?,'STATUS_CORRECTION',?,?,?)`,[row.id,system.id,JSON.stringify('ASSIGNED'),JSON.stringify('VALIDATED'),'Correction automatique : proposition terrain approuvée, sans affectation explicite.']);
  }
  return rows.length;
 });
}
module.exports=migrate;
if(require.main===module)migrate().then(count=>console.log(count+' proposition(s) terrain corrigée(s).')).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
