const canLinkRecord = require('../utils/linkedAccess');
const express = require('express');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const multer = require('multer');
const ReportWorkflowService = require('../services/reportWorkflow');
const { resolveMissionTravel, travelScopeLabel } = require('../services/missionTravelService');
const {
  ensureMissionTargetTables,
  normalizeMissionTargets,
  upsertMissionTargets,
  getMissionTargets
} = require('../services/missionTargetService');
const { deleteStoredUpload, sendStoredUpload, validateUploadedFilesContent } = require('../utils/uploadSecurity');

const router = express.Router();

const ALLOWED_FILE_TYPES = new Map([
  ['application/pdf', new Set(['.pdf'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Set(['.docx'])],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Set(['.xlsx'])]
]);

const uploadDir = path.join(__dirname, '..', 'uploads', 'missions');
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
    if (file.path) deleteStoredUpload(file.path);
  }
}
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);
const ALLOWED_STATUSES = [
  'DRAFT', 'SUBMITTED', 'IN_VALIDATION', 'VALIDATED', 'PLANNED',
  'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED', 'POSTPONED'
];
const VALID_ORDER_STATUSES = new Set(['VALIDATED', 'PLANNED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED']);
const STATUS_TRANSITIONS = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['IN_VALIDATION', 'REJECTED', 'CANCELLED'],
  IN_VALIDATION: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['PLANNED', 'CANCELLED'],
  PLANNED: ['IN_PROGRESS', 'POSTPONED', 'CANCELLED'],
  POSTPONED: ['PLANNED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'POSTPONED', 'CANCELLED'],
  COMPLETED: ['CLOSED'],
  REJECTED: ['DRAFT'],
  CLOSED: [],
  CANCELLED: []
};
const COMMERCIAL_STATUS_TRANSITIONS = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  REJECTED: ['DRAFT'],
  PLANNED: ['IN_PROGRESS', 'POSTPONED'],
  POSTPONED: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED', 'POSTPONED']
};
const STRATEGIC_OBJECTIVES = [
  'OBTENIR_RDV', 'IDENTIFIER_BESOIN', 'QUALIFIER_OPPORTUNITE',
  'PREPARER_OFFRE', 'CARTOGRAPHIER_ACTEURS', 'INTELLIGENCE_ECONOMIQUE', 'AUTRE'
];
const MISSION_EXTRA_COLUMNS = [
  ['mission_reference', "VARCHAR(40) DEFAULT NULL"],
  ['mission_type', "VARCHAR(50) DEFAULT 'PROSPECTION'"],
  ['strategic_objective', "VARCHAR(80) DEFAULT NULL"],
  ['expected_result', 'TEXT NULL'],
  ['target_decision_maker', 'VARCHAR(150) DEFAULT NULL'],
  ['target_technical_prescriber', 'VARCHAR(150) DEFAULT NULL'],
  ['target_influencer', 'VARCHAR(150) DEFAULT NULL'],
  ['target_contacts', 'TEXT NULL'],
  ['need_hypotheses', 'TEXT NULL'],
  ['visit_approach', 'TEXT NULL'],
  ['key_questions', 'TEXT NULL'],
  ['key_messages', 'TEXT NULL'],
  ['risks', 'TEXT NULL'],
  ['planned_measures', 'TEXT NULL'],
  ['completion_request', 'TEXT NULL'],
  ['gate1_validated_at', 'DATETIME NULL'],
  ['gate1_validated_by', 'INT NULL'],
  ['order_verification_token', 'VARCHAR(96) DEFAULT NULL'],
  ['started_at', 'DATETIME NULL'],
  ['check_in_at', 'DATETIME NULL'],
  ['check_in_latitude', 'DECIMAL(10,7) NULL'],
  ['check_in_longitude', 'DECIMAL(10,7) NULL'],
  ['completed_at', 'DATETIME NULL'],
  ['closed_at', 'DATETIME NULL'],
  ['base_city_id', 'INT NULL'],
  ['client_request_id', 'VARCHAR(36) NULL UNIQUE'],
  ['travel_scope', "ENUM('IN_CITY','OUT_OF_CITY') NULL"],
  ['departure_at', 'DATETIME NULL'],
  ['return_at', 'DATETIME NULL'],
  ['transport_mode', 'VARCHAR(40) NULL'],
  ['accommodation_required', 'BOOLEAN NOT NULL DEFAULT FALSE'],
  ['estimated_travel_cost', 'DECIMAL(15,2) NOT NULL DEFAULT 0']
];
let ensureMissionColumnsPromise;

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).map(v => v.trim()).filter(Boolean);
    } catch (err) {
      return value.split('\n').map(v => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function serializeArray(value) {
  return JSON.stringify(normalizeArray(value));
}

function normalizeContacts(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map(contact => ({
      role: String(contact.role || 'AUTRE').trim(),
      name: String(contact.name || '').trim(),
      phone: String(contact.phone || '').trim(),
      email: String(contact.email || '').trim()
    }))
    .filter(contact => contact.name || contact.phone || contact.email);
}

function serializeContacts(value) {
  return JSON.stringify(normalizeContacts(value));
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return String(value).split('\n').map(item => item.trim()).filter(Boolean);
  }
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function roleLabel(role) {
  const labels = {
    DECIDEUR_PRINCIPAL: 'Decideur principal',
    PRESCRIPTEUR_TECHNIQUE: 'Prescripteur technique',
    INFLUENCEUR: 'Influenceur',
    AUTRE: 'Autre contact'
  };
  return labels[role] || role || 'Contact';
}

function strategicObjectiveLabel(value) {
  const labels = {
    OBTENIR_RDV: 'Obtenir un rendez-vous',
    IDENTIFIER_BESOIN: 'Identifier un besoin',
    QUALIFIER_OPPORTUNITE: 'Qualifier une opportunite',
    PREPARER_OFFRE: 'Preparer une offre',
    CARTOGRAPHIER_ACTEURS: 'Cartographier les acteurs',
    INTELLIGENCE_ECONOMIQUE: 'Intelligence economique',
    AUTRE: 'Autre'
  };
  return labels[value] || value || '-';
}

function transportModeLabel(value) {
  const labels = {
    SERVICE_VEHICLE: 'Véhicule de service',
    PERSONAL_VEHICLE: 'Véhicule personnel',
    PUBLIC_TRANSPORT: 'Transport public',
    AIR: 'Avion',
    OTHER: 'Autre'
  };
  return labels[value] || value || '-';
}

function addPdfSection(doc, title) {
  doc.moveDown(0.65);
  const sectionY = doc.y;
  doc.roundedRect(54, sectionY, 487, 22, 5).fill('#f1f5f9');
  doc.rect(54, sectionY, 4, 22).fill('#e31e24');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a')
    .text(title.toUpperCase(), 66, sectionY + 6, { width: 463, lineBreak: false });
  doc.y = sectionY + 29;
  doc.x = 54;
}

function addPdfField(doc, label, value) {
  const rowY = doc.y;
  const safeValue = value === undefined || value === null || value === '' ? '-' : String(value);
  const labelWidth = 118;
  const valueX = 180;
  const valueWidth = 361;
  doc.font('Helvetica-Bold').fontSize(8.4).fillColor('#475569');
  const labelHeight = doc.heightOfString(label, { width: labelWidth });
  doc.text(label, 54, rowY, { width: labelWidth });
  doc.font('Helvetica').fontSize(8.7).fillColor('#111827');
  const valueHeight = doc.heightOfString(safeValue, { width: valueWidth });
  doc.text(safeValue, valueX, rowY, { width: valueWidth });
  doc.y = rowY + Math.max(labelHeight, valueHeight) + 3;
  doc.x = 54;
}

function addPdfList(doc, items, emptyText = '-') {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(emptyText);
    return;
  }
  list.forEach(item => {
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(`- ${item}`);
  });
}

function ensurePdfSpace(doc, minHeight = 120) {
  if (doc.y > 772 - minHeight) doc.addPage();
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildVerificationSignature(mission, token) {
  return crypto
    .createHash('sha256')
    .update(`${mission.id}|${mission.mission_reference || ''}|${mission.gate1_validated_at || ''}|${token}`)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
}

function buildVerificationUrl(req, missionId, token) {
  const baseUrl = String(
    process.env.MISSION_VERIFICATION_PUBLIC_URL
      || process.env.API_PUBLIC_URL
      || `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
  return `${baseUrl}/api/v1/missions/${missionId}/order/verify?token=${encodeURIComponent(token)}`;
}

function secureTokenMatches(storedToken, suppliedToken) {
  const stored = Buffer.from(String(storedToken || ''), 'utf8');
  const supplied = Buffer.from(String(suppliedToken || ''), 'utf8');
  return stored.length === supplied.length
    && stored.length > 0
    && crypto.timingSafeEqual(stored, supplied);
}

function escapeHtml(value) {
  return String(value ?? '-')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderVerificationPage({ state, mission = null, signature = '', checkedAt = new Date(), nonce = '' }) {
  const isValid = state === 'VALID';
  const isRevoked = state === 'REVOKED';
  const theme = isValid
    ? { color: '#047857', soft: '#ecfdf5', border: '#a7f3d0', icon: '&#10003;', label: 'Ordre de mission valide' }
    : isRevoked
      ? { color: '#b45309', soft: '#fffbeb', border: '#fde68a', icon: '!', label: 'Ordre de mission révoqué' }
      : { color: '#b91c1c', soft: '#fef2f2', border: '#fecaca', icon: '&#215;', label: 'Document non vérifié' };
  const reference = mission?.mission_reference || mission?.id || 'inconnue';
  const description = isValid
    ? "Cette référence correspond à un ordre de mission validé et actuellement autorisé dans Remontada Prospectia."
    : isRevoked
      ? "Cette référence a existé, mais son statut actuel ne permet plus de l'utiliser comme ordre de mission valide."
      : "Le lien est incomplet, invalide ou ne correspond à aucun ordre de mission authentifié.";
  const details = mission ? `
    <section class="details" aria-label="Informations vérifiées">
      <div><span>Référence</span><strong>${escapeHtml(reference)}</strong></div>
      <div><span>Date de validation</span><strong>${escapeHtml(formatDateTime(mission.gate1_validated_at))}</strong></div>
    </section>
    <section class="signature-block">
      <span>Empreinte numérique du document</span>
      <code>${escapeHtml(signature)}</code>
    </section>` : '';

  return `<!doctype html>
  <html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Vérification d'un ordre de mission</title>
    <style nonce="${escapeHtml(nonce)}">
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0f172a; background: #f8fafc; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #fff 0, #f8fafc 44%, #eef2f7 100%); padding: 24px 16px; }
      main { width: min(680px, 100%); margin: 0 auto; }
      .brand { display: flex; align-items: center; gap: 12px; margin: 0 0 18px; }
      .brand-mark { width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; background: #e31e24; color: white; font-weight: 900; letter-spacing: -.04em; box-shadow: 0 10px 24px rgba(227,30,36,.22); }
      .brand strong { display: block; font-size: 1rem; }
      .brand span { color: #64748b; font-size: .78rem; }
      .card { overflow: hidden; background: #fff; border: 1px solid #e2e8f0; border-radius: 24px; box-shadow: 0 24px 70px rgba(15,23,42,.10); }
      .status { padding: 26px; background: ${theme.soft}; border-bottom: 1px solid ${theme.border}; }
      .status-line { display: flex; align-items: center; gap: 14px; }
      .status-icon { width: 48px; height: 48px; flex: 0 0 48px; display: grid; place-items: center; border-radius: 50%; color: white; background: ${theme.color}; font-size: 1.45rem; font-weight: 900; }
      .status-label { color: ${theme.color}; font-size: .76rem; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 3px 0 0; font-size: clamp(1.35rem, 5vw, 2rem); line-height: 1.15; }
      .status p { color: #475569; line-height: 1.55; margin: 15px 0 0; }
      .content { padding: 26px; }
      .details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .details div { min-width: 0; padding: 14px; border: 1px solid #e2e8f0; border-radius: 14px; background: #f8fafc; }
      .details span, .signature-block span { display: block; margin-bottom: 5px; color: #64748b; font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
      .details strong { display: block; overflow-wrap: anywhere; font-size: .92rem; line-height: 1.35; }
      .signature-block { margin-top: 18px; padding: 16px; border-radius: 14px; background: #0f172a; color: white; }
      .signature-block span { color: #94a3b8; }
      code { display: block; overflow-wrap: anywhere; font-size: .8rem; color: #d1fae5; }
      footer { display: flex; justify-content: space-between; gap: 12px; padding: 18px 26px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: .72rem; }
      @media (max-width: 560px) { body { padding: 12px; } .status, .content { padding: 20px; } .details { grid-template-columns: 1fr; } footer { align-items: flex-start; flex-direction: column; } }
    </style>
  </head>
  <body>
    <main>
      <div class="brand"><div class="brand-mark">RP</div><div><strong>Remontada Prospectia</strong><span>Vérification officielle des ordres de mission</span></div></div>
      <article class="card">
        <header class="status">
          <div class="status-line"><div class="status-icon">${theme.icon}</div><div><div class="status-label">${theme.label}</div><h1>${isValid ? `Référence ${escapeHtml(reference)}` : theme.label}</h1></div></div>
          <p>${description}</p>
        </header>
        <div class="content">${details || '<p>Aucune donnée opérationnelle n’est affichée pour ce lien.</p>'}</div>
        <footer><span>Contrôle effectué le ${escapeHtml(formatDateTime(checkedAt))}</span><span>Ne pas se fier à une copie dont le QR code ne mène pas à cette page.</span></footer>
      </article>
    </main>
  </body>
  </html>`;
}

async function ensureMissionVerificationToken(mission) {
  if (mission.order_verification_token) return mission.order_verification_token;
  const token = generateVerificationToken();
  await pool.query(
    'UPDATE crm_missions SET order_verification_token = ? WHERE id = ?',
    [token, mission.id]
  );
  mission.order_verification_token = token;
  return token;
}

function drawPdfLogo(doc, logoPath, x, y, options = {}) {
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, x, y, options);
  }
}

async function ensureMissionColumns() {
  if (!ensureMissionColumnsPromise) {
    ensureMissionColumnsPromise = (async () => {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'crm_missions'`
      );
      const existing = new Set(rows.map(row => row.COLUMN_NAME));
      for (const [name, definition] of MISSION_EXTRA_COLUMNS) {
        if (!existing.has(name)) {
          await pool.query(`ALTER TABLE crm_missions ADD COLUMN ${name} ${definition}`).catch(err => {
            console.warn(`[AUTO_MIGRATE_WARN] crm_missions.${name}:`, err?.message);
          });
        }
      }
      // Verifier la colonne base_city_id sur users
      const [userCols] = await pool.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'base_city_id'`
      );
      if (!userCols.length) {
        await pool.query('ALTER TABLE users ADD COLUMN base_city_id INT NULL AFTER job_description_id').catch(() => {});
      }
      // Verifier les colonnes bilingues name_en sur les referentiels
      for (const refTable of ['crm_ref_regions', 'crm_ref_departments', 'crm_ref_cities']) {
        const [refCols] = await pool.query(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'name_en'`,
          [refTable]
        );
        if (!refCols.length) {
          await pool.query(`ALTER TABLE ${refTable} ADD COLUMN name_en VARCHAR(255) DEFAULT NULL`).catch(() => {});
        }
      }
      await pool.query('ALTER TABLE crm_missions MODIFY COLUMN visit_approach TEXT NULL').catch(() => {});
      await ensureMissionTargetTables(pool).catch(err => {
        console.warn('[ENSURE_MISSION_TARGET_TABLES_WARN]', err?.message);
      });
    })().catch(err => {
      ensureMissionColumnsPromise = null;
      throw err;
    });
  }
  return ensureMissionColumnsPromise;
}

function generateMissionReference(id) {
  const year = new Date().getFullYear();
  return `MIS-${year}-${String(id).padStart(5, '0')}`;
}

function canExecuteMission(mission, user) {
  return isManager(user) || mission.primary_commercial_id === user.id || Boolean(mission.is_associate);
}

async function getMissionAccess(id, user) {
  const [rows] = await pool.query(
    `SELECT m.*,
            EXISTS(
              SELECT 1 FROM crm_mission_associates ma
              WHERE ma.mission_id = m.id AND ma.user_id = ?
            ) AS is_associate
     FROM crm_missions m
     WHERE m.id = ?`,
    [user.id, id]
  );
  if (!rows.length) return { mission: null, canRead: false, canWrite: false };
  const mission = rows[0];
  return {
    mission,
    canRead: isManager(user) || mission.primary_commercial_id === user.id || Boolean(mission.is_associate),
    canWrite: isManager(user) || mission.primary_commercial_id === user.id
  };
}

router.get('/', authenticate, async (req, res) => {
  try {
    await ensureMissionColumns();
    const { status, commercialId } = req.query;
    let query = `
      SELECT m.*, o.title AS objective_title, i.name AS institution_name,
             u.full_name AS primary_commercial_name, r.name AS region_name,
             r.name_en AS region_name_en, d.name AS department_name,
             d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en,
             base.name AS base_city_name, base.name_en AS base_city_name_en
      FROM crm_missions m
      JOIN crm_objectives o ON m.objective_id = o.id
      JOIN crm_institutions i ON m.institution_id = i.id
      JOIN users u ON m.primary_commercial_id = u.id
      JOIN crm_ref_regions r ON m.region_id = r.id
      JOIN crm_ref_departments d ON m.department_id = d.id
      JOIN crm_ref_cities c ON m.city_id = c.id
      LEFT JOIN crm_ref_cities base ON m.base_city_id = base.id`;
    const params = [];
    const conditions = [];

    if (req.user.role === 'COMMERCIAL' || req.user.restrictFeatureScope) {
      conditions.push(`(
        m.primary_commercial_id = ?
        OR EXISTS(
          SELECT 1 FROM crm_mission_associates ma
          WHERE ma.mission_id = m.id AND ma.user_id = ?
        )
      )`);
      params.push(req.user.id, req.user.id);
    }
    if (status && ALLOWED_STATUSES.includes(status)) {
      conditions.push('m.status = ?');
      params.push(status);
    }
    if (commercialId && isManager(req.user)) {
      conditions.push('m.primary_commercial_id = ?');
      params.push(commercialId);
    }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY m.scheduled_date DESC';

    const [rows] = await pool.query(query, params);
    let targetsByMission = new Map();
    try {
      targetsByMission = await getMissionTargets(pool, rows.map(row => row.id));
    } catch (targetsErr) {
      console.warn('[MISSIONS/LIST_TARGETS_WARN]', targetsErr?.message);
    }
    return res.json(rows.map(row => ({
      ...row,
      targets: targetsByMission.get(Number(row.id)) || []
    })));
  } catch (err) {
    console.error('[MISSIONS/LIST]', err);
    return res.status(500).json({
      error: 'Erreur serveur.',
      message: err.message,
      code: err.code
    });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    await ensureMissionColumns();
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canRead) return res.status(403).json({ error: 'Acces refuse.' });

    const [rows] = await pool.query(
      `SELECT m.*, o.title AS objective_title, i.name AS institution_name,
              u.full_name AS primary_commercial_name, r.name AS region_name,
               r.name_en AS region_name_en, d.name AS department_name,
               d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en,
               base.name AS base_city_name, base.name_en AS base_city_name_en
       FROM crm_missions m
       JOIN crm_objectives o ON m.objective_id = o.id
       JOIN crm_institutions i ON m.institution_id = i.id
       JOIN users u ON m.primary_commercial_id = u.id
       JOIN crm_ref_regions r ON m.region_id = r.id
       JOIN crm_ref_departments d ON m.department_id = d.id
       JOIN crm_ref_cities c ON m.city_id = c.id
       LEFT JOIN crm_ref_cities base ON m.base_city_id = base.id
       WHERE m.id = ?`,
      [req.params.id]
    );
    const [associates] = await pool.query(
      `SELECT u.id, u.full_name, u.role
       FROM crm_mission_associates ma
       JOIN users u ON ma.user_id = u.id
       WHERE ma.mission_id = ?`,
      [req.params.id]
    );
    const [reports] = await pool.query(
      'SELECT id, status FROM crm_reports WHERE mission_id = ?',
      [req.params.id]
    );
    // Récupérer les pièces jointes
    const [attachments] = await pool.query(
      `SELECT id, file_name, file_size, created_at
       FROM crm_mission_attachments
       WHERE mission_id = ?
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    const targetsByMission = await getMissionTargets(pool, [req.params.id]);
    return res.json({
      ...rows[0],
      targets: targetsByMission.get(Number(req.params.id)) || [],
      associates,
      report: reports[0] || null,
      attachments
    });
  } catch (err) {
    console.error('[MISSIONS/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id/order.pdf', authenticate, async (req, res) => {
  try {
    await ensureMissionColumns();
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canRead) return res.status(403).json({ error: 'Acces refuse.' });

    if (!VALID_ORDER_STATUSES.has(access.mission.status)) {
      return res.status(409).json({ error: 'Ordre de mission disponible uniquement apres validation.' });
    }

    const [rows] = await pool.query(
      `SELECT m.*, o.title AS objective_title, i.name AS institution_name,
              i.address AS institution_address, i.phone AS institution_phone,
              i.email AS institution_email, u.full_name AS primary_commercial_name,
              u.email AS primary_commercial_email, u.phone AS primary_commercial_phone,
              validator.full_name AS validator_name,
              validator.username AS validator_username,
              validator.email AS validator_email,
               r.name AS region_name, d.name AS department_name, c.name AS city_name,
               base.name AS base_city_name
       FROM crm_missions m
       JOIN crm_objectives o ON m.objective_id = o.id
       JOIN crm_institutions i ON m.institution_id = i.id
       JOIN users u ON m.primary_commercial_id = u.id
       LEFT JOIN users validator ON m.gate1_validated_by = validator.id
       JOIN crm_ref_regions r ON m.region_id = r.id
       JOIN crm_ref_departments d ON m.department_id = d.id
       JOIN crm_ref_cities c ON m.city_id = c.id
       LEFT JOIN crm_ref_cities base ON m.base_city_id = base.id
       WHERE m.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mission introuvable.' });
    const mission = rows[0];
    if (!mission.validator_name && !mission.validator_username && mission.gate1_validated_at) {
      const [legacyValidators] = await pool.query(
        `SELECT u.full_name, u.username, u.email
         FROM crm_audit_logs al
         JOIN users u ON u.id = al.user_id
         WHERE al.module_name = 'missions'
           AND al.action_type IN (?, ?)
           AND ABS(TIMESTAMPDIFF(SECOND, al.timestamp, ?)) <= 2
         ORDER BY ABS(TIMESTAMPDIFF(SECOND, al.timestamp, ?)), al.id DESC
         LIMIT 1`,
        [
          `POST /api/v1/missions/${mission.id}/actions`,
          `POST /api/missions/${mission.id}/actions`,
          mission.gate1_validated_at,
          mission.gate1_validated_at
        ]
      );
      if (legacyValidators.length) {
        mission.validator_name = legacyValidators[0].full_name;
        mission.validator_username = legacyValidators[0].username;
        mission.validator_email = legacyValidators[0].email;
      }
    }
    const validatorDisplayName = String(
      mission.validator_name || mission.validator_username || 'Validateur non renseigne'
    ).trim();
    const targetsByMission = await getMissionTargets(pool, [mission.id]);
    const missionTargets = targetsByMission.get(Number(mission.id)) || [];

    const [associates] = await pool.query(
      `SELECT u.full_name, u.email, u.phone
       FROM crm_mission_associates ma
       JOIN users u ON ma.user_id = u.id
       WHERE ma.mission_id = ?
       ORDER BY u.full_name`,
      [req.params.id]
    );

    const reference = mission.mission_reference || generateMissionReference(mission.id);
    mission.mission_reference = reference;
    const verificationToken = await ensureMissionVerificationToken(mission);
    const verificationSignature = buildVerificationSignature(mission, verificationToken);
    const verificationUrl = buildVerificationUrl(req, mission.id, verificationToken);
    const qrCodeDataUrl = await QRCode.toDataURL(verificationUrl, {
      margin: 2,
      width: 220,
      errorCorrectionLevel: 'L'
    });
    const contacts = parseJsonArray(mission.target_contacts);
    const fallbackContacts = [
      mission.target_decision_maker && { role: 'DECIDEUR_PRINCIPAL', name: mission.target_decision_maker },
      mission.target_technical_prescriber && { role: 'PRESCRIPTEUR_TECHNIQUE', name: mission.target_technical_prescriber },
      mission.target_influencer && { role: 'INFLUENCEUR', name: mission.target_influencer }
    ].filter(Boolean);
    const targetContacts = contacts.length ? contacts : fallbackContacts;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ordre-mission-${reference}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true, info: { Title: `Ordre de mission ${reference}` } });
    doc.pipe(res);

    const incLogoPath = path.resolve(__dirname, '..', '..', 'backoffice', 'src', 'assets', 'logo-inc.png');
    const ippcLogoPath = path.resolve(__dirname, '..', '..', 'backoffice', 'src', 'assets', 'logo-ippc.jpeg');
    doc.rect(0, 0, 595.28, 90).fill('#ffffff');
    doc.rect(0, 87, 595.28, 3).fill('#e31e24');
    drawPdfLogo(doc, incLogoPath, 58, 17, { fit: [68, 54], align: 'center', valign: 'center' });
    drawPdfLogo(doc, ippcLogoPath, 455, 21, { fit: [84, 46], align: 'center', valign: 'center' });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16.5)
      .text('REMONTADA PROSPECTIA', 138, 23, { width: 319, align: 'center', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569')
      .text('ORDRE DE MISSION AUTHENTIFIE', 138, 53, { width: 319, align: 'center', characterSpacing: 0.35, lineBreak: false });
    doc.roundedRect(54, 104, 487, 70, 12).fill('#fff5f5');
    doc.fillColor('#e31e24').font('Helvetica-Bold').fontSize(21)
      .text('ORDRE DE MISSION', 78, 119, { width: 439, align: 'center', lineBreak: false });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9)
      .text(`Reference ${reference}`, 78, 150, { width: 439, align: 'center', lineBreak: false });
    doc.y = 184;
    doc.x = 54;

    addPdfSection(doc, 'Identification');
    addPdfField(doc, 'Mission :', mission.title);
    addPdfField(doc, 'Objectif rattache :', mission.objective_title);
    addPdfField(doc, 'Cibles planifiees :', missionTargets.length
      ? missionTargets.map(target => target.institution_name).join(' -> ')
      : mission.institution_name);
    addPdfField(doc, 'Adresse institution :', mission.institution_address || '-');
    addPdfField(doc, 'Zone :', `${mission.city_name || '-'} / ${mission.department_name || '-'} / ${mission.region_name || '-'}`);
    addPdfField(doc, 'Type de déplacement :', mission.travel_scope ? travelScopeLabel(mission.travel_scope) : 'Non classé');
    addPdfField(doc, 'Ville de rattachement :', mission.base_city_name || '-');
    if (mission.travel_scope === 'OUT_OF_CITY') {
      addPdfField(doc, 'Départ :', formatDateTime(mission.departure_at));
      addPdfField(doc, 'Retour :', formatDateTime(mission.return_at));
      addPdfField(doc, 'Transport :', transportModeLabel(mission.transport_mode));
      addPdfField(doc, 'Hébergement :', mission.accommodation_required ? 'Oui' : 'Non');
      addPdfField(doc, 'Coût estimatif :', `${Number(mission.estimated_travel_cost || 0).toLocaleString('fr-FR')} FCFA`);
    }
    addPdfField(doc, 'Date prevue :', formatDate(mission.scheduled_date));
    addPdfField(doc, 'Duree :', `${mission.duration_hours || 2} heure(s)`);
    addPdfField(doc, 'Validation Gate 1 :', formatDateTime(mission.gate1_validated_at));

    ensurePdfSpace(doc);
    addPdfSection(doc, 'Equipe mission');
    addPdfField(doc, 'Commercial principal :', mission.primary_commercial_name);
    addPdfField(doc, 'Contact principal :', [mission.primary_commercial_phone, mission.primary_commercial_email].filter(Boolean).join(' / ') || '-');
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text('Equipe associee :');
    if (associates.length) {
      associates.forEach(member => {
        doc.font('Helvetica').fontSize(9).fillColor('#111827').text(`- ${member.full_name}${member.phone ? ` / ${member.phone}` : ''}${member.email ? ` / ${member.email}` : ''}`);
      });
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text('- Aucune personne associee');
    }

    ensurePdfSpace(doc);
    addPdfSection(doc, 'Objectif et resultat attendu');
    addPdfField(doc, 'Type de mission :', mission.mission_type || 'PROSPECTION');
    addPdfField(doc, 'Objectif strategique :', strategicObjectiveLabel(mission.strategic_objective));
    addPdfField(doc, 'Resultat attendu :', mission.expected_result || '-');
    if (mission.description) addPdfField(doc, 'Contexte :', mission.description);

    ensurePdfSpace(doc);
    addPdfSection(doc, `Etapes de la tournee (${missionTargets.length || 1})`);
    if (missionTargets.length) {
      missionTargets.forEach((target, index) => {
        const opportunityText = target.opportunity?.need_description || '';
        const cardHeight = target.opportunity ? Math.max(54, 46 + doc.heightOfString(opportunityText, { width: 445 })) : 44;
        ensurePdfSpace(doc, cardHeight + 10);
        const actualY = doc.y;
        doc.roundedRect(54, actualY, 487, cardHeight, 7).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827')
          .text(`${index + 1}. ${target.institution_name} - ${target.city_name || 'Ville non renseignee'}`, 66, actualY + 9, { width: 463 });
        const targetDetails = [
          `Priorite ${String(target.priority || 'MEDIUM').toLowerCase()}`,
          `Potentiel ${String(target.potential || 'MEDIUM').toLowerCase()}`,
          target.contact_name ? `Contact ${target.contact_name}${target.contact_role ? ` (${target.contact_role})` : ''}` : null
        ].filter(Boolean).join(' / ');
        doc.font('Helvetica').fontSize(7.7).fillColor('#475569').text(targetDetails, 66, actualY + 24, { width: 463 });
        if (target.opportunity) {
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#b45309')
            .text(`Opportunite : ${target.opportunity.title}`, 66, actualY + 38, { width: 463 });
          doc.font('Helvetica').fontSize(7.7).fillColor('#475569')
            .text(opportunityText || '-', 66, actualY + 50, { width: 463 });
        }
        doc.y = actualY + cardHeight + 6;
        doc.x = 54;
      });
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(`1. ${mission.institution_name}`);
    }

    ensurePdfSpace(doc);
    addPdfSection(doc, 'Personnes de contact ciblees');
    if (targetContacts.length) {
      targetContacts.forEach(contact => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text(roleLabel(contact.role), { continued: true });
        doc.font('Helvetica').fontSize(9).text(` - ${contact.name || '-'}`);
        const contactLine = [contact.phone, contact.email].filter(Boolean).join(' / ');
        if (contactLine) doc.font('Helvetica').fontSize(9).fillColor('#475569').text(`  Contact : ${contactLine}`);
      });
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text('- Aucun contact cible renseigne');
    }

    ensurePdfSpace(doc);
    addPdfSection(doc, 'Plan de visite');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text('Approches :');
    addPdfList(doc, parseJsonArray(mission.visit_approach));
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text('Questions critiques :');
    addPdfList(doc, parseJsonArray(mission.key_questions));
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text('Messages cles a delivrer :');
    addPdfList(doc, parseJsonArray(mission.key_messages));

    ensurePdfSpace(doc);
    addPdfSection(doc, 'Risques et mesures');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text('Hypotheses de besoin :');
    addPdfList(doc, parseJsonArray(mission.need_hypotheses));
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text('Risques identifies :');
    addPdfList(doc, parseJsonArray(mission.risks));
    doc.moveDown(0.4);
    addPdfField(doc, 'Mesures prevues :', mission.planned_measures || '-');

    ensurePdfSpace(doc, 150);
    addPdfSection(doc, 'Validation');
    doc.font('Helvetica').fontSize(9).fillColor('#111827')
      .text('La presente mission est autorisee apres validation hierarchique. Le commercial est mandate pour conduire la visite, recueillir les informations utiles et produire le reporting attendu.');
    doc.moveDown(0.7);
    addPdfField(doc, 'Valide par :', validatorDisplayName);
    addPdfField(doc, 'Email validateur :', mission.validator_email || '-');
    doc.font('Helvetica').fontSize(8).fillColor('#475569')
      .text('Scannez le QR code pour controler le statut actuel de cet ordre de mission.', 54, doc.y + 2, { width: 487 });
    doc.moveDown(0.7);
    const signatureY = doc.y;
    doc.roundedRect(54, signatureY, 487, 148, 10).fillAndStroke('#f8fafc', '#cbd5e1');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('SIGNATURE ELECTRONIQUE DU VALIDATEUR', 72, signatureY + 18, { width: 272 });
    doc.font('Helvetica').fontSize(8).fillColor('#475569').text(validatorDisplayName, 72, signatureY + 36, { width: 272 });
    doc.roundedRect(72, signatureY + 56, 232, 40, 7).fillAndStroke('#ecfdf5', '#a7f3d0');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#047857').text('SIGNE NUMERIQUEMENT', 84, signatureY + 66, { width: 208 });
    doc.font('Helvetica').fontSize(6.7).fillColor('#475569').text(verificationSignature, 84, signatureY + 82, { width: 208 });
    doc.image(qrCodeDataUrl, 392, signatureY + 10, { width: 112, height: 112 });
    doc.font('Helvetica').fontSize(6.8).fillColor('#475569').text('Scanner pour verifier', 376, signatureY + 128, { width: 146, align: 'center' });
    doc.y = signatureY + 156;
    doc.x = 54;

    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i += 1) {
      doc.switchToPage(i);
      const originalBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      if (i > 0) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a')
          .text(`ORDRE DE MISSION - ${reference}`, 54, 28, { width: 360, lineBreak: false });
        doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
          .text('Remontada Prospectia', 421, 28, { width: 120, align: 'right', lineBreak: false });
        doc.moveTo(54, 44).lineTo(541, 44).strokeColor('#e31e24').lineWidth(1).stroke();
      }
      doc.save();
      doc.moveTo(54, 795).lineTo(541, 795).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
      doc.restore();
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text('ERP Remontada Prospectia - Document confidentiel', 54, 804, { align: 'left', width: 240, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text(`Page ${i + 1} / ${pageCount}`, 300, 804, { align: 'right', width: 241, lineBreak: false });
      doc.page.margins.bottom = originalBottomMargin;
    }

    doc.end();
  } catch (err) {
    console.error('[MISSIONS/ORDER_PDF]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id/order/verify', async (req, res) => {
  try {
    await ensureMissionColumns();
    const token = String(req.query.token || '');
    const cspNonce = crypto.randomBytes(18).toString('base64');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${cspNonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).type('html').send(renderVerificationPage({ state: 'INVALID', nonce: cspNonce }));
    }
    const [rows] = await pool.query(
      `SELECT m.id, m.mission_reference, m.gate1_validated_at, m.status,
              m.order_verification_token
       FROM crm_missions m
       WHERE m.id = ?`,
      [req.params.id]
    );
    if (!rows.length || !secureTokenMatches(rows[0].order_verification_token, token)) {
      return res.status(404).type('html').send(renderVerificationPage({ state: 'INVALID', nonce: cspNonce }));
    }
    const mission = rows[0];
    const signature = buildVerificationSignature(mission, token);
    if (!mission.gate1_validated_at || !VALID_ORDER_STATUSES.has(mission.status)) {
      return res.status(410).type('html').send(renderVerificationPage({ state: 'REVOKED', mission, signature, nonce: cspNonce }));
    }
    return res.status(200).type('html').send(renderVerificationPage({ state: 'VALID', mission, signature, nonce: cspNonce }));
  } catch (err) {
    console.error('[MISSIONS/ORDER_VERIFY]', err);
    const cspNonce = crypto.randomBytes(18).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${cspNonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    return res.status(500).type('html').send(renderVerificationPage({ state: 'INVALID', nonce: cspNonce }));
  }
});

router.post('/', authenticate, async (req, res) => {
  const {
    objective_id, institution_id, title, description, scheduled_date,
    duration_hours, primary_commercial_id, associates, targets,
    mission_type, strategic_objective, expected_result, target_decision_maker,
    target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach,
    key_questions, key_messages, risks, planned_measures,
    departure_at, return_at, transport_mode, accommodation_required, estimated_travel_cost
  } = req.body;
  const primaryCommercialId = isManager(req.user) ? primary_commercial_id : req.user.id;

  if (
    !Number(objective_id) || typeof title !== 'string' ||
    !title.trim() || title.length > 150 || !scheduled_date ||
    !Number(primaryCommercialId)
  ) {
    return res.status(400).json({ error: 'Donnees de mission invalides.' });
  }

  const connection = await pool.getConnection();
  try {
    if (!await canLinkRecord(req.user,'objectives',objective_id)) return res.status(403).json({error:'Objectif inaccessible.'});
    await ensureMissionColumns();
    await connection.beginTransaction();
    const normalizedTargets = await normalizeMissionTargets(connection, targets, req.body);
    const primaryTarget = normalizedTargets[0];
    const travel = await resolveMissionTravel(connection, primaryCommercialId, normalizedTargets.map(target => target.city_id), {
      departure_at,
      return_at,
      transport_mode,
      accommodation_required,
      estimated_travel_cost
    });
    const [result] = await connection.query(
      `INSERT INTO crm_missions (
        objective_id, institution_id, title, description, scheduled_date,
        duration_hours, primary_commercial_id, region_id, department_id, city_id,
        base_city_id, travel_scope, departure_at, return_at, transport_mode,
        accommodation_required, estimated_travel_cost,
        mission_type, strategic_objective, expected_result, target_decision_maker,
        target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach,
        key_questions, key_messages, risks, planned_measures, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
      [
        objective_id, primaryTarget.institution_id, title.trim(), description || null, scheduled_date,
        Math.min(Math.max(Number(duration_hours) || 2, 1), 72),
        primaryCommercialId, primaryTarget.region_id, primaryTarget.department_id, primaryTarget.city_id,
        travel.base_city_id, travel.travel_scope, travel.departure_at, travel.return_at,
        travel.transport_mode, travel.accommodation_required, travel.estimated_travel_cost,
        mission_type || 'PROSPECTION',
        strategic_objective || 'IDENTIFIER_BESOIN',
        expected_result || null,
        target_decision_maker || null,
        target_technical_prescriber || null,
        target_influencer || null,
        serializeContacts(target_contacts),
        serializeArray(need_hypotheses),
        serializeArray(visit_approach),
        serializeArray(key_questions),
        serializeArray(key_messages),
        serializeArray(risks),
        planned_measures || null
      ]
    );

    await upsertMissionTargets(connection, result.insertId, normalizedTargets);

    if (isManager(req.user) && Array.isArray(associates) && associates.length) {
      const values = [...new Set(associates.map(Number).filter(Boolean))]
        .map(userId => [result.insertId, userId]);
      if (values.length) {
        await connection.query(
          'INSERT IGNORE INTO crm_mission_associates (mission_id, user_id) VALUES ?',
          [values]
        );
      }
    }
    await connection.commit();
    return res.status(201).json({
      id: result.insertId,
      travel_scope: travel.travel_scope,
      targets: normalizedTargets,
      message: 'Mission creee.'
    });
  } catch (err) {
    await connection.rollback();
    console.error('[MISSIONS/CREATE]', err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    connection.release();
  }
});

router.put('/:id/status', authenticate, async (req, res) => {
  const { status, rejection_reason } = req.body;
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }

  try {
    await ensureMissionColumns();
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canWrite) return res.status(403).json({ error: 'Acces refuse.' });
    if (status === access.mission.status) return res.json({ message: 'Statut inchange.' });

    const transitionMap = isManager(req.user)
      ? STATUS_TRANSITIONS
      : COMMERCIAL_STATUS_TRANSITIONS;
    const allowedNext = transitionMap[access.mission.status] || [];
    if (!allowedNext.includes(status)) {
      return res.status(409).json({
        error: `Transition interdite : ${access.mission.status} vers ${status}.`
      });
    }
    if (status === 'REJECTED' && !String(rejection_reason || '').trim()) {
      return res.status(400).json({ error: 'Le motif de rejet est obligatoire.' });
    }

    await pool.query(
      'UPDATE crm_missions SET status = ?, rejection_reason = ? WHERE id = ?',
      [status, rejection_reason || null, req.params.id]
    );
    return res.json({ message: `Mission passee en statut : ${status}` });
  } catch (err) {
    console.error('[MISSIONS/STATUS]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/:id/actions', authenticate, async (req, res) => {
  const { action, reason, scheduled_date, check_in_at, check_in_latitude, check_in_longitude } = req.body;
  const normalizedAction = String(action || '').toUpperCase();

  try {
    await ensureMissionColumns();
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });

    const mission = access.mission;
    const manager = isManager(req.user);
    const executable = canExecuteMission(mission, req.user);
    let query = '';
    let params = [];
    let message = '';

    if (normalizedAction === 'SUBMIT') {
      if (!access.canWrite) return res.status(403).json({ error: 'Acces refuse.' });
      if (!['DRAFT', 'REJECTED'].includes(mission.status)) {
        return res.status(409).json({ error: 'Seules les missions en brouillon ou a reprendre peuvent etre soumises.' });
      }
      query = 'UPDATE crm_missions SET status = ?, rejection_reason = NULL, completion_request = NULL WHERE id = ?';
      params = ['SUBMITTED', req.params.id];
      message = 'Mission soumise pour validation.';
    } else if (normalizedAction === 'VALIDATE_GATE1') {
      if (!manager) return res.status(403).json({ error: 'Validation reservee au management.' });
      if (!['SUBMITTED', 'IN_VALIDATION', 'VALIDATED'].includes(mission.status)) {
        return res.status(409).json({ error: 'Cette mission ne peut pas etre validee a cette etape.' });
      }
      const reference = mission.mission_reference || generateMissionReference(mission.id);
      const token = mission.order_verification_token || generateVerificationToken();
      query = `UPDATE crm_missions
               SET status = 'PLANNED', mission_reference = ?, gate1_validated_at = NOW(),
                   gate1_validated_by = ?, order_verification_token = ?,
                   rejection_reason = NULL, completion_request = NULL
               WHERE id = ?`;
      params = [reference, req.user.id, token, req.params.id];
      message = 'Mission validee et planifiee.';
    } else if (normalizedAction === 'REQUEST_COMPLETION') {
      if (!manager) return res.status(403).json({ error: 'Demande de complement reservee au management.' });
      if (!['SUBMITTED', 'IN_VALIDATION'].includes(mission.status)) {
        return res.status(409).json({ error: 'Un complement ne peut etre demande que sur une mission soumise.' });
      }
      if (!String(reason || '').trim()) {
        return res.status(400).json({ error: 'Precisez le complement attendu.' });
      }
      query = 'UPDATE crm_missions SET status = ?, completion_request = ?, rejection_reason = NULL WHERE id = ?';
      params = ['REJECTED', String(reason).trim(), req.params.id];
      message = 'Mission renvoyee pour complement.';
    } else if (normalizedAction === 'REJECT') {
      if (!manager) return res.status(403).json({ error: 'Rejet reserve au management.' });
      if (!['SUBMITTED', 'IN_VALIDATION'].includes(mission.status)) {
        return res.status(409).json({ error: 'Cette mission ne peut pas etre rejetee a cette etape.' });
      }
      if (!String(reason || '').trim()) {
        return res.status(400).json({ error: 'Le motif de rejet est obligatoire.' });
      }
      query = 'UPDATE crm_missions SET status = ?, rejection_reason = ?, completion_request = NULL WHERE id = ?';
      params = ['REJECTED', String(reason).trim(), req.params.id];
      message = 'Mission rejetee.';
    } else if (normalizedAction === 'START') {
      if (!executable) return res.status(403).json({ error: 'Execution reservee aux personnes affectees a la mission.' });
      if (!['PLANNED', 'POSTPONED'].includes(mission.status)) {
        return res.status(409).json({ error: 'La mission doit etre planifiee avant execution.' });
      }

      const checkInDate = check_in_at ? new Date(check_in_at) : new Date();
      const checkInMysql = isNaN(checkInDate.getTime()) ? new Date() : checkInDate;
      if (check_in_at && isNaN(checkInDate.getTime())) return res.status(400).json({ error: 'Date de pointage invalide.' });
      if ((check_in_latitude != null && (!Number.isFinite(Number(check_in_latitude)) || Math.abs(Number(check_in_latitude)) > 90)) || (check_in_longitude != null && (!Number.isFinite(Number(check_in_longitude)) || Math.abs(Number(check_in_longitude)) > 180))) return res.status(400).json({ error: 'Coordonnées de pointage invalides.' });
      const formattedCheckIn = checkInMysql.toISOString().slice(0, 19).replace('T', ' ');

      query = `UPDATE crm_missions SET 
        status = 'IN_PROGRESS', 
        started_at = COALESCE(started_at, ?),
        check_in_at = COALESCE(check_in_at, ?),
        check_in_latitude = COALESCE(check_in_latitude, ?),
        check_in_longitude = COALESCE(check_in_longitude, ?)
       WHERE id = ?`;
      params = [
        formattedCheckIn,
        formattedCheckIn,
        check_in_latitude !== undefined && check_in_latitude !== null ? Number(check_in_latitude) : null,
        check_in_longitude !== undefined && check_in_longitude !== null ? Number(check_in_longitude) : null,
        req.params.id
      ];
      message = 'Mission demarree.';
    } else if (normalizedAction === 'COMPLETE') {
      if (!executable) return res.status(403).json({ error: 'Execution reservee aux personnes affectees a la mission.' });
      if (mission.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: 'Seule une mission en cours peut etre terminee.' });
      }
      query = "UPDATE crm_missions SET status = 'COMPLETED', completed_at = COALESCE(completed_at, NOW()) WHERE id = ?";
      params = [req.params.id];
      message = 'Mission terminee. Le reporting peut etre soumis.';
    } else if (normalizedAction === 'CLOSE') {
      if (!manager) return res.status(403).json({ error: 'Cloture reservee au management.' });
      if (mission.status !== 'COMPLETED') {
        return res.status(409).json({ error: 'Seule une mission terminee peut etre cloturee.' });
      }
      query = "UPDATE crm_missions SET status = 'CLOSED', closed_at = COALESCE(closed_at, NOW()) WHERE id = ?";
      params = [req.params.id];
      message = 'Mission cloturee.';
    } else if (normalizedAction === 'POSTPONE') {
      if (!access.canWrite) return res.status(403).json({ error: 'Acces refuse.' });
      if (!['PLANNED', 'IN_PROGRESS', 'POSTPONED'].includes(mission.status)) {
        return res.status(409).json({ error: 'Cette mission ne peut pas etre reportee.' });
      }
      if (!scheduled_date) {
        return res.status(400).json({ error: 'La nouvelle date est obligatoire.' });
      }
      query = "UPDATE crm_missions SET status = 'POSTPONED', scheduled_date = ? WHERE id = ?";
      params = [scheduled_date, req.params.id];
      message = 'Mission reportee.';
    } else if (normalizedAction === 'CANCEL') {
      if (!access.canWrite) return res.status(403).json({ error: 'Acces refuse.' });
      if (['CLOSED', 'CANCELLED'].includes(mission.status)) {
        return res.status(409).json({ error: 'Cette mission ne peut plus etre annulee.' });
      }
      query = "UPDATE crm_missions SET status = 'CANCELLED', rejection_reason = ? WHERE id = ?";
      params = [reason || null, req.params.id];
      message = 'Mission annulee.';
    } else {
      return res.status(400).json({ error: 'Action mission inconnue.' });
    }

    await pool.query(query, params);

    // Auto-generate report draft if mission was completed
    if (normalizedAction === 'COMPLETE') {
      await ReportWorkflowService.generateFromMission(req.params.id, req.user.id);
    }

    return res.json({ message });
  } catch (err) {
    console.error('[MISSIONS/ACTION]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/:id', authenticate, async (req, res) => {
  const {
    title, description, scheduled_date, duration_hours,
    targets,
    mission_type, strategic_objective, expected_result, target_decision_maker,
    target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach,
    key_questions, key_messages, risks, planned_measures,
    departure_at, return_at, transport_mode, accommodation_required, estimated_travel_cost
  } = req.body;
  if (
    typeof title !== 'string' || !title.trim() || title.length > 150 ||
    !scheduled_date
  ) {
    return res.status(400).json({ error: 'Donnees de mission invalides.' });
  }

  let connection;
  try {
    await ensureMissionColumns();
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canWrite) return res.status(403).json({ error: 'Acces refuse.' });
    if (!isManager(req.user) && !['DRAFT', 'REJECTED', 'PLANNED', 'POSTPONED'].includes(access.mission.status)) {
      return res.status(409).json({ error: 'Cette mission ne peut plus etre modifiee.' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const normalizedTargets = await normalizeMissionTargets(connection, targets, req.body);
    const primaryTarget = normalizedTargets[0];
    const travel = await resolveMissionTravel(connection, access.mission.primary_commercial_id, normalizedTargets.map(target => target.city_id), {
      departure_at,
      return_at,
      transport_mode,
      accommodation_required,
      estimated_travel_cost
    });

    await connection.query(
      `UPDATE crm_missions
        SET title = ?, description = ?, scheduled_date = ?, duration_hours = ?,
            institution_id = ?, region_id = ?, department_id = ?, city_id = ?,
            base_city_id = ?, travel_scope = ?, departure_at = ?, return_at = ?,
            transport_mode = ?, accommodation_required = ?, estimated_travel_cost = ?,
            mission_type = ?, strategic_objective = ?, expected_result = ?,
           target_decision_maker = ?, target_technical_prescriber = ?, target_influencer = ?, target_contacts = ?,
           need_hypotheses = ?, visit_approach = ?, key_questions = ?, key_messages = ?, risks = ?, planned_measures = ?
       WHERE id = ?`,
      [
        title.trim(), description || null, scheduled_date,
        Math.min(Math.max(Number(duration_hours) || 2, 1), 72),
        primaryTarget.institution_id, primaryTarget.region_id, primaryTarget.department_id, primaryTarget.city_id,
        travel.base_city_id, travel.travel_scope, travel.departure_at, travel.return_at,
        travel.transport_mode, travel.accommodation_required, travel.estimated_travel_cost,
        mission_type || access.mission.mission_type || 'PROSPECTION',
        strategic_objective || access.mission.strategic_objective || 'IDENTIFIER_BESOIN',
        expected_result || null,
        target_decision_maker || null,
        target_technical_prescriber || null,
        target_influencer || null,
        serializeContacts(target_contacts),
        serializeArray(need_hypotheses),
        serializeArray(visit_approach),
        serializeArray(key_questions),
        serializeArray(key_messages),
        serializeArray(risks),
        planned_measures || null,
        req.params.id
      ]
    );
    await upsertMissionTargets(connection, req.params.id, normalizedTargets);
    await connection.commit();
    return res.json({
      travel_scope: travel.travel_scope,
      targets: normalizedTargets,
      message: 'Mission mise a jour.'
    });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('[MISSIONS/UPDATE]', err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    if (connection) connection.release();
  }
});

router.delete('/:id', authenticate, authorize('DIRECTION', 'SYSTEM', 'ADMIN'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM crm_missions WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Mission introuvable.' });
    return res.json({ message: 'Mission supprimee.' });
  } catch (err) {
    console.error('[MISSIONS/DELETE]', err);
    return res.status(409).json({ error: 'Cette mission ne peut pas etre supprimee.' });
  }
});

/**
 * POST /:id/attachments - Ajouter des pièces jointes à la mission
 */
router.post('/:id/attachments', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) {
      cleanupUploadedFiles(req.files);
      return res.status(404).json({ error: 'Mission introuvable.' });
    }
    if (!access.canRead) {
      cleanupUploadedFiles(req.files);
      return res.status(403).json({ error: 'Accès refusé.' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'Aucun fichier fourni.' });
    if (!validateUploadedFilesContent(req.files)) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ error: 'Contenu de fichier non autorise.' });
    }

    const inserts = req.files.map(file => [
      req.params.id,
      path.basename(file.originalname),
      file.path,
      file.size
    ]);
    await pool.query(
      `INSERT INTO crm_mission_attachments (mission_id, file_name, file_path, file_size)
       VALUES ?`,
      [inserts]
    );
    return res.status(201).json({ message: `${req.files.length} fichier(s) ajouté(s).` });
  } catch (err) {
    cleanupUploadedFiles(req.files);
    console.error('[MISSIONS/ATTACH]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /:id/attachments/:attId/download - Télécharger une pièce jointe de mission
 */
router.get('/:id/attachments/:attId/download', authenticate, async (req, res) => {
  try {
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canRead) return res.status(403).json({ error: 'Accès refusé.' });

    const [rows] = await pool.query(
      `SELECT file_name, file_path
       FROM crm_mission_attachments
       WHERE id = ? AND mission_id = ?`,
      [req.params.attId, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    }
    if (!sendStoredUpload(res, rows[0].file_path, rows[0].file_name)) {
      return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    }
  } catch (err) {
    console.error('[MISSIONS/DOWNLOAD]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * DELETE /:id/attachments/:attId - Supprimer une pièce jointe de mission
 */
router.delete('/:id/attachments/:attId', authenticate, async (req, res) => {
  try {
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canWrite) return res.status(403).json({ error: 'Accès refusé.' });

    const [rows] = await pool.query(
      `SELECT file_path
       FROM crm_mission_attachments
       WHERE id = ? AND mission_id = ?`,
      [req.params.attId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    deleteStoredUpload(rows[0].file_path);
    await pool.query(
      'DELETE FROM crm_mission_attachments WHERE id = ? AND mission_id = ?',
      [req.params.attId, req.params.id]
    );
    return res.json({ message: 'Pièce jointe supprimée.' });
  } catch (err) {
    console.error('[MISSIONS/ATTACH_DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

require('../utils/transactionalRoutes')(router, 'crm_missions', ['/:id/actions', '/:id/status']);
module.exports = router;
