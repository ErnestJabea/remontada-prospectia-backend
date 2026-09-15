const express = require('express');
const router = express.Router();
const pool = require('../db');
const crypto = require('node:crypto');
const { assertFeature } = require('../middleware/featureAccess');
const OpportunityWorkflowService = require('../services/OpportunityWorkflowService');
const { authenticate } = require('../middleware/auth');
const { notifyDirection } = require('../utils/notifications');
const {
  createObjectiveProposal,
  updateObjectiveProposal,
  submitObjectiveProposal,
  deleteObjectiveProposal
} = require('../services/objectiveProposalService');
const { resolveMissionTravel } = require('../services/missionTravelService');
const {
  ensureMissionTargetTables,
  normalizeMissionTargets,
  upsertMissionTargets
} = require('../services/missionTargetService');

const SYNC_REPORT_STATUSES = new Set(['A_COMPLETER', 'SOUMIS']);
const SYNC_OPPORTUNITY_EDITABLE_STATUSES = new Set(['DETECTED', 'TO_CORRECT']);
const SYNC_OPPORTUNITY_SUBMIT_STATUSES = new Set(['DETECTED', 'TO_CORRECT']);
const SYNC_OPPORTUNITY_STAGES = new Set(['DETECTION', 'QUALIFICATION', 'ANALYSE']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizePriority(value, fallback = 'MEDIUM') {
  return PRIORITIES.has(value) ? value : fallback;
}

function normalizeReportStatus(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'SUBMITTED') return 'SOUMIS';
  return SYNC_REPORT_STATUSES.has(status) ? status : 'A_COMPLETER';
}

function normalizeOpportunityStage(value, fallback = 'DETECTION') {
  const stage = String(value || fallback).toUpperCase();
  return SYNC_OPPORTUNITY_STAGES.has(stage) ? stage : fallback;
}

function normalizeOpportunityStatus(value, currentStatus) {
  const status = String(value || '').toUpperCase();
  if (status === 'SUBMITTED' && SYNC_OPPORTUNITY_SUBMIT_STATUSES.has(currentStatus)) return 'SUBMITTED';
  return currentStatus;
}

function serializeList(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(String).map(item => item.trim()).filter(Boolean));
  if (!value) return JSON.stringify([]);
  return JSON.stringify(String(value).split('\n').map(item => item.trim()).filter(Boolean));
}

