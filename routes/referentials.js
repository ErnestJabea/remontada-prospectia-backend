const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

// GET /api/referentials/regions
router.get('/regions', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM crm_ref_regions ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('[REFERENTIALS/REGIONS]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/referentials/departments?regionId=1
router.get('/departments', authenticate, async (req, res) => {
  try {
    const { regionId } = req.query;
    let query = 'SELECT d.*, r.name as region_name FROM crm_ref_departments d JOIN crm_ref_regions r ON d.region_id = r.id';
    const params = [];
    if (regionId) { query += ' WHERE d.region_id = ?'; params.push(regionId); }
    query += ' ORDER BY d.name';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[REFERENTIALS/DEPARTMENTS]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/referentials/cities?departmentId=1
router.get('/cities', authenticate, async (req, res) => {
  try {
    const { departmentId } = req.query;
    let query = 'SELECT c.*, d.name as department_name FROM crm_ref_cities c JOIN crm_ref_departments d ON c.department_id = d.id';
    const params = [];
    if (departmentId) { query += ' WHERE c.department_id = ?'; params.push(departmentId); }
    query += ' ORDER BY c.name';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[REFERENTIALS/CITIES]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
