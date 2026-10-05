const express = require('express');
const bcrypt = require('bcryptjs');
const { query, tx, getEbSettings, setEbSettings } = require('../db');
const { ah, HttpError, str, num, intParam, isoDate, normName, poFromName } = require('../util');
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
  if (req.body.invoice_line_mode !== undefined) {
    u.set('invoice_line_mode', ['entry', 'grouped'].includes(req.body.invoice_line_mode) ? req.body.invoice_line_mode : null);
  }
  if (req.body.invoice_line_format !== undefined) {
    u.set('invoice_line_format', str(req.body.invoice_line_format, { name: 'Opmaak factuurregel', max: 300, required: false }) || null);
  }
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
            (SELECT count(*)::int FROM project_activities pa WHERE pa.project_id = p.id) AS activity_count,
            (SELECT sum(pa.budget_hours) FROM project_activities pa WHERE pa.project_id = p.id) AS activity_budget_hours,
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
  if (b.reference !== undefined) u.set('reference', str(b.reference, { name: 'PO / referentie', max: 50, required: false }) || null);
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
  const reference = str(b.reference, { name: 'PO / referentie', max: 50, required: false }) || null;
  const rate = num(b.default_rate || 0, { min: 0, max: 10000, name: 'tarief' });
  const budget = num(b.budget_hours, { min: 0, max: 100000, name: 'budget', allowNull: true });
  const billable = clientId ? b.billable !== false : false;
  const { rows } = await query(
    `INSERT INTO projects (client_id, name, code, reference, default_rate, budget_hours, billable)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [clientId, name, code, reference, rate, budget, billable]
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

// Import van projecten, bijvoorbeeld de export uit e-Boekhouden (Uren > Configuratie > Projecten).
r.post('/projects/import', ah(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, 'Het bestand bevat geen projecten');
  if (rows.length > 1000) throw new HttpError(400, 'Maximaal 1000 projecten per import');
  const internal = normName(req.body.internal_name);
  const rate = num(req.body.default_rate || 0, { min: 0, max: 10000, name: 'tarief' });
  const addMe = req.body.add_me !== false;

  // Relaties uit e-Boekhouden ophalen om nieuwe klanten meteen te koppelen (niet fataal als het mislukt).
  let relByName = new Map();
  let ebError = null;
  if (eb.configured() && req.body.match_eb !== false) {
    try {
      relByName = new Map((await eb.relations()).filter((x) => !x.inactive).map((x) => [normName(x.name), x]));
    } catch (e) {
      ebError = e.message;
    }
  }

  const result = await tx(async (db) => {
    const byName = new Map((await db.query('SELECT id, name, eb_relation_id FROM clients')).rows.map((c) => [normName(c.name), c]));
    const existing = new Set((await db.query('SELECT name, client_id FROM projects')).rows
      .map((p) => `${p.client_id || 0}|${p.name.trim().toLowerCase()}`));
    const out = { created: 0, skipped: 0, clients_created: 0, clients_linked: 0, eb_error: ebError };

    for (const row of rows) {
      const name = str(row.project, { name: 'Projectnaam', max: 200 });
      const relation = str(row.relation, { name: 'Relatie', max: 200, required: false });
      const isInternal = !relation || (internal && normName(relation) === internal);
      let clientId = null;
      if (!isInternal) {
        const rel = relByName.get(normName(relation));
        let client = byName.get(normName(relation));
        if (!client) {
          client = (await db.query(
            'INSERT INTO clients (name, eb_relation_id, eb_relation_code) VALUES ($1, $2, $3) RETURNING id, name, eb_relation_id',
            [relation, rel ? rel.id : null, rel ? rel.code : null]
          )).rows[0];
          byName.set(normName(relation), client);
          out.clients_created += 1;
          if (rel) out.clients_linked += 1;
        } else if (!client.eb_relation_id && rel) {
          await db.query('UPDATE clients SET eb_relation_id = $1, eb_relation_code = $2 WHERE id = $3', [rel.id, rel.code, client.id]);
          client.eb_relation_id = rel.id;
          out.clients_linked += 1;
        }
        clientId = client.id;
      }
      const key = `${clientId || 0}|${name.toLowerCase()}`;
      if (existing.has(key)) { out.skipped += 1; continue; }
      existing.add(key);
      const project = (await db.query(
        `INSERT INTO projects (client_id, name, reference, default_rate, billable) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [clientId, name, isInternal ? null : poFromName(name), isInternal ? 0 : rate, !isInternal]
      )).rows[0];
      if (addMe) {
        await db.query('INSERT INTO assignments (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [project.id, req.user.id]);
      }
      out.created += 1;
    }
    return out;
  });
  res.json(result);
}));

