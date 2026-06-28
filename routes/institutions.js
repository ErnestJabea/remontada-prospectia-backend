const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);
const TYPES = ['ADMINISTRATION', 'ENTERPRISE_PUBLIQUE', 'CTD', 'PROSPECT'];
const INFLUENCE_LEVELS = ['DECIDEUR', 'PRESCRIPTEUR', 'INFLUENCEUR', 'FACILITATEUR'];
let ensureStatusColumnPromise;

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

function normalizeBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function ensureInstitutionStatusColumn() {
  if (!ensureStatusColumnPromise) {
    ensureStatusColumnPromise = (async () => {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'crm_institutions'
           AND COLUMN_NAME = 'is_active'`
      );
      if (!rows.length) {
        await pool.query('ALTER TABLE crm_institutions ADD COLUMN is_active BOOLEAN DEFAULT TRUE');
      }
    })().catch(err => {
      ensureStatusColumnPromise = null;
      throw err;
    });
  }
  return ensureStatusColumnPromise;
}

async function canEditInstitution(id, user) {
  if (isManager(user)) return true;
  const [rows] = await pool.query(
    'SELECT created_by FROM crm_institutions WHERE id = ?',
    [id]
  );
  return rows.length > 0 && rows[0].created_by === user.id;
}

router.get('/', authenticate, async (req, res) => {
  try {
    await ensureInstitutionStatusColumn();
    const { type, regionId } = req.query;
    let query = `
      SELECT i.*, r.name AS region_name, r.name_en AS region_name_en, d.name AS department_name, d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en
      FROM crm_institutions i
      JOIN crm_ref_regions r ON i.region_id = r.id
      JOIN crm_ref_departments d ON i.department_id = d.id
      JOIN crm_ref_cities c ON i.city_id = c.id`;
    const params = [];
    const conditions = [];
    if (type && TYPES.includes(type)) {
      conditions.push('i.type = ?');
      params.push(type);
    }
    if (regionId && Number(regionId)) {
      conditions.push('i.region_id = ?');
      params.push(regionId);
    }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY i.name';
    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[INSTITUTIONS/LIST]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    await ensureInstitutionStatusColumn();
    const [rows] = await pool.query(
      `SELECT i.*, r.name AS region_name, r.name_en AS region_name_en, d.name AS department_name, d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en
       FROM crm_institutions i
       JOIN crm_ref_regions r ON i.region_id = r.id
       JOIN crm_ref_departments d ON i.department_id = d.id
       JOIN crm_ref_cities c ON i.city_id = c.id
       WHERE i.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Institution introuvable.' });
    const [contacts] = await pool.query(
      'SELECT * FROM crm_contacts WHERE institution_id = ? ORDER BY last_name',
      [req.params.id]
    );
    return res.json({ ...rows[0], contacts });
  } catch (err) {
    console.error('[INSTITUTIONS/DETAIL]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const {
    name, type, tax_id, address, region_id, department_id,
    city_id, phone, email, website, notes, is_active
  } = req.body;
  if (
    typeof name !== 'string' || !name.trim() || name.length > 200 ||
    !TYPES.includes(type) || !Number(region_id) ||
    !Number(department_id) || !Number(city_id)
  ) {
    return res.status(400).json({ error: 'Donnees d\'institution invalides.' });
  }

  try {
    await ensureInstitutionStatusColumn();
    const [result] = await pool.query(
      `INSERT INTO crm_institutions (
        name, type, tax_id, address, region_id, department_id, city_id,
        phone, email, website, notes, is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(), type, tax_id || null, address || null, region_id,
        department_id, city_id, phone || null, email || null,
        website || null, notes || null, normalizeBoolean(is_active, true), req.user.id
      ]
    );

    if (req.user.role === 'COMMERCIAL') {
      const { notifyDirection } = require('../utils/notifications');
      await notifyDirection(
        'Nouveau Prospect/Client',
        `${req.user.full_name} a declare une nouvelle entite : "${name.trim()}" (${type}).`,
        'PROSPECT_CREATED',
        result.insertId
      );
    }
    return res.status(201).json({ id: result.insertId, message: 'Institution creee.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Cette institution existe deja.' });
    }
    console.error('[INSTITUTIONS/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.put('/:id', authenticate, async (req, res) => {
  const {
    name, type, tax_id, address, region_id, department_id,
    city_id, phone, email, website, notes, is_active
  } = req.body;
  if (
    typeof name !== 'string' || !name.trim() || name.length > 200 ||
    !TYPES.includes(type) || !Number(region_id) ||
    !Number(department_id) || !Number(city_id)
  ) {
    return res.status(400).json({ error: 'Donnees d\'institution invalides.' });
  }

  try {
    await ensureInstitutionStatusColumn();
    if (!(await canEditInstitution(req.params.id, req.user))) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }
    const [result] = await pool.query(
      `UPDATE crm_institutions
       SET name = ?, type = ?, tax_id = ?, address = ?, region_id = ?,
           department_id = ?, city_id = ?, phone = ?, email = ?,
           website = ?, notes = ?, is_active = ?
       WHERE id = ?`,
      [
        name.trim(), type, tax_id || null, address || null, region_id,
        department_id, city_id, phone || null, email || null,
        website || null, notes || null, normalizeBoolean(is_active, true), req.params.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Institution introuvable.' });
    return res.json({ message: 'Institution mise a jour.' });
  } catch (err) {
    console.error('[INSTITUTIONS/UPDATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.patch('/:id/status', authenticate, authorize('DIRECTION', 'SYSTEM', 'ADMIN'), async (req, res) => {
  try {
    await ensureInstitutionStatusColumn();
    const isActive = normalizeBoolean(req.body?.is_active, true);
    const [result] = await pool.query(
      'UPDATE crm_institutions SET is_active = ? WHERE id = ?',
      [isActive, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Institution introuvable.' });
    return res.json({ message: isActive ? 'Institution activee.' : 'Institution desactivee.' });
  } catch (err) {
    console.error('[INSTITUTIONS/STATUS]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.delete('/:id', authenticate, authorize('DIRECTION', 'SYSTEM', 'ADMIN'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM crm_institutions WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Institution introuvable.' });
    return res.json({ message: 'Institution supprimee.' });
  } catch (err) {
    console.error('[INSTITUTIONS/DELETE]', err);
    return res.status(409).json({ error: 'Cette institution est liee a d\'autres donnees.' });
  }
});

router.post('/:id/contacts', authenticate, async (req, res) => {
  const { first_name, last_name, email, phone, job_title, influence_level, notes } = req.body;
  if (
    typeof first_name !== 'string' || !first_name.trim() ||
    typeof last_name !== 'string' || !last_name.trim() ||
    typeof job_title !== 'string' || !job_title.trim() ||
    !INFLUENCE_LEVELS.includes(influence_level)
  ) {
    return res.status(400).json({ error: 'Donnees de contact invalides.' });
  }

  try {
    if (!(await canEditInstitution(req.params.id, req.user))) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }
    const [result] = await pool.query(
      `INSERT INTO crm_contacts (
        institution_id, first_name, last_name, email, phone,
        job_title, influence_level, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.params.id, first_name.trim(), last_name.trim(), email || null,
        phone || null, job_title.trim(), influence_level, notes || null
      ]
    );
    return res.status(201).json({ id: result.insertId, message: 'Contact ajoute.' });
  } catch (err) {
    console.error('[CONTACTS/CREATE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

router.delete('/contacts/:contactId', authenticate, async (req, res) => {
  try {
    const [contacts] = await pool.query(
      'SELECT institution_id FROM crm_contacts WHERE id = ?',
      [req.params.contactId]
    );
    if (!contacts.length) return res.status(404).json({ error: 'Contact introuvable.' });
    if (!(await canEditInstitution(contacts[0].institution_id, req.user))) {
      return res.status(403).json({ error: 'Acces refuse.' });
    }
    await pool.query('DELETE FROM crm_contacts WHERE id = ?', [req.params.contactId]);
    return res.json({ message: 'Contact supprime.' });
  } catch (err) {
    console.error('[CONTACTS/DELETE]', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
