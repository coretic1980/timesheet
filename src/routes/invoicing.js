const express = require('express');
const { query, tx, getEbSettings } = require('../db');
const { ah, HttpError, isoDate, intParam, str, todayIso, fmtDateNl, round2 } = require('../util');
const eb = require('../eboekhouden');

const r = express.Router();

const BILLABLE_SQL = (lock) => `
  SELECT e.id, e.hours, e.rate, e.work_date, e.description, e.user_id, u.name AS user_name,
         e.project_id, p.name AS project_name, p.code AS project_code, p.reference AS project_reference,
         e.activity_id, ac.name AS activity_name
    FROM time_entries e
    JOIN projects p ON p.id = e.project_id
    JOIN users u ON u.id = e.user_id
    LEFT JOIN activities ac ON ac.id = e.activity_id
   WHERE p.client_id = $1 AND p.billable AND e.status = 'approved' AND e.invoice_id IS NULL
     AND e.work_date BETWEEN $2 AND $3
     AND ($4::int[] IS NULL OR p.id = ANY($4::int[]))
   ORDER BY e.work_date, p.name, ac.name NULLS FIRST, u.name
   ${lock ? 'FOR UPDATE OF e' : ''}`;

function parsePeriod(src) {
  const from = isoDate(src.from, 'begindatum');
  const to = isoDate(src.to, 'einddatum');
  if (from > to) throw new HttpError(400, 'Begindatum ligt na de einddatum');
  return { from, to };
}

// Opmaak per klant, anders de standaardinstelling.
function lineSettings(client, s) {
  return {
    mode: client.invoice_line_mode || s.lineMode || 'entry',
    format: client.invoice_line_format || s.lineFormat || '[DATUM] | [ACTIVITEIT] | [OPMERKING]',
  };
}

// Vult de codes in, zoals in e-Boekhouden: [DATUM] [PROJECT] [PROJECTCODE] [ACTIVITEIT] [OPMERKING] [MEDEWERKER],
// plus [REFERENTIE] (PO van het project).
// Lege codes laten geen losse scheidingstekens achter.
function renderLine(format, vars) {
  let out = format.replace(/\[(DATUM|PROJECTCODE|PROJECT|ACTIVITEIT|OPMERKING|MEDEWERKER|REFERENTIE)\]/gi, (m, k) => vars[k.toUpperCase()] || '');
  out = out.replace(/\s*([|–,;/])\s*(?:[|–,;/]\s*)+/g, ' $1 ');
  out = out.replace(/^[\s|–,;/:]+|[\s|–,;/:]+$/g, '').replace(/\s{2,}/g, ' ');
  return out.slice(0, 1000);
}

const dateRange = (a, b) => (a === b ? fmtDateNl(a) : `${fmtDateNl(a)} t/m ${fmtDateNl(b)}`);

function checkRate(e) {
  if (e.rate === null || e.rate === undefined) {
    throw new HttpError(400, `Uren van ${e.user_name} op ${e.project_name} hebben geen tarief. Heropen en keur ze opnieuw goed.`);
  }
}

