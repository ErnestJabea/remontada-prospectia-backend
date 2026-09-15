require('dotenv').config();
const pool = require('./db');

const additions = [
  ['users', 'base_city_id', 'INT NULL AFTER job_description_id'],
  ['crm_missions', 'base_city_id', 'INT NULL AFTER city_id'],
  ['crm_missions', 'client_request_id', 'VARCHAR(36) NULL UNIQUE AFTER base_city_id'],
  ['crm_missions', 'travel_scope', "ENUM('IN_CITY','OUT_OF_CITY') NULL AFTER base_city_id"],
  ['crm_missions', 'departure_at', 'DATETIME NULL AFTER travel_scope'],
  ['crm_missions', 'return_at', 'DATETIME NULL AFTER departure_at'],
  ['crm_missions', 'transport_mode', 'VARCHAR(40) NULL AFTER return_at'],
  ['crm_missions', 'accommodation_required', 'BOOLEAN NOT NULL DEFAULT FALSE AFTER transport_mode'],
  ['crm_missions', 'estimated_travel_cost', 'DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER accommodation_required']
];

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function migrate() {
  for (const [table, column, definition] of additions) {
    if (!await columnExists(table, column)) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`Ajout ${table}.${column}`);
    }
  }
  console.log('Migration mission travel scope terminée. Aucune ville de rattachement n’a été attribuée automatiquement.');
  await pool.end();
}

migrate().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
