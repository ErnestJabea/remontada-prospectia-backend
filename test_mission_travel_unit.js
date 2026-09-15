const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMissionTravel } = require('./services/missionTravelService');

function fakeConnection(baseCityId = 1) {
  return {
    async query(sql, params = []) {
      if (sql.includes('FROM users u')) {
        return [[{ id: 3, base_city_id: baseCityId, base_city_name: 'Yaoundé' }]];
      }
      if (sql.includes('FROM crm_ref_cities')) {
        const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
        return [ids.map(id => ({ id, name: Number(id) === 1 ? 'Yaoundé' : 'Douala' }))];
      }
      throw new Error(`Requête inattendue: ${sql}`);
    }
  };
}

test('classe automatiquement une mission dans la ville', async () => {
  const result = await resolveMissionTravel(fakeConnection(1), 3, 1, {});
  assert.equal(result.travel_scope, 'IN_CITY');
  assert.equal(result.base_city_id, 1);
  assert.equal(result.departure_at, null);
  assert.equal(result.estimated_travel_cost, 0);
});

test('classe automatiquement une mission hors de la ville', async () => {
  const result = await resolveMissionTravel(fakeConnection(1), 3, 2, {
    departure_at: '2026-09-10T08:00:00',
    return_at: '2026-09-11T18:00:00',
    transport_mode: 'PUBLIC_TRANSPORT',
    accommodation_required: true,
    estimated_travel_cost: 75000
  });
  assert.equal(result.travel_scope, 'OUT_OF_CITY');
  assert.equal(result.transport_mode, 'PUBLIC_TRANSPORT');
  assert.equal(result.accommodation_required, true);
  assert.equal(result.estimated_travel_cost, 75000);
});

test('refuse une mission hors ville sans organisation du déplacement', async () => {
  await assert.rejects(
    () => resolveMissionTravel(fakeConnection(1), 3, 2, {}),
    error => error.status === 400 && /départ et de retour/.test(error.message)
  );
});

test('refuse la création si la ville de rattachement est absente', async () => {
  await assert.rejects(
    () => resolveMissionTravel(fakeConnection(null), 3, 2, {}),
    error => error.status === 422 && /ville de rattachement/.test(error.message)
  );
});

test('classe toute la tournée hors ville si une seule cible quitte la ville de rattachement', async () => {
  const result = await resolveMissionTravel(fakeConnection(1), 3, [1, 2], {
    departure_at: '2026-09-10T08:00:00',
    return_at: '2026-09-11T18:00:00',
    transport_mode: 'SERVICE_VEHICLE'
  });
  assert.equal(result.travel_scope, 'OUT_OF_CITY');
  assert.deepEqual(result.destination_city_names, ['Yaoundé', 'Douala']);
});
