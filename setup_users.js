/**
 * Initialise les mots de passe des comptes de demonstration.
 * Les secrets doivent etre fournis explicitement par variables d'environnement.
 */
const bcrypt = require('bcryptjs');
const pool = require('./db');

const users = [
  { username: 'admin-crm', env: 'SEED_ADMIN_PASSWORD' },
  { username: 'dg-remontada', env: 'SEED_DIRECTION_PASSWORD' },
  { username: 'commercial-jr', env: 'SEED_COMMERCIAL_JR_PASSWORD' },
  { username: 'commercial-sr', env: 'SEED_COMMERCIAL_SR_PASSWORD' }
];

function validPassword(password) {
  return typeof password === 'string' &&
    password.length >= 10 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
}

async function setupUsers() {
  const missing = users.filter(user => !validPassword(process.env[user.env]));
  if (missing.length) {
    throw new Error(
      `Variables manquantes ou mots de passe trop faibles : ${missing.map(user => user.env).join(', ')}`
    );
  }

  for (const user of users) {
    const hash = await bcrypt.hash(process.env[user.env], 12);
    await pool.query(
      'UPDATE users SET password = ? WHERE username = ?',
      [hash, user.username]
    );
    console.log(`Mot de passe initialise pour ${user.username}`);
  }
  await pool.end();
}

setupUsers().catch(async err => {
  console.error(err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
