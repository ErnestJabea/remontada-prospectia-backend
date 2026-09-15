const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProposal, objectiveNatureFromKpiType } = require('./services/objectiveProposalService');

function validPayload(overrides = {}) {
  return {
    client_request_id: '7b5f1e2d-ec35-4be9-a911-ef8ad2558872',
    title: 'Obtenir dix rendez-vous qualifiés',
    description: 'Qualifier dix prospects institutionnels pendant la période.',
    domain_id: 1,
    kpi_id: 2,
    period_type: 'MONTHLY',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    target_value: 10,
    ...overrides
  };
}

test('normalise une proposition terrain et calcule les seuils par défaut', () => {
  const result = normalizeProposal(validPayload({
    responsible_id: 999,
    team_member_ids: [999]
  }));

  assert.equal(result.target_value, 10);
  assert.equal(result.min_level, 8);
  assert.equal(result.expected_level, 10);
  assert.equal(result.excellent_level, 12);
  assert.equal(Object.hasOwn(result, 'responsible_id'), false);
  assert.equal(Object.hasOwn(result, 'team_member_ids'), false);
});

test('refuse une cible nulle', () => {
  assert.throws(
    () => normalizeProposal(validPayload({ target_value: 0 })),
    /strictement positif/
  );
});

test('refuse une période inversée', () => {
  assert.throws(
    () => normalizeProposal(validPayload({ start_date: '2026-10-01', end_date: '2026-09-30' })),
    /date de début ne peut pas être supérieure/
  );
});

test('refuse des seuils incohérents', () => {
  assert.throws(
    () => normalizeProposal(validPayload({ min_level: 11, expected_level: 10, excellent_level: 12 })),
    /minimum ≤ attendu ≤ excellent/
  );
});

test('déduit une proposition qualitative du type du KPI sans cible numérique', () => {
  const result = normalizeProposal(validPayload({
    target_value: null,
    target_qlty: 'Obtenir un accord de principe documenté.',
    qualitative_criteria: ['Besoin confirmé', 'Prochaine étape acceptée']
  }), 'QUALITATIVE');

  assert.equal(result.objective_nature, 'QUALITATIVE');
  assert.equal(result.target_value, null);
  assert.equal(result.target_qlty, 'Obtenir un accord de principe documenté.');
  assert.deepEqual(result.qualitative_criteria, ['Besoin confirmé', 'Prochaine étape acceptée']);
});

test('refuse un objectif qualitatif sans critère observable', () => {
  assert.throws(
    () => normalizeProposal(validPayload({
      target_value: null,
      target_qlty: 'Améliorer la qualité de la relation.',
      qualitative_criteria: []
    }), 'QUALITATIVE'),
    /critère de réussite qualitatif/
  );
});

test('ne confond pas un KPI manuel numérique avec un KPI qualitatif', () => {
  assert.equal(objectiveNatureFromKpiType('MANUAL'), 'QUANTITATIVE');
  assert.equal(objectiveNatureFromKpiType('QUALITATIVE'), 'QUALITATIVE');
});

test('ignore une nature envoyée par le client et conserve celle du KPI', () => {
  const result = normalizeProposal(validPayload({
    objective_nature: 'QUALITATIVE',
    target_qlty: 'Valeur injectée côté client',
    qualitative_criteria: ['Critère injecté']
  }), 'QUANTITATIVE');

  assert.equal(result.objective_nature, 'QUANTITATIVE');
  assert.equal(result.target_qlty, null);
  assert.equal(result.target_value, 10);
});
