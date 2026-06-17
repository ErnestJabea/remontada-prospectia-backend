const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyDirection, notifyUser } = require('../utils/notifications');

const OBJECTIVE_MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);

function isObjectiveManager(user) {
  return OBJECTIVE_MANAGER_ROLES.has(user.role);
}

async function canAccessObjective(objective, user) {
  if (isObjectiveManager(user)) return true;
  if (objective.responsible_id === user.id || objective.created_by === user.id) return true;
  const [rows] = await pool.query(
    `SELECT 1
     FROM objectif_affectations
     WHERE objective_id = ? AND type = 'COMMERCIAL' AND target_id = ?
     LIMIT 1`,
    [objective.id, user.id]
  );
  return rows.length > 0;
}

async function syncObjectiveTeamMembers(conn, objectiveId, teamMemberIds = []) {
  const ids = [...new Set((Array.isArray(teamMemberIds) ? teamMemberIds : [])
    .map(id => Number(id))
    .filter(id => Number.isInteger(id) && id > 0))];

  await conn.query(
    'DELETE FROM objectif_affectations WHERE objective_id = ? AND type = "COMMERCIAL" AND value_allocated = 0',
    [objectiveId]
  );

  if (!ids.length) return;

  const placeholders = ids.map(() => '?').join(',');
  const [commercials] = await conn.query(
    `SELECT id, full_name FROM users WHERE id IN (${placeholders}) AND role = 'COMMERCIAL' AND is_active = TRUE`,
    ids
  );

  for (const commercial of commercials) {
    await conn.query(
      `INSERT INTO objectif_affectations (objective_id, type, target_id, target_name, value_allocated)
       VALUES (?, 'COMMERCIAL', ?, ?, 0)`,
      [objectiveId, commercial.id, commercial.full_name]
    );
  }
}

