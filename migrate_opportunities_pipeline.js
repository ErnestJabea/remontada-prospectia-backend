/**
 * Script de migration de base de données pour le module Pipeline des Opportunités Commerciales
 * Run: node backend/migrate_opportunities_pipeline.js
 */
const pool = require('./db');

async function migrate() {
  try {
    console.log('🚀 Démarrage de la migration de la base de données pour le Pipeline des Opportunités...');

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

    // Helper pour vérifier le type d'une colonne
    async function getColumnType(tableName, columnName) {
      const [rows] = await pool.query(`
        SELECT DATA_TYPE 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = ? 
          AND COLUMN_NAME = ?
      `, [tableName, columnName]);
      return rows[0]?.DATA_TYPE || null;
    }

    // 1. Modifier crm_opportunities pour changer status et pipeline_stage d'ENUM à VARCHAR
    const statusType = await getColumnType('crm_opportunities', 'status');
    if (statusType === 'enum') {
      console.log('  ⚠️ Modification de crm_opportunities.status d\'ENUM à VARCHAR(50)...');
      await pool.query(`
        ALTER TABLE crm_opportunities 
        MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'DETECTED'
      `);
      console.log('  ✅ crm_opportunities.status modifié');
    }

    const stageType = await getColumnType('crm_opportunities', 'pipeline_stage');
    if (stageType === 'enum') {
      console.log('  ⚠️ Modification de crm_opportunities.pipeline_stage d\'ENUM à VARCHAR(50)...');
      await pool.query(`
        ALTER TABLE crm_opportunities 
        MODIFY COLUMN pipeline_stage VARCHAR(50) NOT NULL DEFAULT 'DETECTION'
      `);
      console.log('  ✅ crm_opportunities.pipeline_stage modifié');
    }

    // 2. Ajouter les nouvelles colonnes de crm_opportunities si absentes
    const newColumns = [
      { name: 'code', type: 'VARCHAR(50) UNIQUE DEFAULT NULL' },
      { name: 'final_amount', type: 'DECIMAL(15,2) DEFAULT NULL' },
      { name: 'decision_date', type: 'TIMESTAMP NULL DEFAULT NULL' },
      { name: 'lost_reason', type: 'TEXT DEFAULT NULL' },
      { name: 'validated_by', type: 'INT DEFAULT NULL' },
      { name: 'validated_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
      { name: 'archived_at', type: 'TIMESTAMP NULL DEFAULT NULL' }
    ];

    for (const col of newColumns) {
      const exists = await columnExists('crm_opportunities', col.name);
      if (!exists) {
        console.log(`  ➕ Ajout de la colonne crm_opportunities.${col.name}...`);
        await pool.query(`ALTER TABLE crm_opportunities ADD COLUMN ${col.name} ${col.type}`);
      }
    }

    // S'assurer de la contrainte de clé étrangère pour validated_by si elle n'existe pas
    try {
      await pool.query(`
        ALTER TABLE crm_opportunities 
        ADD CONSTRAINT fk_opp_validated_by 
        FOREIGN KEY (validated_by) REFERENCES users(id) ON DELETE SET NULL
      `);
      console.log('  ✅ Contrainte de clé étrangère fk_opp_validated_by ajoutée');
    } catch (err) {
      // Si déjà existante, MySQL renverra une erreur, on l'ignore simplement
      if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_FK_DUP_NAME') {
        console.warn('  ⚠️ Attention lors de l\'ajout de la contrainte fk_opp_validated_by:', err.message);
      }
    }

    // 3. Créer la table crm_opportunity_mission_links si absente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunity_mission_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        opportunity_id INT NOT NULL,
        mission_id INT NOT NULL,
        link_type VARCHAR(50) NOT NULL DEFAULT 'follow_up',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        FOREIGN KEY (mission_id) REFERENCES crm_missions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_opportunity_mission_links vérifiée');

    // 4. Créer la table crm_opportunity_actions si absente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunity_actions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        opportunity_id INT NOT NULL,
        title VARCHAR(150) NOT NULL,
        description TEXT DEFAULT NULL,
        action_type VARCHAR(50) NOT NULL,
        assigned_to INT DEFAULT NULL,
        due_date DATE DEFAULT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
        completed_at TIMESTAMP NULL DEFAULT NULL,
        created_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_opportunity_actions vérifiée');

    // 5. Créer la table crm_opportunity_stage_histories si absente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunity_stage_histories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        opportunity_id INT NOT NULL,
        old_status VARCHAR(50) DEFAULT NULL,
        new_status VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        comment TEXT DEFAULT NULL,
        performed_by INT NOT NULL,
        performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_opportunity_stage_histories vérifiée');

    // 6. Créer la table crm_opportunity_comments si absente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_opportunity_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        opportunity_id INT NOT NULL,
        user_id INT NOT NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_opportunity_comments vérifiée');

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