function normalizeClientRequestId(value) {
  const normalized = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

async function createSyncedMission(payload, user, localToServerIdMap, clientRequestId) {
  const resolvedObjectiveId = localToServerIdMap.get(payload.objective_id) || positiveId(payload.objective_id);
  if (!resolvedObjectiveId) {
    throw Object.assign(new Error('Objectif rattaché invalide.'), { status: 400 });
  }
  const rawTargets = Array.isArray(payload.targets)
    ? payload.targets.map(target => ({
        ...target,
        institution_id: localToServerIdMap.get(target.institution_id) || target.institution_id
      }))
    : null;
  const fallbackInstitutionId = localToServerIdMap.get(payload.institution_id) || positiveId(payload.institution_id);
  const title = String(payload.title || '').trim().slice(0, 150);
  if (!title || !payload.scheduled_date) {
    throw Object.assign(new Error('Le titre et la date prévue de la mission sont obligatoires.'), { status: 400 });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureMissionTargetTables(connection);
    const [objectives] = await connection.query(
      `SELECT id FROM crm_objectives
       WHERE id = ? AND (created_by = ? OR responsible_id = ?)
       LIMIT 1`,
      [resolvedObjectiveId, user.id, user.id]
    );
    if (!objectives.length) throw Object.assign(new Error('Objectif rattaché non autorisé.'), { status: 403 });

    const normalizedTargets = await normalizeMissionTargets(connection, rawTargets, {
      ...payload,
      institution_id: fallbackInstitutionId
    });
    const primaryTarget = normalizedTargets[0];
    const travel = await resolveMissionTravel(
      connection,
      user.id,
      normalizedTargets.map(target => target.city_id),
      payload
    );
    const initialStatus = String(payload.status || '').toUpperCase() === 'SUBMITTED' || payload.submit_requested
      ? 'SUBMITTED'
      : 'DRAFT';
    const [insert] = await connection.query(
      `INSERT INTO crm_missions (
        client_request_id, objective_id, institution_id, title, description, scheduled_date,
        duration_hours, primary_commercial_id, region_id, department_id, city_id,
        base_city_id, travel_scope, departure_at, return_at, transport_mode,
        accommodation_required, estimated_travel_cost, mission_type, strategic_objective,
        expected_result, target_contacts, need_hypotheses, key_questions, key_messages,
        risks, planned_measures, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientRequestId, resolvedObjectiveId, primaryTarget.institution_id, title,
        payload.description || payload.expected_result || null, payload.scheduled_date,
        Math.min(Math.max(Number(payload.duration_hours) || 2, 1), 72), user.id,
        primaryTarget.region_id, primaryTarget.department_id, primaryTarget.city_id,
        travel.base_city_id, travel.travel_scope, travel.departure_at,
        travel.return_at, travel.transport_mode, travel.accommodation_required,
        travel.estimated_travel_cost, payload.mission_type || 'PROSPECTION',
        payload.strategic_objective || 'IDENTIFIER_BESOIN', payload.expected_result || null,
        serializeList(payload.target_contacts || payload.target_actors),
        serializeList(payload.need_hypotheses), serializeList(payload.key_questions || payload.critical_questions),
        serializeList(payload.key_messages), serializeList(payload.risks || payload.risk_flags),
        payload.planned_measures || payload.mitigation_plan || null, initialStatus
      ]
    );
    const serverId = insert.insertId;
    const missionReference = `MIS-${new Date().getFullYear()}-${String(serverId).padStart(5, '0')}`;
    await connection.query('UPDATE crm_missions SET mission_reference = ? WHERE id = ?', [missionReference, serverId]);
    await upsertMissionTargets(connection, serverId, normalizedTargets);
    await connection.commit();
    return { serverId, missionReference, travel, title, initialStatus, targets: normalizedTargets };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function commercialCanSyncMission(connection, missionId, userId) {
  const id = positiveId(missionId);
  if (!id) return false;
  const [rows] = await connection.query(
    `SELECT id
     FROM crm_missions
     WHERE id = ?
       AND (
         primary_commercial_id = ?
         OR EXISTS (
           SELECT 1 FROM crm_mission_associates ma
           WHERE ma.mission_id = crm_missions.id AND ma.user_id = ?
         )
       )
     LIMIT 1`,
    [id, userId, userId]
  );
  return rows.length > 0;
}

async function getOwnedReport(connection, reportId, userId) {
  const id = positiveId(reportId);
  if (!id) return null;
  const [rows] = await connection.query(
    `SELECT r.*
     FROM crm_reports r
     LEFT JOIN crm_missions m ON m.id = r.mission_id
     WHERE r.id = ?
       AND (
         r.commercial_id = ?
         OR m.primary_commercial_id = ?
         OR EXISTS (
           SELECT 1 FROM crm_mission_associates ma
           WHERE ma.mission_id = m.id AND ma.user_id = ?
         )
       )
     LIMIT 1`,
    [id, userId, userId, userId]
  );
  return rows[0] || null;
}

// POST /api/sync/push - Synchronisation depuis la PWA mobile
router.post('/push', authenticate, async (req, res) => {
  if (req.user.role !== 'COMMERCIAL') {
    return res.status(403).json({ error: 'Synchronisation reservee aux comptes commerciaux terrain.' });
  }

  const { actions } = req.body;
  if (!Array.isArray(actions)) {
    return res.status(400).json({ error: 'Actions de synchronisation manquantes ou invalides.' });
  }
  if (actions.length > 100) {
    return res.status(413).json({ error: 'Maximum 100 actions par synchronisation.' });
  }

  const results = [];
  const syncHistoryDetails = [];
  let successCount = 0;
  let conflictCount = 0;
  let errorCount = 0;
  const localToServerIdMap = new Map();
  const [knownMappings] = await pool.query('SELECT local_aliases,result_json FROM crm_sync_receipts WHERE user_id=? AND local_aliases IS NOT NULL',[req.user.id]);
  for (const row of knownMappings) {
    const aliases = typeof row.local_aliases === 'string' ? JSON.parse(row.local_aliases) : row.local_aliases;
    const result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
    if (result.serverId) for (const alias of aliases) localToServerIdMap.set(alias,result.serverId);
  }

  for (const actionItem of actions) {
    const { id: localId, action, type, payload } = actionItem || {};
    const resultOffset = results.length;
    const previousCounts = [successCount,conflictCount,errorCount];
    const previousMap = new Map(localToServerIdMap);
    try {
      const feature = {prospect:'institutions',objective:'objectives',mission:'missions',report:'reports',opportunity:'opportunities'}[type];
      if (feature) assertFeature(req.user,feature, action === 'create' ? 'can_create' : action === 'delete' ? 'can_delete' : 'can_update');
      if (typeof localId !== 'string' || localId.length > 120 || !payload || typeof payload !== 'object') throw Object.assign(new Error('Action de synchronisation invalide.'),{status:400});
      await pool.withTransaction(async () => {
        await pool.query('SELECT id FROM users WHERE id=? FOR UPDATE',[req.user.id]);
        const hash = crypto.createHash('sha256').update(JSON.stringify({action,type,payload})).digest('hex');
        const [[receipt]] = await pool.query('SELECT payload_hash,result_json FROM crm_sync_receipts WHERE user_id=? AND request_id=? FOR UPDATE',[req.user.id,localId]);
        if (receipt) {
          if (receipt.payload_hash !== hash) throw Object.assign(new Error('Identifiant de synchronisation réutilisé pour un contenu différent.'),{status:409});
          const saved = typeof receipt.result_json === 'string' ? JSON.parse(receipt.result_json) : receipt.result_json;
          results.push(saved); successCount++;
          if (saved.serverId) { localToServerIdMap.set(localId,saved.serverId); if(payload.id)localToServerIdMap.set(payload.id,saved.serverId); }
          return;
        }
        const aliases = action === 'create' ? [localId,payload.id,payload.client_id].filter(Boolean).map(String) : [];
        const offset = results.length;
        await (async () => {
      if (type === 'prospect') {
        if (action === 'create') {
          // Check if already exists
          const [existing] = await pool.query('SELECT id FROM crm_institutions WHERE name = ?', [payload.name]);
          if (existing.length > 0) {
            conflictCount++;
            const serverRecord = existing[0];
            const [resConflict] = await pool.query(
              'INSERT INTO crm_sync_conflicts (user_id, record_type, record_id, local_data, server_data, resolution_choice) VALUES (?, ?, ?, ?, ?, ?)',
              [req.user.id, 'prospect', serverRecord.id, JSON.stringify(payload), JSON.stringify(serverRecord), 'KEEP_SERVER']
            );
            results.push({
              localId,
              status: 'conflict',
              conflictId: resConflict.insertId,
              recordId: serverRecord.id,
              serverData: serverRecord,
              message: 'Cette structure existe déjà sur le serveur.'
            });
            syncHistoryDetails.push(`Conflit prospect: ${payload.name} existe déjà.`);
            return;
          }

          // Insert prospect
          const [resInsert] = await pool.query(
            `INSERT INTO crm_institutions (
              name, type, tax_id, address, region_id, department_id, city_id,
              phone, email, website, notes, is_active, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              payload.name ? payload.name.trim() : 'Prospect sans nom',
              payload.type || 'PROSPECT',
              payload.tax_id || null,
              payload.address || null,
              payload.region_id || 1,
              payload.department_id || 1,
              payload.city_id || 1,
              payload.phone || null,
              payload.email || null,
              payload.website || null,
              payload.notes || null,
              true,
              req.user.id
            ]
          );

          successCount++;
          localToServerIdMap.set(localId, resInsert.insertId);
          if (payload.id) localToServerIdMap.set(payload.id, resInsert.insertId);
          results.push({ localId, status: 'success', serverId: resInsert.insertId });
          syncHistoryDetails.push(`Prospect créé via synchro: ${payload.name} (ID: ${resInsert.insertId})`);

          // Notify direction
          await notifyDirection(
            'Nouveau Prospect (Synchro)',
            `${req.user.full_name} a synchronisé un nouveau prospect : "${payload.name}".`,
            'PROSPECT_CREATED',
            resInsert.insertId
          );
        }
      }
      else if (type === 'objective') {
        if (action === 'create') {
          const proposalResult = await createObjectiveProposal(req.user, payload, {
            submitImmediately: Boolean(payload.submit_requested)
          });
          const serverId = proposalResult.objective.id;
          localToServerIdMap.set(payload.id || localId, serverId);
          results.push({
            localId,
            status: 'success',
            serverId,
            serverData: proposalResult.objective
          });
          successCount++;
          syncHistoryDetails.push(`Proposition d'objectif synchronisée: ${proposalResult.objective.title} (ID: ${serverId})`);
        } else if (action === 'update') {
          const objective = await updateObjectiveProposal(req.user, payload.id, payload);
          results.push({ localId, status: 'success', serverId: objective.id, serverData: objective });
          successCount++;
          syncHistoryDetails.push(`Proposition d'objectif mise à jour via synchro: #${objective.id}`);
        } else if (action === 'submit') {
          const objective = await submitObjectiveProposal(req.user, payload.id);
          results.push({ localId, status: 'success', serverId: objective.id, serverData: objective });
          successCount++;
          syncHistoryDetails.push(`Proposition d'objectif soumise via synchro: #${objective.id}`);
        } else if (action === 'delete') {
          await deleteObjectiveProposal(req.user, payload.id);
          results.push({ localId, status: 'success', serverId: payload.id });
          successCount++;
          syncHistoryDetails.push(`Brouillon d'objectif supprimé via synchro: #${payload.id}`);
        } else {
          throw Object.assign(new Error("Action d'objectif non prise en charge."), { status: 400 });
        }
      }
      else if (type === 'mission') {
        if (req.user.role !== 'COMMERCIAL') {
          throw Object.assign(new Error('Synchronisation des missions réservée aux commerciaux terrain.'), { status: 403 });
        }

        if (action === 'create') {
          const clientRequestId = normalizeClientRequestId(payload.client_request_id);
          if (!clientRequestId) {
            throw Object.assign(new Error('Identifiant de synchronisation de mission invalide.'), { status: 400 });
          }

          const [existing] = await pool.query(
            'SELECT id, primary_commercial_id FROM crm_missions WHERE client_request_id = ? LIMIT 1',
            [clientRequestId]
          );
          if (existing.length) {
            if (Number(existing[0].primary_commercial_id) !== Number(req.user.id)) {
              throw Object.assign(new Error('Identifiant de synchronisation de mission déjà utilisé.'), { status: 409 });
            }
            localToServerIdMap.set(payload.id || localId, existing[0].id);
            results.push({ localId, status: 'success', serverId: existing[0].id });
            successCount++;
            syncHistoryDetails.push(`Mission déjà synchronisée: #${existing[0].id}`);
            return;
          }

          const { serverId, missionReference, travel, title, initialStatus, targets } = await createSyncedMission(
            payload,
            req.user,
            localToServerIdMap,
            clientRequestId
          );
          localToServerIdMap.set(payload.id || localId, serverId);
          results.push({
            localId,
            status: 'success',
            serverId,
            serverData: { id: serverId, mission_reference: missionReference, travel_scope: travel.travel_scope, targets }
          });
          successCount++;
          syncHistoryDetails.push(`Mission synchronisée: ${title} (ID: ${serverId})`);

          if (initialStatus === 'SUBMITTED') {
            await notifyDirection(
              'Nouvelle mission terrain soumise',
              `${req.user.full_name} a soumis la mission « ${title} » (${travel.travel_scope === 'OUT_OF_CITY' ? 'hors de la ville' : 'dans la ville'}).`,
              'MISSION_SUBMITTED',
              serverId
            );
          }
        } else if (action === 'update') {
          const resolvedMissionId = localToServerIdMap.get(payload.id) || positiveId(payload.id);
          if (!resolvedMissionId) throw Object.assign(new Error('Mission locale non synchronisée.'), { status: 409 });
          const requestedStatus = String(payload.status || '').toUpperCase();
          if (requestedStatus !== 'SUBMITTED') {
            throw Object.assign(new Error('Mise à jour de mission non prise en charge par la synchronisation.'), { status: 400 });
          }
          const [result] = await pool.query(
            `UPDATE crm_missions SET status = 'SUBMITTED'
             WHERE id = ? AND primary_commercial_id = ? AND status = 'DRAFT'`,
            [resolvedMissionId, req.user.id]
          );
          if (!result.affectedRows) throw Object.assign(new Error('Mission introuvable, non autorisée ou déjà soumise.'), { status: 409 });
          results.push({ localId, status: 'success', serverId: resolvedMissionId });
          successCount++;
          syncHistoryDetails.push(`Mission soumise via synchronisation: #${resolvedMissionId}`);
        } else {
          throw Object.assign(new Error('Action de mission non prise en charge.'), { status: 400 });
        }
      }
      else if (type === 'report') {
        if (action === 'create') {
          // Resolve local mission_id if created offline in same sync session
          if (payload.mission_id && localToServerIdMap.has(payload.mission_id)) {
            payload.mission_id = localToServerIdMap.get(payload.mission_id);
          }
          if (payload.institution_id && localToServerIdMap.has(payload.institution_id)) {
            payload.institution_id = localToServerIdMap.get(payload.institution_id);
          }
          if (!await commercialCanSyncMission(pool, payload.mission_id, req.user.id)) {
            errorCount++;
            results.push({ localId, status: 'error', message: 'Mission non autorisee pour ce rapport.' });
            return;
          }

          // Check if report already exists for this mission
          const [existing] = await pool.query('SELECT id FROM crm_reports WHERE mission_id = ?', [payload.mission_id]);
          if (existing.length > 0) {
            conflictCount++;
            const serverRecord = existing[0];
            const [resConflict] = await pool.query(
              'INSERT INTO crm_sync_conflicts (user_id, record_type, record_id, local_data, server_data, resolution_choice) VALUES (?, ?, ?, ?, ?, ?)',
              [req.user.id, 'report', serverRecord.id, JSON.stringify(payload), JSON.stringify(serverRecord), 'KEEP_SERVER']
            );
            results.push({
              localId,
              status: 'conflict',
              conflictId: resConflict.insertId,
              recordId: serverRecord.id,
              serverData: serverRecord,
              message: 'Un rapport existe déjà pour cette mission sur le serveur.'
            });
            syncHistoryDetails.push(`Conflit rapport: Mission #${payload.mission_id} a déjà un rapport.`);
            return;
          }

          // Insert report transactionally
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();

            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const [resInsert] = await conn.query(
              `INSERT INTO crm_reports (
                report_type, mission_id, objective_id, institution_id,
                commercial_id, period_start, period_end, status,
                executive_summary, results, diagnosis, difficulties,
                recommendations, next_steps, generated_from, generated_by, persons_met
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mobile', ?, ?)`,
              [
                payload.report_type || 'activity_report',
                payload.mission_id ? Number(payload.mission_id) : null,
                payload.objective_id ? Number(payload.objective_id) : null,
                payload.institution_id ? Number(payload.institution_id) : null,
                req.user.id,
                payload.period_start || null,
                payload.period_end || null,
                normalizeReportStatus(payload.status),
                (payload.executive_summary || '').trim(),
                (payload.results || '').trim(),
                (payload.diagnosis || '').trim(),
                (payload.difficulties || '').trim(),
                (payload.recommendations || '').trim(),
                (payload.next_steps || '').trim(),
                req.user.id,
                typeof payload.persons_met === 'object' ? JSON.stringify(payload.persons_met) : (payload.persons_met || '')
              ]
            );

            const reportId = resInsert.insertId;
            const code = `RAP-${dateStr}-${String(reportId).padStart(4, '0')}`;
            await conn.query('UPDATE crm_reports SET code = ? WHERE id = ?', [code, reportId]);

            // Mark mission as completed
            if (payload.mission_id) {
              await conn.query('UPDATE crm_missions SET status = "COMPLETED" WHERE id = ?', [payload.mission_id]);
            }

            // Insert opportunities
            if (Array.isArray(payload.opportunities)) {
              for (const opp of payload.opportunities) {
                let oppId = opp.id;
                if (opp.title && isNaN(Number(opp.id))) {
                  const doubleValidationRequired = parseFloat(opp.estimated_amount) > 50000000;
                  const initialStatus = doubleValidationRequired ? 'SUBMITTED' : 'DETECTED';

                  const [oppInsert] = await conn.query(
                    `INSERT INTO crm_opportunities (
                      institution_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      payload.institution_id ? Number(payload.institution_id) : null,
                      opp.title,
                      opp.need_description || null,
                      opp.estimated_amount || 0,
                      normalizePriority(opp.priority),
                      initialStatus,
                      normalizeOpportunityStage(opp.pipeline_stage),
                      req.user.id
                    ]
                  );
                  oppId = oppInsert.insertId;
                }

                if (oppId) {
                  const [ownedOpp] = await conn.query(
                    'SELECT id FROM crm_opportunities WHERE id = ? AND assigned_to = ? LIMIT 1',
                    [Number(oppId), req.user.id]
                  );
                  if (!ownedOpp.length) return;
                  await conn.query(
                    'INSERT INTO crm_report_opportunities (activity_report_id, opportunity_id, relation_type) VALUES (?, ?, ?)',
                    [reportId, Number(oppId), opp.relation_type || 'PRIMARY']
                  );
                }
              }
            }

            await conn.commit();
            successCount++;
            localToServerIdMap.set(localId, reportId);
          if (payload.id) localToServerIdMap.set(payload.id, reportId);
            results.push({ localId, status: 'success', serverId: reportId });
            syncHistoryDetails.push(`Rapport créé via synchro pour mission #${payload.mission_id} (ID: ${reportId})`);

            // Notify direction
            const [mRows] = await pool.query('SELECT title FROM crm_missions WHERE id = ?', [payload.mission_id]);
            const mTitle = mRows.length ? mRows[0].title : `Mission #${payload.mission_id}`;
            await notifyDirection(
              'Rapport Soumis (Synchro)',
              `${req.user.full_name} a soumis un rapport pour la mission "${mTitle}".`,
              'REPORT_SUBMITTED',
              reportId
            );
          } catch (txErr) {
            await conn.rollback();
            console.error('TX Error inserting report during sync:', txErr);
            errorCount++;
            results.push({ localId, status: 'error', message: 'Erreur transactionnelle sur le serveur.' });
          } finally {
            conn.release();
          }
        } else if (action === 'update') {
          // Check for conflict
          const serverRecord = await getOwnedReport(pool, payload.id, req.user.id);
          if (!serverRecord) {
            errorCount++;
            results.push({ localId, status: 'error', message: "Rapport introuvable sur le serveur." });
            return;
          }

          const clientUpdatedAt = new Date(payload.updated_at || Date.now());
          const serverUpdatedAt = new Date(serverRecord.updated_at);

          // Conflict check
          if (serverUpdatedAt > clientUpdatedAt && serverRecord.status !== payload.status) {
            conflictCount++;
            const [resConflict] = await pool.query(
              'INSERT INTO crm_sync_conflicts (user_id, record_type, record_id, local_data, server_data, resolution_choice) VALUES (?, ?, ?, ?, ?, ?)',
              [req.user.id, 'report', serverRecord.id, JSON.stringify(payload), JSON.stringify(serverRecord), 'KEEP_SERVER']
            );
            results.push({
              localId,
              status: 'conflict',
              conflictId: resConflict.insertId,
              recordId: serverRecord.id,
              serverData: serverRecord,
              message: 'Le rapport a été modifié sur le serveur.'
            });
            syncHistoryDetails.push(`Conflit rapport: #${payload.id} modifié sur le serveur.`);
            return;
          }

          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();

            await conn.query(
              `UPDATE crm_reports
               SET executive_summary = ?, 
                   results = ?, 
                   diagnosis = ?, 
                   difficulties = ?, 
                   recommendations = ?, 
                   next_steps = ?,
                   institution_id = ?, 
                   objective_id = ?,
                   period_start = ?,
                   period_end = ?,
                   persons_met = ?,
                   status = CASE
                     WHEN ? = 'SOUMIS' AND status IN ('BROUILLON_AUTO', 'A_COMPLETER', 'CORRECTION_DEMANDEE', 'DRAFT', 'REJECTED') THEN 'SOUMIS'
                     WHEN status = 'BROUILLON_AUTO' THEN 'A_COMPLETER'
                     ELSE status
                   END
               WHERE id = ?`,
              [
                (payload.executive_summary || '').trim(),
                (payload.results || '').trim(),
                (payload.diagnosis || '').trim(),
                (payload.difficulties || '').trim(),
                (payload.recommendations || '').trim(),
                (payload.next_steps || '').trim(),
                payload.institution_id ? Number(payload.institution_id) : serverRecord.institution_id,
                payload.objective_id ? Number(payload.objective_id) : serverRecord.objective_id,
                payload.period_start || serverRecord.period_start,
                payload.period_end || serverRecord.period_end,
                typeof payload.persons_met === 'object' ? JSON.stringify(payload.persons_met) : (payload.persons_met || ''),
                normalizeReportStatus(payload.status),
                payload.id
              ]
            );

            // Handle opportunities links/creation
            if (Array.isArray(payload.opportunities)) {
              const [existingLinks] = await conn.query(
                'SELECT opportunity_id FROM crm_report_opportunities WHERE activity_report_id = ?',
                [payload.id]
              );
              const existingOppIds = new Set(existingLinks.map(l => l.opportunity_id));
              const keepOppIds = new Set();

              for (const opp of payload.opportunities) {
                let oppId = opp.id;
                if (opp.title && isNaN(Number(opp.id))) {
                  const doubleValidationRequired = parseFloat(opp.estimated_amount) > 50000000;
                  const initialStatus = doubleValidationRequired ? 'SUBMITTED' : 'DETECTED';

                  const [oppInsert] = await conn.query(
                    `INSERT INTO crm_opportunities (
                      institution_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      payload.institution_id ? Number(payload.institution_id) : serverRecord.institution_id,
                      opp.title,
                      opp.need_description || null,
                      opp.estimated_amount || 0,
                      normalizePriority(opp.priority),
                      initialStatus,
                      normalizeOpportunityStage(opp.pipeline_stage),
                      req.user.id
                    ]
                  );
                  oppId = oppInsert.insertId;
                }

                if (oppId) {
                  const [ownedOpp] = await conn.query(
                    'SELECT id FROM crm_opportunities WHERE id = ? AND assigned_to = ? LIMIT 1',
                    [Number(oppId), req.user.id]
                  );
                  if (!ownedOpp.length) return;
                  keepOppIds.add(Number(oppId));
                  await conn.query(
                    `INSERT INTO crm_report_opportunities (activity_report_id, opportunity_id, relation_type)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE relation_type = VALUES(relation_type)`,
                    [payload.id, Number(oppId), opp.relation_type || 'PRIMARY']
                  );
                }
              }

              for (const oldId of existingOppIds) {
                if (!keepOppIds.has(oldId)) {
                  await conn.query(
                    'DELETE FROM crm_report_opportunities WHERE activity_report_id = ? AND opportunity_id = ?',
                    [payload.id, oldId]
                  );
                }
              }
            }

            await conn.commit();
            successCount++;
            results.push({ localId, status: 'success' });
            syncHistoryDetails.push(`Rapport mis à jour via synchro: #${payload.id}`);
          } catch (txErr) {
            await conn.rollback();
            console.error('TX Error updating report during sync:', txErr);
            errorCount++;
            results.push({ localId, status: 'error', message: 'Erreur transactionnelle sur le serveur.' });
          } finally {
            conn.release();
          }
        }
      }
      else if (type === 'opportunity') {
        if (['submit','add_comment','complete_action'].includes(action)) {
          const id = localToServerIdMap.get(payload.id) || positiveId(payload.id);
          const opportunity = await OpportunityWorkflowService.getOpportunity(id);
          if (!opportunity || !OpportunityWorkflowService.canAccess(opportunity, req.user)) throw Object.assign(new Error('Opportunité non autorisée.'), {status:403});
          if (action === 'submit') await OpportunityWorkflowService.submit(id, req.user);
          if (action === 'add_comment') {
            if (typeof payload.comment !== 'string' || !payload.comment.trim() || payload.comment.length > 10000) throw Object.assign(new Error('Commentaire invalide.'),{status:400});
            await pool.query('INSERT INTO crm_opportunity_comments (opportunity_id,user_id,comment) VALUES (?,?,?)',[id,req.user.id,payload.comment.trim()]);
          }
          if (action === 'complete_action') {
            if (!['PENDING','COMPLETED'].includes(payload.status)) throw Object.assign(new Error('Statut invalide.'),{status:400});
            const [updated] = await pool.query("UPDATE crm_opportunity_actions SET status=?, completed_at=IF(?='COMPLETED',NOW(),NULL) WHERE id=? AND opportunity_id=?",[payload.status,payload.status,payload.actionId,id]);
            if (!updated.affectedRows) throw Object.assign(new Error('Action introuvable.'),{status:404});
          }
          results.push({localId,status:'success',serverId:id}); successCount++;
        } else if (action === 'create') {
          // Résoudre les identifiants locaux s'ils ont été créés lors de la même session offline
          let resolvedInstId = payload.institution_id;
          if (localToServerIdMap.has(payload.institution_id)) {
            resolvedInstId = localToServerIdMap.get(payload.institution_id);
          }
          const instIdNum = Number(resolvedInstId);
          if (!instIdNum || isNaN(instIdNum)) {
            results.push({ localId, status: 'error', message: 'Institution invalide ou non trouvée pour cette opportunité.' });
            errorCount++;
            return;
          }

          let resolvedMissionId = payload.mission_id || null;
          if (resolvedMissionId && localToServerIdMap.has(resolvedMissionId)) {
            resolvedMissionId = localToServerIdMap.get(resolvedMissionId);
          }
          if (resolvedMissionId && !await commercialCanSyncMission(pool, resolvedMissionId, req.user.id)) {
            results.push({ localId, status: 'error', message: 'Mission non autorisee pour cette opportunite.' });
            errorCount++;
            return;
          }

          // Check double validation
          const requestedStatus = payload.status || 'DETECTED';
          if (!['DETECTED','SUBMITTED'].includes(requestedStatus) || !payload.title?.trim() || payload.title.length > 150 || !payload.need_description?.trim() || !Number.isFinite(Number(payload.estimated_amount)) || Number(payload.estimated_amount) <= 0) throw Object.assign(new Error('Données de création de l’opportunité invalides.'), {status:400});
          const initialStatus = 'DETECTED';

          const [resInsert] = await pool.query(
            'INSERT INTO crm_opportunities (institution_id, mission_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              instIdNum,
              resolvedMissionId || null,
              payload.title || 'Nouvelle opportunité',
              payload.need_description || '',
              parseFloat(payload.estimated_amount || 0),
              normalizePriority(payload.priority),
              initialStatus,
              'DETECTION',
              req.user.id
            ]
          );

          localToServerIdMap.set(payload.id || localId, resInsert.insertId);
          await OpportunityWorkflowService.logHistory(resInsert.insertId, null, 'DETECTED', 'Création hors ligne', null, req.user.id);
          if (requestedStatus === 'SUBMITTED') await OpportunityWorkflowService.submit(resInsert.insertId, req.user);
          successCount++;
          results.push({ localId, status: 'success', serverId: resInsert.insertId });
          syncHistoryDetails.push(`Opportunité créée via synchro: ${payload.title} (ID: ${resInsert.insertId})`);

          // Notify direction
          await notifyDirection(
            'Nouvelle Opportunité (Synchro)',
            `${req.user.full_name} a synchronisé une opportunité : "${payload.title}" (${payload.estimated_amount} FCFA).`,
            'OPPORTUNITY_CREATED',
            resInsert.insertId
          );
        }
        else if (action === 'update') {
          // Check for conflict
          const [existing] = await pool.query(
            'SELECT * FROM crm_opportunities WHERE id = ? AND assigned_to = ?',
            [payload.id, req.user.id]
          );
          if (existing.length === 0) {
            errorCount++;
            results.push({ localId, status: 'error', message: "Opportunite introuvable ou non autorisee sur le serveur." });
            return;
          }

          const serverRecord = existing[0];
          const clientUpdatedAt = new Date(payload.updated_at || Date.now());
          const serverUpdatedAt = new Date(serverRecord.updated_at);

          // If server was updated AFTER client checked out, conflict!
          if (serverUpdatedAt > clientUpdatedAt && payload.pipeline_stage !== undefined && serverRecord.pipeline_stage !== payload.pipeline_stage) {
            conflictCount++;
            const [resConflict] = await pool.query(
              'INSERT INTO crm_sync_conflicts (user_id, record_type, record_id, local_data, server_data, resolution_choice) VALUES (?, ?, ?, ?, ?, ?)',
              [req.user.id, 'opportunity', serverRecord.id, JSON.stringify(payload), JSON.stringify(serverRecord), 'KEEP_SERVER']
            );
            results.push({
              localId,
              status: 'conflict',
              conflictId: resConflict.insertId,
              recordId: serverRecord.id,
              serverData: serverRecord,
              message: 'L\'opportunité a été modifiée sur le serveur entre-temps.'
            });
            syncHistoryDetails.push(`Conflit opportunité: #${payload.id} modifiée sur le serveur.`);
            return;
          }

          if (!SYNC_OPPORTUNITY_EDITABLE_STATUSES.has(serverRecord.status)) {
            errorCount++;
            results.push({ localId, status: 'error', message: "Cette opportunite n'est plus modifiable depuis la PWA." });
            return;
          }

          // No conflict, perform update without accepting client-side reassignment.
          const pipeline_stage = serverRecord.pipeline_stage;
          if (payload.pipeline_stage !== undefined && payload.pipeline_stage !== pipeline_stage) throw Object.assign(new Error('Le changement d’étape doit suivre le workflow de validation.'),{status:400});
          const status = normalizeOpportunityStatus(payload.status, serverRecord.status);
          const title = payload.title !== undefined ? payload.title : serverRecord.title;
          const need_description = payload.need_description !== undefined ? payload.need_description : serverRecord.need_description;
          const estimated_amount = payload.estimated_amount !== undefined ? payload.estimated_amount : serverRecord.estimated_amount;
          const priority = payload.priority !== undefined ? normalizePriority(payload.priority, serverRecord.priority) : serverRecord.priority;
          if (typeof title !== 'string' || !title.trim() || title.length > 150 || typeof need_description !== 'string' || !need_description.trim() || !Number.isFinite(Number(estimated_amount)) || Number(estimated_amount) <= 0) throw Object.assign(new Error('Données d’opportunité invalides.'),{status:400});

          await pool.query(
            `UPDATE crm_opportunities 
             SET pipeline_stage = ?, status = ?, title = ?, need_description = ?, estimated_amount = ?, priority = ?
             WHERE id = ?`,
            [pipeline_stage, serverRecord.status, title, need_description, estimated_amount, priority, payload.id]
          );
          if (status === 'SUBMITTED') await OpportunityWorkflowService.submit(payload.id,req.user);

          successCount++;
          results.push({ localId, status: 'success' });
          syncHistoryDetails.push(`Opportunité mise à jour: #${payload.id} vers ${pipeline_stage}`);

          // Notify direction
          await notifyDirection(
            'Pipeline opportunité mis à jour (Synchro)',
            `${req.user.full_name} a mis à jour l'opportunité "${title}" vers l'étape "${pipeline_stage}".`,
            'OPPORTUNITY_UPDATED',
            payload.id
          );
        }
      }

        })();
        const result = results[offset];
        if (!result) throw Object.assign(new Error('Type ou action de synchronisation non pris en charge.'),{status:400});
        if (result.status === 'success') await pool.query('INSERT INTO crm_sync_receipts (user_id,request_id,payload_hash,result_json,local_aliases) VALUES (?,?,?,?,?)',[req.user.id,localId,hash,JSON.stringify(result),JSON.stringify(aliases)]);
      });
    } catch (err) {
      results.splice(resultOffset);
      [successCount,conflictCount,errorCount] = previousCounts;
      localToServerIdMap.clear(); for (const [key,value] of previousMap) localToServerIdMap.set(key,value);
      console.error('Sync item error:', err);
      errorCount++;
      results.push({
        localId,
        status: 'error',
        message: err.status && err.status < 500 ? err.message : 'Erreur serveur pendant la synchronisation.'
      });
      syncHistoryDetails.push(`Erreur sur l'action ${action} de type ${type}: ${err.message}`);
    }
  }

  // Write Sync History
  try {
    const syncStatus = errorCount > 0 ? 'PARTIAL_ERROR' : (conflictCount > 0 ? 'PARTIAL_ERROR' : 'SUCCESS');
    await pool.query(
      'INSERT INTO crm_sync_history (user_id, actions_count, status, details) VALUES (?, ?, ?, ?)',
      [req.user.id, actions.length, syncStatus, syncHistoryDetails.join('\n')]
    );
  } catch (historyErr) {
    console.error('Error logging sync history:', historyErr);
  }

  res.json({
    success: true,
    processed: actions.length,
    successCount,
    conflictCount,
    errorCount,
    results
  });
});