// ============================================================================
// LOGS D'AUDIT INTERNE
// ============================================================================
async function logObjectiveHistory(objectiveId, userId, action, oldValue, newValue, comments, req) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : '127.0.0.1';
    await pool.query(
      `INSERT INTO objectif_historiques (objective_id, user_id, action, old_value, new_value, comments, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [objectiveId, userId, action, JSON.stringify(oldValue), JSON.stringify(newValue), comments || null, ip]
    );
  } catch (err) {
    console.error('[AUDIT_ERROR] Failed to log history:', err);
  }
}

// ============================================================================
// RÉFÉRENTIEL DES DOMAINES
// ============================================================================

// GET /api/objectives/domains
router.get('/domains', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM objectif_domaines ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/objectives/domains
router.post('/domains', authenticate, authorize('DIRECTION', 'ADMIN'), async (req, res) => {
  const { code, name, description } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Code et libellé requis.' });
  try {
    const [result] = await pool.query(
      'INSERT INTO objectif_domaines (code, name, description) VALUES (?, ?, ?)',
      [code.toUpperCase(), name, description || null]
    );
    res.status(201).json({ id: result.insertId, message: 'Domaine de résultat créé.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// PUT /api/objectives/domains/:id
router.put('/domains/:id', authenticate, authorize('DIRECTION', 'ADMIN'), async (req, res) => {
  const { code, name, description, active } = req.body;
  try {
    await pool.query(
      'UPDATE objectif_domaines SET code = ?, name = ?, description = ?, active = ? WHERE id = ?',
      [code.toUpperCase(), name, description || null, active !== false, req.params.id]
    );
    res.json({ message: 'Domaine de résultat mis à jour.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// DELETE /api/objectives/domains/:id
router.delete('/domains/:id', authenticate, authorize('DIRECTION', 'ADMIN'), async (req, res) => {
  try {
    await pool.query('DELETE FROM objectif_domaines WHERE id = ?', [req.params.id]);
    res.json({ message: 'Domaine de résultat supprimé.' });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de supprimer car le domaine est lié à des objectifs ou KPIs.' });
  }
});

// ============================================================================
// RÉFÉRENTIEL DES KPIS
// ============================================================================

// GET /api/objectives/kpis
router.get('/kpis', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT k.*, d.name as domain_name 
      FROM kpis k
      JOIN objectif_domaines d ON k.domain_id = d.id
      ORDER BY k.name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/objectives/kpis
router.post('/kpis', authenticate, authorize('DIRECTION', 'ADMIN'), async (req, res) => {
  const { code, name, description, domain_id, type, unit, calculation_source, calculation_rule } = req.body;
  if (!code || !name || !domain_id || !type || !unit || !calculation_source) {
    return res.status(400).json({ error: 'Champs requis manquants pour le KPI.' });
  }

  // Valider les sources et agrégations autorisées
  const allowedSources = ['MISSIONS', 'OPPORTUNITIES', 'REPORTS', 'ACTIVITIES', 'MANUAL'];
  if (!allowedSources.includes(calculation_source)) {
    return res.status(400).json({ error: 'Source de calcul non valide.' });
  }

  if (calculation_rule) {
    try {
      const parsed = JSON.parse(calculation_rule);
      const allowedAggregates = ['COUNT', 'SUM', 'AVG', 'PERCENTAGE'];
      if (parsed.aggregate && !allowedAggregates.includes(parsed.aggregate)) {
        return res.status(400).json({ error: 'Agrégation de calcul non autorisée.' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'La règle de calcul doit être un JSON valide.' });
    }
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO kpis (code, name, description, domain_id, type, unit, calculation_source, calculation_rule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [code.toUpperCase(), name, description || null, domain_id, type, unit, calculation_source, calculation_rule || null]
    );
    res.status(201).json({ id: result.insertId, message: 'KPI créé.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// PUT /api/objectives/kpis/:id
router.put('/kpis/:id', authenticate, authorize('DIRECTION', 'ADMIN'), async (req, res) => {
  const { code, name, description, domain_id, type, unit, calculation_source, calculation_rule, active } = req.body;
  try {
    await pool.query(
      `UPDATE kpis SET code = ?, name = ?, description = ?, domain_id = ?, type = ?, unit = ?, 
       calculation_source = ?, calculation_rule = ?, active = ? WHERE id = ?`,
      [code.toUpperCase(), name, description || null, domain_id, type, unit, calculation_source, calculation_rule || null, active !== false, req.params.id]
    );
    res.json({ message: 'KPI mis à jour.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// DELETE /api/objectives/kpis/:id
router.delete('/kpis/:id', authenticate, authorize('DIRECTION', 'ADMIN'), async (req, res) => {
  try {
    await pool.query('DELETE FROM kpis WHERE id = ?', [req.params.id]);
    res.json({ message: 'KPI supprimé.' });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de supprimer car le KPI est actuellement en cours d\'utilisation.' });
  }
});

// ============================================================================
// MOTEUR DE CALCUL AUTOMATIQUE DE KPI
// ============================================================================
async function evaluateKpiPerformance(kpi, responsibleId, startDate, endDate) {
  if (kpi.calculation_source === 'MANUAL') {
    return null; // Do not overwrite manual value, return null to skip auto overwrite
  }

  let rule = {};
  try {
    rule = typeof kpi.calculation_rule === 'string' ? JSON.parse(kpi.calculation_rule) : (kpi.calculation_rule || {});
  } catch (e) {
    console.error('Failed to parse calculation rule JSON', e);
    return 0;
  }

  const source = kpi.calculation_source;
  const aggregate = rule.aggregate || 'COUNT';
  const field = rule.field || 'id';
  const filters = rule.filters || [];

  // Construct query safely
  let selectClause = '';
  if (aggregate === 'COUNT') {
    selectClause = `COUNT(${pool.escapeId(field)}) AS result`;
  } else if (aggregate === 'SUM') {
    selectClause = `SUM(${pool.escapeId(field)}) AS result`;
  } else if (aggregate === 'AVG') {
    selectClause = `AVG(${pool.escapeId(field)}) AS result`;
  } else {
    selectClause = `COUNT(${pool.escapeId(field)}) AS result`;
  }

  let query = '';
  let params = [];

  // Date formatted for DB comparison
  const startStr = new Date(startDate).toISOString().slice(0, 19).replace('T', ' ');
  const endStr = new Date(endDate).toISOString().slice(0, 19).replace('T', ' ');

  if (source === 'MISSIONS' || source === 'ACTIVITIES') {
    query = `SELECT ${selectClause} FROM crm_missions WHERE primary_commercial_id = ? AND scheduled_date BETWEEN ? AND ?`;
    params = [responsibleId, startStr, endStr];
  } else if (source === 'OPPORTUNITIES') {
    query = `SELECT ${selectClause} FROM crm_opportunities WHERE assigned_to = ? AND created_at BETWEEN ? AND ?`;
    params = [responsibleId, startStr, endStr];
  } else if (source === 'REPORTS') {
    query = `SELECT ${selectClause} FROM crm_reports r JOIN crm_missions m ON r.mission_id = m.id WHERE m.primary_commercial_id = ? AND r.created_at BETWEEN ? AND ?`;
    params = [responsibleId, startStr, endStr];
  } else {
    return 0;
  }

  // Safely apply filters
  for (const filter of filters) {
    const colName = filter.column;
    const operator = filter.operator;
    const val = filter.value;

    const allowedColumns = ['status', 'type', 'priority', 'pipeline_stage', 'estimated_amount', 'id'];
    if (!allowedColumns.includes(colName)) continue;

    const allowedOperators = ['=', '!=', '>', '<', '>=', '<=', 'IN'];
    if (!allowedOperators.includes(operator)) continue;

    if (operator === 'IN') {
      if (Array.isArray(val) && val.length > 0) {
        const placeholders = val.map(() => '?').join(', ');
        query += ` AND ${pool.escapeId(colName)} IN (${placeholders})`;
        params.push(...val);
      }
    } else {
      query += ` AND ${pool.escapeId(colName)} ${operator} ?`;
      params.push(val);
    }
  }

  const [rows] = await pool.query(query, params);
  const valResult = rows[0]?.result || 0;
  return parseFloat(valResult);
}

// Consolidate parent-child objectives
async function evaluateObjective(objectiveId, userId = 1) {
  const [objectives] = await pool.query('SELECT * FROM crm_objectives WHERE id = ?', [objectiveId]);
  if (!objectives.length) return;
  const obj = objectives[0];

  // 1. Recalculate based on children or dynamic KPI
  const [children] = await pool.query('SELECT id, achieved_value FROM crm_objectives WHERE parent_id = ?', [objectiveId]);

  let achievedValue = 0;
  let isManual = false;

  if (children.length > 0) {
    // Consolidation parent-enfant
    for (const child of children) {
      achievedValue += parseFloat(child.achieved_value || 0);
    }
  } else {
    // Feuille - Calculer via le KPI
    const [kpis] = await pool.query('SELECT * FROM kpis WHERE id = ?', [obj.kpi_id]);
    if (kpis.length > 0) {
      if (kpis[0].calculation_source !== 'MANUAL') {
        const calculated = await evaluateKpiPerformance(kpis[0], obj.responsible_id, obj.start_date, obj.end_date);
        achievedValue = calculated !== null ? calculated : parseFloat(obj.achieved_value || 0);
      } else {
        achievedValue = parseFloat(obj.achieved_value || 0);
        isManual = true;
      }
    }
  }

  // 2. Taux d'atteinte et statut de performance
  const targetValue = parseFloat(obj.target_value || 1);
  const achievementRate = targetValue > 0 ? (achievedValue / targetValue) * 100 : 0;

  let perfStatus = 'NOT_EVALUATED';
  const minVal = parseFloat(obj.min_level || 0);
  const expVal = parseFloat(obj.expected_level || 0);
  const excVal = parseFloat(obj.excellent_level || 0);

  if (achievedValue < minVal) {
    perfStatus = 'NOT_ACHIEVED';
  } else if (achievedValue >= minVal && achievedValue < expVal) {
    perfStatus = 'UNDER_EXPECTATIONS';
  } else if (achievedValue >= expVal && achievedValue < excVal) {
    perfStatus = 'ACHIEVED';
  } else if (achievedValue >= excVal) {
    perfStatus = 'EXCEEDED';
  }

  // 3. Workflow transition automatique
  let nextWorkflowStatus = obj.status;
  const now = new Date();
  const start = new Date(obj.start_date);

  if (obj.status === 'ASSIGNED' && now >= start) {
    nextWorkflowStatus = 'IN_PROGRESS';
  }

  await pool.query(
    `UPDATE crm_objectives 
     SET achieved_value = ?, achievement_rate = ?, performance_status = ?, status = ?
     WHERE id = ?`,
    [achievedValue, achievementRate, perfStatus, nextWorkflowStatus, objectiveId]
  );

  // Enregistrer le résultat
  await pool.query(
    `INSERT INTO objectif_resultats (objective_id, achieved_value, target_value, gap, achievement_rate, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [objectiveId, achievedValue, targetValue, achievedValue - targetValue, achievementRate, isManual ? 'Saisie Manuelle' : 'Évaluation Automatique', userId]
  );

  // Remontée récursive de consolidation
  if (obj.parent_id) {
    await evaluateObjective(obj.parent_id, userId);
  }
}

