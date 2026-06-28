const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const OpportunityWorkflowService = require('../services/OpportunityWorkflowService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();

const ALLOWED_FILE_TYPES = new Map([
  ['application/pdf', new Set(['.pdf'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Set(['.docx'])],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Set(['.xlsx'])]
]);

const uploadDir = path.join(__dirname, '..', 'uploads', 'opportunities');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, uploadDir),
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${crypto.randomUUID()}${extension}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_FILE_TYPES.get(file.mimetype)?.has(extension)) {
      const error = new Error('Type de fichier non autorise.');
      error.status = 400;
      return callback(error);
    }
    return callback(null, true);
  }
});

function cleanupUploadedFiles(files = []) {
  for (const file of files) {
    if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
}
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);

const STATUSES = [
  'DETECTED', 'SUBMITTED', 'TO_CORRECT', 'VALIDATED', 'REJECTED',
  'IN_ANALYSIS', 'ACTION_PLAN', 'PROPOSAL', 'NEGOTIATION', 'DECISION',
  'WON', 'LOST', 'ARCHIVED'
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

/**
 * GET / - Liste filtrée des opportunités
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, pipeline_stage, institutionId } = req.query;
    let query = `
      SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name,
             (SELECT COUNT(*) FROM crm_opportunity_actions WHERE opportunity_id = op.id AND status = 'PENDING') AS pending_actions_count
      FROM crm_opportunities op
      JOIN crm_institutions i ON op.institution_id = i.id
      LEFT JOIN users u ON op.assigned_to = u.id`;
    
    const params = [];
    const conditions = [];

    // Restriction d'accès pour les commerciaux
    if (req.user.role === 'COMMERCIAL') {
      conditions.push('op.assigned_to = ?');
      params.push(req.user.id);
    }

    if (status && STATUSES.includes(status)) {
      conditions.push('op.status = ?');
      params.push(status);
    } else {
      // Par défaut, masquer les opportunités archivées
      conditions.push("op.status != 'ARCHIVED'");
    }

    if (pipeline_stage && STAGES.includes(pipeline_stage)) {
      conditions.push('op.pipeline_stage = ?');
      params.push(pipeline_stage);
    }

    if (institutionId && Number(institutionId)) {
      conditions.push('op.institution_id = ?');
      params.push(institutionId);
    }

    if (conditions.length) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY op.created_at DESC';

    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[OPPORTUNITIES/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /pipeline - Regroupement par statut pour le Kanban
 */
router.get('/pipeline', authenticate, async (req, res) => {
  try {
    let query = `
      SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name,
             (SELECT COUNT(*) FROM crm_opportunity_actions WHERE opportunity_id = op.id AND status = 'PENDING') AS pending_actions_count
      FROM crm_opportunities op
      JOIN crm_institutions i ON op.institution_id = i.id
      LEFT JOIN users u ON op.assigned_to = u.id
      WHERE op.status NOT IN ('ARCHIVED')`; // Exclure l'archivage du tableau Kanban général
      
    const params = [];
    if (req.user.role === 'COMMERCIAL') {
      query += ' AND op.assigned_to = ?';
      params.push(req.user.id);
    }
    query += ' ORDER BY op.estimated_amount DESC';

    const [rows] = await pool.query(query, params);

    // Initialiser les colonnes Kanban basées sur les statuts actifs
    const activeKanbanStatuses = [
      'DETECTED', 'SUBMITTED', 'TO_CORRECT', 'VALIDATED', 'REJECTED',
      'IN_ANALYSIS', 'ACTION_PLAN', 'PROPOSAL', 'NEGOTIATION', 'DECISION',
      'WON', 'LOST'
    ];
    const pipeline = Object.fromEntries(activeKanbanStatuses.map(status => [status, []]));
    
    rows.forEach(row => {
      if (pipeline[row.status]) {
        pipeline[row.status].push(row);
      }
    });

    return res.json(pipeline);
  } catch (err) {
    console.error('[OPPORTUNITIES/PIPELINE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /:id - Fiche détaillée enrichie
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'Opportunité introuvable.' });
    if (!canAccess(opp, req.user)) return res.status(403).json({ error: 'Accès refusé.' });

    // Récupérer l'opportunité avec les noms de l'institution et du responsable
    const [oppRows] = await pool.query(
      `SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name,
              uv.full_name AS validated_by_name
       FROM crm_opportunities op
       JOIN crm_institutions i ON op.institution_id = i.id
       LEFT JOIN users u ON op.assigned_to = u.id
       LEFT JOIN users uv ON op.validated_by = uv.id
       WHERE op.id = ?`,
      [req.params.id]
    );

    // Récupérer le plan d'action (les tâches)
    const [actions] = await pool.query(
      `SELECT act.*, u.full_name AS assigned_to_name
       FROM crm_opportunity_actions act
       LEFT JOIN users u ON act.assigned_to = u.id
       WHERE act.opportunity_id = ?
       ORDER BY act.due_date ASC, act.created_at ASC`,
      [req.params.id]
    );

    // Récupérer l'historique des transitions
    const [history] = await pool.query(
      `SELECT hist.*, u.full_name AS performed_by_name
       FROM crm_opportunity_stage_histories hist
       JOIN users u ON hist.performed_by = u.id
       WHERE hist.opportunity_id = ?
       ORDER BY hist.performed_at DESC`,
      [req.params.id]
    );

    // Récupérer les commentaires
    const [comments] = await pool.query(
      `SELECT c.*, u.full_name AS user_name
       FROM crm_opportunity_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.opportunity_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    // Récupérer les missions de suivi liées
    const [linkedMissions] = await pool.query(
      `SELECT m.id, m.title, m.scheduled_date, m.status, u.full_name AS commercial_name
       FROM crm_opportunity_mission_links l
       JOIN crm_missions m ON l.mission_id = m.id
       JOIN users u ON m.primary_commercial_id = u.id
       WHERE l.opportunity_id = ?`,
      [req.params.id]
    );

    // Récupérer les pièces jointes
    const [attachments] = await pool.query(
      `SELECT id, file_name, file_size, created_at
       FROM crm_opportunity_attachments
       WHERE opportunity_id = ?
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    return res.json({
      ...oppRows[0],
      actions,
      history,
      comments,
      linkedMissions,
      attachments
    });
  } catch (err) {
    console.error('[OPPORTUNITIES/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * POST / - Création d'une nouvelle opportunité
 */
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
    return res.status(400).json({ error: 'Données d\'opportunité invalides.' });
  }

  try {
    const code = 'OP-' + Math.random().toString(36).substring(2, 7).toUpperCase();

    const [result] = await pool.query(
      `INSERT INTO crm_opportunities (
        code, institution_id, title, need_description,
        estimated_amount, priority, assigned_to, status, pipeline_stage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DETECTED', 'DETECTION')`,
      [
        code, institution_id, title.trim(), need_description.trim(),
        Number(estimated_amount), priority || 'MEDIUM', assignedTo
      ]
    );

    const opportunityId = result.insertId;

    // Si issue d'une mission, ajouter la liaison
    if (Number(mission_id)) {
      await pool.query(
        `INSERT INTO crm_opportunity_mission_links (opportunity_id, mission_id, link_type)
         VALUES (?, ?, 'source')`,
        [opportunityId, Number(mission_id)]
      );
    }

    // Logger la création dans l'historique
    await OpportunityWorkflowService.logHistory(
      opportunityId, null, 'DETECTED', 'Créer opportunité', 'Détection initiale de l\'opportunité commerciale.', req.user.id
    );

    // Notification à la direction si créée par un commercial junior
    if (req.user.role === 'COMMERCIAL') {
      const { notifyDirection } = require('../utils/notifications');
      await notifyDirection(
        'Nouvelle Opportunité détectée',
        `${req.user.full_name} a détecté l'opportunité : "${title.trim()}" (${estimated_amount} FCFA).`,
        'OPPORTUNITY_CREATED',
        opportunityId
      );
    }

    return res.status(201).json({ id: opportunityId, code, message: 'Opportunité créée.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * PUT /:id - Modification manuelle (uniquement pour opportunités en brouillon/DETECTED ou TO_CORRECT)
 */
router.put('/:id', authenticate, async (req, res) => {
  const { title, need_description, estimated_amount, priority, assigned_to } = req.body;
  if (
    typeof title !== 'string' || !title.trim() || title.length > 150 ||
    typeof need_description !== 'string' || !need_description.trim() ||
    !Number.isFinite(Number(estimated_amount)) || Number(estimated_amount) <= 0 ||
    !PRIORITIES.includes(priority)
  ) {
    return res.status(400).json({ error: 'Données d\'opportunité invalides.' });
  }

  try {
    const opportunity = await getOpportunity(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunité introuvable.' });
    if (!canAccess(opportunity, req.user)) return res.status(403).json({ error: 'Accès refusé.' });

    // Un commercial ne peut modifier que si elle est détectée ou nécessite correction
    if (req.user.role === 'COMMERCIAL' && opportunity.status !== 'DETECTED' && opportunity.status !== 'TO_CORRECT') {
      return res.status(400).json({ error: 'Vous ne pouvez pas modifier une opportunité déjà soumise ou validée.' });
    }

    const assignedTo = isManager(req.user)
      ? (Number(assigned_to) || null)
      : opportunity.assigned_to;

    await pool.query(
      `UPDATE crm_opportunities
       SET title = ?, need_description = ?, estimated_amount = ?, priority = ?, assigned_to = ?
       WHERE id = ?`,
      [title.trim(), need_description.trim(), Number(estimated_amount), priority, assignedTo, req.params.id]
    );

    return res.json({ message: 'Opportunité mise à jour.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * DELETE /:id - Suppression (uniquement pour la direction / admin)
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: 'Accès refusé.' });
    const opportunity = await getOpportunity(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunité introuvable.' });
    
    await pool.query('DELETE FROM crm_opportunities WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Opportunité supprimée.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * =========================================================================
 * ROUTES DE TRANSITIONS DU PIPELINE
 * =========================================================================
 */

router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const result = await OpportunityWorkflowService.submit(req.params.id, req.user);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/validate', authenticate, async (req, res) => {
  try {
    const result = await OpportunityWorkflowService.validate(req.params.id, req.user);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/request-correction', authenticate, async (req, res) => {
  try {
    const { comment } = req.body;
    const result = await OpportunityWorkflowService.requestCorrection(req.params.id, req.user, comment);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reject', authenticate, async (req, res) => {
  try {
    const { comment } = req.body;
    const result = await OpportunityWorkflowService.reject(req.params.id, req.user, comment);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/start-analysis', authenticate, async (req, res) => {
  try {
    const result = await OpportunityWorkflowService.startAnalysis(req.params.id, req.user);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/create-action-plan', authenticate, async (req, res) => {
  try {
    const { actions } = req.body;
    const result = await OpportunityWorkflowService.createActionPlan(req.params.id, req.user, actions);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/move-to-proposal', authenticate, async (req, res) => {
  try {
    const { final_amount, comment } = req.body;
    const result = await OpportunityWorkflowService.moveToProposal(req.params.id, req.user, { final_amount, comment });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/move-to-negotiation', authenticate, async (req, res) => {
  try {
    const { comment } = req.body;
    const result = await OpportunityWorkflowService.moveToNegotiation(req.params.id, req.user, { comment });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/move-to-decision', authenticate, async (req, res) => {
  try {
    const { comment } = req.body;
    const result = await OpportunityWorkflowService.moveToDecision(req.params.id, req.user, { comment });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/mark-as-won', authenticate, async (req, res) => {
  try {
    const { final_amount, comment } = req.body;
    const result = await OpportunityWorkflowService.markAsWon(req.params.id, req.user, { final_amount, comment });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/mark-as-lost', authenticate, async (req, res) => {
  try {
    const { lost_reason, comment } = req.body;
    const result = await OpportunityWorkflowService.markAsLost(req.params.id, req.user, { lost_reason, comment });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/:id/archive', authenticate, async (req, res) => {
  try {
    const result = await OpportunityWorkflowService.archive(req.params.id, req.user);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /:id/follow-up-mission - Créer une mission de suivi terrain
 */
router.post('/:id/follow-up-mission', authenticate, async (req, res) => {
  try {
    const result = await OpportunityWorkflowService.createFollowUpMission(req.params.id, req.user, req.body);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /:id/comments - Ajouter un commentaire
 */
router.post('/:id/comments', authenticate, async (req, res) => {
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Commentaire vide.' });

  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'Opportunité introuvable.' });
    if (!canAccess(opp, req.user)) return res.status(403).json({ error: 'Accès refusé.' });

    const [result] = await pool.query(
      `INSERT INTO crm_opportunity_comments (opportunity_id, user_id, comment)
       VALUES (?, ?, ?)`,
      [req.params.id, req.user.id, comment.trim()]
    );

    return res.status(201).json({ id: result.insertId, message: 'Commentaire ajouté.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/ADD_COMMENT]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * PUT /:id/actions/:actionId - Mettre à jour une action du plan d'action
 */
router.put('/:id/actions/:actionId', authenticate, async (req, res) => {
  const { status } = req.body;
  if (status !== 'PENDING' && status !== 'COMPLETED') {
    return res.status(400).json({ error: 'Statut d\'action invalide.' });
  }

  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'Opportunité introuvable.' });
    if (!canAccess(opp, req.user)) return res.status(403).json({ error: 'Accès refusé.' });

    const completedAt = status === 'COMPLETED' ? 'CURRENT_TIMESTAMP' : 'NULL';
    await pool.query(
      `UPDATE crm_opportunity_actions 
       SET status = ?, completed_at = ${completedAt}
       WHERE id = ? AND opportunity_id = ?`,
      [status, req.params.actionId, req.params.id]
    );

    return res.json({ message: 'Action mise à jour.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/UPDATE_ACTION]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * POST /:id/attachments - Ajouter des pièces jointes à l'opportunité
 */
router.post('/:id/attachments', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ error: 'Opportunité introuvable.' });
    }
    if (!canAccess(opp, req.user)) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ error: 'Accès refusé.' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'Aucun fichier fourni.' });

    const inserts = req.files.map(file => [
      req.params.id,
      path.basename(file.originalname),
      file.path,
      file.size
    ]);
    await pool.query(
      `INSERT INTO crm_opportunity_attachments (opportunity_id, file_name, file_path, file_size)
       VALUES ?`,
      [inserts]
    );
    return res.status(201).json({ message: `${req.files.length} fichier(s) ajouté(s).` });
  } catch (err) {
    cleanupUploadedFiles(req.files);
    console.error('[OPPORTUNITIES/ATTACH]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /:id/attachments/:attId/download - Télécharger une pièce jointe d'opportunité
 */
router.get('/:id/attachments/:attId/download', authenticate, async (req, res) => {
  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'Opportunité introuvable.' });
    if (!canAccess(opp, req.user)) return res.status(403).json({ error: 'Accès refusé.' });

    const [rows] = await pool.query(
      `SELECT file_name, file_path
       FROM crm_opportunity_attachments
       WHERE id = ? AND opportunity_id = ?`,
      [req.params.attId, req.params.id]
    );
    if (!rows.length || !fs.existsSync(rows[0].file_path)) {
      return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    }
    return res.download(path.resolve(rows[0].file_path), rows[0].file_name);
  } catch (err) {
    console.error('[OPPORTUNITIES/DOWNLOAD]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * DELETE /:id/attachments/:attId - Supprimer une pièce jointe d'opportunité
 */
router.delete('/:id/attachments/:attId', authenticate, async (req, res) => {
  try {
    const opp = await getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'Opportunité introuvable.' });
    if (!canAccess(opp, req.user)) return res.status(403).json({ error: 'Accès refusé.' });

    const [rows] = await pool.query(
      `SELECT file_path
       FROM crm_opportunity_attachments
       WHERE id = ? AND opportunity_id = ?`,
      [req.params.attId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    if (fs.existsSync(rows[0].file_path)) fs.unlinkSync(rows[0].file_path);
    await pool.query(
      'DELETE FROM crm_opportunity_attachments WHERE id = ? AND opportunity_id = ?',
      [req.params.attId, req.params.id]
    );
    return res.json({ message: 'Pièce jointe supprimée.' });
  } catch (err) {
    console.error('[OPPORTUNITIES/ATTACH_DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