// POST /api/sync/resolve-conflict - Résolution de conflit
router.post('/resolve-conflict', authenticate, async (req, res) => {
  if (req.user.role !== 'COMMERCIAL') {
    return res.status(403).json({ error: 'Resolution de conflit reservee aux comptes commerciaux terrain.' });
  }

  const { conflictId, resolutionChoice, mergedData } = req.body;
  if (!conflictId || !resolutionChoice) {
    return res.status(400).json({ error: 'Paramètres de résolution manquants.' });
  }

  if (!['KEEP_LOCAL', 'KEEP_SERVER', 'MERGED'].includes(resolutionChoice)) {
    return res.status(400).json({ error: 'Choix de resolution invalide.' });
  }

  try {
    const [conflicts] = await pool.query('SELECT * FROM crm_sync_conflicts WHERE id = ? AND user_id = ?', [conflictId, req.user.id]);
    if (conflicts.length === 0) {
      return res.status(404).json({ error: 'Conflit introuvable.' });
    }

    const conflict = conflicts[0];
    const localData = JSON.parse(conflict.local_data);
    const serverData = JSON.parse(conflict.server_data);

    let finalData = {};
    if (resolutionChoice === 'KEEP_LOCAL') {
      finalData = localData;
    } else if (resolutionChoice === 'KEEP_SERVER') {
      finalData = serverData;
    } else if (resolutionChoice === 'MERGED') {
      finalData = mergedData || localData;
    }

    if (resolutionChoice === 'KEEP_SERVER') {
      await pool.query('DELETE FROM crm_sync_conflicts WHERE id = ?', [conflictId]);
      return res.json({ message: 'Conflit resolu en conservant la version serveur.' });
    }

    // Apply final resolved data to DB
    if (conflict.record_type === 'prospect') {
      const [ownedProspect] = await pool.query(
        'SELECT id FROM crm_institutions WHERE id = ? AND created_by = ? LIMIT 1',
        [conflict.record_id, req.user.id]
      );
      if (!ownedProspect.length) {
        return res.status(403).json({ error: 'Prospect non autorise.' });
      }
      await pool.query(
        `UPDATE crm_institutions SET name = ?, type = ?, tax_id = ?, address = ?, region_id = ?, department_id = ?, city_id = ?, phone = ?, email = ?, website = ? WHERE id = ?`,
        [
          finalData.name,
          finalData.type,
          finalData.tax_id || null,
          finalData.address || null,
          finalData.region_id || 1,
          finalData.department_id || 1,
          finalData.city_id || 1,
          finalData.phone || null,
          finalData.email || null,
          finalData.website || null,
          conflict.record_id
        ]
      );
    } else if (conflict.record_type === 'opportunity') {
      const [ownedOpp] = await pool.query(
        'SELECT id, status, pipeline_stage FROM crm_opportunities WHERE id = ? AND assigned_to = ? LIMIT 1',
        [conflict.record_id, req.user.id]
      );
      if (!ownedOpp.length) {
        return res.status(403).json({ error: 'Opportunite non autorisee.' });
      }
      const current = ownedOpp[0];
      if (!SYNC_OPPORTUNITY_EDITABLE_STATUSES.has(current.status)) {
        return res.status(409).json({ error: "Cette opportunite n'est plus modifiable depuis la PWA." });
      }
      await pool.query(
        'UPDATE crm_opportunities SET pipeline_stage = ?, status = ?, title = ?, need_description = ?, estimated_amount = ?, priority = ? WHERE id = ?',
        [
          normalizeOpportunityStage(finalData.pipeline_stage, current.pipeline_stage),
          normalizeOpportunityStatus(finalData.status, current.status),
          finalData.title,
          finalData.need_description,
          finalData.estimated_amount,
          normalizePriority(finalData.priority, 'MEDIUM'),
          conflict.record_id
        ]
      );
    } else if (conflict.record_type === 'report') {
      const report = await getOwnedReport(pool, conflict.record_id, req.user.id);
      if (!report) {
        return res.status(403).json({ error: 'Rapport non autorise.' });
      }
      await pool.query(
        'UPDATE crm_reports SET executive_summary = ?, administrations_visited = ?, persons_met = ?, difficulties = ?, recommendations = ? WHERE id = ?',
        [
          finalData.executive_summary,
          finalData.administrations_visited,
          finalData.persons_met,
          finalData.difficulties || null,
          finalData.recommendations || null,
          conflict.record_id
        ]
      );
    }

    // Delete conflict from DB
    await pool.query('DELETE FROM crm_sync_conflicts WHERE id = ?', [conflictId]);

    res.json({ message: 'Conflit résolu et base serveur mise à jour avec succès.' });
  } catch (err) {
    console.error('Resolve conflict error:', err);
    res.status(500).json({ error: 'Erreur lors de la résolution du conflit' });
  }
});

module.exports = router;
