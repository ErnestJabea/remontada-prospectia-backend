const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMissionTargets } = require('./services/missionTargetService');

function fakeConnection() {
  return {
    async query(sql, params) {
      if (!sql.includes('FROM crm_institutions i')) throw new Error(`Requête inattendue: ${sql}`);
      const ids = params[0];
      return [ids.map(id => ({
        id,
        name: id === 1 ? 'Institution Yaoundé' : 'Institution Douala',
        region_id: 1,
        department_id: id,
        city_id: id,
        city_name: id === 1 ? 'Yaoundé' : 'Douala',
        department_name: 'Département',
        region_name: 'Centre'
      }))];
    }
  };
}

test('normalise plusieurs cibles et une opportunité propre à une cible', async () => {
  const targets = await normalizeMissionTargets(fakeConnection(), [
    { institution_id: 1, priority: 'HIGH', contact_name: 'Mme A' },
    {
      institution_id: 2,
      potential: 'HIGH',
      opportunity: {
        title: 'Archives numériques',
        need_description: 'Numériser le fonds documentaire',
        estimated_amount: 25000000,
        maturity: 'QUALIFIED'
      }
    }
  ]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].visit_order, 1);
  assert.equal(targets[1].visit_order, 2);
  assert.equal(targets[1].opportunity.title, 'Archives numériques');
  assert.equal(targets[1].opportunity.maturity, 'QUALIFIED');
});

test('refuse une institution dupliquée dans la même tournée', async () => {
  await assert.rejects(
    () => normalizeMissionTargets(fakeConnection(), [{ institution_id: 1 }, { institution_id: 1 }]),
    error => error.status === 400 && /qu’une fois/.test(error.message)
  );
});

test('conserve la compatibilité avec une ancienne mission à cible unique', async () => {
  const targets = await normalizeMissionTargets(fakeConnection(), null, {
    institution_id: 1,
    target_decision_maker: 'M. Décideur'
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].contact_name, 'M. Décideur');
  assert.equal(targets[0].contact_role, 'DECIDEUR_PRINCIPAL');
});
