const crypto = require('crypto');
const pool = require('../db');
const { notifyDirection } = require('../utils/notifications');

const ALLOWED_PERIODS = new Set([
  'ANNUAL',
  'SEMESTER',
  'SEMESTRIAL',
  'TRIMESTER',
  'TRIMESTRIAL',
  'MONTHLY',
  'WEEKLY',
  'DAILY',
  'EXCEPTIONAL',
  'PUNCTUAL'
]);

const ALLOWED_MEAN_TYPES = new Set([
  'BUDGET',
  'VEHICLE',
  'HUMAN_RESOURCES',
  'TRAINING',
  'EQUIPMENT',
  'MARKETING_SUPPORT'
]);

const ALLOWED_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);
const QUANTITATIVE_NATURE = 'QUANTITATIVE';
const QUALITATIVE_NATURE = 'QUALITATIVE';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, `${label} invalide.`);
  }
  return id;
}

function requiredText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw httpError(400, `${label} est obligatoire.`);
  if (text.length > maxLength) {
    throw httpError(400, `${label} ne doit pas dépasser ${maxLength} caractères.`);
  }
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw httpError(400, `Un champ texte dépasse la limite de ${maxLength} caractères.`);
  }
  return text;
}

function positiveNumber(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw httpError(400, `${label} doit être un nombre ${allowZero ? 'positif ou nul' : 'strictement positif'}.`);
  }
  return number;
}

function normalizeDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw httpError(400, `${label} invalide.`);
  }
  return text;
}

function normalizeClientRequestId(value) {
  const candidate = String(value || '').trim().toLowerCase();
  if (!candidate) return crypto.randomUUID();
  if (!/^[a-z0-9-]{16,40}$/.test(candidate)) {
    throw httpError(400, 'Identifiant de requête invalide.');
  }
  return candidate;
}

function normalizeMeans(items) {
  if (!Array.isArray(items)) return [];
  if (items.length > 20) throw httpError(400, 'Le nombre de moyens demandés est limité à 20.');

  return items.map((item) => {
    const type = String(item?.type || 'BUDGET').toUpperCase();
    if (!ALLOWED_MEAN_TYPES.has(type)) throw httpError(400, 'Type de moyen invalide.');

    const quantity = Number(item?.quantity || 1);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 10000) {
      throw httpError(400, 'La quantité du moyen doit être un entier positif raisonnable.');
    }

    return {
      type,
      description: requiredText(item?.description, 'La description du moyen', 1000),
      quantity,
      estimated_cost: positiveNumber(item?.estimated_cost || 0, 'Le coût estimé', { allowZero: true })
    };
  });
}

function normalizeTrainings(items) {
  if (!Array.isArray(items)) return [];
  if (items.length > 20) throw httpError(400, 'Le nombre de formations demandées est limité à 20.');

  return items.map((item) => {
    const priority = String(item?.priority || 'MEDIUM').toUpperCase();
    if (!ALLOWED_PRIORITIES.has(priority)) throw httpError(400, 'Priorité de formation invalide.');
    return {
      theme: requiredText(item?.theme, 'Le thème de formation', 255),
      goal: optionalText(item?.goal, 2000) || '-',
      period: optionalText(item?.period, 100) || '-',
      priority
    };
  });
}

function objectiveNatureFromKpiType(kpiType) {
  return String(kpiType || '').toUpperCase() === QUALITATIVE_NATURE
    ? QUALITATIVE_NATURE
    : QUANTITATIVE_NATURE;
}

function normalizeQualitativeCriteria(items) {
  const source = Array.isArray(items)
    ? items
    : String(items || '').split(/\r?\n/);
  const criteria = source.map(item => String(item || '').trim()).filter(Boolean);
  if (!criteria.length) {
    throw httpError(400, 'Au moins un critère de réussite qualitatif est obligatoire.');
  }
  if (criteria.length > 10) {
    throw httpError(400, 'Le nombre de critères de réussite est limité à 10.');
  }
  criteria.forEach((criterion) => {
    if (criterion.length > 500) {
      throw httpError(400, 'Un critère de réussite ne doit pas dépasser 500 caractères.');
    }
  });
  return criteria;
}

