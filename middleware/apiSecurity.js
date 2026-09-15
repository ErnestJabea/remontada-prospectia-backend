const crypto = require('crypto');

const API_VERSION = '1';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

function apiError(res, status, code, message) {
  return res.status(status).json({
    error: message,
    code,
    requestId: res.req?.requestId || null,
    apiVersion: API_VERSION
  });
}

function hasDangerousStructure(value, depth = 0) {
  if (depth > 20) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value) && value.length > 1000) return true;

  return Object.keys(value).some(key => (
    DANGEROUS_KEYS.has(key) || hasDangerousStructure(value[key], depth + 1)
  ));
}

function apiRequestContext(req, res, next) {
  const incomingRequestId = req.get('x-request-id');
  req.requestId = REQUEST_ID_PATTERN.test(incomingRequestId || '')
    ? incomingRequestId
    : crypto.randomUUID();

  res.setHeader('X-Request-ID', req.requestId);
  res.setHeader('X-API-Version', API_VERSION);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function validateApiRequest(req, res, next) {
  if (req.originalUrl.length > 2048) {
    return apiError(res, 414, 'URI_TOO_LONG', 'URI de requete trop longue.');
  }

  if (!ALLOWED_METHODS.has(req.method)) {
    res.setHeader('Allow', [...ALLOWED_METHODS].join(', '));
    return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Methode HTTP non autorisee.');
  }

  if (req.body === undefined) req.body = {};

  const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding');
  if (BODY_METHODS.has(req.method) && hasBody) {
    const supportedType = req.is([
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data'
    ]);
    if (!supportedType) {
      return apiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Type de contenu non pris en charge.');
    }
  }

  if (Object.values(req.query || {}).some(value => Array.isArray(value))) {
    return apiError(res, 400, 'AMBIGUOUS_QUERY', 'Un parametre de requete ne peut pas etre repete.');
  }

  if (hasDangerousStructure(req.query) || hasDangerousStructure(req.body)) {
    return apiError(res, 400, 'INVALID_PAYLOAD', 'Structure de requete non autorisee.');
  }

  next();
}

function apiVersionHeaders({ deprecated = false } = {}) {
  return (req, res, next) => {
    res.setHeader('X-API-Version', API_VERSION);
    if (deprecated) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Warning', '299 - "API non versionnee depreciee; utilisez /api/v1"');
      res.setHeader('Link', '</api/v1>; rel="successor-version"');
    }
    next();
  };
}

module.exports = {
  API_VERSION,
  apiError,
  apiRequestContext,
  apiVersionHeaders,
  validateApiRequest
};
