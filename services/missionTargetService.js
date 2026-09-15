const TARGET_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
const OPPORTUNITY_MATURITIES = new Set([
  'DISCOVERY', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'DECISION'
]);

let ensureTablesPromise;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function text(value, maxLength = 1000) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function level(value, fallback = 'MEDIUM') {
  const normalized = String(value || '').trim().toUpperCase();
  return TARGET_LEVELS.has(normalized) ? normalized : fallback;
}

function maturity(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return OPPORTUNITY_MATURITIES.has(normalized) ? normalized : 'DISCOVERY';
}

function optionalOpportunity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = text(value.title, 150);
  const needDescription = text(value.need_description, 2000);
  const proposedSolution = text(value.proposed_solution, 1000);
  const estimatedAmount = Number(value.estimated_amount || 0);
  if (!title && !needDescription && !proposedSolution && !estimatedAmount) return null;
  if (!title || !needDescription) {
    throw httpError(400, 'Le titre et le besoin sont obligatoires pour chaque opportunité cible.');
  }
  if (!Number.isFinite(estimatedAmount) || estimatedAmount < 0 || estimatedAmount > 1000000000000) {
    throw httpError(400, 'Le montant estimé d’une opportunité cible est invalide.');
  }
  return {
    title,
    need_description: needDescription,
    proposed_solution: proposedSolution,
    estimated_amount: estimatedAmount,
    priority: level(value.priority),
    maturity: maturity(value.maturity),
    expected_deadline: value.expected_deadline || null,
    tender_reference: text(value.tender_reference, 120),
    current_supplier: text(value.current_supplier, 160),
    notes: text(value.notes, 2000)
  };
}

async function ensureMissionTargetTables(connection) {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS crm_mission_targets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          mission_id INT NOT NULL,
          institution_id INT NOT NULL,
          visit_order INT NOT NULL DEFAULT 1,
          priority ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
          potential ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
          contact_name VARCHAR(150) NULL,
          contact_role VARCHAR(120) NULL,
          contact_phone VARCHAR(40) NULL,
          contact_email VARCHAR(190) NULL,
          notes TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_mission_target_institution (mission_id, institution_id),
          KEY idx_mission_targets_order (mission_id, visit_order),
          CONSTRAINT fk_mission_targets_mission FOREIGN KEY (mission_id) REFERENCES crm_missions(id) ON DELETE CASCADE,
          CONSTRAINT fk_mission_targets_institution FOREIGN KEY (institution_id) REFERENCES crm_institutions(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS crm_mission_target_opportunities (
          id INT AUTO_INCREMENT PRIMARY KEY,
          mission_target_id INT NOT NULL,
          title VARCHAR(150) NOT NULL,
          need_description TEXT NOT NULL,
          proposed_solution TEXT NULL,
          estimated_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          priority ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
          maturity ENUM('DISCOVERY','QUALIFIED','PROPOSAL','NEGOTIATION','DECISION') NOT NULL DEFAULT 'DISCOVERY',
          expected_deadline DATE NULL,
          tender_reference VARCHAR(120) NULL,
          current_supplier VARCHAR(160) NULL,
          notes TEXT NULL,
          linked_opportunity_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_mission_target_opportunity (mission_target_id),
          CONSTRAINT fk_target_opportunities_target FOREIGN KEY (mission_target_id) REFERENCES crm_mission_targets(id) ON DELETE CASCADE,
          CONSTRAINT fk_target_opportunities_pipeline FOREIGN KEY (linked_opportunity_id) REFERENCES crm_opportunities(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    })().catch(error => {
      ensureTablesPromise = null;
      throw error;
    });
  }
  return ensureTablesPromise;
}

async function normalizeMissionTargets(connection, rawTargets, fallback = {}) {
  const source = Array.isArray(rawTargets) && rawTargets.length
    ? rawTargets
    : [{
        institution_id: fallback.institution_id,
        contact_name: fallback.target_decision_maker,
        contact_role: fallback.target_decision_maker ? 'DECIDEUR_PRINCIPAL' : null,
        visit_order: 1
      }];

  if (source.length > 20) throw httpError(400, 'Une mission ne peut pas contenir plus de 20 cibles.');

  const seen = new Set();
  const targets = source.map((item, index) => {
    const institutionId = positiveId(item?.institution_id);
    if (!institutionId) throw httpError(400, `Institution invalide pour la cible ${index + 1}.`);
    if (seen.has(institutionId)) throw httpError(400, 'Une institution ne peut apparaître qu’une fois dans la même mission.');
    seen.add(institutionId);
    return {
      institution_id: institutionId,
      visit_order: index + 1,
      priority: level(item.priority),
      potential: level(item.potential),
      contact_name: text(item.contact_name, 150),
      contact_role: text(item.contact_role, 120),
      contact_phone: text(item.contact_phone, 40),
      contact_email: text(item.contact_email, 190),
      notes: text(item.notes, 2000),
      opportunity: optionalOpportunity(item.opportunity)
    };
  });

  const [institutions] = await connection.query(
    `SELECT i.id, i.name, i.region_id, i.department_id, i.city_id,
            c.name AS city_name, d.name AS department_name, r.name AS region_name
     FROM crm_institutions i
     LEFT JOIN crm_ref_cities c ON c.id = i.city_id
     LEFT JOIN crm_ref_departments d ON d.id = i.department_id
     LEFT JOIN crm_ref_regions r ON r.id = i.region_id
     WHERE i.id IN (?)`,
    [targets.map(target => target.institution_id)]
  );
  const byId = new Map(institutions.map(item => [Number(item.id), item]));

  for (const target of targets) {
    const institution = byId.get(target.institution_id);
    if (!institution) throw httpError(404, `Institution cible #${target.institution_id} introuvable.`);
    if (!institution.region_id || !institution.department_id || !institution.city_id) {
      throw httpError(422, `La localisation de l’institution « ${institution.name} » est incomplète.`);
    }
    Object.assign(target, {
      institution_name: institution.name,
      region_id: institution.region_id,
      region_name: institution.region_name,
      department_id: institution.department_id,
      department_name: institution.department_name,
      city_id: institution.city_id,
      city_name: institution.city_name
    });
  }
  return targets;
}

