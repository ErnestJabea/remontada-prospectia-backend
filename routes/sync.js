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

          // Insert report
          const [resInsert] = await pool.query(
            'INSERT INTO crm_reports (mission_id, executive_summary, administrations_visited, persons_met, difficulties, recommendations, status) VALUES (?, ?, ?, ?, ?, ?, "SUBMITTED")',
            [
              payload.mission_id,
              payload.executive_summary,
              payload.administrations_visited,
              payload.persons_met,
              payload.difficulties || null,
              payload.recommendations || null
            ]
          );

          // Mark mission as completed
          await pool.query('UPDATE crm_missions SET status = "COMPLETED" WHERE id = ?', [payload.mission_id]);

          // Insert files if present
          if (payload.files && payload.files.length > 0) {
            for (const f of payload.files) {
              await pool.query(
                'INSERT INTO crm_report_attachments (report_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?)',
                [resInsert.insertId, f.name, f.path || `/ged/crm/reports/${f.name}`, f.size || 1024]
              );
            }
          }

          successCount++;
          results.push({ localId, status: 'success', serverId: resInsert.insertId });
          syncHistoryDetails.push(`Rapport créé via synchro pour mission #${payload.mission_id}`);

          // Notify direction
          const [mRows] = await pool.query('SELECT title FROM crm_missions WHERE id = ?', [payload.mission_id]);
          const mTitle = mRows.length ? mRows[0].title : `Mission #${payload.mission_id}`;
          await notifyDirection(
            'Rapport Soumis (Synchro)',
            `${req.user.full_name} a soumis un rapport pour la mission "${mTitle}".`,
            'REPORT_SUBMITTED',
            resInsert.insertId
          );
        }
      } 
      else if (type === 'opportunity') {
        if (action === 'create') {
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
