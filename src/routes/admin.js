const express = require('express');
const bcrypt = require('bcryptjs');
const { query, getEbSettings, setEbSettings } = require('../db');
const { ah, HttpError, str, num, intParam } = require('../util');
const eb = require('../eboekhouden');

const r = express.Router();

const USER_COLS = 'id, email, name, role, weekly_hours, active, created_at';

function checkPassword(pw) {
  if (String(pw).length < 10) throw new HttpError(400, 'Wachtwoord moet minstens 10 tekens zijn');
  return String(pw);
}

// Bouwt een UPDATE ... SET uit alleen de meegegeven velden.
function updater() {
  const fields = [];
  const values = [];
  return {
    set(col, v) { values.push(v); fields.push(`${col} = $${values.length}`); },
    sql(table, id, returning) {
      if (!fields.length) throw new HttpError(400, 'Niets om bij te werken');
      values.push(id);
      return [`UPDATE ${table} SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING ${returning}`, values];
    },
  };
}

/* ---------- Medewerkers ---------- */

r.get('/users', ah(async (req, res) => {
  const { rows } = await query(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, name`);
  res.json(rows);
}));

r.post('/users', ah(async (req, res) => {
  const email = str(req.body.email, { name: 'E-mail', max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Ongeldig e-mailadres');
  const name = str(req.body.name, { name: 'Naam', max: 120 });
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const weekly = num(req.body.weekly_hours ?? 40, { min: 0, max: 80, name: 'uren per week' });
  const hash = await bcrypt.hash(checkPassword(req.body.password || ''), 12);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, role, weekly_hours) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLS}`,
      [email, name, hash, role, weekly]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Dit e-mailadres is al in gebruik');
    throw err;
  }
}));

