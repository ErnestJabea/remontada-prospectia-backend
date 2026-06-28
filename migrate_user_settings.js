/**
 * Script de migration pour ajouter la colonne settings (JSON) à la table users.
 * Run: node backend/migrate_user_settings.js
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
    console.log('🚀 Démarrage de la migration pour les paramètres utilisateur...');

    const exists = await columnExists('users', 'settings');
    if (!exists) {
      console.log('  Adding settings column to users table...');
      await pool.query('ALTER TABLE users ADD COLUMN settings JSON NULL');
      console.log('  ✅ Colonne users.settings ajoutée.');
    } else {
      console.log('  ℹ️ Colonne users.settings existe déjà.');
    }

    // Initialiser les valeurs par défaut
    const defaultSettings = {
      lang: 'fr',
      theme: 'light',
      notifications: {
        email: true,
        push: false
      },
      alerts: {
        lateRelance: true,
        syncConflict: true
      },
      sync: {
        auto: true,
        frequency: 15
      }
    };

    console.log('  Updating default settings for existing users...');
    await pool.query(
      'UPDATE users SET settings = ? WHERE settings IS NULL',
      [JSON.stringify(defaultSettings)]
    );
    console.log('  ✅ Paramètres par défaut initialisés pour les utilisateurs existants.');

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