// ============================================================================
// CRUD OBJECTIFS
// ============================================================================

// GET /api/objectives
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, period_type, domain_id, responsible_id } = req.query;
    let query = `
      SELECT o.*, u.full_name as assignee_name, c.full_name as creator_name,
             k.name as kpi_name, k.unit as kpi_unit, d.name as domain_name
      FROM crm_objectives o
      LEFT JOIN users u ON o.responsible_id = u.id
      LEFT JOIN users c ON o.created_by = c.id
      LEFT JOIN kpis k ON o.kpi_id = k.id
      LEFT JOIN objectif_domaines d ON o.domain_id = d.id
    `;
    const params = [];
    const conditions = [];

    // Sécurité PWA : si commercial, filtrer par ses objectifs ou ceux assignés
    if (req.user.role === 'COMMERCIAL') {
      conditions.push('(o.responsible_id = ? OR o.id IN (SELECT objective_id FROM objectif_affectations WHERE target_id = ? AND type = "COMMERCIAL"))');
      params.push(req.user.id, req.user.id);
    } else if (responsible_id) {
      conditions.push('o.responsible_id = ?');
      params.push(responsible_id);
    }

    if (status) { conditions.push('o.status = ?'); params.push(status); }
    if (period_type) { conditions.push('o.period_type = ?'); params.push(period_type); }
    if (domain_id) { conditions.push('o.domain_id = ?'); params.push(domain_id); }

    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY o.created_at DESC';

    const [rows] = await pool.query(query, params);
    if (rows.length) {
      const objectiveIds = rows.map(row => row.id);
      const placeholders = objectiveIds.map(() => '?').join(',');
      const [affectations] = await pool.query(
        `SELECT * FROM objectif_affectations WHERE objective_id IN (${placeholders})`,
        objectiveIds
      );
      const affectationsByObjective = affectations.reduce((acc, aff) => {
        if (!acc[aff.objective_id]) acc[aff.objective_id] = [];
        acc[aff.objective_id].push(aff);
        return acc;
      }, {});
      rows.forEach(row => {
        row.affectations = affectationsByObjective[row.id] || [];
        row.team_member_ids = row.affectations
          .filter(aff => aff.type === 'COMMERCIAL' && Number(aff.value_allocated || 0) === 0 && aff.target_id)
          .map(aff => aff.target_id);
      });
    }
    res.json(rows);
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/objectives/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [objs] = await pool.query(
      `SELECT o.*, u.full_name as responsible_name, u.role as responsible_role,
              k.name as kpi_name, k.type as kpi_type, k.calculation_source as kpi_source, d.name as domain_name,
              p.title as parent_title
       FROM crm_objectives o
       LEFT JOIN users u ON o.responsible_id = u.id
       LEFT JOIN kpis k ON o.kpi_id = k.id
       LEFT JOIN objectif_domaines d ON o.domain_id = d.id
       LEFT JOIN crm_objectives p ON o.parent_id = p.id
       WHERE o.id = ?`,
      [req.params.id]
    );

    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    const objective = objs[0];
    if (!(await canAccessObjective(objective, req.user))) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }

    // Récupérer les moyens
    const [moyens] = await pool.query('SELECT * FROM objectif_moyens WHERE objective_id = ?', [objective.id]);
    objective.moyens = moyens;

    // Récupérer les formations
    const [formations] = await pool.query('SELECT * FROM objectif_formations WHERE objective_id = ?', [objective.id]);
    objective.formations = formations;

    // Récupérer les affectations
    const [affectations] = await pool.query('SELECT * FROM objectif_affectations WHERE objective_id = ?', [objective.id]);
    objective.affectations = affectations;

    // Récupérer l'historique
    const [historiques] = await pool.query(
      `SELECT h.*, u.full_name as user_name 
       FROM objectif_historiques h
       JOIN users u ON h.user_id = u.id
       WHERE h.objective_id = ? ORDER BY h.created_at DESC`,
      [objective.id]
    );
    objective.historiques = historiques;

    res.json(objective);
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/objectives
router.post('/', authenticate, authorize('DIRECTION', 'SYSTEM', 'ADMIN'), async (req, res) => {
  const {
    code, title, description, parent_id, period_type, start_date, end_date, responsible_id,
    domain_id, kpi_id, target_value, unit, min_level, expected_level, excellent_level,
    direction, department, service, observations, moyens, formations, team_member_ids
  } = req.body;

  // Validation
  if (!title || !period_type || !start_date || !end_date || !domain_id || !kpi_id) {
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  }
  const allowedPeriods = ['ANNUAL', 'SEMESTRIAL', 'TRIMESTRIAL', 'MONTHLY', 'EXCEPTIONAL'];
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 150 ||
    !allowedPeriods.includes(period_type) ||
    Number.isNaN(Date.parse(start_date)) ||
    Number.isNaN(Date.parse(end_date)) ||
    new Date(start_date) > new Date(end_date) ||
    !Number(domain_id) ||
    !Number(kpi_id) ||
    (target_value !== undefined && target_value !== null && target_value !== '' && Number(target_value) < 0)
  ) {
    return res.status(400).json({ error: 'Donnees d\'objectif invalides.' });
  }

  // Cohérence des seuils
  const minVal = parseFloat(min_level || 0);
  const expVal = parseFloat(expected_level || 0);
  const excVal = parseFloat(excellent_level || 0);

  if (minVal > expVal || expVal > excVal) {
    return res.status(400).json({ error: 'Règle de cohérence non respectée : Seuil Min <= Seuil Attendu <= Seuil Excellent.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO crm_objectives (
        code, title, description, parent_id, period_type, start_date, end_date, responsible_id,
        domain_id, kpi_id, target_value, unit, min_level, expected_level, excellent_level,
        direction, department, service, observations, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
      [
        code || null, title, description || null, parent_id || null, period_type, start_date, end_date, responsible_id || null,
        domain_id, kpi_id, target_value || null, unit || 'FCFA', min_level || null, expected_level || null, excellent_level || null,
        direction || null, department || null, service || null, observations || null, req.user.id
      ]
    );

    const objId = result.insertId;

    // Enregistrer les moyens
    if (moyens && Array.isArray(moyens)) {
      for (const m of moyens) {
        await conn.query(
          `INSERT INTO objectif_moyens (objective_id, type, description, quantity, estimated_cost, approval_status)
           VALUES (?, ?, ?, ?, ?, 'PENDING')`,
          [objId, m.type, m.description, m.quantity || 1, m.estimated_cost || 0]
        );
      }
    }

    // Enregistrer les formations
    if (formations && Array.isArray(formations)) {
      for (const f of formations) {
        await conn.query(
          `INSERT INTO objectif_formations (objective_id, theme, goal, period, priority, status)
           VALUES (?, ?, ?, ?, ?, 'PENDING')`,
          [objId, f.theme, f.goal, f.period, f.priority || 'MEDIUM']
        );
      }
    }

    await syncObjectiveTeamMembers(conn, objId, team_member_ids);

    await conn.commit();

    await logObjectiveHistory(objId, req.user.id, 'CREATE', null, { title, target_value }, 'Création initiale', req);

    res.status(201).json({ id: objId, message: 'Objectif créé sous forme de brouillon.' });
  } catch (err) {
    await conn.rollback();
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    conn.release();
  }
});

