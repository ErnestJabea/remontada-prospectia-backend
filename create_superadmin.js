/**
 * Script utilitaire pour créer ou promouvoir un Superadministrateur (rôle SYSTEM).
 * 
 * Usage :
 * 1. Promouvoir un compte existant :
 *    node create_superadmin.js promote <username_ou_email>
 * 
 * 2. Créer un nouveau Superadministrateur :
 *    node create_superadmin.js create <username> <email> <password> <full_name>
 */

const bcrypt = require('bcryptjs');
const pool = require('./db');

async function run() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || (action !== 'promote' && action !== 'create')) {
    console.log(`
ℹ️ Utilisation :
  - Pour promouvoir votre compte actuel en Superadmin :
    node create_superadmin.js promote <username_ou_email>

  - Pour créer un nouvel utilisateur Superadmin :
    node create_superadmin.js create <username> <email> <password> "Nom Complet"
    `);
    process.exit(0);
  }

  try {
    if (action === 'promote') {
      const identifier = args[1];
      if (!identifier) {
        console.error('❌ Veuillez préciser le nom d\'utilisateur ou l\'email à promouvoir.');
        process.exit(1);
      }

      const [rows] = await pool.query(
        'SELECT id, username, email, full_name, role FROM users WHERE username = ? OR email = ? LIMIT 1',
        [identifier, identifier]
      );

      if (!rows.length) {
        console.error(`❌ Aucun utilisateur trouvé avec l'identifiant : ${identifier}`);
        process.exit(1);
      }

      const user = rows[0];
      await pool.query(
        'UPDATE users SET role = "SYSTEM", job_description_id = NULL, is_active = 1, is_verified = 1 WHERE id = ?',
        [user.id]
      );

      console.log(`
✅ Succès ! L'utilisateur "${user.username}" (${user.email}) est désormais Superadministrateur (rôle SYSTEM).
🔓 Accès total et universel débloqué sur tous les modules et fiches de poste.
👉 Pensez à vous déconnecter et vous reconnecter dans le Backoffice pour appliquer vos nouveaux droits.
      `);
      process.exit(0);
    }

    if (action === 'create') {
      const username = args[1];
      const email = args[2];
      const password = args[3];
      const fullName = args[4] || 'Super Administrateur';

      if (!username || !email || !password) {
        console.error('❌ Usage: node create_superadmin.js create <username> <email> <password> [nom]');
        process.exit(1);
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      await pool.query(`
        INSERT INTO users (
          username, email, password, full_name, role, is_active, is_verified, job_description_id
        ) VALUES (?, ?, ?, ?, 'SYSTEM', 1, 1, NULL)
        ON DUPLICATE KEY UPDATE 
          role = 'SYSTEM', 
          job_description_id = NULL, 
          is_active = 1, 
          is_verified = 1,
          password = VALUES(password)
      `, [username, email, hashedPassword, fullName]);

      console.log(`
✅ Superadministrateur créé avec succès !
   - Identifiant : ${username}
   - Email : ${email}
   - Rôle : SYSTEM (Accès universel complet)
👉 Vous pouvez maintenant vous connecter directement dans le Backoffice avec ces identifiants.
      `);
      process.exit(0);
    }
  } catch (err) {
    console.error('❌ Erreur lors de l\'opération :', err.message || err);
    process.exit(1);
  }
}

run();
