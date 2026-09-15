const assert = require('assert');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = require('./server');
const pool = require('./db');

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function run() {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.headers.get('x-api-version'), '1');
    assert.match(health.headers.get('cache-control') || '', /no-store/);
    assert.strictEqual(health.headers.get('x-powered-by'), null);

    const legacyHealth = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(legacyHealth.status, 200);
    assert.strictEqual(legacyHealth.headers.get('deprecation'), 'true');
    assert.match(legacyHealth.headers.get('link') || '', /\/api\/v1/);

    const unsupportedVersion = await fetch(`${baseUrl}/api/v2/health`);
    assert.strictEqual(unsupportedVersion.status, 404);
    assert.strictEqual((await readJson(unsupportedVersion)).code, 'API_VERSION_UNSUPPORTED');

    const privateRequests = [
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/referentials/countries'],
      ['GET', '/api/v1/objectives'],
      ['GET', '/api/v1/institutions'],
      ['GET', '/api/v1/missions'],
      ['GET', '/api/v1/opportunities'],
      ['GET', '/api/v1/reports'],
      ['POST', '/api/v1/sync/push'],
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/security/active-users'],
      ['GET', '/api/v1/permissions/catalogue']
    ];
    for (const [method, path] of privateRequests) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined
      });
      assert.strictEqual(response.status, 401, `${method} ${path} doit etre prive`);
      assert.strictEqual((await readJson(response)).code, 'AUTHENTICATION_REQUIRED');
    }

    const malformedJson = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    });
    assert.strictEqual(malformedJson.status, 400);
    const malformedBody = await readJson(malformedJson);
    assert.strictEqual(malformedBody.code, 'INVALID_JSON');
    assert.ok(malformedBody.requestId);

    const unsupportedMedia = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'username=test'
    });
    assert.strictEqual(unsupportedMedia.status, 415);

    const repeatedQuery = await fetch(`${baseUrl}/api/v1/health?probe=1&probe=2`);
    assert.strictEqual(repeatedQuery.status, 400);

    const badOrigin = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: 'https://attacker.invalid' }
    });
    assert.strictEqual(badOrigin.status, 403);

    const [[commercial]] = await pool.query(
      `SELECT id, username, role
       FROM users
       WHERE role = 'COMMERCIAL' AND is_active = TRUE
       ORDER BY id
       LIMIT 1`
    );
    assert.ok(commercial, 'Un commercial actif est requis pour le test');
    const mobileToken = jwt.sign(
      { id: commercial.id, username: commercial.username, role: commercial.role, clientType: 'mobile_pwa' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' }
    );
    const webToken = jwt.sign(
      { id: commercial.id, username: commercial.username, role: commercial.role, clientType: 'web_portal' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' }
    );

    const ownProfile = await fetch(`${baseUrl}/api/v1/users/${commercial.id}`, {
      headers: { Authorization: `Bearer ${mobileToken}` }
    });
    assert.strictEqual(ownProfile.status, 200);

    const commercialDirectory = await fetch(`${baseUrl}/api/v1/users/commercials`, {
      headers: { Authorization: `Bearer ${mobileToken}` }
    });
    assert.strictEqual(commercialDirectory.status, 403);

    const wrongChannel = await fetch(`${baseUrl}/api/v1/users/${commercial.id}`, {
      headers: { Authorization: `Bearer ${webToken}` }
    });
    assert.strictEqual(wrongChannel.status, 401);

    const csrfBlocked = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: `crm_access=${webToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.strictEqual(csrfBlocked.status, 403);

    const [validMissions] = await pool.query(
      `SELECT id, order_verification_token
       FROM crm_missions
       WHERE gate1_validated_at IS NOT NULL
         AND order_verification_token IS NOT NULL
         AND status IN ('PLANNED', 'IN_PROGRESS', 'REPORT_PENDING', 'REPORT_SUBMITTED', 'COMPLETED')
       ORDER BY id
       LIMIT 1`
    );
    if (validMissions.length) {
      const mission = validMissions[0];
      const verification = await fetch(
        `${baseUrl}/api/v1/missions/${mission.id}/order/verify?token=${encodeURIComponent(mission.order_verification_token)}`
      );
      assert.strictEqual(verification.status, 200);
      assert.match(await verification.text(), /Ordre de mission valide/);
    }

    console.log('Securite API validee: version v1, legacy deprecie, 11 modules prives, CORS, CSRF, contenus, canaux JWT et QR public.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
