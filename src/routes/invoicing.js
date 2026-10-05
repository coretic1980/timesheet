const express = require('express');
const { query, tx, getEbSettings } = require('../db');
const { ah, HttpError, isoDate, intParam, str, todayIso, fmtDateNl, round2 } = require('../util');
const eb = require('../eboekhouden');

const r = express.Router();

const BILLABLE_SQL = (lock) => `
  SELECT e.id, e.hours, e.rate, e.work_date, e.user_id, u.name AS user_name,
         e.project_id, p.name AS project_name, p.code AS project_code
    FROM time_entries e
    JOIN projects p ON p.id = e.project_id
    JOIN users u ON u.id = e.user_id
   WHERE p.client_id = $1 AND p.billable AND e.status = 'approved' AND e.invoice_id IS NULL
     AND e.work_date BETWEEN $2 AND $3
   ORDER BY p.name, u.name, e.work_date
   ${lock ? 'FOR UPDATE OF e' : ''}`;

function parsePeriod(src) {
  const from = isoDate(src.from, 'begindatum');
  const to = isoDate(src.to, 'einddatum');
  if (from > to) throw new HttpError(400, 'Begindatum ligt na de einddatum');
  return { from, to };
}

// Eén factuurregel per project × medewerker × tarief.
function buildLines(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (e.rate === null || e.rate === undefined) {
      throw new HttpError(400, `Uren van ${e.user_name} op ${e.project_name} hebben geen tarief. Heropen en keur ze opnieuw goed.`);
    }
    const key = `${e.project_id}|${e.user_id}|${e.rate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        project_id: e.project_id, project_name: e.project_name, project_code: e.project_code,
        user_name: e.user_name, rate: e.rate, hours: 0, first: e.work_date, last: e.work_date, ids: [],
      });
    }
    const g = groups.get(key);
    g.hours = round2(g.hours + e.hours);
    if (e.work_date < g.first) g.first = e.work_date;
    if (e.work_date > g.last) g.last = e.work_date;
    g.ids.push(e.id);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    amount: round2(g.hours * g.rate),
    description: `${g.project_code ? `${g.project_code} ` : ''}${g.project_name} – ${g.user_name}, `
      + `${fmtDateNl(g.first)} t/m ${fmtDateNl(g.last)}`,
  }));
}

function buildInvoiceBody(client, lines, s, { from, to, reference, date }) {
  if (!client.eb_relation_id) throw new HttpError(400, 'Koppel deze klant eerst aan een relatie in e-Boekhouden (Beheer › Klanten)');
  if (!s.templateId || !s.revenueLedgerId) {
    throw new HttpError(400, 'Kies eerst een factuursjabloon en omzetrekening (Beheer › Koppeling)');
  }
  if (s.process && !s.debtorLedgerId) {
    throw new HttpError(400, 'Kies een debiteurenrekening of zet "direct verwerken" uit (Beheer › Koppeling)');
  }
  const body = {
    relationId: client.eb_relation_id,
    templateId: s.templateId,
    date,
    termOfPayment: s.termOfPayment,
    items: lines.map((l) => ({
      description: l.description.slice(0, 1000),
      quantity: l.hours,
      pricePerUnit: l.rate,
      vatCode: s.vatCode,
      ledgerId: s.revenueLedgerId,
      ...(s.unitId ? { unitId: s.unitId } : {}),
    })),
  };
  if (reference) body.reference = reference;
  if (s.process) {
    body.mutation = {
      ledgerId: s.debtorLedgerId,
      description: `Uren ${client.name} ${fmtDateNl(from)} t/m ${fmtDateNl(to)}`.slice(0, 200),
    };
  }
  return body;
}

const totals = (lines) => ({
  hours: round2(lines.reduce((s, l) => s + l.hours, 0)),
  total_excl: round2(lines.reduce((s, l) => s + l.amount, 0)),
});

async function loadClient(id) {
  const { rows } = await query('SELECT * FROM clients WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Klant niet gevonden');
  return rows[0];
}

r.get('/candidates', ah(async (req, res) => {
  const { from, to } = parsePeriod(req.query);
  const { rows } = await query(
    `SELECT c.id, c.name, c.eb_relation_id, c.eb_relation_code,
            coalesce(sum(e.hours) FILTER (WHERE e.status = 'approved'), 0) AS hours,
            coalesce(sum(e.hours * e.rate) FILTER (WHERE e.status = 'approved'), 0) AS amount,
            coalesce(sum(e.hours) FILTER (WHERE e.status IN ('draft', 'submitted', 'rejected')), 0) AS open_hours
       FROM clients c
       JOIN projects p ON p.client_id = c.id AND p.billable
       JOIN time_entries e ON e.project_id = p.id AND e.invoice_id IS NULL AND e.work_date BETWEEN $1 AND $2
      GROUP BY c.id
      ORDER BY c.name`,
    [from, to]
  );
  res.json(rows.map((x) => ({ ...x, amount: round2(x.amount) })));
}));

r.get('/preview', ah(async (req, res) => {
  const { from, to } = parsePeriod(req.query);
  const client = await loadClient(intParam(req.query.client_id, 'klant'));
  const entries = (await query(BILLABLE_SQL(false), [client.id, from, to])).rows;
  const lines = buildLines(entries);
  res.json({ client, from, to, lines, ...totals(lines) });
}));

r.post('/create', ah(async (req, res) => {
  const { from, to } = parsePeriod(req.body);
  const client = await loadClient(intParam(req.body.client_id, 'klant'));
  const reference = str(req.body.reference, { name: 'Referentie', max: 50, required: false });
  const date = req.body.date ? isoDate(req.body.date, 'factuurdatum') : todayIso();
  const settings = await getEbSettings();

  if (req.body.dry_run) {
    const entries = (await query(BILLABLE_SQL(false), [client.id, from, to])).rows;
    if (!entries.length) throw new HttpError(400, 'Geen goedgekeurde, nog niet gefactureerde uren in deze periode');
    const lines = buildLines(entries);
    const body = buildInvoiceBody(client, lines, settings, { from, to, reference, date });
    return res.json({ dry_run: true, body, ...totals(lines) });
  }

  const result = await tx(async (db) => {
    const entries = (await db.query(BILLABLE_SQL(true), [client.id, from, to])).rows;
    if (!entries.length) throw new HttpError(400, 'Geen goedgekeurde, nog niet gefactureerde uren in deze periode');
    const lines = buildLines(entries);
    const body = buildInvoiceBody(client, lines, settings, { from, to, reference, date });
    const sum = totals(lines);

    const created = await eb.createInvoice(body);
    const ebId = created && (created.id || created.invoiceId);
    let number = created && created.invoiceNumber;
    let pdf = created && created.urlPdfFile;
    if (ebId && (!number || !pdf)) {
      try {
        const inv = await eb.getInvoice(ebId);
        number = number || (inv && inv.invoiceNumber);
        pdf = pdf || (inv && inv.urlPdfFile);
      } catch { /* factuur bestaat; details zijn optioneel */ }
    }

    const ins = await db.query(
      `INSERT INTO invoices (client_id, eb_invoice_id, eb_invoice_number, pdf_url, period_from, period_to,
                             hours, total_excl, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [client.id, ebId || null, number || null, pdf || null, from, to, sum.hours, sum.total_excl, req.user.id]
    );
    await db.query(
      `UPDATE time_entries SET status = 'invoiced', invoice_id = $1, updated_at = now() WHERE id = ANY($2)`,
      [ins.rows[0].id, entries.map((e) => e.id)]
    );
    return { invoice: ins.rows[0], lines };
  });

  res.status(201).json(result);
}));

r.get('/history', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, c.name AS client_name, u.name AS created_by_name
       FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC LIMIT 100`
  );
  res.json(rows);
}));

module.exports = r;