r.patch('/users/:id', ah(async (req, res) => {
  const id = intParam(req.params.id);
  const u = updater();
  const b = req.body;
  if (b.name !== undefined) u.set('name', str(b.name, { name: 'Naam', max: 120 }));
  if (b.role !== undefined) {
    if (id === req.user.id && b.role !== 'admin') throw new HttpError(400, 'Je kunt je eigen beheerrechten niet intrekken');
    u.set('role', b.role === 'admin' ? 'admin' : 'employee');
  }
  if (b.weekly_hours !== undefined) u.set('weekly_hours', num(b.weekly_hours, { min: 0, max: 80, name: 'uren per week' }));
  if (b.active !== undefined) {
    if (id === req.user.id && !b.active) throw new HttpError(400, 'Je kunt jezelf niet deactiveren');
    u.set('active', Boolean(b.active));
  }
  if (b.password) u.set('password_hash', await bcrypt.hash(checkPassword(b.password), 12));
  const { rows } = await query(...u.sql('users', id, USER_COLS));
  if (!rows[0]) throw new HttpError(404, 'Medewerker niet gevonden');
  if (b.active === false || b.password) await query('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.json(rows[0]);
}));

/* ---------- Klanten ---------- */

const CLIENT_SELECT = `
  SELECT c.*, (SELECT count(*)::int FROM projects p WHERE p.client_id = c.id) AS project_count
    FROM clients c`;

r.get('/clients', ah(async (req, res) => {
  const { rows } = await query(`${CLIENT_SELECT} ORDER BY c.active DESC, c.name`);
  res.json(rows);
}));

r.post('/clients', ah(async (req, res) => {
  const name = str(req.body.name, { name: 'Naam', max: 200 });
  const { rows } = await query('INSERT INTO clients (name) VALUES ($1) RETURNING *', [name]);
  res.status(201).json(rows[0]);
}));

r.patch('/clients/:id', ah(async (req, res) => {
  const id = intParam(req.params.id);
  const u = updater();
  if (req.body.name !== undefined) u.set('name', str(req.body.name, { name: 'Naam', max: 200 }));
  if (req.body.active !== undefined) u.set('active', Boolean(req.body.active));
  const { rows } = await query(...u.sql('clients', id, '*'));
  if (!rows[0]) throw new HttpError(404, 'Klant niet gevonden');
  res.json(rows[0]);
}));

async function loadClient(id) {
  const { rows } = await query('SELECT * FROM clients WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Klant niet gevonden');
  return rows[0];
}

r.post('/clients/:id/link', ah(async (req, res) => {
  const client = await loadClient(intParam(req.params.id));
  const code = str(req.body.code, { name: 'Relatiecode', max: 15 });
  const relation = await eb.findRelationByCode(code);
  if (!relation) throw new HttpError(404, `Relatie met code "${code}" niet gevonden in e-Boekhouden`);
  const { rows } = await query(
    'UPDATE clients SET eb_relation_id = $1, eb_relation_code = $2 WHERE id = $3 RETURNING *',
    [relation.id, relation.code || code, client.id]
  );
  res.json({ client: rows[0], relation });
}));

r.post('/clients/:id/unlink', ah(async (req, res) => {
  const client = await loadClient(intParam(req.params.id));
  const { rows } = await query(
    'UPDATE clients SET eb_relation_id = NULL, eb_relation_code = NULL WHERE id = $1 RETURNING *',
    [client.id]
  );
  res.json(rows[0]);
}));

r.post('/clients/:id/create-relation', ah(async (req, res) => {
  const client = await loadClient(intParam(req.params.id));
  if (client.eb_relation_id) throw new HttpError(400, 'Deze klant is al gekoppeld');
  const b = req.body;
  const code = str(b.code, { name: 'Relatiecode', max: 15 });
  const body = { type: 'B', code, name: client.name };
  const optional = {
    address: 150, postalCode: 50, city: 50, emailAddress: 150, emailAddressInvoice: 150, vatNumber: 50,
  };
  for (const [key, max] of Object.entries(optional)) {
    const v = str(b[key], { name: key, max, required: false });
    if (v) body[key] = v;
  }
  if (b.termOfPayment) body.termOfPayment = num(b.termOfPayment, { min: 0, max: 365, name: 'betaaltermijn' });
  const created = await eb.createRelation(body);
  const relationId = created && (created.id || created.relationId);
  if (!relationId) throw new HttpError(502, 'e-Boekhouden gaf geen relatie-id terug');
  const { rows } = await query(
    'UPDATE clients SET eb_relation_id = $1, eb_relation_code = $2 WHERE id = $3 RETURNING *',
    [relationId, code, client.id]
  );
  res.status(201).json(rows[0]);
}));

/* ---------- Projecten ---------- */

r.get('/projects', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.name AS client_name,
            (SELECT count(*)::int FROM assignments a WHERE a.project_id = p.id) AS member_count,
            (SELECT coalesce(sum(e.hours), 0) FROM time_entries e WHERE e.project_id = p.id) AS hours_total
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
      ORDER BY p.active DESC, c.name NULLS LAST, p.name`
  );
  res.json(rows);
}));

function projectFields(b, u) {
  if (b.client_id !== undefined) u.set('client_id', b.client_id ? intParam(b.client_id, 'klant') : null);
  if (b.name !== undefined) u.set('name', str(b.name, { name: 'Projectnaam', max: 200 }));
  if (b.code !== undefined) u.set('code', str(b.code, { name: 'Code', max: 30, required: false }) || null);
  if (b.default_rate !== undefined) u.set('default_rate', num(b.default_rate || 0, { min: 0, max: 10000, name: 'tarief' }));
  if (b.budget_hours !== undefined) u.set('budget_hours', num(b.budget_hours, { min: 0, max: 100000, name: 'budget', allowNull: true }));
  if (b.billable !== undefined) u.set('billable', Boolean(b.billable) && Boolean(b.client_id !== null));
  if (b.active !== undefined) u.set('active', Boolean(b.active));
}

r.post('/projects', ah(async (req, res) => {
  const b = req.body;
  const clientId = b.client_id ? intParam(b.client_id, 'klant') : null;
  const name = str(b.name, { name: 'Projectnaam', max: 200 });
  const code = str(b.code, { name: 'Code', max: 30, required: false }) || null;
  const rate = num(b.default_rate || 0, { min: 0, max: 10000, name: 'tarief' });
  const budget = num(b.budget_hours, { min: 0, max: 100000, name: 'budget', allowNull: true });
  const billable = clientId ? b.billable !== false : false;
  const { rows } = await query(
    `INSERT INTO projects (client_id, name, code, default_rate, budget_hours, billable)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [clientId, name, code, rate, budget, billable]
  );
  res.status(201).json(rows[0]);
}));

