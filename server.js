const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

for (const requiredSecret of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
  if (!process.env[requiredSecret] || process.env[requiredSecret].length < 32) {
    throw new Error(`${requiredSecret} doit contenir au moins 32 caracteres.`);
  }
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' }
}));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    const error = new Error('Origine non autorisee.');
    error.status = 403;
    return callback(error);
  },
  credentials: true
}));

// SameSite protege les navigateurs modernes. Ce controle d'origine ajoute une
// barriere explicite aux requetes d'ecriture authentifiees par cookie.
app.use((req, res, next) => {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  const usesCookieSession = Boolean(req.cookies?.crm_access || req.cookies?.crm_refresh);
  if (!safeMethods.includes(req.method) && usesCookieSession) {
    const origin = req.get('origin');
    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Origine de requete non autorisee.' });
    }
  }
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requetes. Reessayez dans 15 minutes.' }
});
// Desactive temporairement en local pour eviter les blocages pendant les tests.
// A reactiver avant la mise en production.
// app.use('/api/', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion.' }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de demandes de reinitialisation. Reessayez plus tard.' }
});

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const referentialsRoutes = require('./routes/referentials');
const objectivesRoutes = require('./routes/objectives');
const institutionsRoutes = require('./routes/institutions');
const missionsRoutes = require('./routes/missions');
const opportunitiesRoutes = require('./routes/opportunities');
const reportsRoutes = require('./routes/reports');
const syncRoutes = require('./routes/sync');
const notificationsRoutes = require('./routes/notifications');

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/verify-mfa', loginLimiter);
app.use('/api/auth/forgot-password', passwordResetLimiter);
app.use('/api/auth/reset-password', passwordResetLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/referentials', referentialsRoutes);
app.use('/api/objectives', objectivesRoutes);
app.use('/api/institutions', institutionsRoutes);
app.use('/api/missions', missionsRoutes);
app.use('/api/opportunities', opportunitiesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/notifications', notificationsRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ERP Remontada Prospectia API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  const status = err.status || 500;
  const message = status < 500 ? err.message : 'Erreur serveur interne.';
  res.status(status).json({ error: message });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route non trouvee : ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`ERP Remontada Prospectia API disponible sur le port ${PORT}`);
});

module.exports = app;
