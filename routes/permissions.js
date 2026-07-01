const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Catalogue statique de tous les modules et leurs fonctionnalités auditables
const MODULE_CATALOGUE = [
  {
    module_id: 'crm',
    module_label: 'Objectifs',
    feature_id: 'objectives',
    feature_label: 'Objectifs Commerciaux'
  },
  {
    module_id: 'crm',
    module_label: 'Missions',
    feature_id: 'missions',
    feature_label: 'Missions Commerciales'
  },
  {
    module_id: 'crm',
    module_label: 'Institutions',
    feature_id: 'institutions',
    feature_label: 'Institutions / Prospects'
  },
  {
    module_id: 'crm',
    module_label: 'Opportunités',
    feature_id: 'opportunities',
    feature_label: 'Pipeline des Opportunités'
  },
  {
    module_id: 'crm',
    module_label: 'Rapports',
    feature_id: 'reports',
    feature_label: "Rapports d'Activité"
  },
  {
    module_id: 'admin',
    module_label: 'Administration',
    feature_id: 'users',
    feature_label: 'Utilisateurs & Équipes'
  },
  {
    module_id: 'admin',
    module_label: 'Administration',
    feature_id: 'referentials',
    feature_label: 'Référentiels Géographiques'
  },
  {
    module_id: 'admin',
    module_label: 'Administration',
    feature_id: 'kpis',
    feature_label: 'KPI & Indicateurs'
  },
  {
    module_id: 'admin',
    module_label: 'Administration',
    feature_id: 'security',
    feature_label: 'Sécurité & Audit'
  }
];

/**
 * GET /api/permissions/catalogue
 * Retourne le catalogue de tous les modules/features disponibles
 */
router.get('/catalogue', authenticate, authorize('SYSTEM', 'ADMIN'), (req, res) => {
  return res.json(MODULE_CATALOGUE);
});

/**
 * GET /api/permissions/job-descriptions
 * Retourne toutes les fiches de poste avec leurs habilitations
 */
router.get('/job-descriptions', authenticate, authorize('SYSTEM', 'ADMIN'), async (req, res) => {
  try {
    const [jobs] = await pool.query(
      `SELECT id, title, description, role_category FROM job_descriptions ORDER BY role_category, title`
    );

    const [perms] = await pool.query(
      `SELECT job_description_id, module_id, feature_id,
              can_view, can_create, can_update, can_delete, can_view_all, can_reorganize
       FROM job_feature_permissions`
    );

    // Grouper les permissions par job_description_id
    const permsByJob = {};
    for (const p of perms) {
      if (!permsByJob[p.job_description_id]) permsByJob[p.job_description_id] = [];
      permsByJob[p.job_description_id].push(p);
    }

    const result = jobs.map(job => ({
      ...job,
      permissions: permsByJob[job.id] || []
    }));

    return res.json(result);
  } catch (err) {
    console.error('[PERMISSIONS/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /api/permissions/job-descriptions/:jobId
 * Retourne les habilitations d'une fiche de poste spécifique
 */
router.get('/job-descriptions/:jobId', authenticate, authorize('SYSTEM', 'ADMIN'), async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!jobId) return res.status(400).json({ error: 'Identifiant invalide.' });

  try {
    const [[job]] = await pool.query(
      `SELECT id, title, description, role_category FROM job_descriptions WHERE id = ?`,
      [jobId]
    );
    if (!job) return res.status(404).json({ error: 'Fiche de poste introuvable.' });

    const [perms] = await pool.query(
      `SELECT module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize
       FROM job_feature_permissions WHERE job_description_id = ?`,
      [jobId]
    );

    return res.json({ ...job, permissions: perms });
  } catch (err) {
    console.error('[PERMISSIONS/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * PUT /api/permissions/job-descriptions/:jobId/feature
 * Met à jour ou crée les habilitations pour une feature d'une fiche de poste
 * Body: { module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize }
 */
router.put('/job-descriptions/:jobId/feature', authenticate, authorize('SYSTEM', 'ADMIN'), async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!jobId) return res.status(400).json({ error: 'Identifiant invalide.' });

  const { module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize } = req.body;

  if (!module_id || !feature_id) {
    return res.status(400).json({ error: 'module_id et feature_id sont requis.' });
  }

  // Vérifier que la fiche de poste existe
  const [[job]] = await pool.query(
    `SELECT id, role_category FROM job_descriptions WHERE id = ?`,
    [jobId]
  );
  if (!job) return res.status(404).json({ error: 'Fiche de poste introuvable.' });

  // Interdire la modification des habilitations du rôle SYSTEM
  if (job.role_category === 'SYSTEM') {
    return res.status(403).json({ error: 'Les habilitations du rôle Système ne peuvent pas être modifiées.' });
  }

  try {
    await pool.query(
      `INSERT INTO job_feature_permissions 
         (job_description_id, module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         can_view = VALUES(can_view),
         can_create = VALUES(can_create),
         can_update = VALUES(can_update),
         can_delete = VALUES(can_delete),
         can_view_all = VALUES(can_view_all),
         can_reorganize = VALUES(can_reorganize)`,
      [
        jobId, module_id, feature_id,
        can_view ? 1 : 0,
        can_create ? 1 : 0,
        can_update ? 1 : 0,
        can_delete ? 1 : 0,
        can_view_all ? 1 : 0,
        can_reorganize ? 1 : 0
      ]
    );

    // Log d'audit
    pool.query(
      `INSERT INTO crm_audit_logs (user_id, action_type, module_name, ip_address)
       VALUES (?, ?, 'permissions', ?)`,
      [
        req.user.id,
        `MAJ habilitations job#${jobId} — ${module_id}/${feature_id}`.slice(0, 100),
        (req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 45)
      ]
    ).catch(e => console.error('[AUDIT_PERMS]', e.message));

    return res.json({ message: 'Habilitation mise à jour.' });
  } catch (err) {
    console.error('[PERMISSIONS/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * POST /api/permissions/job-descriptions/:jobId/select-all
 * Active ou désactive toutes les permissions d'une feature pour une fiche de poste
 * Body: { module_id, feature_id, enable_all }
 */
router.post('/job-descriptions/:jobId/select-all', authenticate, authorize('SYSTEM', 'ADMIN'), async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!jobId) return res.status(400).json({ error: 'Identifiant invalide.' });

  const { module_id, feature_id, enable_all } = req.body;
  if (!module_id || !feature_id) {
    return res.status(400).json({ error: 'module_id et feature_id sont requis.' });
  }

  const [[job]] = await pool.query(`SELECT role_category FROM job_descriptions WHERE id = ?`, [jobId]);
  if (!job) return res.status(404).json({ error: 'Fiche de poste introuvable.' });
  if (job.role_category === 'SYSTEM') {
    return res.status(403).json({ error: 'Les habilitations du rôle Système ne peuvent pas être modifiées.' });
  }

  const val = enable_all ? 1 : 0;
  try {
    await pool.query(
      `INSERT INTO job_feature_permissions
         (job_description_id, module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         can_view = VALUES(can_view), can_create = VALUES(can_create),
         can_update = VALUES(can_update), can_delete = VALUES(can_delete),
         can_view_all = VALUES(can_view_all), can_reorganize = VALUES(can_reorganize)`,
      [jobId, module_id, feature_id, val, val, val, val, val, val]
    );
    return res.json({ message: enable_all ? 'Toutes les habilitations activées.' : 'Toutes les habilitations désactivées.' });
  } catch (err) {
    console.error('[PERMISSIONS/SELECT_ALL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
