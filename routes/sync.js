const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { notifyDirection } = require('../utils/notifications');

// POST /api/sync/push — Synchronisation depuis la PWA mobile
router.post('/push', authenticate, async (req, res) => {
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

  for (const actionItem of actions) {
    const { id: localId, action, type, payload } = actionItem;
    try {
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
            continue;
          }

          // Insert prospect
          const [resInsert] = await pool.query(
            `INSERT INTO crm_institutions (name, type, tax_id, address, region_id, department_id, city_id, phone, email, website, created_by) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              payload.name, 
              payload.type || 'PROSPECT', 
              payload.tax_id || null, 
              payload.address || null, 
              payload.region_id || 1, 
              payload.department_id || 1, 
              payload.city_id || 1, 
              payload.phone || null, 
              payload.email || null, 
              payload.website || null,
              req.user.id
            ]
          );

          successCount++;
          localToServerIdMap.set(localId, resInsert.insertId);
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
      else if (type === 'report') {
        if (action === 'create') {
          // Resolve local mission_id if created offline in same sync session
          if (payload.mission_id && localToServerIdMap.has(payload.mission_id)) {
            payload.mission_id = localToServerIdMap.get(payload.mission_id);
          }
          if (payload.institution_id && localToServerIdMap.has(payload.institution_id)) {
            payload.institution_id = localToServerIdMap.get(payload.institution_id);
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
            continue;
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
                payload.status || 'A_COMPLETER',
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
                      opp.priority || 'MEDIUM',
                      initialStatus,
                      opp.pipeline_stage || 'DETECTION',
                      req.user.id
                    ]
                  );
                  oppId = oppInsert.insertId;
                }

                if (oppId) {
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
          const [existing] = await pool.query('SELECT id, updated_at, status FROM crm_reports WHERE id = ?', [payload.id]);
          if (existing.length === 0) {
            errorCount++;
            results.push({ localId, status: 'error', message: "Rapport introuvable sur le serveur." });
            continue;
          }

          const serverRecord = existing[0];
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
            continue;
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
                   status = CASE WHEN status = 'BROUILLON_AUTO' THEN 'A_COMPLETER' ELSE status END
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
                      opp.priority || 'MEDIUM',
                      initialStatus,
                      opp.pipeline_stage || 'DETECTION',
                      req.user.id
                    ]
                  );
                  oppId = oppInsert.insertId;
                }

                if (oppId) {
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
        if (action === 'create') {
          // Résoudre les identifiants locaux s'ils ont été créés lors de la même session offline
          if (localToServerIdMap.has(payload.institution_id)) {
            payload.institution_id = localToServerIdMap.get(payload.institution_id);
          }
          if (payload.mission_id && localToServerIdMap.has(payload.mission_id)) {
            payload.mission_id = localToServerIdMap.get(payload.mission_id);
          }
          // Check double validation
          const doubleValidationRequired = parseFloat(payload.estimated_amount) > 50000000;
          const initialStatus = doubleValidationRequired ? 'SUBMITTED' : 'DETECTED';

          const [resInsert] = await pool.query(
            'INSERT INTO crm_opportunities (institution_id, mission_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              payload.institution_id,
              payload.mission_id || null,
              payload.title,
              payload.need_description,
              payload.estimated_amount,
              payload.priority || 'MEDIUM',
              initialStatus,
              payload.pipeline_stage || 'DETECTION',
              req.user.id
            ]
          );

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
          const [existing] = await pool.query('SELECT id, updated_at, pipeline_stage FROM crm_opportunities WHERE id = ?', [payload.id]);
          if (existing.length === 0) {
            errorCount++;
            results.push({ localId, status: 'error', message: "Opportunité introuvable sur le serveur." });
            continue;
          }

          const serverRecord = existing[0];
          const clientUpdatedAt = new Date(payload.updated_at || Date.now());
          const serverUpdatedAt = new Date(serverRecord.updated_at);

          // If server was updated AFTER client checked out, conflict!
          if (serverUpdatedAt > clientUpdatedAt && serverRecord.pipeline_stage !== payload.pipeline_stage) {
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
            continue;
          }

          // No conflict, perform update
          await pool.query(
            'UPDATE crm_opportunities SET pipeline_stage = ?, status = ? WHERE id = ?',
            [payload.pipeline_stage, payload.status || 'DETECTED', payload.id]
          );

          successCount++;
          results.push({ localId, status: 'success' });
          syncHistoryDetails.push(`Opportunité mise à jour: #${payload.id} vers ${payload.pipeline_stage}`);

          // Notify direction
          await notifyDirection(
            'Pipeline opportunité mis à jour (Synchro)',
            `${req.user.full_name} a mis à jour l'opportunité "${payload.title}" vers l'étape "${payload.pipeline_stage}".`,
            'OPPORTUNITY_UPDATED',
            payload.id
          );
        }
      }
    } catch (err) {
      console.error('Sync item error:', err);
      errorCount++;
      results.push({ localId, status: 'error', message: 'Erreur serveur pendant la synchronisation.' });
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

// POST /api/sync/resolve-conflict — Résolution de conflit
router.post('/resolve-conflict', authenticate, async (req, res) => {
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

    // Apply final resolved data to DB
    if (conflict.record_type === 'prospect') {
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
      await pool.query(
        'UPDATE crm_opportunities SET pipeline_stage = ?, status = ?, title = ?, need_description = ?, estimated_amount = ?, priority = ? WHERE id = ?',
        [
          finalData.pipeline_stage,
          finalData.status,
          finalData.title,
          finalData.need_description,
          finalData.estimated_amount,
          finalData.priority,
          conflict.record_id
        ]
      );
    } else if (conflict.record_type === 'report') {
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