function normalizeObjectiveTargets(payload, objectiveNature) {
  if (objectiveNature === QUALITATIVE_NATURE) {
    return {
      objective_nature: QUALITATIVE_NATURE,
      target_value: null,
      min_level: null,
      expected_level: null,
      excellent_level: null,
      target_qlty: requiredText(payload.target_qlty, 'Le résultat qualitatif attendu', 5000),
      qualitative_criteria: normalizeQualitativeCriteria(payload.qualitative_criteria)
    };
  }

  const targetValue = positiveNumber(payload.target_value, 'La valeur cible');
  const minLevel = payload.min_level === '' || payload.min_level == null
    ? targetValue * 0.8
    : positiveNumber(payload.min_level, 'Le seuil minimum', { allowZero: true });
  const expectedLevel = payload.expected_level === '' || payload.expected_level == null
    ? targetValue
    : positiveNumber(payload.expected_level, 'Le seuil attendu', { allowZero: true });
  const excellentLevel = payload.excellent_level === '' || payload.excellent_level == null
    ? targetValue * 1.2
    : positiveNumber(payload.excellent_level, 'Le seuil excellent', { allowZero: true });

  if (minLevel > expectedLevel || expectedLevel > excellentLevel) {
    throw httpError(400, 'Les seuils doivent respecter : minimum ≤ attendu ≤ excellent.');
  }

  return {
    objective_nature: QUANTITATIVE_NATURE,
    target_value: targetValue,
    min_level: minLevel,
    expected_level: expectedLevel,
    excellent_level: excellentLevel,
    target_qlty: null,
    qualitative_criteria: []
  };
}

function normalizeProposal(payload = {}, kpiType = QUANTITATIVE_NATURE) {
  const periodType = String(payload.period_type || '').toUpperCase();
  if (!ALLOWED_PERIODS.has(periodType)) {
    throw httpError(400, 'Type de périodicité invalide.');
  }

  const startDate = normalizeDate(payload.start_date, 'Date de début');
  const endDate = normalizeDate(payload.end_date, 'Date de fin');
  if (startDate > endDate) {
    throw httpError(400, 'La date de début ne peut pas être supérieure à la date de fin.');
  }

  const targets = normalizeObjectiveTargets(payload, objectiveNatureFromKpiType(kpiType));

  return {
    client_request_id: normalizeClientRequestId(payload.client_request_id),
    title: requiredText(payload.title, "Le titre de l'objectif", 1000),
    description: requiredText(payload.description, "La description de l'objectif", 5000),
    period_type: periodType,
    start_date: startDate,
    end_date: endDate,
    domain_id: positiveId(payload.domain_id, 'Domaine'),
    kpi_id: positiveId(payload.kpi_id, 'KPI'),
    ...targets,
    observations: optionalText(payload.observations, 5000),
    moyens: normalizeMeans(payload.moyens),
    formations: normalizeTrainings(payload.formations)
  };
}

async function assertActiveKpi(conn, proposal) {
  const [rows] = await conn.query(
    `SELECT k.id, k.domain_id, k.type, k.unit, k.active AS kpi_active,
            d.active AS domain_active
     FROM kpis k
     JOIN objectif_domaines d ON d.id = k.domain_id
     WHERE k.id = ? AND d.id = ?
     LIMIT 1`,
    [proposal.kpi_id, proposal.domain_id]
  );

  if (!rows.length) throw httpError(400, 'Le KPI ne correspond pas au domaine sélectionné.');
  if (!rows[0].kpi_active || !rows[0].domain_active) {
    throw httpError(400, 'Le domaine et le KPI doivent être actifs.');
  }
  return rows[0];
}

