/**
 * Script de migration pour créer les tables de pièces jointes des opportunités et des missions
 * Run: node backend/migrate_attachments.js
 */
const pool = require('./db');

async function migrate() {
  try {
    console.log('🚀 Démarrage de la migration de la base de données pour les pièces jointes (Missions & Opportunités)...');

    // 1. Créer la table crm_opportunity_attachments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunity_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        opportunity_id INT NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_size INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_opportunity_attachments créée/vérifiée.');

    // 2. Créer la table crm_mission_attachments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_mission_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        mission_id INT NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_size INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (mission_id) REFERENCES crm_missions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_mission_attachments créée/vérifiée.');

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
