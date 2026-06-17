/**
 * Script de migration de base de données pour le module Objectifs et Performance
 * Run: node backend/migrate_objectives.js
 */
const pool = require('./db');

async function migrate() {
  console.log('🚀 Démarrage de la migration de la base de données...');

  // 1. Créer crm_notifications si absente
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) NOT NULL,
      target_id INT DEFAULT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table crm_notifications vérifiée');

  // 2. Créer objectif_domaines
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objectif_domaines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table objectif_domaines vérifiée');

  // 3. Créer kpis
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpis (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      domain_id INT NOT NULL,
      type ENUM('QUANTITATIVE', 'FINANCIAL', 'PERCENTAGE', 'CALCULATED', 'MANUAL') NOT NULL,
      unit VARCHAR(50) NOT NULL,
      calculation_source ENUM('MISSIONS', 'OPPORTUNITIES', 'REPORTS', 'ACTIVITIES', 'MANUAL') NOT NULL,
      calculation_rule TEXT, -- JSON configuration rule
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (domain_id) REFERENCES objectif_domaines(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table kpis vérifiée');

  // Helper function to check if a column exists
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

  // 4. Pré-migration de crm_objectives pour éviter les conflits d'ENUM
  // Création temporaire de performance_status si elle n'existe pas encore pour pouvoir migrer le statut
  const hasPerfStatus = await columnExists('crm_objectives', 'performance_status');
  if (!hasPerfStatus) {
    await pool.query(`
      ALTER TABLE crm_objectives 
      ADD COLUMN performance_status ENUM('NOT_EVALUATED', 'NOT_ACHIEVED', 'UNDER_EXPECTATIONS', 'ACHIEVED', 'EXCEEDED') DEFAULT 'NOT_EVALUATED'
    `);
  }

  // Migration des anciens statuts vers la colonne de performance
  await pool.query(`UPDATE crm_objectives SET performance_status = 'ACHIEVED' WHERE status = 'ACHIEVED'`);
  await pool.query(`UPDATE crm_objectives SET performance_status = 'NOT_ACHIEVED' WHERE status = 'NOT_ACHIEVED'`);
  await pool.query(`UPDATE crm_objectives SET status = 'CLOSED' WHERE status IN ('ACHIEVED', 'NOT_ACHIEVED')`);

  // 5. Altérer crm_objectives pour ajouter les champs manquants
  const alters = [
    { col: 'code', sql: 'ADD COLUMN code VARCHAR(50) UNIQUE DEFAULT NULL' },
    { col: 'domain_id', sql: 'ADD COLUMN domain_id INT DEFAULT NULL, ADD CONSTRAINT fk_obj_domain FOREIGN KEY (domain_id) REFERENCES objectif_domaines(id) ON DELETE RESTRICT' },
    { col: 'kpi_id', sql: 'ADD COLUMN kpi_id INT DEFAULT NULL, ADD CONSTRAINT fk_obj_kpi FOREIGN KEY (kpi_id) REFERENCES kpis(id) ON DELETE RESTRICT' },
    { col: 'target_value', sql: 'ADD COLUMN target_value DECIMAL(15,2) DEFAULT NULL' },
    { col: 'unit', sql: 'ADD COLUMN unit VARCHAR(50) DEFAULT "FCFA"' },
    { col: 'min_level', sql: 'ADD COLUMN min_level DECIMAL(15,2) DEFAULT NULL' },
    { col: 'expected_level', sql: 'ADD COLUMN expected_level DECIMAL(15,2) DEFAULT NULL' },
    { col: 'excellent_level', sql: 'ADD COLUMN excellent_level DECIMAL(15,2) DEFAULT NULL' },
    { col: 'direction', sql: 'ADD COLUMN direction VARCHAR(100) DEFAULT NULL' },
    { col: 'department', sql: 'ADD COLUMN department VARCHAR(100) DEFAULT NULL' },
    { col: 'service', sql: 'ADD COLUMN service VARCHAR(100) DEFAULT NULL' },
    { col: 'responsible_id', sql: 'ADD COLUMN responsible_id INT DEFAULT NULL, ADD CONSTRAINT fk_obj_resp FOREIGN KEY (responsible_id) REFERENCES users(id) ON DELETE RESTRICT' },
    { col: 'achieved_value', sql: 'ADD COLUMN achieved_value DECIMAL(15,2) DEFAULT 0' },
    { col: 'achievement_rate', sql: 'ADD COLUMN achievement_rate DECIMAL(5,2) DEFAULT 0' },
    { col: 'observations', sql: 'ADD COLUMN observations TEXT DEFAULT NULL' }
  ];

  for (const alt of alters) {
    const hasCol = await columnExists('crm_objectives', alt.col);
    if (!hasCol) {
      await pool.query(`ALTER TABLE crm_objectives ${alt.sql}`);
      console.log(`  ✅ Colonne crm_objectives.${alt.col} ajoutée`);
    }
  }

  // Modifier la colonne status de crm_objectives
  await pool.query(`
    ALTER TABLE crm_objectives 
    MODIFY COLUMN status ENUM('DRAFT', 'SUBMITTED', 'CORRECTION', 'REJECTED', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS', 'CLOSED', 'CANCELLED') DEFAULT 'DRAFT'
  `);
  console.log('  ✅ ENUM de crm_objectives.status mis à jour');

  // 6. Créer objectif_moyens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objectif_moyens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      objective_id INT NOT NULL,
      type ENUM('BUDGET', 'VEHICLE', 'HUMAN_RESOURCES', 'TRAINING', 'EQUIPMENT', 'MARKETING_SUPPORT') NOT NULL,
      description TEXT NOT NULL,
      quantity INT DEFAULT 1,
      estimated_cost DECIMAL(15,2) DEFAULT 0,
      validated_cost DECIMAL(15,2) DEFAULT 0,
      approval_status ENUM('PENDING', 'APPROVED', 'REJECTED') DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (objective_id) REFERENCES crm_objectives(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table objectif_moyens vérifiée');

  // 7. Créer objectif_formations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objectif_formations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      objective_id INT NOT NULL,
      theme VARCHAR(255) NOT NULL,
      goal TEXT NOT NULL,
      period VARCHAR(100) NOT NULL,
      priority ENUM('LOW', 'MEDIUM', 'HIGH') DEFAULT 'MEDIUM',
      status ENUM('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED') DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (objective_id) REFERENCES crm_objectives(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table objectif_formations vérifiée');

  // 8. Créer objectif_affectations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objectif_affectations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      objective_id INT NOT NULL,
      type ENUM('TEAM', 'COMMERCIAL', 'REGION', 'DEPARTMENT') NOT NULL,
      target_id INT DEFAULT NULL,
      target_name VARCHAR(150) DEFAULT NULL,
      value_allocated DECIMAL(15,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (objective_id) REFERENCES crm_objectives(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table objectif_affectations vérifiée');

  // 9. Créer objectif_resultats
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objectif_resultats (
      id INT AUTO_INCREMENT PRIMARY KEY,
      objective_id INT NOT NULL,
      date_calculated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      achieved_value DECIMAL(15,2) NOT NULL,
      target_value DECIMAL(15,2) NOT NULL,
      gap DECIMAL(15,2) NOT NULL,
      achievement_rate DECIMAL(5,2) NOT NULL,
      notes TEXT DEFAULT NULL, -- Obligatoire pour manuel
      recorded_by INT DEFAULT NULL, -- Habilité si manuel
      FOREIGN KEY (objective_id) REFERENCES crm_objectives(id) ON DELETE CASCADE,
      FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table objectif_resultats vérifiée');

  // 10. Créer objectif_historiques
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objectif_historiques (
      id INT AUTO_INCREMENT PRIMARY KEY,
      objective_id INT NOT NULL,
      user_id INT NOT NULL,
      action VARCHAR(100) NOT NULL,
      old_value LONGTEXT DEFAULT NULL,
      new_value LONGTEXT DEFAULT NULL,
      comments TEXT DEFAULT NULL,
      ip_address VARCHAR(45) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (objective_id) REFERENCES crm_objectives(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✅ Table objectif_historiques vérifiée');

  // 11. Seeder les Domaines par défaut s'ils n'existent pas
  const domainsSeed = [
    { code: 'COM', name: 'Commercial', desc: 'Ventes, visites clients et prospection terrain' },
    { code: 'MKT', name: 'Marketing', desc: 'Actions promotionnelles et communication' },
    { code: 'PR', name: 'Prospection', desc: 'Recherche de nouveaux comptes' },
    { code: 'PTN', name: 'Partenariat', desc: 'Alliances et partenariats institutionnels' },
    { code: 'INS', name: 'Développement institutionnel', desc: 'Relations avec les administrations publiques' }
  ];

  for (const dom of domainsSeed) {
    const [exists] = await pool.query('SELECT id FROM objectif_domaines WHERE code = ?', [dom.code]);
    if (exists.length === 0) {
      await pool.query(
        'INSERT INTO objectif_domaines (code, name, description) VALUES (?, ?, ?)',
        [dom.code, dom.name, dom.desc]
      );
      console.log(`  🌱 Domaine semé : ${dom.name}`);
    }
  }

  // Récupérer l'ID du domaine Commercial pour lier les KPIs
  const [comDomain] = await pool.query('SELECT id FROM objectif_domaines WHERE code = "COM"');
  const comDomainId = comDomain[0].id;

  // 12. Seeder les KPIs par défaut s'ils n'existent pas
  const kpisSeed = [
    {
      code: 'VISITES',
      name: 'Nombre de visites',
      desc: 'Nombre de missions commerciales complétées',
      domain_id: comDomainId,
      type: 'QUANTITATIVE',
      unit: 'visites',
      calculation_source: 'MISSIONS',
      calculation_rule: JSON.stringify({
        table: 'crm_missions',
        aggregate: 'COUNT',
        field: 'id',
        filters: [{ column: 'status', operator: '=', value: 'COMPLETED' }]
      })
    },
    {
      code: 'OPPS',
      name: 'Opportunités détectées',
      desc: 'Nombre total d\'opportunités qualifiées ou validées',
      domain_id: comDomainId,
      type: 'QUANTITATIVE',
      unit: 'opportunités',
      calculation_source: 'OPPORTUNITIES',
      calculation_rule: JSON.stringify({
        table: 'crm_opportunities',
        aggregate: 'COUNT',
        field: 'id',
        filters: [{ column: 'status', operator: 'IN', value: ['QUALIFIED', 'VALIDATED', 'WON'] }]
      })
    },
    {
      code: 'CONTRATS',
      name: 'Contrats gagnés',
      desc: 'Nombre d\'opportunités transformées en contrats (gagnées)',
      domain_id: comDomainId,
      type: 'QUANTITATIVE',
      unit: 'contrats',
      calculation_source: 'OPPORTUNITIES',
      calculation_rule: JSON.stringify({
        table: 'crm_opportunities',
        aggregate: 'COUNT',
        field: 'id',
        filters: [{ column: 'status', operator: '=', value: 'WON' }]
      })
    },
    {
      code: 'CA',
      name: 'Chiffre d\'affaires',
      desc: 'Volume d\'affaires généré par les contrats gagnés',
      domain_id: comDomainId,
      type: 'FINANCIAL',
      unit: 'FCFA',
      calculation_source: 'OPPORTUNITIES',
      calculation_rule: JSON.stringify({
        table: 'crm_opportunities',
        aggregate: 'SUM',
        field: 'estimated_amount',
        filters: [{ column: 'status', operator: '=', value: 'WON' }]
      })
    }
  ];

  for (const kpi of kpisSeed) {
    const [exists] = await pool.query('SELECT id FROM kpis WHERE code = ?', [kpi.code]);
    if (exists.length === 0) {
      await pool.query(
        `INSERT INTO kpis (code, name, description, domain_id, type, unit, calculation_source, calculation_rule) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [kpi.code, kpi.name, kpi.desc, kpi.domain_id, kpi.type, kpi.unit, kpi.calculation_source, kpi.calculation_rule]
      );
      console.log(`  🌱 KPI semé : ${kpi.name}`);
    }
  }

  // 13. S'assurer de la non-régression des anciennes entrées dans crm_objectives
  // Attribuer des valeurs par défaut pour domain_id et kpi_id s'ils sont nuls
  const [firstKpi] = await pool.query('SELECT id, unit FROM kpis WHERE code = "CA"');
  if (firstKpi.length > 0) {
    const defaultKpiId = firstKpi[0].id;
    const defaultUnit = firstKpi[0].unit;
    await pool.query(
      `UPDATE crm_objectives 
       SET domain_id = ?, kpi_id = ?, unit = ?, code = CONCAT('OBJ-', id)
       WHERE domain_id IS NULL OR kpi_id IS NULL`,
      [comDomainId, defaultKpiId, defaultUnit]
    );
  }

  console.log('\n✅ Migration et initialisation terminées avec succès !');
  process.exit(0);
}

migrate().catch(err => {
  console.error('\n❌ Erreur pendant la migration :', err);
  process.exit(1);
});
