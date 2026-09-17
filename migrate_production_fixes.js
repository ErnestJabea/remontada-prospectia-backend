/**
 * Script de migration sécurisé et non destructif pour l'environnement de production.
 * Exécute l'ajout des colonnes requises si elles n'existent pas encore.
 * Usage: node migrate_production_fixes.js
 */
const pool = require('./db');

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function safeAddColumn(tableName, columnName, definition) {
  const exists = await columnExists(tableName, columnName);
  if (exists) {
    console.log(`  ℹ️  ${tableName}.${columnName} existe déjà.`);
    return;
  }
  try {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    console.log(`  ✅ Ajouté avec succès: ${tableName}.${columnName}`);
  } catch (err) {
    console.warn(`  ⚠️ Échec ajout ${tableName}.${columnName}:`, err.message);
  }
}

async function run() {
  console.log('🚀 Démarrage de la mise à niveau de la base de données production...');
  try {
    // 1. Colonnes crm_missions
    console.log('\n📦 Vérification de crm_missions...');
    await safeAddColumn('crm_missions', 'base_city_id', 'INT NULL AFTER city_id');
    await safeAddColumn('crm_missions', 'client_request_id', 'VARCHAR(36) NULL');
    await safeAddColumn('crm_missions', 'travel_scope', "ENUM('IN_CITY','OUT_OF_CITY') NULL");
    await safeAddColumn('crm_missions', 'departure_at', 'DATETIME NULL');
    await safeAddColumn('crm_missions', 'return_at', 'DATETIME NULL');
    await safeAddColumn('crm_missions', 'transport_mode', 'VARCHAR(40) NULL');
    await safeAddColumn('crm_missions', 'accommodation_required', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await safeAddColumn('crm_missions', 'estimated_travel_cost', 'DECIMAL(15,2) NOT NULL DEFAULT 0');

    // 2. Colonnes users
    console.log('\n👤 Vérification de users...');
    await safeAddColumn('users', 'base_city_id', 'INT NULL AFTER job_description_id');
    await safeAddColumn('users', 'auth_version', 'INT NOT NULL DEFAULT 0');

    // 3. Colonnes multilingues sur les référentiels géographiques
    console.log('\n🌍 Vérification des référentiels géographiques...');
    for (const table of ['crm_ref_countries', 'crm_ref_regions', 'crm_ref_departments', 'crm_ref_cities']) {
      try {
        const [tableExists] = await pool.query(
          `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
          [table]
        );
        if (tableExists.length > 0) {
          await safeAddColumn(table, 'name_en', 'VARCHAR(255) DEFAULT NULL');
        }
      } catch (err) {
        console.warn(`  ⚠️ Table ${table} introuvable ou inaccessible:`, err.message);
      }
    }

    // 4. Tables crm_mission_targets si manquantes
    console.log('\n🎯 Vérification des cibles de mission...');
    const { ensureMissionTargetTables } = require('./services/missionTargetService');
    await ensureMissionTargetTables(pool).catch(err => {
      console.warn('  ⚠️ Note missionTargetTables:', err.message);
    });

    console.log('\n🎉 Toutes les vérifications et migrations sont terminées avec succès !');
  } catch (err) {
    console.error('\n❌ Erreur inattendue:', err);
  } finally {
    if (require.main === module) {
      process.exit(0);
    }
  }
}

if (require.main === module) {
  run();
}

module.exports = { runMigration: run };
