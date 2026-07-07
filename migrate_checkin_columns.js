/**
 * Migration: Add GPS check-in columns to crm_missions
 * Run: node backend/migrate_checkin_columns.js
 */
const pool = require('./db');

async function migrate() {
  console.log('🚀 Ajout des colonnes GPS check-in sur crm_missions...');

  const newCols = [
    ['check_in_at', 'DATETIME NULL COMMENT "Date/heure de démarrage terrain (PWA)"'],
    ['check_in_latitude', 'DECIMAL(10,7) NULL COMMENT "Latitude GPS au check-in"'],
    ['check_in_longitude', 'DECIMAL(10,7) NULL COMMENT "Longitude GPS au check-in"']
  ];

  try {
    const [existing] = await pool.query('SHOW COLUMNS FROM crm_missions');
    const existingNames = new Set(existing.map(c => c.Field));

    for (const [name, def] of newCols) {
      if (!existingNames.has(name)) {
        await pool.query(`ALTER TABLE crm_missions ADD COLUMN ${name} ${def}`);
        console.log(`  ✅ Colonne ajoutée : ${name}`);
      } else {
        console.log(`  ℹ️  Colonne déjà existante : ${name}`);
      }
    }

    console.log('\n🎉 Migration terminée avec succès !');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erreur lors de la migration :', err);
    process.exit(1);
  }
}

migrate();
