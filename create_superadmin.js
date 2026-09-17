/**
 * Script utilitaire pour gérer les Superadministrateurs (rôle SYSTEM / ADMIN).
 * 
 * Usage :
 * 1. Lister les comptes administrateurs existants :
 *    node create_superadmin.js list
 * 
 * 2. Réinitialiser le mot de passe d'un admin existant :
 *    node create_superadmin.js reset-password <username_ou_email> <nouveau_mot_de_passe>
 * 
 * 3. Promouvoir un compte existant en Superadmin (SYSTEM) :
 *    node create_superadmin.js promote <username_ou_email>
 * 
 * 4. Créer un nouveau Superadministrateur :
 *    node create_superadmin.js create <username> <email> <password> "Nom Complet"
 */

const bcrypt = require('bcryptjs');
const pool = require('./db');

async function run() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || !['list', 'reset-password', 'promote', 'create'].includes(action)) {
    console.log(`
ℹ️ Utilisation :
  - Voir la liste des administrateurs existants :
    node create_superadmin.js list

  - Définir un nouveau mot de passe pour un admin existant :
    node create_superadmin.js reset-password <username_ou_email> <nouveau_mot_de_passe>

  - Promouvoir un compte existant en Superadmin SYSTEM :
    node create_superadmin.js promote <username_ou_email>

  - Créer un nouvel utilisateur Superadmin :
    node create_superadmin.js create <username> <email> <password> "Nom Complet"
    `);
    process.exit(0);
  }

  try {
    if (action === 'list') {
      const [rows] = await pool.query(
        `SELECT id, username, email, full_name, role, is_active, is_verified, blocked_until 
         FROM users 
         WHERE role IN ('SYSTEM', 'ADMIN', 'DIRECTION') 
         ORDER BY FIELD(role, 'SYSTEM', 'ADMIN', 'DIRECTION'), id ASC`
      );

      console.log('\n📋 Liste des comptes d\'administration existants dans la base de données :\n');
      if (!rows.length) {
        console.log('  ⚠️ Aucun compte SYSTEM, ADMIN ou DIRECTION trouvé.');
      } else {
        console.table(rows.map(u => ({
          ID: u.id,
          Identifiant: u.username,
          Email: u.email,
          Nom: u.full_name,
          Rôle: u.role,
          Actif: u.is_active ? 'Oui' : 'Non',
          Bloqué: u.blocked_until ? 'Oui' : 'Non'
        })));
      }
      console.log('\n💡 Pour réinitialiser le mot de passe de l\'un de ces comptes :');
      console.log('   node create_superadmin.js reset-password <identifiant_ou_email> <nouveau_mot_de_passe>\n');
      process.exit(0);
    }

    if (action === 'reset-password') {
      const identifier = args[1];
      const newPassword = args[2];

      if (!identifier || !newPassword) {
        console.error('❌ Usage : node create_superadmin.js reset-password <username_ou_email> <nouveau_mot_de_passe>');
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
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      await pool.query(
        `UPDATE users 
         SET password = ?, 
             failed_login_attempts = 0, 
             blocked_until = NULL, 
             is_active = 1, 
             is_verified = 1,
             role = CASE WHEN role = 'COMMERCIAL' THEN 'SYSTEM' ELSE role END
         WHERE id = ?`,
        [hashedPassword, user.id]
      );

      console.log(`
✅ Mot de passe réinitialisé avec succès pour "${user.username}" (${user.email}) !
   - Rôle actuel : ${user.role}
   - Statut du compte : Actif et débloqué
👉 Vous pouvez maintenant vous connecter sur le Backoffice avec cet identifiant et votre nouveau mot de passe.
      `);
      process.exit(0);
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