// PUT /api/objectives/:id
router.put('/:id', authenticate, async (req, res) => {
  const {
    code, title, description, parent_id, period_type, start_date, end_date, responsible_id,
    domain_id, kpi_id, target_value, unit, min_level, expected_level, excellent_level,
    direction, department, service, observations, moyens, formations, team_member_ids
  } = req.body;

  const allowedPeriods = ['ANNUAL', 'SEMESTRIAL', 'TRIMESTRIAL', 'MONTHLY', 'EXCEPTIONAL'];
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 150 ||
    !allowedPeriods.includes(period_type) ||
    Number.isNaN(Date.parse(start_date)) ||
    Number.isNaN(Date.parse(end_date)) ||
    new Date(start_date) > new Date(end_date) ||
    !Number(domain_id) ||
    !Number(kpi_id)
  ) {
    return res.status(400).json({ error: 'Donnees d\'objectif invalides.' });
  }

  // Cohérence des seuils
  const minVal = parseFloat(min_level || 0);
  const expVal = parseFloat(expected_level || 0);
  const excVal = parseFloat(excellent_level || 0);

  if (minVal > expVal || expVal > excVal) {
    return res.status(400).json({ error: 'Règle de cohérence non respectée : Seuil Min <= Seuil Attendu <= Seuil Excellent.' });
  }

  // Récupérer l'ancien état pour audit et historique
  const [oldRows] = await pool.query('SELECT * FROM crm_objectives WHERE id = ?', [req.params.id]);
  if (!oldRows.length) return res.status(404).json({ error: 'Objectif introuvable.' });
  const oldObj = oldRows[0];

  if (!isObjectiveManager(req.user) && oldObj.created_by !== req.user.id && oldObj.responsible_id !== req.user.id) {
    return res.status(403).json({ error: 'Acces refuse.' });
  }

  // Seul le créateur ou la direction peut modifier en DRAFT ou CORRECTION
  if (oldObj.status !== 'DRAFT' && oldObj.status !== 'CORRECTION' && !isObjectiveManager(req.user)) {
    return res.status(403).json({ error: 'Vous ne pouvez plus modifier cet objectif dans son statut actuel.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE crm_objectives SET 
        code = ?, title = ?, description = ?, parent_id = ?, period_type = ?, start_date = ?, end_date = ?, 
        responsible_id = ?, domain_id = ?, kpi_id = ?, target_value = ?, unit = ?, min_level = ?, 
        expected_level = ?, excellent_level = ?, direction = ?, department = ?, service = ?, observations = ?
       WHERE id = ?`,
      [
        code || null, title, description || null, parent_id || null, period_type, start_date, end_date, responsible_id || null,
        domain_id, kpi_id, target_value || null, unit || 'FCFA', min_level || null, expected_level || null, excellent_level || null,
        direction || null, department || null, service || null, observations || null, req.params.id
      ]
    );

    // Supprimer et réinsérer les moyens/formations pour garder le CRUD simple (si fournis)
    if (moyens) {
      await conn.query('DELETE FROM objectif_moyens WHERE objective_id = ?', [req.params.id]);
      for (const m of moyens) {
        await conn.query(
          `INSERT INTO objectif_moyens (objective_id, type, description, quantity, estimated_cost, validated_cost, approval_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [req.params.id, m.type, m.description, m.quantity || 1, m.estimated_cost || 0, m.validated_cost || 0, m.approval_status || 'PENDING']
        );
      }
    }

    if (formations) {
      await conn.query('DELETE FROM objectif_formations WHERE objective_id = ?', [req.params.id]);
      for (const f of formations) {
        await conn.query(
          `INSERT INTO objectif_formations (objective_id, theme, goal, period, priority, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.params.id, f.theme, f.goal, f.period, f.priority || 'MEDIUM', f.status || 'PENDING']
        );
      }
    }

    if (Array.isArray(team_member_ids)) {
      await syncObjectiveTeamMembers(conn, req.params.id, team_member_ids);
    }

    await conn.commit();

    await logObjectiveHistory(req.params.id, req.user.id, 'UPDATE', oldObj, { title, target_value }, 'Modification de l\'objectif', req);

    res.json({ message: 'Objectif mis à jour avec succès.' });
  } catch (err) {
    await conn.rollback();
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    conn.release();
  }
});

// DELETE /api/objectives/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const [objs] = await pool.query(
      'SELECT status, created_by, responsible_id FROM crm_objectives WHERE id = ?',
      [req.params.id]
    );
    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });

    if (!isObjectiveManager(req.user) && objs[0].created_by !== req.user.id && objs[0].responsible_id !== req.user.id) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }

    if (objs[0].status !== 'DRAFT' && !isObjectiveManager(req.user)) {
      return res.status(403).json({ error: 'Seuls les brouillons peuvent être supprimés.' });
    }

    await pool.query('DELETE FROM crm_objectives WHERE id = ?', [req.params.id]);
    res.json({ message: 'Objectif supprimé.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ============================================================================
// ROUTES ACTIONS WORKFLOW
// ============================================================================

// POST /api/objectives/:id/submit
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const [objs] = await pool.query('SELECT * FROM crm_objectives WHERE id = ?', [req.params.id]);
    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    const obj = objs[0];

    if (!isObjectiveManager(req.user) && obj.created_by !== req.user.id && obj.responsible_id !== req.user.id) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }

    if (obj.status !== 'DRAFT' && obj.status !== 'CORRECTION') {
      return res.status(400).json({ error: 'L\'objectif n\'est pas dans un état soumisible.' });
    }

    await pool.query('UPDATE crm_objectives SET status = "SUBMITTED" WHERE id = ?', [req.params.id]);
    await logObjectiveHistory(req.params.id, req.user.id, 'SUBMIT', obj.status, 'SUBMITTED', 'Soumission pour validation', req);

    // Notifier la direction
    await notifyDirection(
      'Objectif Soumis',
      `L'objectif "${obj.title}" a été soumis pour validation par ${req.user.full_name}.`,
      'OBJECTIVE_SUBMITTED',
      obj.id
    );

    res.json({ message: 'Objectif soumis à la direction.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/objectives/:id/validate
router.post('/:id/validate', authenticate, authorize('DIRECTION'), async (req, res) => {
  const { action, comments, moyens, formations } = req.body; // action: 'VALIDATE', 'CORRECTION', 'REJECT'
  if (!['VALIDATE', 'CORRECTION', 'REJECT'].includes(action)) {
    return res.status(400).json({ error: 'Action invalide.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [objs] = await conn.query('SELECT * FROM crm_objectives WHERE id = ?', [req.params.id]);
    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    const obj = objs[0];

    if (obj.status !== 'SUBMITTED') {
      return res.status(400).json({ error: 'Seuls les objectifs soumis peuvent être validés.' });
    }

    let targetStatus = 'VALIDATED';
    let labelAction = 'VALIDATE';
    if (action === 'CORRECTION') {
      targetStatus = 'CORRECTION';
      labelAction = 'NEED_CORRECTION';
    } else if (action === 'REJECT') {
      targetStatus = 'REJECTED';
      labelAction = 'REJECT';
    }

    await conn.query('UPDATE crm_objectives SET status = ? WHERE id = ?', [targetStatus, req.params.id]);

    // Mettre à jour l'approbation des moyens si fournis
    if (moyens && Array.isArray(moyens)) {
      for (const m of moyens) {
        await conn.query(
          'UPDATE objectif_moyens SET validated_cost = ?, approval_status = ? WHERE id = ? AND objective_id = ?',
          [m.validated_cost || 0, m.approval_status || 'APPROVED', m.id, req.params.id]
        );
      }
    }

    // Mettre à jour le statut des formations si fournies
    if (formations && Array.isArray(formations)) {
      for (const f of formations) {
        await conn.query(
          'UPDATE objectif_formations SET status = ? WHERE id = ? AND objective_id = ?',
          [f.status || 'APPROVED', f.id, req.params.id]
        );
      }
    }

    await conn.commit();

    await logObjectiveHistory(req.params.id, req.user.id, labelAction, obj.status, targetStatus, comments, req);

    // Notifier le créateur/responsable
    const notifTitle = action === 'VALIDATE' ? 'Objectif Validé' : (action === 'CORRECTION' ? 'Objectif à Corriger' : 'Objectif Rejeté');
    const notifType = action === 'VALIDATE' ? 'OBJECTIVE_VALIDATED' : (action === 'CORRECTION' ? 'OBJECTIVE_CORRECTION' : 'OBJECTIVE_REJECTED');
    const msg = `Votre objectif "${obj.title}" a été ${action === 'VALIDATE' ? 'validé' : (action === 'CORRECTION' ? 'renvoyé pour correction' : 'rejeté')} par la direction.`;

    if (obj.created_by) await notifyUser(obj.created_by, notifTitle, msg, notifType, obj.id);
    if (obj.responsible_id && obj.responsible_id !== obj.created_by) {
      await notifyUser(obj.responsible_id, notifTitle, msg, notifType, obj.id);
    }

    res.json({ message: `Objectif mis à jour avec le statut : ${targetStatus}` });
  } catch (err) {
    await conn.rollback();
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    conn.release();
  }
});

// POST /api/objectives/:id/assign
router.post('/:id/assign', authenticate, async (req, res) => {
  const { affectations } = req.body;
  if (!affectations || !Array.isArray(affectations) || affectations.length === 0) {
    return res.status(400).json({ error: 'Affectations requises.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [objs] = await conn.query('SELECT * FROM crm_objectives WHERE id = ?', [req.params.id]);
    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    const obj = objs[0];

    // L'affectation requiert DIRECTION ou d'être le responsable principal
    if (!isObjectiveManager(req.user) && obj.responsible_id !== req.user.id) {
      return res.status(403).json({ error: 'Permissions d\'affectation insuffisantes.' });
    }
    if (!['VALIDATED', 'ASSIGNED'].includes(obj.status)) {
      return res.status(409).json({ error: 'Seul un objectif valide peut etre affecte.' });
    }

    // Effacer les affectations existantes
    await conn.query('DELETE FROM objectif_affectations WHERE objective_id = ?', [req.params.id]);

    // Insérer les nouvelles affectations
    for (const aff of affectations) {
      await conn.query(
        `INSERT INTO objectif_affectations (objective_id, type, target_id, target_name, value_allocated)
         VALUES (?, ?, ?, ?, ?)`,
        [req.params.id, aff.type, aff.target_id || null, aff.target_name || null, aff.value_allocated]
      );

      // Notifier le commercial affecté
      if (aff.type === 'COMMERCIAL' && aff.target_id) {
        await notifyUser(
          aff.target_id,
          'Objectif Affecté',
          `Un sous-objectif de "${obj.title}" vous a été affecté (cible: ${aff.value_allocated}).`,
          'OBJECTIVE_ASSIGNED',
          obj.id
        );
      }
    }

    // Passer à ASSIGNED
    await conn.query('UPDATE crm_objectives SET status = "ASSIGNED" WHERE id = ?', [req.params.id]);

    await conn.commit();

    await logObjectiveHistory(req.params.id, req.user.id, 'ASSIGN', obj.status, 'ASSIGNED', 'Affectation des parts d\'objectifs', req);

    res.json({ message: 'Affectations enregistrées avec succès. Objectif affecté.' });
  } catch (err) {
    await conn.rollback();
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    conn.release();
  }
});

// POST /api/objectives/:id/evaluate (Déclencher l'évaluation automatique)
router.post('/:id/evaluate', authenticate, async (req, res) => {
  try {
    const [objectives] = await pool.query(
      'SELECT id, responsible_id FROM crm_objectives WHERE id = ?',
      [req.params.id]
    );
    if (!objectives.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    if (!isObjectiveManager(req.user) && objectives[0].responsible_id !== req.user.id) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }
    await evaluateObjective(req.params.id, req.user.id);
    res.json({ message: 'Évaluation et consolidation accomplies avec succès.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/objectives/:id/record-manual-performance
router.post('/:id/record-manual-performance', authenticate, authorize('DIRECTION'), async (req, res) => {
  const { value, comments } = req.body;
  if (value === undefined || value === null || !comments) {
    return res.status(400).json({ error: 'Valeur et commentaire/justification obligatoires.' });
  }

  try {
    const [objs] = await pool.query(
      `SELECT o.*, k.calculation_source 
       FROM crm_objectives o 
       JOIN kpis k ON o.kpi_id = k.id 
       WHERE o.id = ?`,
      [req.params.id]
    );

    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    const obj = objs[0];

    if (obj.calculation_source !== 'MANUAL') {
      return res.status(400).json({ error: 'La saisie manuelle est réservée exclusivement aux KPIs de type MANUAL.' });
    }

    const oldValue = obj.achieved_value;
    const newValue = parseFloat(value);

    // Mettre à jour la valeur manuelle
    await pool.query('UPDATE crm_objectives SET achieved_value = ? WHERE id = ?', [newValue, req.params.id]);

    // Recalculer l'objectif (taux, statut, etc. + cascade parent)
    await evaluateObjective(req.params.id, req.user.id);

    // Insérer l'historique d'audit strict
    await logObjectiveHistory(
      req.params.id,
      req.user.id,
      'RECORD_MANUAL_PERFORMANCE',
      { achieved_value: oldValue },
      { achieved_value: newValue },
      comments,
      req
    );

    res.json({ message: 'Performance manuelle enregistrée et évaluée.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/objectives/:id/close (Clôturer)
router.post('/:id/close', authenticate, authorize('DIRECTION'), async (req, res) => {
  try {
    const [objs] = await pool.query('SELECT * FROM crm_objectives WHERE id = ?', [req.params.id]);
    if (!objs.length) return res.status(404).json({ error: 'Objectif introuvable.' });
    const obj = objs[0];

    await pool.query('UPDATE crm_objectives SET status = "CLOSED" WHERE id = ?', [req.params.id]);
    await logObjectiveHistory(req.params.id, req.user.id, 'CLOSE', obj.status, 'CLOSED', 'Clôture de l\'objectif', req);

    // Notifier le responsable
    if (obj.responsible_id) {
      await notifyUser(
        obj.responsible_id,
        'Objectif Clôturé',
        `Votre objectif "${obj.title}" a été clôturé par la direction.`,
        'OBJECTIVE_CLOSED',
        obj.id
      );
    }

    res.json({ message: 'Objectif clôturé et archivé.' });
  } catch (err) {
    console.error('[OBJECTIVES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
