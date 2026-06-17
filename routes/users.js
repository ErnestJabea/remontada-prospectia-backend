const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendInitialPasswordEmail } = require('../utils/mailer');

const router = express.Router();
const MANAGER_ROLES = new Set(['SYSTEM', 'DIRECTION', 'ADMIN']);
const ASSIGNABLE_ROLES = new Set(['COMMERCIAL', 'DIRECTION']);

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

function validPassword(password) {
  return typeof password === 'string' &&
    password.length >= 10 &&
    password.length <= 200 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
}

function normalizeEmail(email) {
  if (email == null || email === '') return null;
  if (typeof email !== 'string') return false;
  const value = email.trim().toLowerCase();
  if (!value || value.length > 150) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : false;
}

router.get('/', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.first_name, u.last_name,
              u.email, u.phone, u.role, u.job_description_id, u.is_active,
              u.is_verified, u.last_login, u.created_at,
              jd.title AS job_title, jd.role_category
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.role NOT IN ('SYSTEM', 'ADMIN')
       ORDER BY u.created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    console.error('[USERS/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/commercials', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.first_name, u.last_name,
              u.email, u.phone, u.role, u.is_active, u.last_login,
              jd.title AS job_title
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.role = 'COMMERCIAL' AND u.is_active = TRUE
       ORDER BY u.full_name`
    );
    return res.json(rows);
  } catch (err) {
    console.error('[USERS/COMMERCIALS]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/job-descriptions/all', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, description, role_category FROM job_descriptions ORDER BY role_category, title'
    );
    return res.json(rows);
  } catch (err) {
    console.error('[USERS/JOBS]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  const requestedId = Number(req.params.id);
  if (!requestedId) return res.status(400).json({ error: 'Identifiant invalide.' });
  if (!isManager(req.user) && requestedId !== req.user.id) {
    return res.status(403).json({ error: 'Acces refuse.' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.first_name, u.last_name,
              u.email, u.phone, u.role, u.is_active, u.is_verified,
              u.last_login, u.created_at, u.avatar_url,
              jd.id AS job_description_id, jd.title AS job_title, jd.role_category
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.id = ?`,
      [requestedId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[USERS/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), async (req, res) => {
  const {
    username, password, full_name, first_name, last_name,
    email, phone, role, job_description_id
  } = req.body;
  const normalizedEmail = normalizeEmail(email);
  if (
    typeof username !== 'string' || !username.trim() || username.length > 50 ||
    typeof full_name !== 'string' || !full_name.trim() || full_name.length > 100 ||
    !validPassword(password) || !ASSIGNABLE_ROLES.has(role) ||
    normalizedEmail === false ||
    (role === 'COMMERCIAL' && !normalizedEmail)
  ) {
    return res.status(400).json({
      error: 'Donnees utilisateur invalides. Pour un commercial, un email valide est obligatoire. Le mot de passe doit contenir au moins 10 caracteres, avec majuscule, minuscule, chiffre et symbole.'
    });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const hashedPassword = await bcrypt.hash(password, 12);
    const [result] = await connection.query(
      `INSERT INTO users (
        username, password, full_name, first_name, last_name,
        email, phone, role, job_description_id, is_verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        username.trim(), hashedPassword, full_name.trim(), first_name || null,
        last_name || null, normalizedEmail, phone || null, role,
        Number(job_description_id) || null
      ]
    );

    if (role === 'COMMERCIAL') {
      const emailSent = await sendInitialPasswordEmail(normalizedEmail, {
        username: username.trim(),
        fullName: full_name.trim(),
        password
      });
      if (!emailSent) {
        await connection.rollback();
        return res.status(503).json({
          error: 'Utilisateur non cree : impossible d\'envoyer le mot de passe par email. Verifiez la configuration SMTP.'
        });
      }
    }

    await connection.commit();
    return res.status(201).json({ id: result.insertId, message: 'Utilisateur cree.' });
  } catch (err) {
    await connection.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ce nom d\'utilisateur ou email existe deja.' });
    }
    console.error('[USERS/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    connection.release();
  }
});

router.put('/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), async (req, res) => {
  const {
    full_name, first_name, last_name, email, phone,
    role, job_description_id, is_active
  } = req.body;
  if (
    typeof full_name !== 'string' || !full_name.trim() ||
    full_name.length > 100 || !ASSIGNABLE_ROLES.has(role)
  ) {
    return res.status(400).json({ error: 'Donnees utilisateur invalides.' });
  }

  try {
    const [result] = await pool.query(
      `UPDATE users
       SET full_name = ?, first_name = ?, last_name = ?, email = ?, phone = ?,
           role = ?, job_description_id = ?, is_active = ?, updated_at = NOW()
       WHERE id = ? AND role NOT IN ('SYSTEM', 'ADMIN')`,
      [
        full_name.trim(), first_name || null, last_name || null, email || null,
        phone || null, role, Number(job_description_id) || null,
        is_active !== false, req.params.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (is_active === false) {
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [req.params.id]);
    }
    return res.json({ message: 'Utilisateur mis a jour.' });
  } catch (err) {
    console.error('[USERS/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/:id/password', authenticate, authorize('SYSTEM', 'ADMIN'), async (req, res) => {
  const { newPassword } = req.body;
  if (!validPassword(newPassword)) {
    return res.status(400).json({
      error: 'Le mot de passe doit contenir au moins 10 caracteres, avec majuscule, minuscule, chiffre et symbole.'
    });
  }
  try {
    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.params.id]);
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [req.params.id]);
    return res.json({ message: 'Mot de passe mis a jour.' });
  } catch (err) {
    console.error('[USERS/PASSWORD]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.delete('/:id', authenticate, authorize('SYSTEM', 'ADMIN'), async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [req.params.id]);
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [req.params.id]);
    return res.json({ message: 'Utilisateur desactive.' });
  } catch (err) {
    console.error('[USERS/DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
