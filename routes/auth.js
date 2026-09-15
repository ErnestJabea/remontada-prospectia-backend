const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { sendOTPEmail, sendPasswordResetEmail } = require('../utils/mailer');

const router = express.Router();
const mfaTickets = new Map();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const ACCESS_COOKIE = 'crm_access';
const REFRESH_COOKIE = 'crm_refresh';
const JWT_ALGORITHMS = ['HS256'];
const MFA_TTL_MS = 10 * 60 * 1000;
const MFA_RESEND_COOLDOWN_MS = 30 * 1000;
const MFA_MAX_RESENDS = 3;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('Invalid-password-timing-padding-9!', 12);

const secureCookies = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
const configuredSameSite = String(process.env.COOKIE_SAMESITE || '').toLowerCase();
const cookieSameSite = ['strict', 'lax', 'none'].includes(configuredSameSite)
  ? configuredSameSite
  : (secureCookies ? 'none' : 'lax');
if (cookieSameSite === 'none' && !secureCookies) {
  throw new Error('COOKIE_SAMESITE=none exige des cookies Secure.');
}
const baseCookieOptions = {
  httpOnly: true,
  secure: secureCookies,
  sameSite: cookieSameSite,
  path: '/'
};

function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashOtp(otp) {
  return crypto.createHmac('sha256', JWT_SECRET).update(String(otp)).digest('hex');
}

function secureHashEquals(expectedHash, candidate) {
  if (typeof expectedHash !== 'string' || typeof candidate !== 'string') return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashOtp(candidate), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function cleanupExpiredMfaTickets() {
  const now = Date.now();
  for (const [ticket, data] of mfaTickets.entries()) {
    if (!data || data.expiry <= now) mfaTickets.delete(ticket);
  }
}

function normalizeDeviceValue(value, maxLength, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
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

function tokenMaxAge(token) {
  const decoded = jwt.decode(token);
  return decoded?.exp ? Math.max((decoded.exp * 1000) - Date.now(), 0) : undefined;
}

async function publicUser(user) {
  const [jobPermissions] = user.job_description_id && user.role !== 'SYSTEM'
    ? await pool.query('SELECT module_id, feature_id, can_view, can_view_all, can_create, can_update, can_delete, can_reorganize FROM job_feature_permissions WHERE job_description_id=?',[user.job_description_id])
    : [[]];
  let settings = null;
  if (user.settings) {
    if (typeof user.settings === 'object') {
      settings = user.settings;
    } else {
      try { settings = JSON.parse(user.settings); } catch { settings = null; }
    }
  }
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    name: user.full_name,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    role: user.role,
    job_title: user.job_title,
    job_description_id: user.job_description_id || null,
    jobPermissions,
    base_city_id: user.base_city_id || null,
    avatar_url: user.avatar_url,
    settings: settings,
    mfa_enabled: Boolean(user.mfa_enabled)
  };
}


function createAccessToken(user, clientType) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      clientType,
      authVersion: Number(user.auth_version || 0),
      jti: crypto.randomUUID()
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN }
  );
}

function createRefreshToken(userId, authVersion = 0) {
  return jwt.sign(
    { id: userId, authVersion: Number(authVersion), jti: crypto.randomUUID() },
    JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: JWT_REFRESH_EXPIRES }
  );
}

function setWebCookies(res, accessToken, refreshToken) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookieOptions,
    maxAge: tokenMaxAge(accessToken)
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookieOptions,
    maxAge: tokenMaxAge(refreshToken)
  });
}

function clearWebCookies(res) {
  res.clearCookie(ACCESS_COOKIE, baseCookieOptions);
  res.clearCookie(REFRESH_COOKIE, baseCookieOptions);
}

async function storeRefreshToken(connection, userId, refreshToken, deviceId) {
  const decoded = jwt.decode(refreshToken);
  const expiresAt = new Date(decoded.exp * 1000);
  await connection.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_id, expires_at)
     VALUES (?, ?, ?, ?)`,
    [userId, hashToken(refreshToken), deviceId, expiresAt]
  );
}

async function logLoginAttempt(userId, username, ip, ua, clientType, status, failureReason = null) {
  try {
    await pool.query(
      `INSERT INTO crm_login_history (user_id, username, ip_address, user_agent, client_type, status, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        String(username || 'unknown').slice(0, 50),
        String(ip || 'unknown').slice(0, 45),
        ua ? String(ua).slice(0, 255) : null,
        String(clientType || 'unknown').slice(0, 20),
        status,
        failureReason ? String(failureReason).slice(0, 100) : null
      ]
    );
  } catch (err) {
    console.error('[LOG_LOGIN_ERROR]', err.message);
  }
}

