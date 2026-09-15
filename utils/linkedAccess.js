const pool = require('../db');
const { scopeRestricted } = require('../middleware/featureAccess');

// A submitted foreign key must have the same visibility as the corresponding selector.
module.exports = async function canLinkRecord(user, feature, id) {
  if (id === undefined || id === null || id === '') return true;
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return false;
  const definitions = {
    missions: ['crm_missions x', '(x.primary_commercial_id=? OR EXISTS (SELECT 1 FROM crm_mission_associates a WHERE a.mission_id=x.id AND a.user_id=?))', 2],
    objectives: ['crm_objectives x', "(x.created_by=? OR x.responsible_id=? OR EXISTS (SELECT 1 FROM objectif_affectations a WHERE a.objective_id=x.id AND a.type='COMMERCIAL' AND a.target_id=?))", 3]
  };
  const [table, condition, repeats] = definitions[feature];
  const restricted = scopeRestricted(user,feature);
  const [rows] = await pool.query(`SELECT x.id FROM ${table} WHERE x.id=?${restricted ? ' AND '+condition : ''}`, [id,...(restricted ? Array(repeats).fill(user.id) : [])]);
  return rows.length > 0;
};
