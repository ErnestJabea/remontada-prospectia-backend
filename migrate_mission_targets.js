require('dotenv').config();
const pool = require('./db');
const { ensureMissionTargetTables } = require('./services/missionTargetService');

async function migrate() {
  await ensureMissionTargetTables(pool);
  const [result] = await pool.query(`
    INSERT INTO crm_mission_targets (
      mission_id, institution_id, visit_order, priority, potential,
      contact_name, contact_role
    )
    SELECT m.id, m.institution_id, 1, 'MEDIUM', 'MEDIUM', NULL, NULL
    FROM crm_missions m
    WHERE NOT EXISTS (
      SELECT 1 FROM crm_mission_targets mt WHERE mt.mission_id = m.id
    )
  `);
  console.log(`Migration multi-cibles terminée. ${result.affectedRows} mission(s) historique(s) rétroalimentée(s).`);
  await pool.end();
}

migrate().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
