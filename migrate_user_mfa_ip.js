/**
 * Script de migration pour ajouter la colonne last_mfa_ip (VARCHAR) à la table users.
 * Run: node backend/migrate_user_mfa_ip.js
 */
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

async function migrate() {
  try {
    console.log('🚀 Démarrage de la migration pour le bypass MFA par IP...');

    const exists = await columnExists('users', 'last_mfa_ip');
    if (!exists) {
      console.log('  Adding last_mfa_ip column to users table...');
      await pool.query('ALTER TABLE users ADD COLUMN last_mfa_ip VARCHAR(45) NULL');
      console.log('  ✅ Colonne users.last_mfa_ip ajoutée.');
    } else {
      console.log('  ℹ️ Colonne users.last_mfa_ip existe déjà.');
    }

    console.log('🎉 Migration complétée avec succès !');

  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    console.log('🏁 Fin du processus.');
  }
}

migrate();
