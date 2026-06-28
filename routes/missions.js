const express = require('express');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const multer = require('multer');

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
    if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
}
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);
const ALLOWED_STATUSES = [
  'DRAFT', 'SUBMITTED', 'IN_VALIDATION', 'VALIDATED', 'PLANNED',
  'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED', 'POSTPONED'
];
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
  ['completed_at', 'DATETIME NULL'],
  ['closed_at', 'DATETIME NULL']
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

function addPdfSection(doc, title) {
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(title.toUpperCase());
  doc.moveTo(doc.x, doc.y + 2).lineTo(540, doc.y + 2).strokeColor('#e5e7eb').stroke();
  doc.moveDown(0.5);
  doc.fillColor('#111827');
}

function addPdfField(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text(label, { continued: true });
  doc.font('Helvetica').fontSize(9).fillColor('#111827').text(` ${value || '-'}`);
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
  if (doc.y > 760 - minHeight) doc.addPage();
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
  const baseUrl = process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/api/missions/${missionId}/order/verify?token=${encodeURIComponent(token)}`;
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
          await pool.query(`ALTER TABLE crm_missions ADD COLUMN ${name} ${definition}`);
        }
      }
      await pool.query('ALTER TABLE crm_missions MODIFY COLUMN visit_approach TEXT NULL');
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
             d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en
      FROM crm_missions m
      JOIN crm_objectives o ON m.objective_id = o.id
      JOIN crm_institutions i ON m.institution_id = i.id
      JOIN users u ON m.primary_commercial_id = u.id
      JOIN crm_ref_regions r ON m.region_id = r.id
      JOIN crm_ref_departments d ON m.department_id = d.id
      JOIN crm_ref_cities c ON m.city_id = c.id`;
    const params = [];
    const conditions = [];

    if (req.user.role === 'COMMERCIAL') {
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
    return res.json(rows);
  } catch (err) {
    console.error('[MISSIONS/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
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
              d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en
       FROM crm_missions m
       JOIN crm_objectives o ON m.objective_id = o.id
       JOIN crm_institutions i ON m.institution_id = i.id
       JOIN users u ON m.primary_commercial_id = u.id
       JOIN crm_ref_regions r ON m.region_id = r.id
       JOIN crm_ref_departments d ON m.department_id = d.id
       JOIN crm_ref_cities c ON m.city_id = c.id
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
    return res.json({ 
      ...rows[0], 
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

    const printableStatuses = ['VALIDATED', 'PLANNED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED'];
    if (!printableStatuses.includes(access.mission.status)) {
      return res.status(409).json({ error: 'Ordre de mission disponible uniquement apres validation.' });
    }

    const [rows] = await pool.query(
      `SELECT m.*, o.title AS objective_title, i.name AS institution_name,
              i.address AS institution_address, i.phone AS institution_phone,
              i.email AS institution_email, u.full_name AS primary_commercial_name,
              u.email AS primary_commercial_email, u.phone AS primary_commercial_phone,
              validator.full_name AS validator_name,
              validator.email AS validator_email,
              r.name AS region_name, d.name AS department_name, c.name AS city_name
       FROM crm_missions m
       JOIN crm_objectives o ON m.objective_id = o.id
       JOIN crm_institutions i ON m.institution_id = i.id
       JOIN users u ON m.primary_commercial_id = u.id
       LEFT JOIN users validator ON m.gate1_validated_by = validator.id
       JOIN crm_ref_regions r ON m.region_id = r.id
       JOIN crm_ref_departments d ON m.department_id = d.id
       JOIN crm_ref_cities c ON m.city_id = c.id
       WHERE m.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mission introuvable.' });
    const mission = rows[0];

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
      margin: 1,
      width: 116,
      errorCorrectionLevel: 'M'
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
    doc.rect(0, 0, 595.28, 94).fill('#ffffff');
    doc.rect(0, 92, 595.28, 4).fill('#e31e24');
    drawPdfLogo(doc, incLogoPath, 54, 18, { fit: [72, 54] });
    drawPdfLogo(doc, ippcLogoPath, 464, 18, { fit: [78, 54] });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text('REMONTADA PROSPECTIA', 140, 24, { width: 315, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Gestion des missions commerciales', 140, 47, { width: 315, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('ORDRE DE MISSION AUTHENTIFIE', 140, 64, { width: 315, align: 'center' });
    doc.fillColor('#e31e24').font('Helvetica-Bold').fontSize(20).text('ORDRE DE MISSION', 54, 118, { align: 'center' });
    doc.moveDown(0.3);
    doc.fillColor('#0f172a').fontSize(10).text(`Reference : ${reference}`, { align: 'center' });
    doc.moveDown(1);

    addPdfSection(doc, 'Identification');
    addPdfField(doc, 'Mission :', mission.title);
    addPdfField(doc, 'Objectif rattache :', mission.objective_title);
    addPdfField(doc, 'Institution cible :', mission.institution_name);
    addPdfField(doc, 'Adresse institution :', mission.institution_address || '-');
    addPdfField(doc, 'Zone :', `${mission.city_name || '-'} / ${mission.department_name || '-'} / ${mission.region_name || '-'}`);
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
    addPdfField(doc, 'Valide par :', mission.validator_name || 'Management');
    addPdfField(doc, 'Email validateur :', mission.validator_email || '-');
    addPdfField(doc, 'Signature electronique :', verificationSignature);
    addPdfField(doc, 'Verification :', verificationUrl);
    doc.moveDown(0.8);
    const signatureY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('Signature electronique Direction', 54, signatureY);
    doc.font('Helvetica').fontSize(8).fillColor('#475569').text(mission.validator_name || 'Management', 54, signatureY + 16);
    doc.rect(54, signatureY + 34, 190, 44).strokeColor('#94a3b8').stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#047857').text('VALIDE NUMERIQUEMENT', 68, signatureY + 48);
    doc.font('Helvetica').fontSize(7).fillColor('#475569').text(verificationSignature, 68, signatureY + 62, { width: 160 });
    doc.image(qrCodeDataUrl, 390, signatureY, { width: 92, height: 92 });
    doc.font('Helvetica').fontSize(7).fillColor('#475569').text('Scanner pour verifier l authenticite', 360, signatureY + 96, { width: 150, align: 'center' });
    doc.y = Math.max(doc.y, signatureY + 118);

    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text(`Genere le ${formatDateTime(new Date())} - Page ${i + 1}/${pageCount}`, 54, 806, { align: 'center', width: 487 });
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
    if (!token || token.length < 32) {
      return res.status(400).type('html').send('<h1>Verification impossible</h1><p>Jeton manquant ou invalide.</p>');
    }
    const [rows] = await pool.query(
      `SELECT m.id, m.title, m.mission_reference, m.gate1_validated_at,
              m.order_verification_token, i.name AS institution_name,
              u.full_name AS validator_name
       FROM crm_missions m
       JOIN crm_institutions i ON m.institution_id = i.id
       LEFT JOIN users u ON m.gate1_validated_by = u.id
       WHERE m.id = ?`,
      [req.params.id]
    );
    if (!rows.length || rows[0].order_verification_token !== token) {
      return res.status(404).type('html').send('<h1>Document non verifie</h1><p>Ce QR code ne correspond a aucun ordre de mission valide.</p>');
    }
    const mission = rows[0];
    const signature = buildVerificationSignature(mission, token);
    return res.type('html').send(`<!doctype html>
      <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Verification ordre de mission</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; padding: 32px; }
          .card { max-width: 680px; margin: 0 auto; background: white; border-radius: 18px; padding: 28px; box-shadow: 0 18px 45px rgba(15,23,42,.1); }
          .ok { color: #047857; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
          .row { margin: 12px 0; }
          .label { color: #64748b; font-weight: 700; }
          .signature { font-family: monospace; background: #f1f5f9; border-radius: 10px; padding: 12px; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="ok">Document authentifie</div>
          <h1>Ordre de mission ${mission.mission_reference || mission.id}</h1>
          <div class="row"><span class="label">Mission :</span> ${mission.title || '-'}</div>
          <div class="row"><span class="label">Institution :</span> ${mission.institution_name || '-'}</div>
          <div class="row"><span class="label">Valide par :</span> ${mission.validator_name || 'Management'}</div>
          <div class="row"><span class="label">Date de validation :</span> ${formatDateTime(mission.gate1_validated_at)}</div>
          <div class="row"><span class="label">Signature electronique :</span></div>
          <div class="signature">${signature}</div>
        </div>
      </body>
      </html>`);
  } catch (err) {
    console.error('[MISSIONS/ORDER_VERIFY]', err);
    return res.status(500).type('html').send('<h1>Erreur serveur</h1>');
  }
});

router.post('/', authenticate, async (req, res) => {
  const {
    objective_id, institution_id, title, description, scheduled_date,
    duration_hours, primary_commercial_id, region_id, department_id, city_id, associates,
    mission_type, strategic_objective, expected_result, target_decision_maker,
    target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach,
    key_questions, key_messages, risks, planned_measures
  } = req.body;
  const primaryCommercialId = isManager(req.user) ? primary_commercial_id : req.user.id;

  if (
    !Number(objective_id) || !Number(institution_id) || typeof title !== 'string' ||
    !title.trim() || title.length > 150 || !scheduled_date ||
    !Number(primaryCommercialId) || !Number(region_id) ||
    !Number(department_id) || !Number(city_id)
  ) {
    return res.status(400).json({ error: 'Donnees de mission invalides.' });
  }

  const connection = await pool.getConnection();
  try {
    await ensureMissionColumns();
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO crm_missions (
        objective_id, institution_id, title, description, scheduled_date,
        duration_hours, primary_commercial_id, region_id, department_id, city_id,
        mission_type, strategic_objective, expected_result, target_decision_maker,
        target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach,
        key_questions, key_messages, risks, planned_measures, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
      [
        objective_id, institution_id, title.trim(), description || null, scheduled_date,
        Math.min(Math.max(Number(duration_hours) || 2, 1), 72),
        primaryCommercialId, region_id, department_id, city_id,
        mission_type || 'PROSPECTION',
        STRATEGIC_OBJECTIVES.includes(strategic_objective) ? strategic_objective : 'IDENTIFIER_BESOIN',
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
    return res.status(201).json({ id: result.insertId, message: 'Mission creee.' });
  } catch (err) {
    await connection.rollback();
    console.error('[MISSIONS/CREATE]', err);
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
  const { action, reason, scheduled_date } = req.body;
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
      query = "UPDATE crm_missions SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, NOW()) WHERE id = ?";
      params = [req.params.id];
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
    return res.json({ message });
  } catch (err) {
    console.error('[MISSIONS/ACTION]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/:id', authenticate, async (req, res) => {
  const {
    title, description, scheduled_date, duration_hours,
    institution_id, region_id, department_id, city_id,
    mission_type, strategic_objective, expected_result, target_decision_maker,
    target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach,
    key_questions, key_messages, risks, planned_measures
  } = req.body;
  if (
    typeof title !== 'string' || !title.trim() || title.length > 150 ||
    !scheduled_date || !Number(institution_id) || !Number(region_id) ||
    !Number(department_id) || !Number(city_id)
  ) {
    return res.status(400).json({ error: 'Donnees de mission invalides.' });
  }

  try {
    await ensureMissionColumns();
    const access = await getMissionAccess(req.params.id, req.user);
    if (!access.mission) return res.status(404).json({ error: 'Mission introuvable.' });
    if (!access.canWrite) return res.status(403).json({ error: 'Acces refuse.' });
    if (!isManager(req.user) && !['DRAFT', 'REJECTED', 'PLANNED', 'POSTPONED'].includes(access.mission.status)) {
      return res.status(409).json({ error: 'Cette mission ne peut plus etre modifiee.' });
    }

    await pool.query(
      `UPDATE crm_missions
       SET title = ?, description = ?, scheduled_date = ?, duration_hours = ?,
           institution_id = ?, region_id = ?, department_id = ?, city_id = ?,
           mission_type = ?, strategic_objective = ?, expected_result = ?,
           target_decision_maker = ?, target_technical_prescriber = ?, target_influencer = ?, target_contacts = ?,
           need_hypotheses = ?, visit_approach = ?, key_questions = ?, key_messages = ?, risks = ?, planned_measures = ?
       WHERE id = ?`,
      [
        title.trim(), description || null, scheduled_date,
        Math.min(Math.max(Number(duration_hours) || 2, 1), 72),
        institution_id, region_id, department_id, city_id,
        mission_type || access.mission.mission_type || 'PROSPECTION',
        STRATEGIC_OBJECTIVES.includes(strategic_objective) ? strategic_objective : access.mission.strategic_objective,
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
    return res.json({ message: 'Mission mise a jour.' });
  } catch (err) {
    console.error('[MISSIONS/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
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
    if (!rows.length || !fs.existsSync(rows[0].file_path)) {
      return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    }
    return res.download(path.resolve(rows[0].file_path), rows[0].file_name);
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
    if (fs.existsSync(rows[0].file_path)) fs.unlinkSync(rows[0].file_path);
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

module.exports = router;
