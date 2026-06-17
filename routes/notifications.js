const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

// GET /api/notifications — Récupérer toutes les notifications de l'utilisateur connecté
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM crm_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[NOTIFICATIONS/LIST]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/notifications/:id/read — Marquer une notification comme lue
router.post('/:id/read', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE crm_notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Notification marquée comme lue.' });
  } catch (err) {
    console.error('[NOTIFICATIONS/READ]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