async function replaceNeeds(conn, objectiveId, proposal) {
  await conn.query('DELETE FROM objectif_moyens WHERE objective_id = ?', [objectiveId]);
  await conn.query('DELETE FROM objectif_formations WHERE objective_id = ?', [objectiveId]);

  for (const mean of proposal.moyens) {
    await conn.query(
      `INSERT INTO objectif_moyens
         (objective_id, type, description, quantity, estimated_cost, approval_status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [objectiveId, mean.type, mean.description, mean.quantity, mean.estimated_cost]
    );
  }

  for (const training of proposal.formations) {
    await conn.query(
      `INSERT INTO objectif_formations
         (objective_id, theme, goal, period, priority, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [objectiveId, training.theme, training.goal, training.period, training.priority]
    );
  }
}

async function addHistory(conn, objectiveId, userId, action, oldValue, newValue, comments = null) {
  await conn.query(
    `INSERT INTO objectif_historiques
       (objective_id, user_id, action, old_value, new_value, comments, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [objectiveId, userId, action, JSON.stringify(oldValue), JSON.stringify(newValue), comments, 'pwa-sync']
  );
}

async function fetchObjective(db, objectiveId) {
  const [rows] = await db.query(
    `SELECT o.*, u.full_name AS assignee_name, c.full_name AS creator_name,
            k.name AS kpi_name, k.type AS kpi_type, k.unit AS kpi_unit,
            d.name AS domain_name
     FROM crm_objectives o
     LEFT JOIN users u ON o.responsible_id = u.id
     LEFT JOIN users c ON o.created_by = c.id
     LEFT JOIN kpis k ON o.kpi_id = k.id
     LEFT JOIN objectif_domaines d ON o.domain_id = d.id
     WHERE o.id = ?`,
    [objectiveId]
  );
  const objective = rows[0] || null;
  if (objective && typeof objective.qualitative_criteria === 'string') {
    try {
      objective.qualitative_criteria = JSON.parse(objective.qualitative_criteria);
    } catch {
      objective.qualitative_criteria = [];
    }
  }
  return objective;
}

function assertCommercial(user) {
  if (!user || user.role !== 'COMMERCIAL') {
    throw httpError(403, 'Seul un commercial peut créer une proposition terrain.');
  }
}

async function createObjectiveProposal(user, payload = {}, options = {}) {
  assertCommercial(user);
  const proposalReference = {
    domain_id: positiveId(payload.domain_id, 'Domaine'),
    kpi_id: positiveId(payload.kpi_id, 'KPI')
  };
  const submitImmediately = Boolean(options.submitImmediately);
  const conn = await pool.getConnection();
  let objectiveId;
  let created = false;
  let submittedNow = false;

  try {
    await conn.beginTransaction();

    const kpi = await assertActiveKpi(conn, proposalReference);
    const proposal = normalizeProposal(payload, kpi.type);
    const code = `OBJ-PWA-${proposal.client_request_id.toUpperCase()}`;

    const [existing] = await conn.query(
      'SELECT id, created_by, responsible_id, status FROM crm_objectives WHERE code = ? LIMIT 1',
      [code]
    );
    if (existing.length) {
      if (Number(existing[0].created_by) !== Number(user.id)) {
        throw httpError(409, 'Identifiant de synchronisation déjà utilisé.');
      }
      objectiveId = existing[0].id;
      if (!existing[0].responsible_id) {
        await conn.query('UPDATE crm_objectives SET responsible_id = ? WHERE id = ?', [user.id, objectiveId]);
        await addHistory(conn, objectiveId, user.id, 'SELF_ASSIGN', null, user.id, 'Auto-affectation au commercial créateur');
      }
      if (submitImmediately && ['DRAFT', 'CORRECTION'].includes(existing[0].status)) {
        await conn.query('UPDATE crm_objectives SET status = "SUBMITTED" WHERE id = ?', [objectiveId]);
        await addHistory(conn, objectiveId, user.id, 'SUBMIT', existing[0].status, 'SUBMITTED', 'Reprise idempotente de la soumission PWA');
        submittedNow = true;
      }
    } else {
      const initialStatus = submitImmediately ? 'SUBMITTED' : 'DRAFT';
      const [result] = await conn.query(
        `INSERT INTO crm_objectives (
           code, title, description, parent_id, period_type, start_date, end_date,
           responsible_id, domain_id, kpi_id, objective_nature, target_value, unit, min_level,
           expected_level, excellent_level, target_qlty, qualitative_criteria, direction, department, service,
           observations, status, created_by
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        [
          code,
          proposal.title,
          proposal.description,
          proposal.period_type,
          proposal.start_date,
          proposal.end_date,
          user.id,
          proposal.domain_id,
          proposal.kpi_id,
          proposal.objective_nature,
          proposal.target_value,
          kpi.unit,
          proposal.min_level,
          proposal.expected_level,
          proposal.excellent_level,
          proposal.target_qlty,
          JSON.stringify(proposal.qualitative_criteria),
          proposal.observations,
          initialStatus,
          user.id
        ]
      );
      objectiveId = result.insertId;
      created = true;

      await replaceNeeds(conn, objectiveId, proposal);
      await addHistory(conn, objectiveId, user.id, 'CREATE_PROPOSAL', null, {
        title: proposal.title,
        objective_nature: proposal.objective_nature,
        target_value: proposal.target_value,
        target_qlty: proposal.target_qlty,
        status: initialStatus,
        responsible_id: user.id
      }, 'Proposition créée et auto-affectée depuis la PWA terrain');

      if (submitImmediately) {
        await addHistory(conn, objectiveId, user.id, 'SUBMIT', 'DRAFT', 'SUBMITTED', 'Soumission immédiate depuis la PWA terrain');
        submittedNow = true;
      }
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  const objective = await fetchObjective(pool, objectiveId);
  if (submittedNow) {
    await notifyDirection(
      'Objectif soumis depuis le terrain',
      `L'objectif "${objective.title}" a été soumis par ${user.full_name}.`,
      'OBJECTIVE_SUBMITTED',
      objectiveId
    );
  }
  return { objective, created };
}

async function updateObjectiveProposal(user, objectiveIdValue, payload = {}) {
  assertCommercial(user);
  const objectiveId = positiveId(objectiveIdValue, 'Objectif');
  const proposalReference = {
    domain_id: positiveId(payload.domain_id, 'Domaine'),
    kpi_id: positiveId(payload.kpi_id, 'KPI')
  };
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [objectiveId]);
    if (!rows.length) throw httpError(404, 'Objectif introuvable.');
    const oldObjective = rows[0];
    if (Number(oldObjective.created_by) !== Number(user.id)) throw httpError(403, 'Accès refusé.');
    if (!['DRAFT', 'CORRECTION'].includes(oldObjective.status)) {
      throw httpError(409, "Cet objectif n'est plus modifiable dans son statut actuel.");
    }

    const kpi = await assertActiveKpi(conn, proposalReference);
    const proposal = normalizeProposal(payload, kpi.type);
    await conn.query(
      `UPDATE crm_objectives SET
         title = ?, description = ?, period_type = ?, start_date = ?, end_date = ?,
         domain_id = ?, kpi_id = ?, objective_nature = ?, target_value = ?, unit = ?, min_level = ?,
         expected_level = ?, excellent_level = ?, target_qlty = ?, qualitative_criteria = ?, observations = ?
       WHERE id = ?`,
      [
        proposal.title,
        proposal.description,
        proposal.period_type,
        proposal.start_date,
        proposal.end_date,
        proposal.domain_id,
        proposal.kpi_id,
        proposal.objective_nature,
        proposal.target_value,
        kpi.unit,
        proposal.min_level,
        proposal.expected_level,
        proposal.excellent_level,
        proposal.target_qlty,
        JSON.stringify(proposal.qualitative_criteria),
        proposal.observations,
        objectiveId
      ]
    );
    await replaceNeeds(conn, objectiveId, proposal);
    await addHistory(conn, objectiveId, user.id, 'UPDATE_PROPOSAL', {
      title: oldObjective.title,
      objective_nature: oldObjective.objective_nature,
      target_value: oldObjective.target_value
    }, {
      title: proposal.title,
      objective_nature: proposal.objective_nature,
      target_value: proposal.target_value,
      target_qlty: proposal.target_qlty
    }, 'Proposition modifiée depuis la PWA terrain');
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  return fetchObjective(pool, objectiveId);
}

async function submitObjectiveProposal(user, objectiveIdValue) {
  assertCommercial(user);
  const objectiveId = positiveId(objectiveIdValue, 'Objectif');
  const conn = await pool.getConnection();
  let objective;

  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [objectiveId]);
    if (!rows.length) throw httpError(404, 'Objectif introuvable.');
    objective = rows[0];
    if (Number(objective.created_by) !== Number(user.id)) throw httpError(403, 'Accès refusé.');
    if (!['DRAFT', 'CORRECTION'].includes(objective.status)) {
      throw httpError(409, "Cet objectif n'est pas dans un état soumissible.");
    }
    await conn.query('UPDATE crm_objectives SET status = "SUBMITTED" WHERE id = ?', [objectiveId]);
    await addHistory(conn, objectiveId, user.id, 'SUBMIT', objective.status, 'SUBMITTED', 'Soumission depuis la PWA terrain');
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  await notifyDirection(
    'Objectif soumis depuis le terrain',
    `L'objectif "${objective.title}" a été soumis par ${user.full_name}.`,
    'OBJECTIVE_SUBMITTED',
    objectiveId
  );
  return fetchObjective(pool, objectiveId);
}

async function deleteObjectiveProposal(user, objectiveIdValue) {
  assertCommercial(user);
  const objectiveId = positiveId(objectiveIdValue, 'Objectif');
  const [rows] = await pool.query('SELECT status, created_by FROM crm_objectives WHERE id = ?', [objectiveId]);
  if (!rows.length) throw httpError(404, 'Objectif introuvable.');
  if (Number(rows[0].created_by) !== Number(user.id)) throw httpError(403, 'Accès refusé.');
  if (rows[0].status !== 'DRAFT') throw httpError(409, 'Seul un brouillon peut être supprimé.');
  await pool.query('DELETE FROM crm_objectives WHERE id = ?', [objectiveId]);
}

module.exports = {
  createObjectiveProposal,
  updateObjectiveProposal,
  submitObjectiveProposal,
  deleteObjectiveProposal,
  normalizeProposal,
  normalizeObjectiveTargets,
  objectiveNatureFromKpiType,
  assertActiveKpi
};
