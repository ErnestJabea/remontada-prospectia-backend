const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
const TEMP_SIMPLE_AUTH = process.env.TEMP_SIMPLE_AUTH === 'true';

async function authenticateTemporarily(req, res, next) {
  const requestedUserId = Number(req.headers['x-crm-user-id'] || 0);
  if (!requestedUserId) {
    return res.status(401).json({ error: 'Token d\'authentification manquant.' });
  }

  const [rows] = await pool.query(
    `SELECT id, username, full_name, role, is_active
     FROM users
     WHERE id = ? AND is_active = TRUE
     LIMIT 1`,
    [requestedUserId]
  );

  if (!rows.length) {
    return res.status(401).json({ error: 'Utilisateur temporaire invalide ou inactif.' });
  }

  req.user = {
    id: rows[0].id,
    username: rows[0].username,
    full_name: rows[0].full_name,
    role: rows[0].role,
    clientType: 'temporary_backoffice'
  };

  return next();
}

/**
 * Accepte le cookie HttpOnly du portail web et conserve le Bearer token
 * pour la compatibilite avec la PWA mobile.
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = req.cookies?.crm_access || bearerToken;

  if (!token) {
    if (TEMP_SIMPLE_AUTH) return authenticateTemporarily(req, res, next);
    return res.status(401).json({ error: 'Token d\'authentification manquant.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query(
      `SELECT id, username, full_name, role, is_active
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [decoded.id]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'Session invalide ou compte desactive.' });
    }

    req.user = {
      ...decoded,
      id: rows[0].id,
      username: rows[0].username,
      full_name: rows[0].full_name,
      role: rows[0].role
    };

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.once('finish', () => {
        if (res.statusCode >= 500) return;
        const path = req.originalUrl.split('?')[0];
        const moduleName = path.split('/').filter(Boolean)[1] || 'api';
        pool.query(
          `INSERT INTO crm_audit_logs (
            user_id, action_type, module_name, ip_address
          ) VALUES (?, ?, ?, ?)`,
          [
            req.user.id,
            `${req.method} ${path}`.slice(0, 100),
            moduleName.slice(0, 50),
            (req.ip || req.socket.remoteAddress || 'unknown').slice(0, 45)
          ]
        ).catch(auditError => {
          console.error('[AUDIT_ERROR]', auditError.message);
        });
      });
    }

    next();
  } catch (err) {
    if (TEMP_SIMPLE_AUTH) return authenticateTemporarily(req, res, next);
    return res.status(401).json({ error: 'Token invalide ou expire.' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acces refuse. Droits insuffisants.' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
