const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);
const REPORT_STATUSES = ['DRAFT', 'SUBMITTED', 'VALIDATED', 'REJECTED'];
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
  const [rows] = await pool.query(
    `SELECT rp.*, m.primary_commercial_id
     FROM crm_reports rp
     JOIN crm_missions m ON rp.mission_id = m.id
     WHERE rp.id = ?`,
    [reportId]
  );
  if (!rows.length) return { report: null, allowed: false };
  return {
    report: rows[0],
    allowed: isManager(user) || rows[0].primary_commercial_id === user.id
  };
}

async function canAccessMission(missionId, user) {
  if (isManager(user)) return true;
  const [rows] = await pool.query(
    `SELECT 1
     FROM crm_missions
     WHERE id = ? AND primary_commercial_id = ?`,
    [missionId, user.id]
  );
  return rows.length > 0;
}

router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT rp.*, m.title AS mission_title, m.scheduled_date,
             u.full_name AS commercial_name
      FROM crm_reports rp
      JOIN crm_missions m ON rp.mission_id = m.id
      JOIN users u ON m.primary_commercial_id = u.id`;
    const params = [];
    const conditions = [];
    if (req.user.role === 'COMMERCIAL') {
      conditions.push('m.primary_commercial_id = ?');
      params.push(req.user.id);
    }
    if (status && REPORT_STATUSES.includes(status)) {
      conditions.push('rp.status = ?');
      params.push(status);
    }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY rp.created_at DESC';
    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[REPORTS/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    const [rows] = await pool.query(
      `SELECT rp.*, m.title AS mission_title, m.scheduled_date,
              i.name AS institution_name, u.full_name AS commercial_name
       FROM crm_reports rp
       JOIN crm_missions m ON rp.mission_id = m.id
       JOIN crm_institutions i ON m.institution_id = i.id
       JOIN users u ON m.primary_commercial_id = u.id
       WHERE rp.id = ?`,
      [req.params.id]
    );
    const [attachments] = await pool.query(
      `SELECT id, report_id, file_name, file_size, created_at
       FROM crm_report_attachments
       WHERE report_id = ?`,
      [req.params.id]
    );
    return res.json({ ...rows[0], attachments });
  } catch (err) {
    console.error('[REPORTS/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const {
    mission_id, executive_summary, administrations_visited,
    persons_met, difficulties, recommendations
  } = req.body;
  if (
    !Number(mission_id) || typeof executive_summary !== 'string' ||
    !executive_summary.trim() || typeof administrations_visited !== 'string' ||
    !administrations_visited.trim() || typeof persons_met !== 'string' ||
    !persons_met.trim()
  ) {
    return res.status(400).json({ error: 'Donnees de rapport invalides.' });
  }

  try {
    if (!(await canAccessMission(mission_id, req.user))) {
      return res.status(403).json({ error: 'Acces refuse a cette mission.' });
    }
    const [result] = await pool.query(
      `INSERT INTO crm_reports (
        mission_id, executive_summary, administrations_visited,
        persons_met, difficulties, recommendations, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT')`,
      [
        mission_id, executive_summary.trim(), administrations_visited.trim(),
        persons_met.trim(), difficulties || null, recommendations || null
      ]
    );
    return res.status(201).json({ id: result.insertId, message: 'Rapport cree.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Un rapport existe deja pour cette mission.' });
    }
    console.error('[REPORTS/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/:id', authenticate, async (req, res) => {
  const {
    executive_summary, administrations_visited, persons_met,
    difficulties, recommendations, status
  } = req.body;
  if (
    typeof executive_summary !== 'string' || !executive_summary.trim() ||
    typeof administrations_visited !== 'string' || !administrations_visited.trim() ||
    typeof persons_met !== 'string' || !persons_met.trim() ||
    !REPORT_STATUSES.includes(status)
  ) {
    return res.status(400).json({ error: 'Donnees de rapport invalides.' });
  }

  try {
    const access = await getReportAccess(req.params.id, req.user);
    if (!access.report) return res.status(404).json({ error: 'Rapport introuvable.' });
    if (!access.allowed) return res.status(403).json({ error: 'Acces refuse.' });

    if (!isManager(req.user)) {
      const allowedTransition =
        status === access.report.status ||
        (['DRAFT', 'REJECTED'].includes(access.report.status) && ['DRAFT', 'SUBMITTED'].includes(status));
      if (!allowedTransition) {
        return res.status(409).json({ error: 'Transition de rapport interdite.' });
      }
    } else {
      const managerTransition =
        status === access.report.status ||
        (access.report.status === 'DRAFT' && status === 'SUBMITTED') ||
        (access.report.status === 'SUBMITTED' && ['VALIDATED', 'REJECTED'].includes(status)) ||
        (access.report.status === 'REJECTED' && ['DRAFT', 'SUBMITTED'].includes(status));
      if (!managerTransition) {
        return res.status(409).json({ error: 'Transition de rapport interdite.' });
      }
    }

    await pool.query(
      `UPDATE crm_reports
       SET executive_summary = ?, administrations_visited = ?, persons_met = ?,
           difficulties = ?, recommendations = ?, status = ?
       WHERE id = ?`,
      [
        executive_summary.trim(), administrations_visited.trim(), persons_met.trim(),
        difficulties || null, recommendations || null, status, req.params.id
      ]
    );

    if (status === 'SUBMITTED' && access.report.status !== 'SUBMITTED') {
      const { notifyDirection } = require('../utils/notifications');
      const [missionRows] = await pool.query(
        `SELECT u.full_name, m.title AS mission_title
         FROM crm_reports rp
         JOIN crm_missions m ON rp.mission_id = m.id
         JOIN users u ON m.primary_commercial_id = u.id
         WHERE rp.id = ?`,
        [req.params.id]
      );
      if (missionRows.length) {
        await notifyDirection(
          'Rapport Soumis',
          `${missionRows[0].full_name} a soumis le rapport de la mission "${missionRows[0].mission_title}" pour validation.`,
          'REPORT_SUBMITTED',
          req.params.id
        );
      }
    }
    return res.json({ message: 'Rapport mis a jour.' });
  } catch (err) {
    console.error('[REPORTS/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

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
    console.error('[REPORTS/DOWNLOAD]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

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
