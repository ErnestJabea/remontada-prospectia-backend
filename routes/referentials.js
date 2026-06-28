const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Helper wrapper for CRUD handlers to reduce boilerplate
async function handleGetList(table, orderByField, req, res) {
  try {
    const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderByField}`);
    return res.json(rows);
  } catch (err) {
    console.error(`[GET /${table}]`, err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}

async function handleCreate(table, fields, req, res) {
  try {
    const insertFields = [];
    const placeholders = [];
    const params = [];
    
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        insertFields.push(field);
        placeholders.push('?');
        params.push(req.body[field] === '' ? null : req.body[field]);
      }
    }

    if (insertFields.length === 0) {
      return res.status(400).json({ error: 'Aucun champ fourni.' });
    }

    const query = `INSERT INTO ${table} (${insertFields.join(', ')}) VALUES (${placeholders.join(', ')})`;
    const [result] = await pool.query(query, params);
    
    return res.status(201).json({ id: result.insertId, message: 'Élément créé avec succès.' });
  } catch (err) {
    console.error(`[POST /${table}]`, err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Un élément avec ce code ou cette valeur existe déjà.' });
    }
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}

async function handleUpdate(table, fields, req, res) {
  try {
    const { id } = req.params;
    const updateParts = [];
    const params = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updateParts.push(`${field} = ?`);
        params.push(req.body[field] === '' ? null : req.body[field]);
      }
    }

    if (updateParts.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à modifier.' });
    }

    params.push(id);
    const query = `UPDATE ${table} SET ${updateParts.join(', ')} WHERE id = ?`;
    const [result] = await pool.query(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Élément introuvable.' });
    }

    return res.json({ message: 'Élément modifié avec succès.' });
  } catch (err) {
    console.error(`[PUT /${table}/:id]`, err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Un élément avec ce code ou cette valeur existe déjà.' });
    }
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}

async function handleDelete(table, req, res) {
  try {
    const { id } = req.params;
    const [result] = await pool.query(`DELETE FROM ${table} WHERE id = ?`, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Élément introuvable.' });
    }

    return res.json({ message: 'Élément supprimé avec succès.' });
  } catch (err) {
    console.error(`[DELETE /${table}/:id]`, err);
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(400).json({ 
        error: 'Impossible de supprimer cet élément car il est lié à d\'autres enregistrements actifs dans l\'application.' 
      });
    }
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// ==========================================
// 1. PAYS (crm_ref_countries)
// ==========================================
router.get('/countries', authenticate, (req, res) => handleGetList('crm_ref_countries', 'name', req, res));
router.post('/countries', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_countries', ['code', 'name', 'name_en'], req, res);
});
router.put('/countries/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_countries', ['code', 'name', 'name_en'], req, res)
);
router.delete('/countries/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_countries', req, res)
);

// ==========================================
// 2. RÉGIONS (crm_ref_regions)
// ==========================================
router.get('/regions', authenticate, async (req, res) => {
  try {
    const { countryId } = req.query;
    let query = `
      SELECT r.*, c.name as country_name, c.name_en as country_name_en 
      FROM crm_ref_regions r 
      LEFT JOIN crm_ref_countries c ON r.country_id = c.id
    `;
    const params = [];
    if (countryId) {
      query += ' WHERE r.country_id = ?';
      params.push(countryId);
    }
    query += ' ORDER BY r.name';
    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[GET /regions]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/regions', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_regions', ['code', 'name', 'name_en', 'country_id'], req, res);
});

router.put('/regions/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_regions', ['code', 'name', 'name_en', 'country_id'], req, res)
);

router.delete('/regions/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_regions', req, res)
);

// ==========================================
// 3. DÉPARTEMENTS (crm_ref_departments)
// ==========================================
router.get('/departments', authenticate, async (req, res) => {
  try {
    const { regionId } = req.query;
    let query = `
      SELECT d.*, r.name as region_name, r.name_en as region_name_en, r.country_id 
      FROM crm_ref_departments d 
      JOIN crm_ref_regions r ON d.region_id = r.id
    `;
    const params = [];
    if (regionId) { 
      query += ' WHERE d.region_id = ?'; 
      params.push(regionId); 
    }
    query += ' ORDER BY d.name';
    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[GET /departments]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/departments', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name || !req.body.region_id) {
    return res.status(400).json({ error: 'Le code, le nom et la région sont requis.' });
  }
  return handleCreate('crm_ref_departments', ['code', 'name', 'name_en', 'region_id'], req, res);
});

router.put('/departments/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_departments', ['code', 'name', 'name_en', 'region_id'], req, res)
);

router.delete('/departments/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_departments', req, res)
);

// ==========================================
// 4. VILLES / ARRONDISSEMENTS (crm_ref_cities)
// ==========================================
router.get('/cities', authenticate, async (req, res) => {
  try {
    const { departmentId } = req.query;
    let query = `
      SELECT c.*, d.name as department_name, d.name_en as department_name_en, d.region_id 
      FROM crm_ref_cities c 
      JOIN crm_ref_departments d ON c.department_id = d.id
    `;
    const params = [];
    if (departmentId) { 
      query += ' WHERE c.department_id = ?'; 
      params.push(departmentId); 
    }
    query += ' ORDER BY c.name';
    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[GET /cities]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/cities', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.name || !req.body.department_id) {
    return res.status(400).json({ error: 'Le nom et le département sont requis.' });
  }
  return handleCreate('crm_ref_cities', ['name', 'name_en', 'department_id'], req, res);
});

router.put('/cities/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_cities', ['name', 'name_en', 'department_id'], req, res)
);

router.delete('/cities/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_cities', req, res)
);

// ==========================================
// 5. TYPES D'INSTITUTIONS (crm_ref_institution_types)
// ==========================================
router.get('/institution-types', authenticate, (req, res) => handleGetList('crm_ref_institution_types', 'name', req, res));
router.post('/institution-types', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_institution_types', ['code', 'name', 'name_en'], req, res);
});
router.put('/institution-types/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_institution_types', ['code', 'name', 'name_en'], req, res)
);
router.delete('/institution-types/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_institution_types', req, res)
);

// ==========================================
// 6. NIVEAUX D'INFLUENCE (crm_ref_influence_levels)
// ==========================================
router.get('/influence-levels', authenticate, (req, res) => handleGetList('crm_ref_influence_levels', 'name', req, res));
router.post('/influence-levels', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_influence_levels', ['code', 'name', 'name_en'], req, res);
});
router.put('/influence-levels/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_influence_levels', ['code', 'name', 'name_en'], req, res)
);
router.delete('/influence-levels/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_influence_levels', req, res)
);

// ==========================================
// 7. PRIORITÉS D'OPPORTUNITÉS (crm_ref_priorities)
// ==========================================
router.get('/priorities', authenticate, (req, res) => handleGetList('crm_ref_priorities', 'name', req, res));
router.post('/priorities', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_priorities', ['code', 'name', 'name_en'], req, res);
});
router.put('/priorities/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_priorities', ['code', 'name', 'name_en'], req, res)
);
router.delete('/priorities/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_priorities', req, res)
);

// ==========================================
// 8. TYPES DE MISSIONS (crm_ref_mission_types)
// ==========================================
router.get('/mission-types', authenticate, (req, res) => handleGetList('crm_ref_mission_types', 'name', req, res));
router.post('/mission-types', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_mission_types', ['code', 'name', 'name_en'], req, res);
});
router.put('/mission-types/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_mission_types', ['code', 'name', 'name_en'], req, res)
);
router.delete('/mission-types/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_mission_types', req, res)
);

// ==========================================
// 9. PÉRIODES D'OBJECTIFS (crm_ref_period_types)
// ==========================================
router.get('/period-types', authenticate, (req, res) => handleGetList('crm_ref_period_types', 'name', req, res));
router.post('/period-types', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_period_types', ['code', 'name', 'name_en'], req, res);
});
router.put('/period-types/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_period_types', ['code', 'name', 'name_en'], req, res)
);
router.delete('/period-types/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_period_types', req, res)
);

// ==========================================
// 10. OBSERVATIONS DOCUMENTAIRES (crm_ref_documentary_observations)
// ==========================================
router.get('/documentary-observations', authenticate, (req, res) => handleGetList('crm_ref_documentary_observations', 'name', req, res));
router.post('/documentary-observations', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => {
  if (!req.body.code || !req.body.name) {
    return res.status(400).json({ error: 'Le code et le nom sont requis.' });
  }
  return handleCreate('crm_ref_documentary_observations', ['code', 'name', 'name_en'], req, res);
});
router.put('/documentary-observations/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleUpdate('crm_ref_documentary_observations', ['code', 'name', 'name_en'], req, res)
);
router.delete('/documentary-observations/:id', authenticate, authorize('SYSTEM', 'DIRECTION', 'ADMIN'), (req, res) => 
  handleDelete('crm_ref_documentary_observations', req, res)
);

module.exports = router;

