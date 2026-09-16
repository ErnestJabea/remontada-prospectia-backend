const pool = require('../db');

/**
 * Envoie une notification à tous les utilisateurs ayant le rôle 'DIRECTION' (et 'ADMIN').
 * @param {string} title Titre de la notification
 * @param {string} message Contenu de la notification
 * @param {string} type Type de la notification (ex: 'REPORT_SUBMITTED')
 * @param {number} targetId ID de la ressource concernée
 */
async function notifyDirection(title, message, type, targetId = null) {
  try {
    // 1. Récupérer les utilisateurs Direction
    const [users] = await pool.query(
      "SELECT id FROM users WHERE role IN ('DIRECTION', 'ADMIN') AND is_active = TRUE"
    );

    if (users.length === 0) return;

    await Promise.all(users.map(user => notifyUser(user.id, title, message, type, targetId)));
    console.log(`[NOTIF] Notification de type ${type} envoyée à ${users.length} utilisateurs de la direction.`);
  } catch (err) {
    if (pool.inTransaction()) throw err;
    console.error('[NOTIF_ERROR]', err);
  }
}

/**
 * Envoie une notification à un utilisateur spécifique.
 * @param {number} userId ID de l'utilisateur destinataire
 * @param {string} title Titre de la notification
 * @param {string} message Contenu de la notification
 * @param {string} type Type de la notification
 * @param {number} targetId ID de la ressource concernée
 */
async function notifyUser(userId, title, message, type, targetId = null) {
  try {
    const [inserted] = await pool.query(
      `INSERT INTO crm_notifications (user_id, title, message, type, target_id)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, title, message, type, targetId]
    );
    if (type.startsWith('OBJECTIVE_')) {
      await pool.query("INSERT INTO notification_deliveries (notification_id,channel) VALUES (?, 'email'), (?, 'push')", [inserted.insertId, inserted.insertId]);
    }
    console.log(`[NOTIF] Notification de type ${type} envoyée à l'utilisateur ${userId}.`);
  } catch (err) {
    if (pool.inTransaction()) throw err;
    console.error('[NOTIF_USER_ERROR]', err);
  }
}

module.exports = { notifyDirection, notifyUser };
