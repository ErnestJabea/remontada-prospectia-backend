/**
 * Script de migration pour l'historique des connexions et l'audit (empreintes)
 * Run: node backend/migrate_security_logs.js
 */
const pool = require('./db');

async function migrate() {
  try {
    console.log('🚀 Démarrage de la migration pour l\'historique des connexions et l\'audit...');

    // Helper pour vérifier si une colonne existe
    async function columnExists(tableName, columnName) {
      const [rows] = await pool.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = ? 
          AND COLUMN_NAME = ?
      `, [tableName, columnName]);
      return rows.length > 0;
    }

    // 1. Ajouter les colonnes last_activity et last_active_client à la table users
    console.log('  👤 Mise à jour de la table users...');
    if (!(await columnExists('users', 'last_activity'))) {
      console.log('    - Ajout de la colonne last_activity...');
      await pool.query('ALTER TABLE users ADD COLUMN last_activity TIMESTAMP NULL DEFAULT NULL');
    } else {
      console.log('    - La colonne last_activity existe déjà.');
    }

    if (!(await columnExists('users', 'last_active_client'))) {
      console.log('    - Ajout de la colonne last_active_client...');
      await pool.query("ALTER TABLE users ADD COLUMN last_active_client ENUM('web_portal', 'mobile_pwa', 'unknown') DEFAULT 'unknown'");
    } else {
      console.log('    - La colonne last_active_client existe déjà.');
    }

    // 2. Créer la table crm_login_history
    console.log('  🔑 Création de la table crm_login_history...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_login_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        username VARCHAR(50) NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        user_agent VARCHAR(255) DEFAULT NULL,
        client_type ENUM('web_portal', 'mobile_pwa', 'unknown') NOT NULL DEFAULT 'unknown',
        status ENUM('SUCCESS', 'FAILED', 'BLOCKED') NOT NULL,
        failure_reason VARCHAR(100) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('🎉 Migration complétée avec succès !');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erreur critique lors de la migration:', err);
    process.exit(1);
  }
}

migrate();
