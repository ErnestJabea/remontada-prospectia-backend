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

const secureCookies = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
const cookieSameSite = process.env.COOKIE_SAMESITE || (secureCookies ? 'none' : 'lax');
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

function publicUser(user) {
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
    avatar_url: user.avatar_url
  };
}

function createAccessToken(user, clientType) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      clientType
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function createRefreshToken(userId) {
  return jwt.sign(
    { id: userId, jti: crypto.randomUUID() },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES }
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

router.post('/login', async (req, res) => {
  const { username, password, clientType, deviceId, deviceName } = req.body;
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !username.trim() ||
    !password ||
    username.length > 50 ||
    password.length > 200
  ) {
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
    if (!rows.length) return res.status(401).json({ error: 'Identifiants incorrects.' });

    const user = rows[0];
    if (user.blocked_until && new Date(user.blocked_until) > new Date()) {
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
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Compte desactive. Contactez l\'administrateur.' });
    }

    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, blocked_until = NULL, last_login = NOW() WHERE id = ?',
      [user.id]
    );

    const isMobileClient = !clientType || clientType === 'mobile_pwa';
    if (isMobileClient) {
      const ticket = crypto.randomUUID();
      const otp = generateOTP();
      mfaTickets.set(ticket, {
        userId: user.id,
        otp,
        expiry: Date.now() + 10 * 60 * 1000,
        attempts: 0,
        deviceId: deviceId || null,
        deviceName: deviceName || 'Terrain'
      });

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
    const refreshToken = createRefreshToken(user.id);
    await storeRefreshToken(pool, user.id, refreshToken, deviceId || `web-${crypto.randomUUID()}`);
    setWebCookies(res, accessToken, refreshToken);

    return res.json({
      user: publicUser(user),
      token: accessToken,
      accessToken,
      refreshToken
    });
  } catch (err) {
    console.error('[AUTH/LOGIN]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/verify-mfa', async (req, res) => {
  const { ticket, otp, deviceId, deviceName } = req.body;
  if (!ticket || !otp) return res.status(400).json({ error: 'Ticket et OTP requis.' });

  const ticketData = mfaTickets.get(ticket);
  if (!ticketData) return res.status(401).json({ error: 'Ticket invalide ou expire.' });
  if (Date.now() > ticketData.expiry) {
    mfaTickets.delete(ticket);
    return res.status(401).json({ error: 'Code OTP expire. Veuillez vous reconnecter.' });
  }

  if (ticketData.otp !== otp.toString().trim()) {
    ticketData.attempts += 1;
    if (ticketData.attempts >= 5) mfaTickets.delete(ticket);
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
    const token = createAccessToken(user, 'mobile_pwa');
    const refreshToken = createRefreshToken(user.id);
    const devId = deviceId || ticketData.deviceId || crypto.randomUUID();
    const devName = deviceName || ticketData.deviceName || 'Terrain';

    await storeRefreshToken(pool, user.id, refreshToken, devId);
    await pool.query(
      `INSERT INTO user_authorized_devices (user_id, device_id, device_name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), last_used_at = NOW()`,
      [user.id, devId, devName]
    );

    return res.json({
      token,
      refreshToken,
      user: publicUser(user)
    });
  } catch (err) {
    console.error('[AUTH/VERIFY-MFA]', err);
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
       SET password = ?, failed_login_attempts = 0, blocked_until = NULL
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
    return res.json({ user: publicUser(rows[0]) });
  } catch (err) {
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
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const [tokens] = await connection.query(
      `SELECT *
       FROM refresh_tokens
       WHERE token_hash = ? AND user_id = ? AND expires_at > NOW()
       LIMIT 1`,
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
    const accessToken = createAccessToken(user, cookieSession ? 'web_portal' : 'mobile_pwa');

    if (cookieSession) {
      const rotatedRefreshToken = createRefreshToken(user.id);
      await connection.beginTransaction();
      transactionStarted = true;
      await connection.query('DELETE FROM refresh_tokens WHERE id = ?', [tokens[0].id]);
      await storeRefreshToken(connection, user.id, rotatedRefreshToken, tokens[0].device_id);
      await connection.commit();
      transactionStarted = false;
      setWebCookies(res, accessToken, rotatedRefreshToken);
      return res.json({ user: publicUser(user) });
    }

    return res.json({ accessToken });
  } catch (err) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    clearWebCookies(res);
    return res.status(401).json({ error: 'Refresh token invalide.' });
  } finally {
    connection.release();
  }
});

router.post('/logout', async (req, res) => {
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

module.exports = router;
