const pool = require('../db');
const FEATURES = {objectives:'crm',missions:'crm',institutions:'crm',opportunities:'crm',reports:'crm',users:'admin',referentials:'admin',kpis:'admin',security:'admin'};
function permissionFor(user,feature) {
  if (user.role === 'SYSTEM' || !user.job_description_id) return null;
  return user.jobPermissions?.find(p => p.feature_id === feature && p.module_id === FEATURES[feature]) || {};
}
function assertFeature(user,feature,operation='can_view') {
  const permission = permissionFor(user,feature);
  if (permission && (!permission.can_view || !permission[operation])) throw Object.assign(new Error('Cette action n’est pas autorisée par votre fiche de poste.'), {status:403});
}
function scopeRestricted(user,feature) {
  const permission = permissionFor(user,feature);
  return user.role === 'COMMERCIAL' || Boolean(permission && !permission.can_view_all);
}
const ownership = {
  objectives: ['crm_objectives x',"(x.created_by=? OR x.responsible_id=? OR EXISTS (SELECT 1 FROM objectif_affectations a WHERE a.objective_id=x.id AND a.type='COMMERCIAL' AND a.target_id=?))",3],
  missions: ['crm_missions x','(x.primary_commercial_id=? OR EXISTS (SELECT 1 FROM crm_mission_associates a WHERE a.mission_id=x.id AND a.user_id=?))',2],
  opportunities: ['crm_opportunities x','x.assigned_to=?',1],
  reports: ['crm_reports x','(x.commercial_id=? OR EXISTS (SELECT 1 FROM crm_missions m WHERE m.id=x.mission_id AND m.primary_commercial_id=?))',2],
  institutions: ['crm_institutions x','x.created_by=?',1],
  users: ['users x','x.id=?',1]
};
function requireFeature(defaultFeature) {
  return async (req,res,next) => {
    try {
      const feature = defaultFeature === 'objectives' && /^\/(domains|kpis)(\/|$)/.test(req.path) ? 'kpis' : defaultFeature;
      const operation = ['GET','HEAD'].includes(req.method) ? 'can_view' : req.method === 'DELETE' ? 'can_delete' : req.method === 'POST' && (req.path === '/' || req.path === '/proposals' || req.path.startsWith('/generate')) ? 'can_create' : 'can_update';
      assertFeature(req.user,feature,operation);
      if (/\/(assign|affectations)(\/|$)/.test(req.path)) assertFeature(req.user,feature,'can_reorganize');
      const permission = permissionFor(req.user,feature);
      req.user.restrictFeatureScope = Boolean(permission && !permission.can_view_all);
      const id = /^\/(\d+)(?:\/|$)/.exec(req.path)?.[1];
      if (id && req.user.restrictFeatureScope && ownership[feature]) {
        const [table,condition,repeats] = ownership[feature];
        const [rows] = await pool.query(`SELECT x.id FROM ${table} WHERE x.id=? AND ${condition}`,[id,...Array(repeats).fill(req.user.id)]);
        if (!rows.length) return res.status(403).json({error:'Ce dossier est hors de votre périmètre.'});
      }
      next();
    } catch(error) { next(error); }
  };
}
module.exports = {requireFeature,permissionFor,assertFeature,scopeRestricted};
