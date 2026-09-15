const TRAVEL_SCOPES = new Set(['IN_CITY', 'OUT_OF_CITY']);
const TRANSPORT_MODES = new Set([
  'SERVICE_VEHICLE',
  'PERSONAL_VEHICLE',
  'PUBLIC_TRANSPORT',
  'AIR',
  'OTHER'
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toPositiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function toNullableDate(value, label) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label} invalide.`);
  return date;
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function validateBaseCity(connection, cityIdValue, required = false) {
  const cityId = toPositiveId(cityIdValue);
  if (!cityId) {
    if (required) throw httpError(400, 'La ville de rattachement du commercial est obligatoire.');
    return null;
  }
  const [rows] = await connection.query('SELECT id, name FROM crm_ref_cities WHERE id = ? LIMIT 1', [cityId]);
  if (!rows.length) throw httpError(400, 'Ville de rattachement invalide.');
  return rows[0];
}

async function resolveMissionTravel(connection, primaryCommercialIdValue, destinationCityIdValue, payload = {}) {
  const primaryCommercialId = toPositiveId(primaryCommercialIdValue);
  const rawDestinationIds = Array.isArray(destinationCityIdValue) ? destinationCityIdValue : [destinationCityIdValue];
  const destinationCityIds = [...new Set(rawDestinationIds.map(toPositiveId).filter(Boolean))];
  if (!primaryCommercialId || !destinationCityIds.length) throw httpError(400, 'Commercial ou ville de destination invalide.');

  const [users] = await connection.query(
    `SELECT u.id, u.base_city_id, base.name AS base_city_name
     FROM users u
     LEFT JOIN crm_ref_cities base ON base.id = u.base_city_id
     WHERE u.id = ? AND u.role = 'COMMERCIAL' AND u.is_active = TRUE
     LIMIT 1`,
    [primaryCommercialId]
  );
  if (!users.length) throw httpError(400, 'Commercial principal invalide ou inactif.');
  if (!users[0].base_city_id) {
    throw httpError(422, 'La ville de rattachement du commercial doit être configurée avant de créer une mission.');
  }

  const [destinations] = await connection.query('SELECT id, name FROM crm_ref_cities WHERE id IN (?)', [destinationCityIds]);
  if (destinations.length !== destinationCityIds.length) throw httpError(400, 'Ville de destination invalide.');

  const travelScope = destinationCityIds.every(cityId => Number(users[0].base_city_id) === cityId)
    ? 'IN_CITY'
    : 'OUT_OF_CITY';
  if (!TRAVEL_SCOPES.has(travelScope)) throw httpError(400, 'Type géographique de mission invalide.');

  if (travelScope === 'IN_CITY') {
    return {
      base_city_id: users[0].base_city_id,
      base_city_name: users[0].base_city_name,
      destination_city_name: destinations[0].name,
      destination_city_names: destinations.map(item => item.name),
      travel_scope: travelScope,
      departure_at: null,
      return_at: null,
      transport_mode: null,
      accommodation_required: false,
      estimated_travel_cost: 0
    };
  }

  const departureAt = toNullableDate(payload.departure_at, 'Date de départ');
  const returnAt = toNullableDate(payload.return_at, 'Date de retour');
  if (!departureAt || !returnAt) {
    throw httpError(400, 'Les dates de départ et de retour sont obligatoires pour une mission hors de la ville.');
  }
  if (returnAt < departureAt) throw httpError(400, 'La date de retour doit être postérieure à la date de départ.');

  const transportMode = String(payload.transport_mode || '').trim().toUpperCase();
  if (!TRANSPORT_MODES.has(transportMode)) {
    throw httpError(400, 'Le moyen de transport est obligatoire pour une mission hors de la ville.');
  }
  const estimatedTravelCost = Number(payload.estimated_travel_cost || 0);
  if (!Number.isFinite(estimatedTravelCost) || estimatedTravelCost < 0 || estimatedTravelCost > 1000000000) {
    throw httpError(400, 'Le coût estimatif du déplacement est invalide.');
  }

  return {
    base_city_id: users[0].base_city_id,
    base_city_name: users[0].base_city_name,
    destination_city_name: destinations[0].name,
    destination_city_names: destinations.map(item => item.name),
    travel_scope: travelScope,
    departure_at: departureAt,
    return_at: returnAt,
    transport_mode: transportMode,
    accommodation_required: toBoolean(payload.accommodation_required),
    estimated_travel_cost: estimatedTravelCost
  };
}

function travelScopeLabel(scope) {
  return scope === 'OUT_OF_CITY' ? 'Hors de la ville' : 'Dans la ville';
}

module.exports = {
  resolveMissionTravel,
  validateBaseCity,
  travelScopeLabel,
  TRAVEL_SCOPES,
  TRANSPORT_MODES
};
