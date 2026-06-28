/**
 * Migration script for crm_ref_documentary_observations (Documentary Observations)
 * Run: node backend/migrate_doc_observations.js
 */
const pool = require('./db');

async function migrate() {
  try {
    console.log('🚀 Starting migration for Documentary Observations referential...');

    // 1. Create table crm_ref_documentary_observations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_ref_documentary_observations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        name_en VARCHAR(255) DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_ref_documentary_observations created.');

    // 2. Insert seeds
    const seeds = [
      { code: 'WEAK_ORG', name: 'Organisation documentaire faible', name_en: 'Weak documentary organization' },
      { code: 'HEAVY_PHYS', name: 'Flux physiques importants', name_en: 'Heavy physical flows' },
      { code: 'OLD_EQUIP', name: 'Equipements vieillissants', name_en: 'Aging equipment' },
      { code: 'LOW_DIGIT', name: 'Digitalisation faible', name_en: 'Low digitalization' },
      { code: 'UNSTRUCT_ARCH', name: 'Archives non structurees', name_en: 'Unstructured archives' },
      { code: 'SEC_NEED', name: 'Besoin de securisation', name_en: 'Security needs' },
      { code: 'OTHER', name: 'Autre', name_en: 'Other' }
    ];

    for (const seed of seeds) {
      await pool.query(`
        INSERT INTO crm_ref_documentary_observations (code, name, name_en)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), name_en = VALUES(name_en)
      `, [seed.code, seed.name, seed.name_en]);
    }
    console.log('  ✅ Seed observations injected successfully.');

    console.log('🎉 Migration complétée avec succès !');
    process.exit(0);
  } catch (err) {
    console.error('❌ Critical error during migration:', err);
    process.exit(1);
  }
}

migrate();