/* ---------- Activiteiten ---------- */

r.get('/activities', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, (SELECT count(*)::int FROM project_activities pa WHERE pa.activity_id = a.id) AS project_count
       FROM activities a ORDER BY a.active DESC, a.name`
  );
  res.json(rows);
}));

function activityFields(b) {
  return {
    name: str(b.name, { name: 'Naam', max: 120 }),
    description: str(b.description, { name: 'Omschrijving', max: 500, required: false }) || null,
    default_rate: num(b.default_rate, { min: 0, max: 10000, name: 'tarief', allowNull: true }),
  };
}

r.post('/activities', ah(async (req, res) => {
  const f = activityFields(req.body);
  try {
    const { rows } = await query(
      'INSERT INTO activities (name, description, default_rate) VALUES ($1, $2, $3) RETURNING *',
      [f.name, f.description, f.default_rate]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Er bestaat al een activiteit met deze naam');
    throw err;
  }
}));

r.patch('/activities/:id', ah(async (req, res) => {
  const f = activityFields(req.body);
  try {
    const { rows } = await query(
      `UPDATE activities SET name = $1, description = $2, default_rate = $3, active = $4 WHERE id = $5 RETURNING *`,
      [f.name, f.description, f.default_rate, req.body.active !== false, intParam(req.params.id)]
    );
    if (!rows[0]) throw new HttpError(404, 'Activiteit niet gevonden');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Er bestaat al een activiteit met deze naam');
    throw err;
  }
}));

// Import van de activiteitenexport uit e-Boekhouden (Uren > Configuratie > Activiteiten).
r.post('/activities/import', ah(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, 'Het bestand bevat geen activiteiten');
  if (rows.length > 1000) throw new HttpError(400, 'Maximaal 1000 activiteiten per import');
  const updateRates = req.body.update_rates !== false;
  const out = await tx(async (db) => {
    const byName = new Map((await db.query('SELECT id, name, default_rate FROM activities')).rows
      .map((a) => [a.name.trim().toLowerCase(), a]));
    const result = { created: 0, updated: 0, skipped: 0 };
    for (const row of rows) {
      const name = str(row.name, { name: 'Naam', max: 120 });
      const rate = num(row.rate, { min: 0, max: 10000, name: 'tarief', allowNull: true });
      const ex = byName.get(name.toLowerCase());
      if (!ex) {
        const a = (await db.query('INSERT INTO activities (name, default_rate) VALUES ($1, $2) RETURNING id, name, default_rate', [name, rate])).rows[0];
        byName.set(name.toLowerCase(), a);
        result.created += 1;
      } else if (updateRates && rate !== ex.default_rate) {
        await db.query('UPDATE activities SET default_rate = $1 WHERE id = $2', [rate, ex.id]);
        ex.default_rate = rate;
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
    }
    return result;
  });
  res.json(out);
}));

// Projecten waaraan een activiteit gekoppeld is, met tarief, budget en verbruik.
r.get('/activities/:id/projects', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT p.id AS project_id, p.name AS project_name, p.active, c.name AS client_name,
            pa.rate, pa.budget_hours, pa.budget_amount,
            (SELECT coalesce(sum(e.hours), 0) FROM time_entries e WHERE e.project_id = p.id AND e.activity_id = pa.activity_id) AS used_hours,
            (SELECT coalesce(sum(e.hours * e.rate), 0) FROM time_entries e
              WHERE e.project_id = p.id AND e.activity_id = pa.activity_id AND e.status IN ('approved', 'invoiced')) AS used_amount
       FROM project_activities pa
       JOIN projects p ON p.id = pa.project_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE pa.activity_id = $1
      ORDER BY p.active DESC, c.name NULLS LAST, p.name`,
    [intParam(req.params.id)]
  );
  res.json(rows);
}));

