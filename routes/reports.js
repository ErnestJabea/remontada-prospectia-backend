const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const ReportWorkflowService = require('../services/reportWorkflow');
const ReportPdfService = require('../services/reportPdfService');

const router = express.Router();
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);

const ALLOWED_FILE_TYPES = new Map([
  ['application/pdf', new Set(['.pdf'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Set(['.docx'])],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Set(['.xlsx'])]
]);

const uploadDir = path.join(__dirname, '..', 'uploads', 'reports');
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

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

function cleanupUploadedFiles(files = []) {
  for (const file of files) {
    if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
}

async function getReportAccess(reportId, user) {
  const report = await ReportWorkflowService.getReport(reportId);
  if (!report) return { report: null, allowed: false };
  return {
    report,
    allowed: ReportWorkflowService.canAccess(report, user)
  };
}

/**
 * GET /api/reports - List activity reports
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, report_type, commercial_id, institution_id } = req.query;

    let query = `
      SELECT rp.*, 
             m.title AS mission_title, m.scheduled_date,
             o.title AS objective_title,
             i.name AS institution_name,
             u.full_name AS commercial_name
      FROM crm_reports rp
      LEFT JOIN crm_missions m ON rp.mission_id = m.id
      LEFT JOIN crm_objectives o ON rp.objective_id = o.id
      LEFT JOIN crm_institutions i ON rp.institution_id = i.id
      LEFT JOIN users u ON rp.commercial_id = u.id
    `;
    const params = [];
    const conditions = [];

    // Role-based restrictions
    if (req.user.role === 'COMMERCIAL') {
      conditions.push('(rp.commercial_id = ? OR m.primary_commercial_id = ?)');
      params.push(req.user.id, req.user.id);
    } else if (commercial_id) {
      conditions.push('(rp.commercial_id = ? OR m.primary_commercial_id = ?)');
      params.push(Number(commercial_id), Number(commercial_id));
    }

    if (status) {
      conditions.push('rp.status = ?');
      params.push(status);
    }
    if (report_type) {
      conditions.push('rp.report_type = ?');
      params.push(report_type);
    }
    if (institution_id) {
      conditions.push('rp.institution_id = ?');
      params.push(Number(institution_id));
    }

    if (conditions.length) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY rp.created_at DESC';

    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[REPORTS/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /api/reports/:id - Get report details
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    const [rows] = await pool.query(
      `SELECT rp.*, 
              m.title AS mission_title, m.scheduled_date,
              o.title AS objective_title, 
              i.name AS institution_name, i.address AS institution_address,
              u.full_name AS commercial_name,
              submitted.full_name AS submitted_by_name,
              validated.full_name AS validated_by_name,
              rejected.full_name AS rejected_by_name,
              correction.full_name AS correction_requested_by_name,
              archived.full_name AS archived_by_name
       FROM crm_reports rp
       LEFT JOIN crm_missions m ON rp.mission_id = m.id
       LEFT JOIN crm_objectives o ON rp.objective_id = o.id
       LEFT JOIN crm_institutions i ON rp.institution_id = i.id
       LEFT JOIN users u ON rp.commercial_id = u.id
       LEFT JOIN users submitted ON rp.submitted_by = submitted.id
       LEFT JOIN users validated ON rp.validated_by = validated.id
       LEFT JOIN users rejected ON rp.rejected_by = rejected.id
       LEFT JOIN users correction ON rp.correction_requested_by = correction.id
       LEFT JOIN users archived ON rp.archived_by = archived.id
       WHERE rp.id = ?`,
      [req.params.id]
    );

    // Fetch attachments
    const [attachments] = await pool.query(
      `SELECT id, file_name, file_size, created_at
       FROM crm_report_attachments
       WHERE report_id = ?`,
      [req.params.id]
    );

    // Fetch linked opportunities
    const [opportunities] = await pool.query(
      `SELECT o.*, ro.relation_type
       FROM crm_report_opportunities ro
       JOIN crm_opportunities o ON ro.opportunity_id = o.id
       WHERE ro.activity_report_id = ?`,
      [req.params.id]
    );

    // Fetch workflow history
    const [history] = await pool.query(
      `SELECT h.*, u.full_name AS performed_by_name
       FROM crm_report_histories h
       JOIN users u ON h.performed_by = u.id
       WHERE h.activity_report_id = ?
       ORDER BY h.performed_at ASC`,
      [req.params.id]
    );

    // Fetch comments
    const [comments] = await pool.query(
      `SELECT c.*, u.full_name AS user_name, u.avatar_url
       FROM crm_report_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.activity_report_id = ?
       ORDER BY c.created_at ASC`,
      [req.params.id]
    );

    return res.json({
      ...rows[0],
      attachments,
      opportunities,
      history,
      comments
    });
  } catch (err) {
    console.error('[REPORTS/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * POST /api/reports - Create manual draft report
 */
router.post('/', authenticate, async (req, res) => {
  const {
    report_type, mission_id, objective_id, institution_id,
    period_start, period_end, executive_summary, results,
    diagnosis, difficulties, recommendations, next_steps
  } = req.body;

  try {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const defaultType = report_type || 'activity_report';

    const [result] = await pool.query(
      `INSERT INTO crm_reports (
        report_type, mission_id, objective_id, institution_id,
        commercial_id, period_start, period_end, status,
        executive_summary, results, diagnosis, difficulties,
        recommendations, next_steps, generated_from, generated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'A_COMPLETER', ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [
        defaultType,
        mission_id ? Number(mission_id) : null,
        objective_id ? Number(objective_id) : null,
        institution_id ? Number(institution_id) : null,
        req.user.id,
        period_start || null,
        period_end || null,
        (executive_summary || '').trim(),
        (results || '').trim(),
        (diagnosis || '').trim(),
        (difficulties || '').trim(),
        (recommendations || '').trim(),
        (next_steps || '').trim(),
        req.user.id
      ]
    );

    const reportId = result.insertId;
    const code = `RAP-${dateStr}-${String(reportId).padStart(4, '0')}`;
    
    await pool.query('UPDATE crm_reports SET code = ? WHERE id = ?', [code, reportId]);

    // Log history
    await ReportWorkflowService.logHistory(reportId, null, 'A_COMPLETER', 'Création manuelle', 'Brouillon créé manuellement', req.user.id);

    return res.status(201).json({ id: reportId, code, message: 'Rapport créé.' });
  } catch (err) {
    console.error('[REPORTS/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * PUT /api/reports/:id - Update report details
 */
router.put('/:id', authenticate, async (req, res) => {
  const {
    executive_summary, results, diagnosis, difficulties,
    recommendations, next_steps, institution_id, objective_id,
    period_start, period_end, persons_met, opportunities
  } = req.body;

  const conn = await pool.getConnection();
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) {
      conn.release();
      return res.status(404).json({ error: 'Rapport introuvable.' });
    }
    if (!access.allowed) {
      conn.release();
      return res.status(403).json({ error: 'Acces refuse.' });
    }

    // Enforce workflow restrictions: non-managers can only edit if report is in draft/to-correct status
    const editableStatuses = ['BROUILLON_AUTO', 'A_COMPLETER', 'CORRECTION_DEMANDEE', 'DRAFT', 'REJECTED'];
    if (!isManager(req.user) && !editableStatuses.includes(access.report.status)) {
      conn.release();
      return res.status(409).json({ error: 'Modification impossible sur un rapport soumis ou validé.' });
    }

    await conn.beginTransaction();

    // 1. Update crm_reports table
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
        (executive_summary || '').trim(),
        (results || '').trim(),
        (diagnosis || '').trim(),
        (difficulties || '').trim(),
        (recommendations || '').trim(),
        (next_steps || '').trim(),
        institution_id ? Number(institution_id) : access.report.institution_id,
        objective_id ? Number(objective_id) : access.report.objective_id,
        period_start || access.report.period_start,
        period_end || access.report.period_end,
        typeof persons_met === 'object' ? JSON.stringify(persons_met) : (persons_met || ''),
        req.params.id
      ]
    );

    // 2. Manage Opportunities links/creation
    if (Array.isArray(opportunities)) {
      // Get existing links to know what to delete
      const [existingLinks] = await conn.query(
        'SELECT opportunity_id FROM crm_report_opportunities WHERE activity_report_id = ?',
        [req.params.id]
      );
      const existingOppIds = new Set(existingLinks.map(l => l.opportunity_id));
      const keepOppIds = new Set();

      for (const opp of opportunities) {
        let oppId = opp.id;

        // If it's a new opportunity creation payload (has a title and is not a number)
        if (opp.title && isNaN(Number(opp.id))) {
          // Double validation check
          const doubleValidationRequired = parseFloat(opp.estimated_amount) > 50000000;
          const initialStatus = doubleValidationRequired ? 'SUBMITTED' : 'DETECTED';

          const [oppInsert] = await conn.query(
            `INSERT INTO crm_opportunities (
              institution_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              institution_id ? Number(institution_id) : access.report.institution_id,
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
          // Insert or update link
          await conn.query(
            `INSERT INTO crm_report_opportunities (activity_report_id, opportunity_id, relation_type)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE relation_type = VALUES(relation_type)`,
            [req.params.id, Number(oppId), opp.relation_type || 'PRIMARY']
          );
        }
      }

      // Delete old links that were removed
      for (const oldId of existingOppIds) {
        if (!keepOppIds.has(oldId)) {
          await conn.query(
            'DELETE FROM crm_report_opportunities WHERE activity_report_id = ? AND opportunity_id = ?',
            [req.params.id, oldId]
          );
        }
      }
    }

    await conn.commit();
    return res.json({ message: 'Rapport mis a jour avec ses liaisons opportunites.' });
  } catch (err) {
    await conn.rollback();
    console.error('[REPORTS/UPDATE_SYNC]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    conn.release();
  }
});

/**
 * POST /api/reports/:id/submit - Submit report
 */
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const result = await ReportWorkflowService.submit(req.params.id, req.user);
    return res.json(result);
  } catch (err) {
    console.error('[REPORTS/SUBMIT]', err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/reports/:id/request-correction - Request correction
 */
router.post('/:id/request-correction', authenticate, async (req, res) => {
  const { comment } = req.body;
  try {
    const result = await ReportWorkflowService.requestCorrection(req.params.id, req.user, comment);
    return res.json(result);
  } catch (err) {
    console.error('[REPORTS/CORRECTION]', err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/reports/:id/validate - Validate report
 */
router.post('/:id/validate', authenticate, async (req, res) => {
  try {
    const result = await ReportWorkflowService.validateReport(req.params.id, req.user);
    
    // Auto generate and store PDF
    try {
      await ReportPdfService.generatePdf(req.params.id);
    } catch (pdfErr) {
      console.error('[REPORTS/VALIDATE/PDF] Failed to generate PDF:', pdfErr);
    }

    return res.json(result);
  } catch (err) {
    console.error('[REPORTS/VALIDATE]', err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/reports/:id/reject - Reject report
 */
router.post('/:id/reject', authenticate, async (req, res) => {
  const { comment } = req.body;
  try {
    const result = await ReportWorkflowService.reject(req.params.id, req.user, comment);
    return res.json(result);
  } catch (err) {
    console.error('[REPORTS/REJECT]', err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/reports/:id/archive - Archive report
 */
router.post('/:id/archive', authenticate, async (req, res) => {
  try {
    const result = await ReportWorkflowService.archive(req.params.id, req.user);
    return res.json(result);
  } catch (err) {
    console.error('[REPORTS/ARCHIVE]', err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/reports/:id/download-pdf - Download generated PDF
 */
router.get('/:id/download-pdf', authenticate, async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    let finalPath = '';
    if (access.report.pdf_path) {
      finalPath = path.resolve(__dirname, '..', access.report.pdf_path);
    }

    if (!finalPath || !fs.existsSync(finalPath)) {
      // Generate PDF dynamically if not present
      finalPath = await ReportPdfService.generatePdf(req.params.id);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-${access.report.code || req.params.id}.pdf"`);
    return res.sendFile(finalPath);
  } catch (err) {
    console.error('[REPORTS/DOWNLOAD_PDF]', err);
    return res.status(500).json({ error: 'Impossible de generer ou telecharger le PDF.' });
  }
});

/**
 * POST /api/reports/:id/comments - Add report comment
 */
router.post('/:id/comments', authenticate, async (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) {
    return res.status(400).json({ error: 'Commentaire vide.' });
  }

  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    await pool.query(
      `INSERT INTO crm_report_comments (activity_report_id, user_id, comment)
       VALUES (?, ?, ?)`,
      [req.params.id, req.user.id, comment.trim()]
    );

    return res.status(201).json({ message: 'Commentaire ajoute.' });
  } catch (err) {
    console.error('[REPORTS/ADD_COMMENT]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * POST /api/reports/:id/opportunities - Link opportunity to report
 */
router.post('/:id/opportunities', authenticate, async (req, res) => {
  const { opportunity_id, relation_type } = req.body;
  if (!opportunity_id || !relation_type) {
    return res.status(400).json({ error: 'Champs manquants.' });
  }

  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    await pool.query(
      `INSERT INTO crm_report_opportunities (activity_report_id, opportunity_id, relation_type)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE relation_type = VALUES(relation_type)`,
      [req.params.id, Number(opportunity_id), relation_type]
    );

    return res.status(201).json({ message: 'Opportunite liee avec succes.' });
  } catch (err) {
    console.error('[REPORTS/LINK_OPPORTUNITY]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * DELETE /api/reports/:id/opportunities/:oppId - Unlink opportunity from report
 */
router.delete('/:id/opportunities/:oppId', authenticate, async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    await pool.query(
      `DELETE FROM crm_report_opportunities 
       WHERE activity_report_id = ? AND opportunity_id = ?`,
      [req.params.id, Number(req.params.oppId)]
    );

    return res.json({ message: 'Lien opportunite supprime.' });
  } catch (err) {
    console.error('[REPORTS/UNLINK_OPPORTUNITY]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * POST /api/reports/:id/attachments - Add attachment
 */
router.post('/:id/attachments', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ error: 'Rapport introuvable.' });
    }
    if (!access.allowed) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ error: 'Acces refuse.' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'Aucun fichier fourni.' });

    const inserts = req.files.map(file => [
      req.params.id,
      path.basename(file.originalname),
      file.path,
      file.size
    ]);
    await pool.query(
      `INSERT INTO crm_report_attachments (report_id, file_name, file_path, file_size)
       VALUES ?`,
      [inserts]
    );
    return res.status(201).json({ message: `${req.files.length} fichier(s) ajoute(s).` });
  } catch (err) {
    cleanupUploadedFiles(req.files);
    console.error('[REPORTS/ATTACH]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /api/reports/:id/attachments/:attId/download - Download attachment
 */
router.get('/:id/attachments/:attId/download', authenticate, async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    const [rows] = await pool.query(
      `SELECT file_name, file_path
       FROM crm_report_attachments
       WHERE id = ? AND report_id = ?`,
      [req.params.attId, req.params.id]
    );
    if (!rows.length || !fs.existsSync(rows[0].file_path)) {
      return res.status(404).json({ error: 'Piece jointe introuvable.' });
    }
    return res.download(path.resolve(rows[0].file_path), rows[0].file_name);
  } catch (err) {
    console.error('[REPORTS/DOWNLOAD_ATTACHMENT]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * DELETE /api/reports/:id/attachments/:attId - Delete attachment
 */
router.delete('/:id/attachments/:attId', authenticate, async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    const [rows] = await pool.query(
      `SELECT file_path
       FROM crm_report_attachments
       WHERE id = ? AND report_id = ?`,
      [req.params.attId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Piece jointe introuvable.' });
    if (fs.existsSync(rows[0].file_path)) fs.unlinkSync(rows[0].file_path);
    await pool.query(
      'DELETE FROM crm_report_attachments WHERE id = ? AND report_id = ?',
      [req.params.attId, req.params.id]
    );
    return res.json({ message: 'Piece jointe supprimee.' });
  } catch (err) {
    console.error('[REPORTS/ATTACH_DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