router.post('/login', async (req, res) => {
  const { username, password, clientType, deviceId, deviceName } = req.body;
  const normalizedClientType = clientType === 'mobile_pwa' ? 'mobile_pwa' : 'web_portal';
  const isMobileClient = normalizedClientType === 'mobile_pwa';
  const ip = req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || null;

  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !username.trim() ||
    !password ||
    username.length > 50 ||
    password.length > 200
  ) {
    await logLoginAttempt(null, username || 'unknown', ip, ua, clientType, 'FAILED', 'Identifiants invalides');
    return res.status(400).json({ error: 'Identifiants invalides.' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.*, jd.title AS job_title, jd.role_category
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.username = ?
       LIMIT 1`,
      [username.trim()]
    );
    if (!rows.length) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      await logLoginAttempt(null, username.trim(), ip, ua, clientType, 'FAILED', 'Identifiants incorrects');
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    const user = rows[0];
    if (user.blocked_until && new Date(user.blocked_until) > new Date()) {
      await logLoginAttempt(user.id, username.trim(), ip, ua, clientType, 'BLOCKED', 'Compte temporairement bloque');
      return res.status(403).json({ error: 'Compte temporairement bloque.' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      const blockedUntil = attempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;
      await pool.query(
        'UPDATE users SET failed_login_attempts = ?, blocked_until = ? WHERE id = ?',
        [attempts, blockedUntil, user.id]
      );
      await logLoginAttempt(user.id, username.trim(), ip, ua, clientType, 'FAILED', 'Mot de passe incorrect');
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    if (!user.is_active) {
      await logLoginAttempt(user.id, username.trim(), ip, ua, clientType, 'BLOCKED', 'Compte desactive');
      return res.status(403).json({ error: 'Compte desactive. Contactez l\'administrateur.' });
    }

    await pool.query(
      `UPDATE users 
       SET failed_login_attempts = 0, 
           blocked_until = NULL, 
           last_login = NOW(), 
           last_activity = NOW(), 
           last_active_client = ? 
       WHERE id = ?`,
      [normalizedClientType, user.id]
    );

    const requiresMfa = Boolean(user.mfa_enabled) || isMobileClient;

    if (requiresMfa) {
      cleanupExpiredMfaTickets();
      const ticket = crypto.randomUUID();
      const otp = generateOTP();
      mfaTickets.set(ticket, {
        userId: user.id,
        otpHash: hashOtp(otp),
        expiry: Date.now() + MFA_TTL_MS,
        attempts: 0,
        resendCount: 0,
        lastSentAt: Date.now(),
        deviceId: normalizeDeviceValue(deviceId, 100, null),
        deviceName: normalizeDeviceValue(deviceName, 100, isMobileClient ? 'Terrain' : 'Web Portal'),
        clientType: normalizedClientType
      });

      // Disponible uniquement pour les tests locaux explicites.
      if (process.env.NODE_ENV !== 'production' && process.env.LOG_DEV_OTP === 'true') {
        const fs = require('fs');
        const path = require('path');
        fs.writeFileSync(path.join(__dirname, '../last_otp.txt'), String(otp));
      }

      const recipientEmail = user.email || `${username}@remontada.cm`;
      sendOTPEmail(recipientEmail, username, otp).catch(err => {
        console.error('[MFA/MAIL_ERROR]', err.message);
      });

      return res.json({
        mfaRequired: true,
        ticket,
        email: recipientEmail.replace(/(.{2}).+(@.+)/, '$1***$2')
      });
    }


    const accessToken = createAccessToken(user, 'web_portal');
    const refreshToken = createRefreshToken(user.id, user.auth_version);
    await storeRefreshToken(
      pool,
      user.id,
      refreshToken,
      normalizeDeviceValue(deviceId, 100, `web-${crypto.randomUUID()}`)
    );
    setWebCookies(res, accessToken, refreshToken);

    await logLoginAttempt(user.id, username.trim(), ip, ua, 'web_portal', 'SUCCESS');

    return res.json({
      user: await publicUser(user)
    });
  } catch (err) {
    console.error('[AUTH/LOGIN]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/verify-mfa', async (req, res) => {
  const { ticket, otp, deviceId, deviceName } = req.body;
  const ip = req.ip || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || null;

  if (
    typeof ticket !== 'string' || ticket.length > 100 ||
    (typeof otp !== 'string' && typeof otp !== 'number') ||
    !/^\d{6}$/.test(String(otp).trim())
  ) {
    return res.status(400).json({ error: 'Ticket et OTP invalides.' });
  }

  const ticketData = mfaTickets.get(ticket);
  if (!ticketData) return res.status(401).json({ error: 'Ticket invalide ou expire.' });
  
  const logClientType = ticketData.clientType || 'mobile_pwa';

  if (Date.now() > ticketData.expiry) {
    mfaTickets.delete(ticket);
    await logLoginAttempt(ticketData.userId, 'unknown', ip, ua, logClientType, 'FAILED', 'Ticket/OTP expire');
    return res.status(401).json({ error: 'Code OTP expire. Veuillez vous reconnecter.' });
  }

  if (!secureHashEquals(ticketData.otpHash, String(otp).trim())) {
    ticketData.attempts += 1;
    const isBlocked = ticketData.attempts >= 5;
    if (isBlocked) mfaTickets.delete(ticket);

    const [uRows] = await pool.query('SELECT username FROM users WHERE id = ?', [ticketData.userId]);
    const username = uRows[0]?.username || 'unknown';
    await logLoginAttempt(ticketData.userId, username, ip, ua, logClientType, isBlocked ? 'BLOCKED' : 'FAILED', 'Code OTP incorrect');

    return res.status(401).json({ error: 'Code OTP incorrect.' });
  }
  mfaTickets.delete(ticket);

  try {
    const [rows] = await pool.query(
      `SELECT u.*, jd.title AS job_title
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.id = ? AND u.is_active = TRUE`,
      [ticketData.userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Utilisateur introuvable ou inactif.' });

    const user = rows[0];
    const token = createAccessToken(user, logClientType);
    const refreshToken = createRefreshToken(user.id, user.auth_version);
    const devId = normalizeDeviceValue(deviceId, 100, ticketData.deviceId || crypto.randomUUID());
    const devName = normalizeDeviceValue(
      deviceName,
      100,
      ticketData.deviceName || (logClientType === 'mobile_pwa' ? 'Terrain' : 'Web Portal')
    );

    await storeRefreshToken(pool, user.id, refreshToken, devId);
    await pool.query(
      `INSERT INTO user_authorized_devices (user_id, device_id, device_name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), last_used_at = NOW()`,
      [user.id, devId, devName]
    );

    await pool.query(
      `UPDATE users 
       SET last_activity = NOW(), 
           last_active_client = ?,
           last_mfa_ip = ?
       WHERE id = ?`,
      [logClientType, ip, user.id]
    );


    await logLoginAttempt(user.id, user.username, ip, ua, logClientType, 'SUCCESS');

    if (logClientType === 'web_portal') {
      setWebCookies(res, token, refreshToken);
      return res.json({ user: await publicUser(user) });
    }

    return res.json({
      token,
      accessToken: token,
      refreshToken,
      user: await publicUser(user)
    });
  } catch (err) {
    console.error('[AUTH/VERIFY-MFA]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/resend-mfa', async (req, res) => {
  const { ticket } = req.body;
  if (typeof ticket !== 'string' || !ticket || ticket.length > 100) {
    return res.status(400).json({ error: 'Ticket invalide.' });
  }

  const ticketData = mfaTickets.get(ticket);
  if (!ticketData) {
    return res.status(404).json({ error: 'Session de connexion expirée ou invalide. Veuillez vous reconnecter.' });
  }
  if (Date.now() > ticketData.expiry) {
    mfaTickets.delete(ticket);
    return res.status(401).json({ error: 'Session de connexion expiree. Veuillez vous reconnecter.' });
  }
  if (Date.now() - ticketData.lastSentAt < MFA_RESEND_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Veuillez patienter avant de demander un nouveau code.' });
  }
  if (ticketData.resendCount >= MFA_MAX_RESENDS) {
    mfaTickets.delete(ticket);
    return res.status(429).json({ error: 'Trop de codes demandes. Veuillez vous reconnecter.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT username, email FROM users WHERE id = ? AND is_active = TRUE',
      [ticketData.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable ou inactif.' });

    const user = rows[0];
    const otp = generateOTP();
    
    // Mettre à jour le ticket avec le nouvel OTP
    ticketData.otpHash = hashOtp(otp);
    ticketData.expiry = Date.now() + MFA_TTL_MS;
    ticketData.attempts = 0;
    ticketData.resendCount += 1;
    ticketData.lastSentAt = Date.now();

    const recipientEmail = user.email || `${user.username}@remontada.cm`;
    await sendOTPEmail(recipientEmail, user.username, otp);

    return res.json({
      message: 'Code OTP renvoyé avec succès.',
      email: recipientEmail.replace(/(.{2}).+(@.+)/, '$1***$2')
    });
  } catch (err) {
    console.error('[AUTH/RESEND-MFA]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const identifier = typeof req.body?.identifier === 'string'
    ? req.body.identifier.trim()
    : '';
  if (!identifier || identifier.length > 100) {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }

  const ticket = crypto.randomUUID();
  const genericResponse = {
    ticket,
    message: 'Si un compte actif correspond, un code de reinitialisation a ete envoye.'
  };

  try {
    const [users] = await pool.query(
      `SELECT id, username, email
       FROM users
       WHERE (username = ? OR email = ?) AND is_active = TRUE
       LIMIT 1`,
      [identifier, identifier]
    );

    if (!users.length || !users[0].email) {
      return res.json(genericResponse);
    }

    const user = users[0];
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, 12);

    await pool.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW()
       WHERE user_id = ? AND used_at IS NULL`,
      [user.id]
    );
    await pool.query(
      `INSERT INTO password_reset_tokens (
        user_id, ticket_hash, otp_hash, expires_at
      ) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [user.id, hashToken(ticket), otpHash]
    );

    await sendPasswordResetEmail(user.email, user.username, otp);
    return res.json(genericResponse);
  } catch (err) {
    console.error('[AUTH/FORGOT_PASSWORD]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { ticket, otp, newPassword } = req.body || {};
  if (
    typeof ticket !== 'string' ||
    typeof otp !== 'string' ||
    !/^\d{6}$/.test(otp.trim()) ||
    !validPassword(newPassword)
  ) {
    return res.status(400).json({
      error: 'Code invalide ou mot de passe insuffisamment robuste.'
    });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [tokens] = await connection.query(
      `SELECT prt.*, u.is_active
       FROM password_reset_tokens prt
       JOIN users u ON prt.user_id = u.id
       WHERE prt.ticket_hash = ?
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()
       LIMIT 1
       FOR UPDATE`,
      [hashToken(ticket)]
    );

    if (!tokens.length || !tokens[0].is_active || tokens[0].attempts >= 5) {
      await connection.rollback();
      return res.status(400).json({ error: 'Code invalide ou expire.' });
    }

    const resetToken = tokens[0];
    const otpMatches = await bcrypt.compare(otp.trim(), resetToken.otp_hash);
    if (!otpMatches) {
      await connection.query(
        'UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE id = ?',
        [resetToken.id]
      );
      await connection.commit();
      return res.status(400).json({ error: 'Code invalide ou expire.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await connection.query(
      `UPDATE users
       SET password = ?, auth_version = auth_version + 1, failed_login_attempts = 0, blocked_until = NULL
       WHERE id = ?`,
      [passwordHash, resetToken.user_id]
    );
    await connection.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?',
      [resetToken.id]
    );
    await connection.query(
      'DELETE FROM refresh_tokens WHERE user_id = ?',
      [resetToken.user_id]
    );
    await connection.commit();

    clearWebCookies(res);
    return res.json({ message: 'Mot de passe reinitialise. Vous pouvez vous connecter.' });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error('[AUTH/RESET_PASSWORD]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    connection.release();
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.*, jd.title AS job_title
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.id = ? AND u.is_active = TRUE`,
      [req.user.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Session invalide.' });
    return res.json({ user: await publicUser(rows[0]) });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/settings', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT settings FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    
    const defaultSettings = {
      lang: 'fr',
      theme: 'light',
      notifications: { email: true, push: false },
      alerts: { lateRelance: true, syncConflict: true },
      sync: { auto: true, frequency: 15 }
    };
    
    let settings = rows[0].settings;
    if (!settings) {
      settings = defaultSettings;
    } else if (typeof settings === 'string') {
      try { settings = JSON.parse(settings); } catch { settings = defaultSettings; }
    }
    
    return res.json(settings);
  } catch (err) {
    console.error('[SETTINGS/GET]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/settings', authenticate, async (req, res) => {
  try {
    const newSettings = req.body;
    if (!newSettings || typeof newSettings !== 'object') {
      return res.status(400).json({ error: 'Format de paramètres invalide.' });
    }
    
    await pool.query(
      'UPDATE users SET settings = ? WHERE id = ?',
      [JSON.stringify(newSettings), req.user.id]
    );
    
    return res.json({ success: true, settings: newSettings });
  } catch (err) {
    console.error('[SETTINGS/PUT]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});


router.get('/devices', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, device_id, device_name, authorized_at AS created_at, last_used_at
       FROM user_authorized_devices
       WHERE user_id = ?
       ORDER BY last_used_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.delete('/devices/:id', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [devices] = await connection.query(
      'SELECT device_id FROM user_authorized_devices WHERE id = ? AND user_id = ? FOR UPDATE',
      [req.params.id, req.user.id]
    );
    if (!devices.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Appareil introuvable.' });
    }

    await connection.query(
      'DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ?',
      [req.user.id, devices[0].device_id]
    );
    await connection.query(
      'DELETE FROM user_authorized_devices WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    await connection.commit();
    return res.json({ message: 'Appareil revoque.' });
  } catch (err) {
    await connection.rollback();
    return res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    connection.release();
  }
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
  const cookieSession = Boolean(req.cookies?.[REFRESH_COOKIE]);
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token manquant.' });

  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET, { algorithms: JWT_ALGORITHMS });
    await connection.beginTransaction();
    transactionStarted = true;
    const [tokens] = await connection.query(
      `SELECT *
       FROM refresh_tokens
       WHERE token_hash = ? AND user_id = ? AND expires_at > NOW()
       LIMIT 1 FOR UPDATE`,
      [hashToken(refreshToken), decoded.id]
    );
    if (!tokens.length) {
      clearWebCookies(res);
      return res.status(401).json({ error: 'Refresh token invalide ou expire.' });
    }

    const [users] = await connection.query(
      `SELECT u.*, jd.title AS job_title
       FROM users u
       LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id
       WHERE u.id = ? AND u.is_active = TRUE`,
      [decoded.id]
    );
    if (!users.length) {
      clearWebCookies(res);
      return res.status(401).json({ error: 'Utilisateur introuvable ou inactif.' });
    }

    const user = users[0];
    if (Number(decoded.authVersion || 0) !== Number(user.auth_version)) return res.status(401).json({ error: 'Session révoquée.' });
    const accessToken = createAccessToken(user, cookieSession ? 'web_portal' : 'mobile_pwa');

    const rotatedRefreshToken = createRefreshToken(user.id, user.auth_version);
    await connection.query('DELETE FROM refresh_tokens WHERE id = ?', [tokens[0].id]);
    await storeRefreshToken(connection, user.id, rotatedRefreshToken, tokens[0].device_id);
    await connection.commit();
    transactionStarted = false;

    if (cookieSession) {
      setWebCookies(res, accessToken, rotatedRefreshToken);
      return res.json({ user: await publicUser(user) });
    }

    return res.json({ accessToken, refreshToken: rotatedRefreshToken });
  } catch (err) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    clearWebCookies(res);
    return res.status(401).json({ error: 'Refresh token invalide.' });
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => {});
    connection.release();
  }
});

router.post('/logout', async (req, res) => {
  const access = req.cookies?.[ACCESS_COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (access) {
    let decoded;
    try { decoded = jwt.verify(access, JWT_SECRET, { algorithms: JWT_ALGORITHMS }); } catch { /* expired sessions already cannot be used */ }
    if (decoded?.exp) await pool.query('INSERT IGNORE INTO revoked_access_tokens (token_hash, expires_at) VALUES (?, FROM_UNIXTIME(?))', [hashToken(access), decoded.exp]);
  }
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
  if (refreshToken) {
    await pool.query(
      'DELETE FROM refresh_tokens WHERE token_hash = ?',
      [hashToken(refreshToken)]
    ).catch(() => {});
  }
  clearWebCookies(res);
  return res.json({ message: 'Deconnexion reussie.' });
});

router.post('/toggle-mfa', authenticate, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Statut MFA invalide.' });
  try {
    const mfaEnabledVal = enabled;
    await pool.query('UPDATE users SET mfa_enabled = ? WHERE id = ?', [mfaEnabledVal, req.user.id]);
    
    // Log target action for audit log
    await pool.query(
      `INSERT INTO crm_audit_logs (user_id, action_type, module_name, old_value, new_value, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        'POST /api/v1/auth/toggle-mfa',
        'auth',
        JSON.stringify({ mfa_enabled: !mfaEnabledVal }),
        JSON.stringify({ mfa_enabled: mfaEnabledVal }),
        req.ip || req.socket.remoteAddress
      ]
    );

    return res.json({ success: true, mfa_enabled: mfaEnabledVal });
  } catch (err) {
    console.error('[AUTH/TOGGLE-MFA]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
