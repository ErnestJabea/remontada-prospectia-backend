const pool = require('./db');

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function tableExists(tableName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(tableName, columnName, definition) {
  if (await columnExists(tableName, columnName)) return false;
  await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  return true;
}

async function ensureAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_descriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      role_category ENUM('SYSTEM', 'COMMERCIAL', 'DIRECTION', 'ADMIN') NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  if (!(await tableExists('users'))) {
    throw new Error('La table users est introuvable. Importez init_db_crm.sql avant cette migration.');
  }

  const columns = [
    ['first_name', 'VARCHAR(50) NULL'],
    ['last_name', 'VARCHAR(50) NULL'],
    ['email', 'VARCHAR(100) NULL'],
    ['phone', 'VARCHAR(20) NULL'],
    ['role', "ENUM('SYSTEM', 'COMMERCIAL', 'DIRECTION', 'ADMIN') NOT NULL DEFAULT 'COMMERCIAL'"],
    ['is_verified', 'BOOLEAN DEFAULT FALSE'],
    ['is_active', 'BOOLEAN DEFAULT TRUE'],
    ['job_description_id', 'INT NULL'],
    ['mfa_secret', 'VARCHAR(255) DEFAULT NULL'],
    ['mfa_enabled', 'BOOLEAN DEFAULT FALSE'],
    ['failed_login_attempts', 'INT DEFAULT 0'],
    ['blocked_until', 'TIMESTAMP NULL DEFAULT NULL'],
    ['last_login', 'TIMESTAMP NULL DEFAULT NULL'],
    ['avatar_url', 'VARCHAR(255) DEFAULT NULL'],
    ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
  ];

  for (const [column, definition] of columns) {
    const created = await ensureColumn('users', column, definition);
    if (created) console.log(`Colonne users.${column} ajoutee.`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(255) UNIQUE NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_refresh_user (user_id),
      INDEX idx_refresh_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      ticket_hash CHAR(64) UNIQUE NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      attempts INT DEFAULT 0,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_password_reset_user (user_id),
      INDEX idx_password_reset_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_authorized_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      device_name VARCHAR(150),
      fingerprint VARCHAR(255),
      authorized_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_device (user_id, device_id),
      INDEX idx_authorized_devices_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('Schema authentification pret.');
}

ensureAuthSchema()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