r.patch('/projects/:id', ah(async (req, res) => {
  const id = intParam(req.params.id);
  const u = updater();
  projectFields(req.body, u);
  const { rows } = await query(...u.sql('projects', id, '*'));
  if (!rows[0]) throw new HttpError(404, 'Project niet gevonden');
  if (!rows[0].client_id && rows[0].billable) {
    await query('UPDATE projects SET billable = FALSE WHERE id = $1', [id]);
    rows[0].billable = false;
  }
  res.json(rows[0]);
}));

r.get('/projects/:id/assignments', ah(async (req, res) => {
  const id = intParam(req.params.id);
  const { rows } = await query(
    `SELECT u.id AS user_id, u.name, u.active, a.rate, (a.user_id IS NOT NULL) AS assigned
       FROM users u LEFT JOIN assignments a ON a.user_id = u.id AND a.project_id = $1
      WHERE u.active OR a.user_id IS NOT NULL
      ORDER BY u.name`,
    [id]
  );
  res.json(rows);
}));

r.put('/projects/:id/assignments/:userId', ah(async (req, res) => {
  const projectId = intParam(req.params.id);
  const userId = intParam(req.params.userId);
  const rate = num(req.body.rate, { min: 0, max: 10000, name: 'tarief', allowNull: true });
  await query(
    `INSERT INTO assignments (project_id, user_id, rate) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET rate = EXCLUDED.rate`,
    [projectId, userId, rate]
  );
  res.json({ ok: true });
}));

r.delete('/projects/:id/assignments/:userId', ah(async (req, res) => {
  await query('DELETE FROM assignments WHERE project_id = $1 AND user_id = $2', [
    intParam(req.params.id), intParam(req.params.userId),
  ]);
  res.json({ ok: true });
}));

/* ---------- Koppeling e-Boekhouden ---------- */

const VAT_CODES = ['HOOG_VERK_21', 'LAAG_VERK_9', 'VERL_VERK', 'BU_EU_VERK', 'BI_EU_VERK', 'GEEN'];

r.get('/settings', ah(async (req, res) => {
  res.json({ eb: await getEbSettings(), eb_configured: eb.configured(), vat_codes: VAT_CODES });
}));

r.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  const optInt = (v, name) => (v === '' || v === null || v === undefined ? null : intParam(v, name));
  if (b.vatCode && !VAT_CODES.includes(b.vatCode)) throw new HttpError(400, 'Onbekende btw-code');
  const value = {
    templateId: optInt(b.templateId, 'factuursjabloon'),
    revenueLedgerId: optInt(b.revenueLedgerId, 'omzetrekening'),
    debtorLedgerId: optInt(b.debtorLedgerId, 'debiteurenrekening'),
    unitId: optInt(b.unitId, 'eenheid'),
    vatCode: b.vatCode || 'HOOG_VERK_21',
    termOfPayment: num(b.termOfPayment ?? 30, { min: 0, max: 365, name: 'betaaltermijn' }),
    process: b.process !== false,
  };
  await setEbSettings(value);
  res.json(value);
}));

r.post('/eb/test', ah(async (req, res) => {
  await eb.testConnection();
  res.json({ ok: true });
}));

r.get('/eb/options', ah(async (req, res) => {
  const [ledgers, templates, units] = await Promise.all([eb.ledgers(), eb.invoiceTemplates(), eb.units()]);
  res.json({
    ledgers: ledgers.map((l) => ({
      id: l.id,
      code: l.code || '',
      category: l.category || '',
      label: [l.code, l.description || l.name].filter(Boolean).join(' '),
    })),
    templates: templates.map((t) => ({ id: t.id, label: t.name || t.description || `Sjabloon ${t.id}` })),
    units: units.map((u) => ({ id: u.id, label: u.name || u.description || u.code || `Eenheid ${u.id}` })),
  });
}));

module.exports = r;