r.get('/projects/:id/activities', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id AS activity_id, a.name, a.default_rate, a.active, pa.rate, pa.budget_hours, pa.budget_amount,
            (pa.activity_id IS NOT NULL) AS linked,
            (SELECT coalesce(sum(e.hours), 0) FROM time_entries e WHERE e.project_id = $1 AND e.activity_id = a.id) AS used_hours,
            (SELECT coalesce(sum(e.hours * e.rate), 0) FROM time_entries e
              WHERE e.project_id = $1 AND e.activity_id = a.id AND e.status IN ('approved', 'invoiced')) AS used_amount
       FROM activities a
       LEFT JOIN project_activities pa ON pa.activity_id = a.id AND pa.project_id = $1
      WHERE a.active OR pa.activity_id IS NOT NULL
      ORDER BY a.name`,
    [intParam(req.params.id)]
  );
  res.json(rows);
}));

r.put('/projects/:id/activities/:activityId', ah(async (req, res) => {
  const rate = num(req.body.rate, { min: 0, max: 10000, name: 'tarief', allowNull: true });
  const budgetHours = num(req.body.budget_hours, { min: 0, max: 1000000, name: 'budget in uren', allowNull: true });
  const budgetAmount = num(req.body.budget_amount, { min: 0, max: 100000000, name: 'budget in euro', allowNull: true });
  await query(
    `INSERT INTO project_activities (project_id, activity_id, rate, budget_hours, budget_amount) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, activity_id) DO UPDATE
        SET rate = EXCLUDED.rate, budget_hours = EXCLUDED.budget_hours, budget_amount = EXCLUDED.budget_amount`,
    [intParam(req.params.id), intParam(req.params.activityId), rate, budgetHours, budgetAmount]
  );
  res.json({ ok: true });
}));

r.delete('/projects/:id/activities/:activityId', ah(async (req, res) => {
  await query('DELETE FROM project_activities WHERE project_id = $1 AND activity_id = $2', [
    intParam(req.params.id), intParam(req.params.activityId),
  ]);
  res.json({ ok: true });
}));

/* ---------- Uren importeren (historie uit e-Boekhouden) ---------- */

// Rijen komen al gekoppeld binnen (user_id, project_id, activity_id); de server controleert ze.
// Uren t/m invoiced_through worden 'gefactureerd' (niet opnieuw te factureren), latere 'goedgekeurd'.
r.post('/hours/import', ah(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, 'Geen uren om te importeren');
  if (rows.length > 20000) throw new HttpError(400, 'Maximaal 20.000 regels per import');
  const invoicedThrough = req.body.invoiced_through ? isoDate(req.body.invoiced_through, 'datum') : null;
  const addToTeam = req.body.add_to_team !== false;

  const result = await tx(async (db) => {
    const users = new Set((await db.query('SELECT id FROM users')).rows.map((x) => x.id));
    const projects = new Set((await db.query('SELECT id FROM projects')).rows.map((x) => x.id));
    const activities = new Set((await db.query('SELECT id FROM activities')).rows.map((x) => x.id));
    const linked = new Set((await db.query('SELECT project_id, activity_id FROM project_activities')).rows.map((x) => `${x.project_id}|${x.activity_id}`));
    const team = new Set((await db.query('SELECT project_id, user_id FROM assignments')).rows.map((x) => `${x.project_id}|${x.user_id}`));
    const out = { inserted: 0, skipped: 0, hours: 0, linked_activities: 0, team_added: 0 };

    for (const [i, row] of rows.entries()) {
      const where = `regel ${i + 1}`;
      const userId = intParam(row.user_id, `medewerker (${where})`);
      const projectId = intParam(row.project_id, `project (${where})`);
      const activityId = row.activity_id ? intParam(row.activity_id, `activiteit (${where})`) : null;
      if (!users.has(userId) || !projects.has(projectId) || (activityId && !activities.has(activityId))) {
        throw new HttpError(400, `Onbekende medewerker, project of activiteit in ${where}`);
      }
      const date = isoDate(row.work_date, `datum (${where})`);
      const hours = num(row.hours, { min: 0.01, max: 24, name: `aantal uren (${where})` });
      const description = str(row.description, { name: 'Omschrijving', max: 1000, required: false });

      if (activityId && !linked.has(`${projectId}|${activityId}`)) {
        await db.query('INSERT INTO project_activities (project_id, activity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, activityId]);
        linked.add(`${projectId}|${activityId}`);
        out.linked_activities += 1;
      }
      if (addToTeam && !team.has(`${projectId}|${userId}`)) {
        await db.query('INSERT INTO assignments (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, userId]);
        team.add(`${projectId}|${userId}`);
        out.team_added += 1;
      }

      const status = invoicedThrough && date <= invoicedThrough ? 'invoiced' : 'approved';
      const ins = await db.query(
        `INSERT INTO time_entries (user_id, project_id, activity_id, work_date, hours, description, status, approved_by, approved_at, rate)
         VALUES ($1, $2, $3::int, $4, $5, $6, $7, $8, now(), COALESCE(
           (SELECT pa.rate FROM project_activities pa WHERE pa.project_id = $2 AND pa.activity_id = $3::int),
           (SELECT a.rate FROM assignments a WHERE a.project_id = $2 AND a.user_id = $1),
           (SELECT ac.default_rate FROM activities ac WHERE ac.id = $3::int),
           (SELECT p.default_rate FROM projects p WHERE p.id = $2)))
         ON CONFLICT (user_id, project_id, (COALESCE(activity_id, 0)), work_date) DO NOTHING
         RETURNING id`,
        [userId, projectId, activityId, date, hours, description, status, req.user.id]
      );
      if (ins.rowCount) { out.inserted += 1; out.hours += hours; } else out.skipped += 1;
    }
    out.hours = Math.round(out.hours * 100) / 100;
    return out;
  });
  res.json(result);
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
    lineMode: b.lineMode === 'grouped' ? 'grouped' : 'entry',
    lineFormat: str(b.lineFormat, { name: 'Opmaak factuurregel', max: 300 }),
    emailDefault: Boolean(b.emailDefault),
    emailSubject: str(b.emailSubject, { name: 'Onderwerp', max: 200 }),
    emailBody: str(b.emailBody, { name: 'Tekst e-mail', max: 5000 }),
    emailTemplateId: optInt(b.emailTemplateId, 'e-mailsjabloon'),
    invoiceText: str(b.invoiceText, { name: 'Factuurtekst', max: 500, required: false }),
    numberPrefix: str(b.numberPrefix, { name: 'Voorvoegsel factuurnummer', max: 10, required: false }),
    numberDigits: num(b.numberDigits ?? 5, { min: 1, max: 10, name: 'aantal cijfers' }),
    printDefault: Boolean(b.printDefault),
  };
  if (value.numberPrefix && !/^[A-Za-z0-9-]*$/.test(value.numberPrefix)) {
    throw new HttpError(400, 'Het voorvoegsel mag alleen letters, cijfers en een streepje bevatten');
  }
  await setEbSettings(value);
  res.json(value);
}));

r.get('/eb/relations', ah(async (req, res) => {
  const relations = await eb.relations({ fresh: req.query.fresh === '1' });
  const clients = (await query('SELECT id, name, eb_relation_id FROM clients')).rows;
  const byRelation = new Map(clients.filter((c) => c.eb_relation_id).map((c) => [c.eb_relation_id, c]));
  const byName = new Map(clients.filter((c) => !c.eb_relation_id).map((c) => [normName(c.name), c]));
  res.json(relations.map((rel) => {
    const linked = byRelation.get(rel.id);
    const sameName = !linked && byName.get(normName(rel.name));
    return {
      ...rel,
      client_id: linked ? linked.id : null,
      client_name: linked ? linked.name : null,
      match_client_id: sameName ? sameName.id : null,
    };
  }));
}));

// Relaties uit e-Boekhouden overnemen als (gekoppelde) klanten.
r.post('/clients/import-eb', ah(async (req, res) => {
  const ids = Array.isArray(req.body.relation_ids) ? req.body.relation_ids.map((x) => intParam(x, 'relatie')) : [];
  if (!ids.length) throw new HttpError(400, 'Selecteer een of meer relaties');
  const relations = new Map((await eb.relations()).map((x) => [x.id, x]));
  const out = await tx(async (db) => {
    const clients = (await db.query('SELECT id, name, eb_relation_id FROM clients')).rows;
    const linkedIds = new Set(clients.filter((c) => c.eb_relation_id).map((c) => c.eb_relation_id));
    const byName = new Map(clients.filter((c) => !c.eb_relation_id).map((c) => [normName(c.name), c]));
    const result = { created: 0, linked: 0, skipped: 0 };
    for (const id of ids) {
      const rel = relations.get(id);
      if (!rel || linkedIds.has(id)) { result.skipped += 1; continue; }
      const same = byName.get(normName(rel.name));
      if (same) {
        await db.query('UPDATE clients SET eb_relation_id = $1, eb_relation_code = $2 WHERE id = $3', [rel.id, rel.code, same.id]);
        byName.delete(normName(rel.name));
        result.linked += 1;
      } else {
        await db.query(
          'INSERT INTO clients (name, eb_relation_id, eb_relation_code) VALUES ($1, $2, $3)',
          [rel.name, rel.id, rel.code]
        );
        result.created += 1;
      }
      linkedIds.add(id);
    }
    return result;
  });
  res.json(out);
}));

r.post('/eb/test', ah(async (req, res) => {
  await eb.testConnection();
  res.json({ ok: true });
}));

r.get('/eb/options', ah(async (req, res) => {
  const [ledgers, templates, units, emailTemplates] = await Promise.all([
    eb.ledgers(), eb.invoiceTemplates(), eb.units(), eb.emailTemplates().catch(() => []),
  ]);
  res.json({
    ledgers: ledgers.map((l) => ({
      id: l.id,
      code: l.code || '',
      category: l.category || '',
      label: [l.code, l.description || l.name].filter(Boolean).join(' '),
    })),
    templates: templates.map((t) => ({ id: t.id, label: t.name || t.description || `Sjabloon ${t.id}` })),
    emailTemplates: emailTemplates.filter((t) => t.useInvoice !== false)
      .map((t) => ({ id: t.id, label: t.name || `E-mailsjabloon ${t.id}` })),
    // e-Boekhouden noemt eenheden in enkelvoud en meervoud, bijvoorbeeld "uur" / "uren".
    units: units.map((u) => {
      const one = u.singular || u.name || u.description || u.code;
      const label = one ? (u.plural && u.plural !== one ? `${one} / ${u.plural}` : one) : `Eenheid ${u.id}`;
      return { id: u.id, label };
    }),
  });
}));

module.exports = r;
