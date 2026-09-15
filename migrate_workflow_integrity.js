const pool = require('./db');
async function migrate() {
  const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'auth_version'");
  if (!columns.length) await pool.query('ALTER TABLE users ADD COLUMN auth_version INT NOT NULL DEFAULT 0');
  await pool.query(`CREATE TABLE IF NOT EXISTS revoked_access_tokens (
    token_hash CHAR(64) PRIMARY KEY, expires_at DATETIME NOT NULL, INDEX(expires_at)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crm_sync_receipts (
    user_id INT NOT NULL, request_id VARCHAR(120) NOT NULL,
    payload_hash CHAR(64) NOT NULL, result_json JSON NOT NULL, local_aliases JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id,request_id)
  ) ENGINE=InnoDB`);
  const [receiptColumns] = await pool.query("SHOW COLUMNS FROM crm_sync_receipts LIKE 'local_aliases'");
  if (!receiptColumns.length) await pool.query('ALTER TABLE crm_sync_receipts ADD COLUMN local_aliases JSON NULL');
}
module.exports = migrate;
if (require.main === module) migrate().then(() => console.log('Migration intégrité des workflows terminée.')).finally(() => pool.end()).catch(error => { console.error(error.message); process.exitCode=1; });
