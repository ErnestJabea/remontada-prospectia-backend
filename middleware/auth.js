const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_ALGORITHMS = ['HS256'];

function authenticationError(res, message) {
  return res.status(401).json({
    error: message,
    code: 'AUTHENTICATION_REQUIRED',
    requestId: res.req?.requestId || null
  });
}

/**
 * Accepte le cookie HttpOnly du portail web et conserve le Bearer token
 * pour la compatibilite avec la PWA mobile.
 */
async function authenticate(req, res, next) {
  if (req.user?.id) return next();

  const authHeader = req.headers.authorization;
  if (authHeader && !/^Bearer [A-Za-z0-9._-]+$/.test(authHeader)) {
    return authenticationError(res, 'En-tete d\'authentification invalide.');
  }

  const bearerToken = authHeader ? authHeader.slice(7) : null;
  const cookieToken = req.cookies?.crm_access || null;
  if (cookieToken && bearerToken && cookieToken !== bearerToken) {
    return authenticationError(res, 'Sources d\'authentification incompatibles.');
  }
  const token = cookieToken || bearerToken;

  if (!token) {
    return authenticationError(res, 'Token d\'authentification manquant.');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ACCESS_TOKEN_ALGORITHMS });
    const expectedClientType = cookieToken ? 'web_portal' : 'mobile_pwa';
    if (!Number(decoded.id) || decoded.clientType !== expectedClientType) {
      return authenticationError(res, 'Jeton incompatible avec ce canal d\'acces.');
    }
    const [rows] = await pool.query(
      `SELECT id, username, full_name, role, is_active, auth_version, job_description_id
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [decoded.id]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'Session invalide ou compte desactive.' });
    }
    if (Number(decoded.authVersion || 0) !== Number(rows[0].auth_version)) {
      return authenticationError(res, 'Session révoquée. Veuillez vous reconnecter.');
    }
    const [revoked] = await pool.query('SELECT token_hash FROM revoked_access_tokens WHERE token_hash = ? AND expires_at > NOW()', [crypto.createHash('sha256').update(token).digest('hex')]);
    if (revoked.length) return authenticationError(res, 'Session révoquée.');

    req.user = {
      ...decoded,
      id: rows[0].id,
      username: rows[0].username,
      full_name: rows[0].full_name,
      job_description_id: rows[0].job_description_id,
      role: rows[0].role
    };
    if (rows[0].job_description_id && rows[0].role !== 'SYSTEM') {
      const [permissions] = await pool.query('SELECT module_id,feature_id,can_view,can_create,can_update,can_delete,can_view_all,can_reorganize FROM job_feature_permissions WHERE job_description_id=?',[rows[0].job_description_id]);
      req.user.jobPermissions = permissions;
    }

    // Mettre à jour l'activité en arrière-plan (non bloquant)
    pool.query(
      `UPDATE users 
       SET last_activity = NOW(), 
           last_active_client = ? 
       WHERE id = ?`,
      [decoded.clientType || 'unknown', rows[0].id]
    ).catch(err => {
      console.error('[MIDDLEWARE_LAST_ACTIVITY_ERROR]', err.message);
    });

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.once('finish', () => {
        if (res.statusCode >= 500) return;
        const rawPath = req.originalUrl.split('?')[0];
        const canonicalPath = rawPath.replace(/^\/api(?!\/v1(?:\/|$))/, '/api/v1');
        const pathParts = canonicalPath.split('/').filter(Boolean);
        const moduleName = pathParts[0] === 'api' && pathParts[1] === 'v1'
          ? (pathParts[2] || 'api')
          : 'api';
        pool.query(
          `INSERT INTO crm_audit_logs (
            user_id, action_type, module_name, ip_address
          ) VALUES (?, ?, ?, ?)`,
          [
            req.user.id,
            `${req.method} ${canonicalPath}`.slice(0, 100),
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
    return authenticationError(res, 'Token invalide ou expire.');
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Acces refuse. Droits insuffisants.',
        code: 'FORBIDDEN',
        requestId: req.requestId || null
      });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
