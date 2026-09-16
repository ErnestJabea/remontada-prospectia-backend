const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { authenticate } = require('./middleware/auth');
const { requireFeature } = require('./middleware/featureAccess');
const {
  API_VERSION,
  apiError,
  apiRequestContext,
  apiVersionHeaders,
  validateApiRequest
} = require('./middleware/apiSecurity');

const app = express();
const PORT = process.env.PORT || 3002;
const isProduction = process.env.NODE_ENV === 'production';
const API_HOST = process.env.API_HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
const configuredProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
const bodyLimit = /^\d+(?:kb|mb)$/i.test(process.env.API_BODY_LIMIT || '')
  ? process.env.API_BODY_LIMIT
  : '512kb';

app.set('trust proxy', Number.isInteger(configuredProxyHops) && configuredProxyHops > 0
  ? configuredProxyHops
  : false);
app.set('query parser', 'simple');

for (const requiredSecret of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
  if (!process.env[requiredSecret] || process.env[requiredSecret].length < 32) {
    throw new Error(`${requiredSecret} doit contenir au moins 32 caracteres.`);
  }
}

const allowedOrigins = [
  process.env.ALLOWED_ORIGINS,
  process.env.FRONTEND_ORIGINS
]
  .filter(Boolean)
  .join(',')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
  .filter((origin, index, origins) => origins.indexOf(origin) === index);

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use('/api', apiRequestContext);
app.use(cookieParser());
app.use(express.json({ limit: bodyLimit, strict: true }));
app.use(express.urlencoded({ extended: false, limit: bodyLimit, parameterLimit: 100 }));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    const error = new Error('Origine non autorisee.');
    error.status = 403;
    return callback(error);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID', 'X-API-Version', 'Deprecation', 'Link', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 600,
  optionsSuccessStatus: 204
}));

app.use('/api', validateApiRequest);

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

const disableApiRateLimit = process.env.API_RATE_LIMIT_DISABLED === 'true' || process.env.DISABLE_RATE_LIMIT === 'true';
if (isProduction && disableApiRateLimit) {
  throw new Error('Le rate limiting ne peut pas etre desactive en production.');
}
if (disableApiRateLimit) {
  console.warn('[SECURITY] Rate limiting API desactive via API_RATE_LIMIT_DISABLED=true.');
} else {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requetes. Reessayez dans 15 minutes.' }
  });

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

  app.use('/api/', limiter);
  app.use(['/api/v1/auth/login', '/api/auth/login'], loginLimiter);
  app.use(['/api/v1/auth/verify-mfa', '/api/auth/verify-mfa'], loginLimiter);
  app.use(['/api/v1/auth/resend-mfa', '/api/auth/resend-mfa'], loginLimiter);
  app.use(['/api/v1/auth/forgot-password', '/api/auth/forgot-password'], passwordResetLimiter);
  app.use(['/api/v1/auth/reset-password', '/api/auth/reset-password'], passwordResetLimiter);
}

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
const securityRoutes = require('./routes/security');
const permissionsRoutes = require('./routes/permissions');

function healthHandler(req, res) {
  res.json({
    status: 'ok',
    service: 'ERP Remontada Prospectia API',
    apiVersion: API_VERSION,
    serviceVersion: require('./package.json').version,
    timestamp: new Date().toISOString(),
    port: PORT
  });
}

function createApiRouter({ deprecated = false } = {}) {
  const router = express.Router();
  router.use(apiVersionHeaders({ deprecated }));
  router.get('/health', healthHandler);
  router.use('/auth', authRoutes);

  // Toutes les ressources metier sont privees par defaut. La page de controle
  // d'un ordre reste publique car son jeton aleatoire fait office de preuve.
  router.use((req, res, next) => {
    const publicMissionVerification = req.method === 'GET' &&
      /^\/missions\/\d+\/order\/verify$/.test(req.path);
    if (publicMissionVerification) return next();
    return authenticate(req, res, next);
  });

  router.use('/users', requireFeature('users'), usersRoutes);
  router.use('/referentials', requireFeature('referentials'), referentialsRoutes);
  router.use('/objectives', requireFeature('objectives'), objectivesRoutes);
  router.use('/institutions', requireFeature('institutions'), institutionsRoutes);
  router.use('/missions', (req,res,next) => !req.user && req.method === 'GET' && /^\/\d+\/order\/verify$/.test(req.path) ? next() : requireFeature('missions')(req,res,next), missionsRoutes);
  router.use('/opportunities', requireFeature('opportunities'), opportunitiesRoutes);
  router.use('/reports', requireFeature('reports'), reportsRoutes);
  router.use('/sync', syncRoutes);
  router.use('/notifications', notificationsRoutes);
  router.use('/security', requireFeature('security'), securityRoutes);
  router.use('/permissions', permissionsRoutes);
  router.use('/analytics', require('./routes/analytics'));
  return router;
}

app.use('/api/v1', createApiRouter());
const legacyApiRouter = createApiRouter({ deprecated: true });
app.use('/api', (req, res, next) => {
  if (/^\/v\d+(?:\/|$)/.test(req.path)) {
    return apiError(res, 404, 'API_VERSION_UNSUPPORTED', 'Version d\'API inexistante ou non prise en charge.');
  }
  return legacyApiRouter(req, res, next);
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const malformedJson = err instanceof SyntaxError && err.type === 'entity.parse.failed';
  const resolvedStatus = malformedJson ? 400 : status;
  if (resolvedStatus >= 500) {
    console.error(`[ERROR][${req.requestId || 'sans-request-id'}]`, err);
  } else {
    console.warn(`[REQUEST_REJECTED][${req.requestId || 'sans-request-id'}] status=${resolvedStatus}`);
  }
  const message = malformedJson
    ? 'Corps JSON invalide.'
    : (resolvedStatus < 500 ? err.message : 'Erreur serveur interne.');
  return apiError(
    res,
    resolvedStatus,
    malformedJson ? 'INVALID_JSON' : (err.code || 'REQUEST_FAILED'),
    message
  );
});

app.use((req, res) => {
  return apiError(res, 404, 'ROUTE_NOT_FOUND', `Route non trouvee : ${req.method} ${req.path}`);
});

if (require.main === module) {
  const server = app.listen(PORT, API_HOST);
  server.once('listening', () => {
    require('./utils/notificationDelivery').startDeliveryWorker();
    console.log(`ERP Remontada Prospectia API v${API_VERSION} disponible sur ${API_HOST}:${PORT}`);
  });
  server.once('error', error => {
    console.error(`Impossible de lancer l'API sur ${API_HOST}:${PORT}: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = app;
