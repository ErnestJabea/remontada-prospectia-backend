const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// 1. Récupérer les utilisateurs actifs ces 15 dernières minutes
router.get('/active-users', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, username, full_name, role, last_activity, last_active_client
      FROM users
      WHERE last_activity >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
        AND is_active = TRUE
      ORDER BY last_activity DESC
    `);
    return res.json(rows);
  } catch (err) {
    console.error('[GET /security/active-users]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 2. Récupérer l'historique des connexions (limité à 200)
router.get('/login-history', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, user_id, username, ip_address, user_agent, client_type, status, failure_reason, created_at
      FROM crm_login_history
      ORDER BY created_at DESC
      LIMIT 200
    `);
    return res.json(rows);
  } catch (err) {
    console.error('[GET /security/login-history]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// 3. Récupérer les logs d'audit des actions (limité à 200)
router.get('/audit-logs', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT l.id, l.user_id, u.username, u.full_name, l.action_type, l.module_name, l.old_value, l.new_value, l.ip_address, l.timestamp
      FROM crm_audit_logs l
      LEFT JOIN users u ON l.user_id = u.id
      ORDER BY l.timestamp DESC
      LIMIT 200
    `);
    return res.json(rows);
  } catch (err) {
    console.error('[GET /security/audit-logs]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
