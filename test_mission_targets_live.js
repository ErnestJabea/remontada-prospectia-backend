require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const API = `http://127.0.0.1:${process.env.PORT || 3002}/api/v1`;

async function main() {
  let missionId;
  let syncedMissionId;
  let temporaryInstitutionId;
  try {
    const [commercials] = await pool.query(
      `SELECT id, username, role, base_city_id
       FROM users
       WHERE role = 'COMMERCIAL' AND is_active = TRUE AND base_city_id IS NOT NULL
       ORDER BY id LIMIT 1`
    );
    assert.ok(commercials.length, 'Aucun commercial actif avec ville de rattachement.');
    const commercial = commercials[0];
    const [objectives] = await pool.query(
      `SELECT id FROM crm_objectives
       WHERE created_by = ? OR responsible_id = ?
       ORDER BY id LIMIT 1`,
      [commercial.id, commercial.id]
    );
    assert.ok(objectives.length, 'Aucun objectif accessible au commercial de test.');
    const [sameCityTargets] = await pool.query(
      `SELECT id, city_id FROM crm_institutions
       WHERE city_id = ? AND region_id IS NOT NULL AND department_id IS NOT NULL
       ORDER BY id LIMIT 1`,
      [commercial.base_city_id]
    );
    let [otherCityTargets] = await pool.query(
      `SELECT id, city_id FROM crm_institutions
       WHERE city_id <> ? AND city_id IS NOT NULL AND region_id IS NOT NULL AND department_id IS NOT NULL
       ORDER BY id LIMIT 1`,
      [commercial.base_city_id]
    );
    assert.ok(sameCityTargets.length, 'Une institution dans la ville de rattachement est nécessaire.');
    if (!otherCityTargets.length) {
      const [destinations] = await pool.query(
        `SELECT c.id AS city_id, d.id AS department_id, d.region_id
         FROM crm_ref_cities c
         JOIN crm_ref_departments d ON d.id = c.department_id
         WHERE c.id <> ? ORDER BY c.id LIMIT 1`,
        [commercial.base_city_id]
      );
      assert.ok(destinations.length, 'Une ville extérieure est nécessaire.');
      const destination = destinations[0];
      const [insert] = await pool.query(
        `INSERT INTO crm_institutions (name, type, region_id, department_id, city_id, notes, created_by)
         VALUES (?, 'PROSPECT', ?, ?, ?, 'Donnée temporaire de test automatique', ?)`,
        [`TEST INSTITUTION HORS VILLE ${Date.now()}`, destination.region_id, destination.department_id, destination.city_id, commercial.id]
      );
      temporaryInstitutionId = insert.insertId;
      otherCityTargets = [{ id: temporaryInstitutionId, city_id: destination.city_id }];
    }

    const token = jwt.sign(
      { id: commercial.id, username: commercial.username, role: commercial.role, clientType: 'mobile_pwa' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    const response = await fetch(`${API}/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        objective_id: objectives[0].id,
        title: `TEST TOURNEE MULTI-CIBLES ${Date.now()}`,
        description: 'Mission temporaire de validation automatique.',
        scheduled_date: '2026-09-18',
        duration_hours: 8,
        mission_type: 'PROSPECTION',
        strategic_objective: 'QUALIFIER_OPPORTUNITE',
        expected_result: 'Valider la tournée multi-cibles.',
        departure_at: '2026-09-18T07:00:00',
        return_at: '2026-09-18T20:00:00',
        transport_mode: 'SERVICE_VEHICLE',
        targets: [
          {
            institution_id: sameCityTargets[0].id,
            priority: 'HIGH',
            potential: 'MEDIUM',
            contact_name: 'Contact test local'
          },
          {
            institution_id: otherCityTargets[0].id,
            priority: 'MEDIUM',
            potential: 'HIGH',
            opportunity: {
              title: 'Opportunité test multi-cibles',
              need_description: 'Besoin temporaire de validation.',
              estimated_amount: 1500000,
              maturity: 'QUALIFIED'
            }
          }
        ]
      })
    });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    missionId = created.id;
    assert.equal(created.travel_scope, 'OUT_OF_CITY');
    assert.equal(created.targets.length, 2);

    const detailResponse = await fetch(`${API}/missions/${missionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200, JSON.stringify(detail));
    assert.equal(detail.targets.length, 2);
    assert.equal(detail.targets[1].opportunity.title, 'Opportunité test multi-cibles');
    assert.equal(detail.travel_scope, 'OUT_OF_CITY');
    const listResponse = await fetch(`${API}/missions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const missionList = await listResponse.json();
    const listedMission = missionList.find(item => Number(item.id) === Number(missionId));
    assert.equal(listResponse.status, 200, JSON.stringify(missionList));
    assert.equal(listedMission?.targets?.length, 2);
    await pool.query(
      "UPDATE crm_missions SET status = 'VALIDATED', gate1_validated_at = NOW(), gate1_validated_by = ? WHERE id = ?",
      [commercial.id, missionId]
    );
    const pdfResponse = await fetch(`${API}/missions/${missionId}/order.pdf`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const pdfBuffer = await pdfResponse.arrayBuffer();
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get('content-type') || '', /application\/pdf/);
    assert.ok(pdfBuffer.byteLength > 1000, 'Le PDF de tournée semble vide.');
    const pdfSource = Buffer.from(pdfBuffer).toString('latin1');
    const pageCount = (pdfSource.match(/\/Type\s*\/Page\b/g) || []).length;
    assert.equal(pageCount, 2, `Le PDF devrait contenir 2 pages utiles, reçu: ${pageCount}.`);

    const [[verificationData]] = await pool.query(
      'SELECT order_verification_token FROM crm_missions WHERE id = ?',
      [missionId]
    );
    const verificationUrl = `${API}/missions/${missionId}/order/verify?token=${encodeURIComponent(verificationData.order_verification_token)}`;
    const validVerificationResponse = await fetch(verificationUrl);
    const validVerificationHtml = await validVerificationResponse.text();
    assert.equal(validVerificationResponse.status, 200);
    assert.match(validVerificationHtml, /Ordre de mission valide/);
    assert.doesNotMatch(validVerificationHtml, /TEST TOURNEE MULTI-CIBLES/);
    assert.doesNotMatch(validVerificationHtml, /Contact test local/);

    const invalidVerificationResponse = await fetch(
      `${API}/missions/${missionId}/order/verify?token=${'0'.repeat(64)}`
    );
    assert.equal(invalidVerificationResponse.status, 404);

    await pool.query("UPDATE crm_missions SET status = 'CANCELLED' WHERE id = ?", [missionId]);
    const revokedVerificationResponse = await fetch(verificationUrl);
    const revokedVerificationHtml = await revokedVerificationResponse.text();
    assert.equal(revokedVerificationResponse.status, 410);
    assert.match(revokedVerificationHtml, /Ordre de mission révoqué/);
    await pool.query("UPDATE crm_missions SET status = 'VALIDATED' WHERE id = ?", [missionId]);

    const localId = `mission_local_${Date.now()}`;
    const syncResponse = await fetch(`${API}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        actions: [{
          id: localId,
          action: 'create',
          type: 'mission',
          payload: {
            id: localId,
            client_request_id: crypto.randomUUID(),
            objective_id: objectives[0].id,
            title: `TEST SYNC TOURNEE ${Date.now()}`,
            scheduled_date: '2026-09-19',
            mission_type: 'PROSPECTION',
            strategic_objective: 'IDENTIFIER_BESOIN',
            expected_result: 'Valider la synchronisation multi-cibles.',
            departure_at: '2026-09-19T07:00:00',
            return_at: '2026-09-19T20:00:00',
            transport_mode: 'PUBLIC_TRANSPORT',
            targets: [
              { institution_id: sameCityTargets[0].id, priority: 'HIGH' },
              {
                institution_id: otherCityTargets[0].id,
                potential: 'HIGH',
                opportunity: {
                  title: 'Opportunité synchronisée',
                  need_description: 'Besoin temporaire hors ligne.',
                  estimated_amount: 750000
                }
              }
            ]
          }
        }]
      })
    });
    const syncResult = await syncResponse.json();
    assert.equal(syncResponse.status, 200, JSON.stringify(syncResult));
    assert.equal(syncResult.results?.[0]?.status, 'success', JSON.stringify(syncResult));
    syncedMissionId = syncResult.results[0].serverId;
    assert.equal(syncResult.results[0].serverData.targets.length, 2);
    console.log(`Validation HTTP réussie: API #${missionId}, PDF 2 pages, vérification QR valide/invalide/révoquée et synchro hors ligne #${syncedMissionId}.`);
  } finally {
    if (missionId) await pool.query('DELETE FROM crm_missions WHERE id = ?', [missionId]);
    if (syncedMissionId) await pool.query('DELETE FROM crm_missions WHERE id = ?', [syncedMissionId]);
    if (temporaryInstitutionId) await pool.query('DELETE FROM crm_institutions WHERE id = ?', [temporaryInstitutionId]);
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