// mode 'entry': één factuurregel per uurregel (zoals e-Boekhouden).
// mode 'grouped': één regel per project × activiteit × medewerker × tarief.
function buildLines(entries, { mode, format }) {
  if (mode === 'entry') {
    return entries.map((e) => {
      checkRate(e);
      return {
        ids: [e.id], hours: e.hours, rate: e.rate, amount: round2(e.hours * e.rate),
        description: renderLine(format, {
          DATUM: fmtDateNl(e.work_date), PROJECT: e.project_name, PROJECTCODE: e.project_code,
          ACTIVITEIT: e.activity_name, OPMERKING: e.description, MEDEWERKER: e.user_name, REFERENTIE: e.project_reference,
        }),
      };
    });
  }
  const groups = new Map();
  for (const e of entries) {
    checkRate(e);
    const key = `${e.project_id}|${e.activity_id || 0}|${e.user_id}|${e.rate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        project_name: e.project_name, project_code: e.project_code, project_reference: e.project_reference, activity_name: e.activity_name,
        user_name: e.user_name, rate: e.rate, hours: 0, first: e.work_date, last: e.work_date, ids: [], notes: [],
      });
    }
    const g = groups.get(key);
    g.hours = round2(g.hours + e.hours);
    if (e.work_date < g.first) g.first = e.work_date;
    if (e.work_date > g.last) g.last = e.work_date;
    g.ids.push(e.id);
    if (e.description && !g.notes.includes(e.description)) g.notes.push(e.description);
  }
  return [...groups.values()].map((g) => ({
    ids: g.ids, hours: g.hours, rate: g.rate, amount: round2(g.hours * g.rate),
    description: renderLine(format, {
      DATUM: dateRange(g.first, g.last), PROJECT: g.project_name, PROJECTCODE: g.project_code,
      ACTIVITEIT: g.activity_name, OPMERKING: g.notes.join('; '), MEDEWERKER: g.user_name, REFERENTIE: g.project_reference,
    }),
  }));
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
// "september 2026", of "september t/m oktober 2026" als de periode meerdere maanden beslaat.
function monthLabel(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (fy === ty && fm === tm) return `${MONTHS[fm - 1]} ${fy}`;
  if (fy === ty) return `${MONTHS[fm - 1]} t/m ${MONTHS[tm - 1]} ${fy}`;
  return `${MONTHS[fm - 1]} ${fy} t/m ${MONTHS[tm - 1]} ${ty}`;
}

// Codes in e-mail en factuurtekst: [KLANT] [PERIODE] [MAAND] [REFERENTIE].
function fillMail(text, client, from, to, reference = '') {
  return String(text || '')
    .replace(/\[KLANT\]/gi, client.name)
    .replace(/\[PERIODE\]/gi, dateRange(from, to))
    .replace(/\[MAAND\]/gi, monthLabel(from, to))
    .replace(/\[REFERENTIE\]/gi, reference || '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

// Volgend factuurnummer: hoogste nummer met hetzelfde voorvoegsel in e-Boekhouden (en in de app) + 1.
async function nextInvoiceNumber(s) {
  const prefix = s.numberPrefix || '';
  const digits = Number(s.numberDigits) || 5;
  const re = new RegExp(`^${escRe(prefix)}(\\d+)$`, 'i');
  let max = 0;
  let source = 'app';
  try {
    for (const inv of await eb.invoices()) {
      const m = String(inv.invoiceNumber || '').match(re);
      if (m) max = Math.max(max, Number(m[1]));
    }
    source = 'e-Boekhouden';
  } catch { /* e-Boekhouden niet bereikbaar: alleen de facturen uit de app */ }
  const own = (await query('SELECT eb_invoice_number FROM invoices WHERE eb_invoice_number IS NOT NULL')).rows;
  for (const r of own) {
    const m = String(r.eb_invoice_number).match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return { number: `${prefix}${String(max + 1).padStart(digits, '0')}`, source };
}

const escHtml = (t) => t.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function buildInvoiceBody(client, lines, s, { from, to, reference, date, sendEmail, invoiceNumber, text, print }) {
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
      description: l.description,
      quantity: l.hours,
      pricePerUnit: l.rate,
      vatCode: s.vatCode,
      ledgerId: s.revenueLedgerId,
      ...(s.unitId ? { unitId: s.unitId } : {}),
    })),
  };
  if (reference) body.reference = reference;
  if (invoiceNumber) body.invoiceNumber = invoiceNumber;
  if (text) body.text = text;
  if (print) body.print = true;
  if (s.emailTemplateId) body.emailTemplateId = s.emailTemplateId;
  if (s.process) {
    body.mutation = {
      ledgerId: s.debtorLedgerId,
      description: `Uren ${client.name} ${dateRange(from, to)}`.slice(0, 200),
    };
  }
  if (sendEmail) {
    // e-Boekhouden mailt de factuur naar het factuur-e-mailadres van de relatie.
    // Met een e-mailsjabloon uit e-Boekhouden komen onderwerp en tekst uit het sjabloon.
    body.email = s.emailTemplateId ? {} : {
      subject: fillMail(s.emailSubject, client, from, to, reference).slice(0, 200),
      body: escHtml(fillMail(s.emailBody, client, from, to, reference)).split('\n').join('<br>'),
    };
  }
  return body;
}

const totals = (lines) => ({
  hours: round2(lines.reduce((s, l) => s + l.hours, 0)),
  total_excl: round2(lines.reduce((s, l) => s + l.amount, 0)),
});

// Optionele selectie van projecten (om per PO te factureren).
function projectIds(v) {
  if (v === undefined || v === null || v === '') return null;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => intParam(x, 'project'));
  return list.length ? list : null;
}

// Projecten met factureerbare uren in de periode (los van de selectie), voor de keuze in het voorbeeld.
async function billableProjects(clientId, from, to) {
  const { rows } = await query(
    `SELECT p.id, p.name, p.reference, sum(e.hours) AS hours, sum(e.hours * e.rate) AS amount
       FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE p.client_id = $1 AND p.billable AND e.status = 'approved' AND e.invoice_id IS NULL
        AND e.work_date BETWEEN $2 AND $3
      GROUP BY p.id ORDER BY p.name`,
    [clientId, from, to]
  );
  return rows.map((x) => ({ ...x, amount: round2(x.amount) }));
}

// Referentie: de PO('s) van de projecten op de factuur.
function suggestReference(entries) {
  const refs = [...new Set(entries.map((e) => e.project_reference).filter(Boolean))];
  return { reference: refs.join(', ').slice(0, 50), references: refs };
}

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
  const settings = await getEbSettings();
  const ls = lineSettings(client, settings);
  const ids = projectIds(req.query.project_ids);
  const entries = (await query(BILLABLE_SQL(false), [client.id, from, to, ids])).rows;
  const lines = buildLines(entries, ls);
  res.json({
    client, from, to, lines, ...totals(lines),
    projects: await billableProjects(client.id, from, to),
    selected_project_ids: ids,
    ...suggestReference(entries),
    line_mode: ls.mode, line_format: ls.format, email_default: Boolean(settings.emailDefault),
    email_template: Boolean(settings.emailTemplateId),
    print_default: Boolean(settings.printDefault),
    invoice_number: await nextInvoiceNumber(settings),
    invoice_text: fillMail(settings.invoiceText, client, from, to, suggestReference(entries).reference),
  });
}));

r.post('/create', ah(async (req, res) => {
  const { from, to } = parsePeriod(req.body);
  const client = await loadClient(intParam(req.body.client_id, 'klant'));
  const reference = str(req.body.reference, { name: 'Referentie', max: 50, required: false });
  const date = req.body.date ? isoDate(req.body.date, 'factuurdatum') : todayIso();
  const settings = await getEbSettings();
  const ls = lineSettings(client, settings);
  const sendEmail = Boolean(req.body.send_email);
  const ids = projectIds(req.body.project_ids);
  const invoiceNumber = str(req.body.invoice_number, { name: 'Factuurnummer', max: 30, required: false });
  if (invoiceNumber && !/\d$/.test(invoiceNumber)) throw new HttpError(400, 'Het factuurnummer moet op een cijfer eindigen');
  const text = str(req.body.text, { name: 'Factuurtekst', max: 2000, required: false });
  const print = Boolean(req.body.print);

  if (req.body.dry_run) {
    const entries = (await query(BILLABLE_SQL(false), [client.id, from, to, ids])).rows;
    if (!entries.length) throw new HttpError(400, 'Geen goedgekeurde, nog niet gefactureerde uren in deze periode');
    const lines = buildLines(entries, ls);
    const body = buildInvoiceBody(client, lines, settings, { from, to, reference, date, sendEmail, invoiceNumber, text, print });
    return res.json({ dry_run: true, body, ...totals(lines) });
  }

  const result = await tx(async (db) => {
    const entries = (await db.query(BILLABLE_SQL(true), [client.id, from, to, ids])).rows;
    if (!entries.length) throw new HttpError(400, 'Geen goedgekeurde, nog niet gefactureerde uren in deze periode');
    const lines = buildLines(entries, ls);
    const body = buildInvoiceBody(client, lines, settings, { from, to, reference, date, sendEmail, invoiceNumber, text, print });
    const sum = totals(lines);

    const created = await eb.createInvoice(body);
    const ebId = created && (created.id || created.invoiceId);
    let number = (created && created.invoiceNumber) || invoiceNumber || null;
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
    return { invoice: ins.rows[0], lines, emailed: sendEmail };
  });

  res.status(201).json(result);
}));

r.get('/history', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, c.name AS client_name, u.name AS created_by_name, rv.name AS reverted_by_name
       FROM invoices i JOIN clients c ON c.id = i.client_id
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN users rv ON rv.id = i.reverted_by
      ORDER BY i.created_at DESC LIMIT 100`
  );
  res.json(rows);
}));

// Factuur terugdraaien: de uren gaan terug naar 'goedgekeurd' en kunnen opnieuw gefactureerd worden.
// De factuur in e-Boekhouden moet de gebruiker zelf verwijderen of crediteren (de API kan dat niet).
r.post('/:id/revert', ah(async (req, res) => {
  const id = intParam(req.params.id, 'factuur');
  const result = await tx(async (db) => {
    const inv = (await db.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!inv) throw new HttpError(404, 'Factuur niet gevonden');
    if (inv.reverted_at) throw new HttpError(400, 'Deze factuur is al teruggedraaid');
    const upd = await db.query(
      `UPDATE time_entries SET status = 'approved', invoice_id = NULL, updated_at = now()
        WHERE invoice_id = $1 AND status = 'invoiced'
        RETURNING hours`,
      [id]
    );
    await db.query('UPDATE invoices SET reverted_at = now(), reverted_by = $2 WHERE id = $1', [id, req.user.id]);
    return { reverted: upd.rowCount, hours: round2(upd.rows.reduce((t, x) => t + x.hours, 0)) };
  });
  res.json(result);
}));

module.exports = r;
