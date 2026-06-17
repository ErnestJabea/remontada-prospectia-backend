const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);
const STATUSES = [
  'DETECTED', 'QUALIFIED', 'SUBMITTED', 'IN_VALIDATION', 'VALIDATED',
  'REJECTED', 'IN_NEGOTIATION', 'WON', 'LOST', 'ARCHIVED'
];
const STAGES = [
  'DETECTION', 'QUALIFICATION', 'ANALYSE', 'PROPOSITION',
  'NEGOCIATION', 'DECISION', 'SIGNATURE'
];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

async function getOpportunity(id) {
  const [rows] = await pool.query(
    'SELECT * FROM crm_opportunities WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

function canAccess(opportunity, user) {
  return isManager(user) || opportunity.assigned_to === user.id;
}

router.get('/', authenticate, async (req, res) => {
  try {
    const { status, pipeline_stage, institutionId } = req.query;
    let query = `
      SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name
      FROM crm_opportunities op
      JOIN crm_institutions i ON op.institution_id = i.id
      LEFT JOIN users u ON op.assigned_to = u.id`;
    const params = [];
    const conditions = [];

    if (req.user.role === 'COMMERCIAL') {
      conditions.push('op.assigned_to = ?');
      params.push(req.user.id);
    }
    if (status && STATUSES.includes(status)) {
      conditions.push('op.status = ?');
      params.push(status);
    }
    if (pipeline_stage && STAGES.includes(pipeline_stage)) {
      conditions.push('op.pipeline_stage = ?');
      params.push(pipeline_stage);
    }
    if (institutionId && Number(institutionId)) {
      conditions.push('op.institution_id = ?');
      params.push(institutionId);
    }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY op.created_at DESC';

    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[OPPORTUNITIES/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/pipeline', authenticate, async (req, res) => {
  try {
    let query = `
      SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name
      FROM crm_opportunities op
      JOIN crm_institutions i ON op.institution_id = i.id
      LEFT JOIN users u ON op.assigned_to = u.id
      WHERE op.status NOT IN ('LOST', 'ARCHIVED')`;
    const params = [];
    if (req.user.role === 'COMMERCIAL') {
      query += ' AND op.assigned_to = ?';
      params.push(req.user.id);
    }
    query += ' ORDER BY op.estimated_amount DESC';

    const [rows] = await pool.query(query, params);
    const pipeline = Object.fromEntries(STAGES.map(stage => [stage, []]));
    rows.forEach(row => {
      if (pipeline[row.pipeline_stage]) pipeline[row.pipeline_stage].push(row);
    });
    return res.json(pipeline);
  } catch (err) {
    console.error('[OPPORTUNITIES/PIPELINE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const opportunity = await getOpportunity(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunite introuvable.' });
    if (!canAccess(opportunity, req.user)) return res.status(403).json({ error: 'Acces refuse.' });

    const [rows] = await pool.query(
      `SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name
       FROM crm_opportunities op
       JOIN crm_institutions i ON op.institution_id = i.id
       LEFT JOIN users u ON op.assigned_to = u.id
       WHERE op.id = ?`,
      [req.params.id]
    );
    return res.json(rows[0]);
  } catch (err) {
    console.error('[OPPORTUNITIES/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const {
    institution_id, mission_id, title, need_description,
    estimated_amount, priority, assigned_to
  } = req.body;
  const assignedTo = isManager(req.user) ? (Number(assigned_to) || null) : req.user.id;
  if (
    !Number(institution_id) || typeof title !== 'string' || !title.trim() ||
    title.length > 150 || typeof need_description !== 'string' ||
    !need_description.trim() || !Number.isFinite(Number(estimated_amount)) ||
    Number(estimated_amount) <= 0 || (priority && !PRIORITIES.includes(priority))
  ) {
    return res.status(400).json({ error: 'Donnees d\'opportunite invalides.' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO crm_opportunities (
        institution_id, mission_id, title, need_description,
        estimated_amount, priority, assigned_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        institution_id, Number(mission_id) || null, title.trim(),
        need_description.trim(), Number(estimated_amount),
        priority || 'MEDIUM', assignedTo
      ]
    );

    if (req.user.role === 'COMMERCIAL') {
      const { notifyDirection } = require('../utils/notifications');
      await notifyDirection(
        'Nouvelle Opportunite',
        `${req.user.full_name} a detecte une opportunite : "${title.trim()}" (${estimated_amount} FCFA).`,
        'OPPORTUNITY_CREATED',
        result.insertId
      );
    }
    return res.status(201).json({ id: result.insertId, message: 'Opportunite creee.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/:id', authenticate, async (req, res) => {
  const {
    title, need_description, estimated_amount, priority,
    status, pipeline_stage, assigned_to
  } = req.body;
  if (
    typeof title !== 'string' || !title.trim() || title.length > 150 ||
    typeof need_description !== 'string' || !need_description.trim() ||
    !Number.isFinite(Number(estimated_amount)) || Number(estimated_amount) <= 0 ||
    !PRIORITIES.includes(priority) || !STATUSES.includes(status) ||
    !STAGES.includes(pipeline_stage)
  ) {
    return res.status(400).json({ error: 'Donnees d\'opportunite invalides.' });
  }

  try {
    const opportunity = await getOpportunity(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunite introuvable.' });
    if (!canAccess(opportunity, req.user)) return res.status(403).json({ error: 'Acces refuse.' });

    const assignedTo = isManager(req.user)
      ? (Number(assigned_to) || null)
      : opportunity.assigned_to;
    await pool.query(
      `UPDATE crm_opportunities
       SET title = ?, need_description = ?, estimated_amount = ?, priority = ?,
           status = ?, pipeline_stage = ?, assigned_to = ?
       WHERE id = ?`,
      [
        title.trim(), need_description.trim(), Number(estimated_amount),
        priority, status, pipeline_stage, assignedTo, req.params.id
      ]
    );

    if (req.user.role === 'COMMERCIAL') {
      const { notifyDirection } = require('../utils/notifications');
      await notifyDirection(
        'Pipeline opportunite mis a jour',
        `${req.user.full_name} a mis a jour l'opportunite "${title.trim()}" (etape: ${pipeline_stage}, statut: ${status}).`,
        'OPPORTUNITY_UPDATED',
        req.params.id
      );
    }
    return res.json({ message: 'Opportunite mise a jour.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const opportunity = await getOpportunity(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunite introuvable.' });
    if (!canAccess(opportunity, req.user)) return res.status(403).json({ error: 'Acces refuse.' });
    await pool.query('DELETE FROM crm_opportunities WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Opportunite supprimee.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