async function upsertMissionTargets(connection, missionId, targets) {
  await ensureMissionTargetTables(connection);
  for (const target of targets) {
    const [existing] = await connection.query(
      `SELECT id FROM crm_mission_targets
       WHERE mission_id = ? AND institution_id = ? LIMIT 1`,
      [missionId, target.institution_id]
    );
    let missionTargetId = existing[0]?.id;
    if (missionTargetId) {
      await connection.query(
        `UPDATE crm_mission_targets
         SET visit_order = ?, priority = ?, potential = ?, contact_name = ?, contact_role = ?,
             contact_phone = ?, contact_email = ?, notes = ?
         WHERE id = ?`,
        [
          target.visit_order, target.priority, target.potential, target.contact_name, target.contact_role,
          target.contact_phone, target.contact_email, target.notes, missionTargetId
        ]
      );
    } else {
      const [result] = await connection.query(
      `INSERT INTO crm_mission_targets (
         mission_id, institution_id, visit_order, priority, potential,
         contact_name, contact_role, contact_phone, contact_email, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        missionId, target.institution_id, target.visit_order, target.priority, target.potential,
        target.contact_name, target.contact_role, target.contact_phone, target.contact_email, target.notes
      ]
      );
      missionTargetId = result.insertId;
    }
    if (target.opportunity) {
      const opportunity = target.opportunity;
      await connection.query(
        `INSERT INTO crm_mission_target_opportunities (
           mission_target_id, title, need_description, proposed_solution, estimated_amount,
           priority, maturity, expected_deadline, tender_reference, current_supplier, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), need_description = VALUES(need_description),
           proposed_solution = VALUES(proposed_solution), estimated_amount = VALUES(estimated_amount),
           priority = VALUES(priority), maturity = VALUES(maturity),
           expected_deadline = VALUES(expected_deadline), tender_reference = VALUES(tender_reference),
           current_supplier = VALUES(current_supplier), notes = VALUES(notes)`,
        [
          missionTargetId, opportunity.title, opportunity.need_description, opportunity.proposed_solution,
          opportunity.estimated_amount, opportunity.priority, opportunity.maturity,
          opportunity.expected_deadline, opportunity.tender_reference, opportunity.current_supplier,
          opportunity.notes
        ]
      );
    }
  }
}

async function getMissionTargets(connection, missionIds) {
  await ensureMissionTargetTables(connection);
  const ids = [...new Set((Array.isArray(missionIds) ? missionIds : [missionIds]).map(positiveId).filter(Boolean))];
  if (!ids.length) return new Map();
  const [targets] = await connection.query(
    `SELECT mt.*, i.name AS institution_name,
            i.region_id, i.department_id, i.city_id,
            r.name AS region_name, d.name AS department_name, c.name AS city_name
     FROM crm_mission_targets mt
     JOIN crm_institutions i ON i.id = mt.institution_id
     LEFT JOIN crm_ref_regions r ON r.id = i.region_id
     LEFT JOIN crm_ref_departments d ON d.id = i.department_id
     LEFT JOIN crm_ref_cities c ON c.id = i.city_id
     WHERE mt.mission_id IN (?)
     ORDER BY mt.mission_id, mt.visit_order, mt.id`,
    [ids]
  );
  const [opportunities] = targets.length
    ? await connection.query(
        `SELECT * FROM crm_mission_target_opportunities
         WHERE mission_target_id IN (?)`,
        [targets.map(target => target.id)]
      )
    : [[]];
  const opportunityByTarget = new Map(opportunities.map(item => [Number(item.mission_target_id), item]));
  const grouped = new Map(ids.map(id => [id, []]));
  for (const target of targets) {
    grouped.get(Number(target.mission_id))?.push({
      ...target,
      opportunity: opportunityByTarget.get(Number(target.id)) || null
    });
  }
  return grouped;
}

module.exports = {
  ensureMissionTargetTables,
  normalizeMissionTargets,
  upsertMissionTargets,
  getMissionTargets,
  TARGET_LEVELS,
  OPPORTUNITY_MATURITIES
};
