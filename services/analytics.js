const { permissionFor, scopeRestricted } = require('../middleware/featureAccess');
// Identifiers and expressions are server-owned; request values only use placeholders.
const count = (fr, en, sql, unit = 'number', alert = false) => ({ fr, en, sql, unit, alert });
const managers = ['SYSTEM', 'ADMIN', 'DIRECTION'];
const definitions = {
  objectives: {
    from: 'crm_objectives x', group: 'x.status',
    scope: "(x.created_by = ? OR x.responsible_id = ? OR EXISTS (SELECT 1 FROM objectif_affectations a WHERE a.objective_id=x.id AND a.type='COMMERCIAL' AND a.target_id=?))", scopeArgs: 3,
    metrics: [count('Objectifs', 'Objectives', 'COUNT(*)'), count('Réalisation quantitative moyenne', 'Average quantitative achievement', "AVG(CASE WHEN objective_nature='QUANTITATIVE' THEN achievement_rate END)", 'percent'), count('Qualitatifs atteints', 'Qualitative objectives achieved', "SUM(objective_nature='QUALITATIVE' AND qualitative_rating IN ('ACHIEVED','EXCEEDED'))"), count('Échéances dépassées', 'Overdue objectives', "SUM(end_date < CURRENT_DATE AND status NOT IN ('CLOSED','CANCELLED','REJECTED'))", 'number', true)]
  },
  missions: {
    from: 'crm_missions x', group: 'x.status',
    scope: '(x.primary_commercial_id=? OR EXISTS (SELECT 1 FROM crm_mission_associates a WHERE a.mission_id=x.id AND a.user_id=?))', scopeArgs: 2,
    metrics: [count('Missions', 'Missions', 'COUNT(*)'), count('Taux de réalisation', 'Completion rate', "100*SUM(status IN ('COMPLETED','CLOSED'))/NULLIF(COUNT(*),0)", 'percent'), count('Déplacements estimés', 'Estimated travel costs', 'SUM(estimated_travel_cost)', 'XAF'), count('Missions en retard', 'Overdue missions', "SUM(scheduled_date < NOW() AND status IN ('VALIDATED','PLANNED','IN_PROGRESS'))", 'number', true)],
    extraGroup: 'x.travel_scope'
  },
  institutions: {
    from: 'crm_institutions x', group: 'x.type', scope:'x.created_by=?', scopeArgs:1,
    metrics: [count('Institutions', 'Institutions', 'COUNT(*)'), count('Actives', 'Active', 'SUM(is_active=1)'), count('Villes couvertes', 'Cities covered', 'COUNT(DISTINCT city_id)'), count('Sans téléphone ni e-mail', 'Without phone or email', "SUM(COALESCE(TRIM(phone),'')='' AND COALESCE(TRIM(email),'')='')", 'number', true)],
    extraGroup: "COALESCE((SELECT r.name FROM crm_ref_regions r WHERE r.id=x.region_id),'-')"
  },
  opportunities: {
    from: 'crm_opportunities x', group: 'x.status', scope: 'x.assigned_to=?', scopeArgs: 1,
    metrics: [count('Opportunités', 'Opportunities', 'COUNT(*)'), count('Pipeline ouvert estimé', 'Estimated open pipeline', "SUM(CASE WHEN status NOT IN ('WON','LOST','ARCHIVED','REJECTED') THEN estimated_amount ELSE 0 END)", 'XAF'), count('Gagnées / décisions', 'Won / decisions', "100*SUM(status='WON')/NULLIF(SUM(status IN ('WON','LOST')),0)", 'percent'), count('Sans évolution depuis 30 jours', 'Unchanged for 30 days', "SUM(updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND status NOT IN ('WON','LOST','ARCHIVED','REJECTED'))", 'number', true)],
    extraGroup: 'x.pipeline_stage'
  },
  reports: {
    from: 'crm_reports x', group: 'x.status', scope: '(x.commercial_id=? OR EXISTS (SELECT 1 FROM crm_missions m WHERE m.id=x.mission_id AND m.primary_commercial_id=?))', scopeArgs: 2,
    metrics: [count('Rapports', 'Reports', 'COUNT(*)'), count('À valider', 'Awaiting validation', "SUM(status IN ('SOUMIS','SUBMITTED'))", 'number', true), count('Délai moyen de validation', 'Average validation delay', 'AVG(CASE WHEN validated_at >= submitted_at THEN TIMESTAMPDIFF(HOUR,submitted_at,validated_at)/24 END)', 'days'), count('Sans synthèse', 'Without summary', "SUM(COALESCE(TRIM(executive_summary),'')='')", 'number', true)]
  },
  commerciaux: {
    roles: managers, from: 'crm_missions x LEFT JOIN users u ON u.id=x.primary_commercial_id', group: "COALESCE(u.full_name,'-')",
    metrics: [count('Missions confiées', 'Assigned missions', 'COUNT(*)'), count('Commerciaux mobilisés', 'Salespeople assigned', 'COUNT(DISTINCT primary_commercial_id)'), count('Missions terminées', 'Completed missions', "SUM(status IN ('COMPLETED','CLOSED'))"), count('Missions en retard', 'Overdue missions', "SUM(scheduled_date < NOW() AND status IN ('VALIDATED','PLANNED','IN_PROGRESS'))", 'number', true)]
  },
  security: {
    roles: ['SYSTEM','ADMIN'], from: 'crm_login_history x', group: 'x.status',
    metrics: [count('Tentatives de connexion', 'Login attempts', 'COUNT(*)'), count('Réussies', 'Successful', "SUM(status='SUCCESS')"), count('Échecs et blocages', 'Failed and blocked', "SUM(status IN ('FAILED','BLOCKED'))", 'number', true), count('Utilisateurs connectés distincts', 'Distinct signed-in users', "COUNT(DISTINCT CASE WHEN status='SUCCESS' THEN user_id END)")]
  }
};
const refTables = ['countries','regions','departments','cities','institution_types','influence_levels','mission_types','period_types','priorities','documentary_observations'];
function period(query, now = new Date()) {
  if (Object.keys(query).some(key => !['start','end'].includes(key))) throw Object.assign(new Error('Filtre inconnu.'), { status: 400 });
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error('Date invalide.'), { status: 400 });
    const d = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(+d) || d.toISOString().slice(0,10) !== value) throw Object.assign(new Error('Date invalide.'), { status: 400 });
    return d;
  };
  const end = query.end ? parse(query.end) : parse(now.toISOString().slice(0,10));
  const start = query.start ? parse(query.start) : new Date(+end - 29*86400000);
  const days = Math.round((end-start)/86400000)+1;
  if (days < 1 || days > 366) throw Object.assign(new Error('Période invalide (1 à 366 jours).'), { status: 400 });
  const format = d => d.toISOString().slice(0,10);
  return { start: format(start), end: format(end), exclusiveEnd: format(new Date(+end+86400000)), previousStart: format(new Date(+start-days*86400000)), days };
}
async function cohort(db, name, user, range) {
  const def = definitions[name];
  const scoped = (name === 'institutions' ? Boolean(permissionFor(user,name) && !permissionFor(user,name).can_view_all) : scopeRestricted(user, name)) && def.scope;
  const where = scoped ? def.scope : '1=1';
  const args = scoped ? Array(def.scopeArgs).fill(user.id) : [];

  const runQuery = async (sqlQuery, sqlArgs) => {
    try {
      return await db.query(sqlQuery, sqlArgs);
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054) {
        console.warn(`[ANALYTICS/COHORT] Column fallback for ${name}:`, err.message);
        const safeSql = sqlQuery
          .replace(/SUM\(estimated_travel_cost\)/gi, '0')
          .replace(/estimated_travel_cost/gi, '0')
          .replace(/x\.travel_scope/gi, "'-'");
        return await db.query(safeSql, sqlArgs);
      }
      throw err;
    }
  };

  const metrics = def.metrics.map((m,i) => `${m.sql} AS m${i}`).join(',');
  const read = async (start,end) => (await runQuery(`SELECT ${metrics} FROM ${def.from} WHERE ${where} AND x.created_at >= ? AND x.created_at < ?`, [...args,start,end]))[0][0];
  const current = await read(range.start,range.exclusiveEnd);
  const previous = await read(range.previousStart,range.start);
  const [[stock]] = await runQuery(`SELECT ${metrics} FROM ${def.from} WHERE ${where}`, args);
  const group = async expression => {
    try {
      return (await runQuery(`SELECT COALESCE(${expression},'-') AS label, COUNT(*) AS value FROM ${def.from} WHERE ${where} AND x.created_at >= ? AND x.created_at < ? GROUP BY label ORDER BY value DESC, label LIMIT 12`, [...args,range.start,range.exclusiveEnd]))[0];
    } catch (err) {
      console.warn(`[ANALYTICS] Grouping fallback for ${expression}:`, err.message);
      return [];
    }
  };
  const [daily] = await runQuery(`SELECT DATE_FORMAT(x.created_at,'%Y-%m-%d') AS day, COUNT(*) AS value FROM ${def.from} WHERE ${where} AND x.created_at >= ? AND x.created_at < ? GROUP BY day ORDER BY day`, [...args,range.start,range.exclusiveEnd]);
  const byDay = new Map(daily.map(row => [row.day, Number(row.value)]));
  return {
    stockMetrics: def.metrics.map((m,i) => ({ ...m, sql: undefined, value: stock[`m${i}`] === null ? null : Number(stock[`m${i}`]) })),
    mode: 'cohort', metrics: def.metrics.map((m,i) => ({ ...m, sql: undefined, value: current[`m${i}`] === null ? null : Number(current[`m${i}`]), previous: previous[`m${i}`] === null ? null : Number(previous[`m${i}`]) })),
    groups: await group(def.group), extraGroups: def.extraGroup ? await group(def.extraGroup) : [],
    trend: Array.from({length:range.days}, (_,i) => { const day = new Date(new Date(range.start+'T00:00:00Z').getTime()+i*86400000).toISOString().slice(0,10); return { label: day, value: byDay.get(day) || 0 }; })
  };
}
async function snapshot(db, name) {
  if (name === 'referentials') {
    const groups = [];
    let missing = 0;
    for (const table of refTables) {
      const [[row]] = await db.query(`SELECT COUNT(*) AS value, SUM(COALESCE(TRIM(name_en),'')='') AS missing FROM crm_ref_${table}`);
      groups.push({label:table, value:Number(row.value)}); missing += Number(row.missing);
    }
    const [[inactive]] = await db.query('SELECT (SELECT COUNT(*) FROM kpis WHERE active=0) + (SELECT COUNT(*) FROM objectif_domaines WHERE active=0) AS value');
    return {mode:'snapshot', metrics:[{fr:'Entrées de référence',en:'Reference entries',value:groups.reduce((s,r)=>s+r.value,0)}, {fr:'Traductions anglaises manquantes',en:'Missing English translations',value:missing,alert:true}, {fr:'KPI et domaines inactifs',en:'Inactive KPIs and domains',value:Number(inactive.value)}],groups,trend:[]};
  }
  const [[row]] = await db.query(`SELECT (SELECT COUNT(*) FROM job_descriptions) AS profiles, (SELECT COUNT(DISTINCT job_description_id) FROM job_feature_permissions WHERE can_view=1) AS covered, (SELECT COUNT(*) FROM users WHERE is_active=1 AND job_description_id IS NULL) AS unassigned, (SELECT COUNT(*) FROM job_feature_permissions WHERE can_delete=1 OR can_view_all=1) AS sensitive_rules`);
  const [groups] = await db.query('SELECT j.title AS label, COALESCE(SUM(p.can_view=1),0) AS value FROM job_descriptions j LEFT JOIN job_feature_permissions p ON p.job_description_id=j.id GROUP BY j.id,j.title ORDER BY value DESC,j.title');
  return {mode:'snapshot', metrics:[{fr:'Profils',en:'Profiles',value:Number(row.profiles)}, {fr:'Profils sans droit de lecture',en:'Profiles without read access',value:Number(row.profiles)-Number(row.covered),alert:true}, {fr:'Comptes actifs sans fiche de poste',en:'Active accounts without job profile',value:Number(row.unassigned),alert:true}, {fr:'Règles avec suppression ou vue globale',en:'Rules granting deletion or global view',value:Number(row.sensitive_rules)}],groups,trend:[]};
}
function canRead(name,user) {
  if (!user || ![...managers,'COMMERCIAL'].includes(user.role)) return false;
  const permission = permissionFor(user,name === 'commerciaux' ? 'users' : name);
  if (name !== 'dashboard' && name !== 'permissions' && permission && !permission.can_view) return false;
  if (['commerciaux','security','referentials'].includes(name) && permission && !permission.can_view_all) return false;
  if (name === 'permissions') return ['SYSTEM','ADMIN'].includes(user.role);
  if (name === 'referentials') return managers.includes(user.role);
  return !definitions[name]?.roles || definitions[name].roles.includes(user.role);
}
async function analytics(db,name,user,range) {
  if (!['dashboard','permissions','referentials',...Object.keys(definitions)].includes(name)) throw Object.assign(new Error('Module inconnu.'),{status:404});
  if (!canRead(name,user)) throw Object.assign(new Error('Accès refusé.'),{status:403});
  if (name === 'dashboard') {
    const sections = {};
    for (const key of ['objectives','missions','opportunities','reports']) {
      if (canRead(key,user)) {
        try {
          sections[key] = await cohort(db,key,user,range);
        } catch (err) {
          console.error(`[ANALYTICS/DASHBOARD] Cohort for ${key} failed:`, err?.message || err);
          sections[key] = { stockMetrics: [], mode: 'cohort', metrics: [], groups: [], extraGroups: [], trend: [] };
        }
      }
    }
    return {mode:'dashboard',sections};
  }
  return definitions[name] ? cohort(db,name,user,range) : snapshot(db,name);
}
module.exports = { analytics, period, canRead };
