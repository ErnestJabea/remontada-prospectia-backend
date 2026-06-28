/**
 * Script de migration pour le module étendu "Données de base"
 * Run: node backend/migrate_referentials.js
 */
const pool = require('./db');

async function migrate() {
  try {
    console.log('🚀 Démarrage de la migration pour le module "Données de base"...');

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

    // 1. Table crm_ref_countries (Pays)
    console.log('  🏠 Création de la table crm_ref_countries...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_ref_countries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Insérer Cameroun par défaut
    await pool.query(`
      INSERT IGNORE INTO crm_ref_countries (id, code, name) VALUES (1, 'CMR', 'Cameroun');
    `);
    console.log('  ✅ Table crm_ref_countries configurée');

    // 2. Associer crm_ref_regions au pays
    const hasCountryId = await columnExists('crm_ref_regions', 'country_id');
    if (!hasCountryId) {
      console.log('  ➕ Ajout de country_id dans crm_ref_regions...');
      await pool.query(`
        ALTER TABLE crm_ref_regions ADD COLUMN country_id INT DEFAULT NULL
      `);
      try {
        await pool.query(`
          ALTER TABLE crm_ref_regions 
          ADD CONSTRAINT fk_ref_regions_country 
          FOREIGN KEY (country_id) REFERENCES crm_ref_countries(id) ON DELETE SET NULL
        `);
      } catch (err) {
        console.warn('  ⚠️ Attention lors de l\'ajout de la contrainte fk_ref_regions_country:', err.message);
      }
      // Mettre à jour au pays par défaut (Cameroun)
      await pool.query(`UPDATE crm_ref_regions SET country_id = 1 WHERE country_id IS NULL`);
      console.log('  ✅ crm_ref_regions lié aux pays.');
    }

    // 3. Créer les nouvelles tables de référence CRM
    const refTables = [
      {
        name: 'crm_ref_institution_types',
        seeds: [
          { code: 'PROSPECT', name: 'Prospect' },
          { code: 'ADMINISTRATION', name: 'Administration' },
          { code: 'ENTERPRISE_PUBLIQUE', name: 'Entreprise Publique' },
          { code: 'CTD', name: 'Collectivité Territoriale (CTD)' }
        ]
      },
      {
        name: 'crm_ref_influence_levels',
        seeds: [
          { code: 'DECIDEUR', name: 'Décideur' },
          { code: 'PRESCRIPTEUR', name: 'Prescripteur' },
          { code: 'INFLUENCEUR', name: 'Influenceur' },
          { code: 'FACILITATEUR', name: 'Facilitateur' }
        ]
      },
      {
        name: 'crm_ref_priorities',
        seeds: [
          { code: 'LOW', name: 'Faible' },
          { code: 'MEDIUM', name: 'Moyenne' },
          { code: 'HIGH', name: 'Élevée' }
        ]
      },
      {
        name: 'crm_ref_mission_types',
        seeds: [
          { code: 'PROSPECTION', name: 'Prospection' },
          { code: 'RELANCE', name: 'Relance' },
          { code: 'NEGOCIATION', name: 'Négociation' },
          { code: 'SIGNATURE', name: 'Signature' },
          { code: 'SUIVI', name: 'Suivi' },
          { code: 'AUTRE', name: 'Autre' }
        ]
      },
      {
        name: 'crm_ref_period_types',
        seeds: [
          { code: 'ANNUAL', name: 'Annuel' },
          { code: 'SEMESTRIAL', name: 'Semestriel' },
          { code: 'TRIMESTRIAL', name: 'Trimestriel' },
          { code: 'MONTHLY', name: 'Mensuel' },
          { code: 'EXCEPTIONAL', name: 'Exceptionnel' }
        ]
      }
    ];

    for (const table of refTables) {
      console.log(`  ⚙️ Configuration de la table de référence ${table.name}...`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${table.name} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(100) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      for (const seed of table.seeds) {
        await pool.query(
          `INSERT IGNORE INTO ${table.name} (code, name) VALUES (?, ?)`,
          [seed.code, seed.name]
        );
      }
      console.log(`  ✅ Table ${table.name} initialisée et alimentée.`);
    }

    // 4. Modifier les colonnes ENUM à VARCHAR(50)
    console.log('  🔄 Conversion des colonnes ENUM en VARCHAR(50)...');

    // crm_institutions.type
    const typeColType = await getColumnType('crm_institutions', 'type');
    if (typeColType === 'enum') {
      console.log('    - Modification de crm_institutions.type...');
      await pool.query(`
        ALTER TABLE crm_institutions 
        MODIFY COLUMN type VARCHAR(50) NOT NULL DEFAULT 'PROSPECT'
      `);
    }

    // crm_contacts.influence_level
    const influenceColType = await getColumnType('crm_contacts', 'influence_level');
    if (influenceColType === 'enum') {
      console.log('    - Modification de crm_contacts.influence_level...');
      await pool.query(`
        ALTER TABLE crm_contacts 
        MODIFY COLUMN influence_level VARCHAR(50) NOT NULL
      `);
    }

    // crm_opportunities.priority
    const priorityColType = await getColumnType('crm_opportunities', 'priority');
    if (priorityColType === 'enum') {
      console.log('    - Modification de crm_opportunities.priority...');
      await pool.query(`
        ALTER TABLE crm_opportunities 
        MODIFY COLUMN priority VARCHAR(50) DEFAULT 'MEDIUM'
      `);
    }

    // crm_objectives.period_type
    const periodColType = await getColumnType('crm_objectives', 'period_type');
    if (periodColType === 'enum') {
      console.log('    - Modification de crm_objectives.period_type...');
      await pool.query(`
        ALTER TABLE crm_objectives 
        MODIFY COLUMN period_type VARCHAR(50) NOT NULL
      `);
    }

    console.log('🎉 Migration complétée avec succès !');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erreur critique lors de la migration:', err);
    process.exit(1);
  }
}

migrate();
