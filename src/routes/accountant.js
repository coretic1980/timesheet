// Controle voor de accountant (en de beheerder): alleen lezen.
// Omzet per maand, onderhanden werk, signaleringen, uren- en factuuroverzichten, logboek en CSV-exports.
const express = require('express');
const { query, getEbSettings } = require('../db');
const { ah, HttpError, isoDate, intParam, addDays, todayIso, round2 } = require('../util');
const { sendCsv } = require('../csv');

const r = express.Router();

// Alleen GET: de accountant kan niets wijzigen, ook niet via een ander pad.
r.use((req, res, next) => (req.method === 'GET' ? next() : next(new HttpError(405, 'Alleen inzien'))));

const STATUS_NL = {
  draft: 'Concept', submitted: 'Ingediend', approved: 'Goedgekeurd', rejected: 'Afgekeurd', invoiced: 'Gefactureerd',
};

// Factuurdatum; voor facturen van vóór deze versie de aanmaakdatum (Nederlandse tijd).
const INV_DATE = `coalesce(i.invoice_date, (i.created_at AT TIME ZONE 'Europe/Amsterdam')::date)`;

// Tarief van een uurregel: vastgelegd bij goedkeuring, anders een schatting volgens dezelfde volgorde.
const EST_RATE = `COALESCE(e.rate,
  (SELECT pa.rate FROM project_activities pa WHERE pa.project_id = e.project_id AND pa.activity_id = e.activity_id),
  (SELECT a.rate FROM assignments a WHERE a.project_id = e.project_id AND a.user_id = e.user_id),
  (SELECT ac.default_rate FROM activities ac WHERE ac.id = e.activity_id),
  p.default_rate, 0)`;

function period(q) {
  const from = isoDate(q.from, 'begindatum');
  const to = isoDate(q.to, 'einddatum');
  if (from > to) throw new HttpError(400, 'Begindatum ligt na de einddatum');
  return { from, to };
}

const sum = (rows, f) => round2(rows.reduce((t, x) => t + (Number(x[f]) || 0), 0));

/* ---------- Overzicht ---------- */

r.get('/overview', ah(async (req, res) => {
  const { from, to } = period(req.query);
  const ohwDate = req.query.ohw_date ? isoDate(req.query.ohw_date, 'peildatum') : to;

  const byMonth = (await query(
    `SELECT to_char(${INV_DATE}, 'YYYY-MM') AS month, count(*)::int AS count,
            sum(i.hours) AS hours, sum(i.total_excl) AS total_excl
       FROM invoices i
      WHERE i.reverted_at IS NULL AND ${INV_DATE} BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 1`,
    [from, to]
  )).rows.map((x) => ({ ...x, total_excl: round2(x.total_excl) }));

  const byStatus = (await query(
    `SELECT e.status, sum(e.hours) AS hours,
            coalesce(sum(e.hours) FILTER (WHERE p.billable), 0) AS billable_hours,
            coalesce(sum(e.hours * e.rate) FILTER (WHERE p.billable AND e.status IN ('approved', 'invoiced')), 0) AS value
       FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE e.work_date BETWEEN $1 AND $2
      GROUP BY e.status`,
    [from, to]
  )).rows.map((x) => ({ ...x, value: round2(x.value) }));

  // Onderhanden werk op de peildatum: declarabele uren t/m die datum die toen nog niet gefactureerd waren.
  const ohw = (await query(
    `SELECT c.id AS client_id, c.name AS client_name,
            coalesce(sum(e.hours) FILTER (WHERE e.status IN ('approved', 'invoiced')), 0) AS approved_hours,
            coalesce(sum(e.hours * e.rate) FILTER (WHERE e.status IN ('approved', 'invoiced')), 0) AS approved_value,
            coalesce(sum(e.hours) FILTER (WHERE e.status IN ('draft', 'submitted', 'rejected')), 0) AS open_hours,
            coalesce(sum(e.hours * ${EST_RATE}) FILTER (WHERE e.status IN ('draft', 'submitted', 'rejected')), 0) AS open_value
       FROM time_entries e
       JOIN projects p ON p.id = e.project_id AND p.billable
       JOIN clients c ON c.id = p.client_id
       LEFT JOIN invoices i ON i.id = e.invoice_id
      WHERE e.work_date <= $1
        AND (e.status <> 'invoiced' OR (e.invoice_id IS NOT NULL AND ${INV_DATE} > $1))
      GROUP BY c.id ORDER BY c.name`,
    [ohwDate]
  )).rows.map((x) => ({ ...x, approved_value: round2(x.approved_value), open_value: round2(x.open_value) }));

  const purchases = (await query(
    `SELECT count(*)::int AS count, coalesce(sum(hours), 0) AS hours, coalesce(sum(total_excl), 0) AS total_excl,
            coalesce(sum(vat_amount), 0) AS vat_amount
       FROM self_bills WHERE reverted_at IS NULL AND bill_date BETWEEN $1 AND $2`,
    [from, to]
  )).rows[0];

  res.json({
    from, to,
    purchases: { ...purchases, total_excl: round2(purchases.total_excl), vat_amount: round2(purchases.vat_amount) },
    invoices: {
      count: byMonth.reduce((t, x) => t + x.count, 0), hours: sum(byMonth, 'hours'), total_excl: sum(byMonth, 'total_excl'), by_month: byMonth,
    },
    hours: { by_status: byStatus, total: sum(byStatus, 'hours'), approved_value: sum(byStatus, 'value') },
    ohw: {
      date: ohwDate, rows: ohw,
      approved_hours: sum(ohw, 'approved_hours'), approved_value: sum(ohw, 'approved_value'),
      open_hours: sum(ohw, 'open_hours'), open_value: sum(ohw, 'open_value'),
    },
    checks: await checks(from, to),
  });
}));

/* ---------- Signaleringen ---------- */

const fh = (n) => String(round2(Number(n) || 0)).replace('.', ',');
const eur = (n) => `€ ${(round2(Number(n) || 0)).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

async function checks(from, to) {
  const today = todayIso();
  const out = [];
  const add = (key, level, title, okText, items, text) => out.push({
    key, title, level: items.length ? level : 'ok', text: items.length ? text : okText, items,
  });

  // 1. Factuurbedrag sluit niet aan op de gekoppelde uren.
  const mism = (await query(
    `SELECT i.id, i.eb_invoice_number AS number, c.name AS client_name, i.hours, i.total_excl,
            count(e.id)::int AS entries, coalesce(sum(e.hours), 0) AS entry_hours, coalesce(sum(e.hours * e.rate), 0) AS entry_value
       FROM invoices i JOIN clients c ON c.id = i.client_id
       LEFT JOIN time_entries e ON e.invoice_id = i.id
      WHERE i.reverted_at IS NULL AND ${INV_DATE} BETWEEN $1 AND $2
      GROUP BY i.id, c.name
     HAVING count(e.id) = 0 OR abs(coalesce(sum(e.hours * e.rate), 0) - i.total_excl) > 0.01
         OR abs(coalesce(sum(e.hours), 0) - i.hours) > 0.01`,
    [from, to]
  )).rows;
  add('invoice_match', 'warn', 'Facturen sluiten aan op de uren', 'Alle facturen in deze periode sluiten aan op de gefactureerde uren.',
    mism.map((x) => ({
      label: `${x.number || `#${x.id}`} ${x.client_name}`,
      value: x.entries ? `factuur ${eur(x.total_excl)}, uren ${eur(x.entry_value)}` : 'geen uren gekoppeld',
      invoice_id: x.id,
    })),
    'Bij deze facturen wijkt het bedrag of het aantal uren af van de gekoppelde uurregels.');

  // 2. Dubbele factuurnummers.
  const dups = (await query(
    `SELECT eb_invoice_number AS number, count(*)::int AS n FROM invoices
      WHERE reverted_at IS NULL AND eb_invoice_number IS NOT NULL
      GROUP BY eb_invoice_number HAVING count(*) > 1 ORDER BY 1`
  )).rows;
  add('duplicate_numbers', 'warn', 'Unieke factuurnummers', 'Geen factuurnummer is dubbel gebruikt.',
    dups.map((x) => ({ label: x.number, value: `${x.n} keer` })), 'Deze factuurnummers komen meer dan één keer voor.');

  // 3. Gaten in de nummering van facturen uit de app (kunnen in e-Boekhouden handmatig zijn gemaakt).
  const settings = await getEbSettings();
  const prefix = settings.numberPrefix || '';
  const re = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d+)$`, 'i');
  const nums = (await query(
    `SELECT eb_invoice_number AS number FROM invoices i
      WHERE i.reverted_at IS NULL AND eb_invoice_number IS NOT NULL AND ${INV_DATE} <= $1`,
    [to]
  )).rows.map((x) => { const m = String(x.number).match(re); return m ? Number(m[1]) : null; }).filter((n) => n !== null).sort((a, b) => a - b);
  const gaps = [];
  for (let k = 1; k < nums.length && gaps.length < 30; k += 1) {
    for (let n = nums[k - 1] + 1; n < nums[k] && gaps.length < 30; n += 1) gaps.push(n);
  }
  const digits = Number(settings.numberDigits) || 5;
  add('number_gaps', 'info', 'Doorlopende factuurnummers', nums.length ? 'De factuurnummers uit de app lopen door zonder gaten.' : 'Nog geen facturen uit de app.',
    gaps.map((n) => ({ label: `${prefix}${String(n).padStart(digits, '0')}`, value: 'niet in de app' })),
    'Deze nummers ontbreken tussen de facturen uit de app. Controleer of ze in e-Boekhouden handmatig zijn gemaakt.');

  // 4. Teruggedraaide facturen.
  const reverted = (await query(
    `SELECT i.id, i.eb_invoice_number AS number, c.name AS client_name, i.total_excl, i.reverted_at, u.name AS by_name
       FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN users u ON u.id = i.reverted_by
      WHERE i.reverted_at IS NOT NULL AND (i.reverted_at AT TIME ZONE 'Europe/Amsterdam')::date BETWEEN $1 AND $2
      ORDER BY i.reverted_at`,
    [from, to]
  )).rows;
  add('reverted', 'info', 'Teruggedraaide facturen', 'Geen facturen teruggedraaid in deze periode.',
    reverted.map((x) => ({ label: `${x.number || `#${x.id}`} ${x.client_name}`, value: `${eur(x.total_excl)}, door ${x.by_name || 'onbekend'}`, invoice_id: x.id })),
    'Deze facturen zijn teruggedraaid; in e-Boekhouden hoort er een creditfactuur of verwijdering bij.');

  // 5. Goedgekeurde declarabele uren die al lang niet gefactureerd zijn.
  const old = (await query(
    `SELECT c.name AS client_name, sum(e.hours) AS hours, sum(e.hours * e.rate) AS value, min(e.work_date) AS oldest
       FROM time_entries e JOIN projects p ON p.id = e.project_id AND p.billable JOIN clients c ON c.id = p.client_id
      WHERE e.status = 'approved' AND e.invoice_id IS NULL AND e.work_date < $1 AND e.work_date <= $2
      GROUP BY c.name ORDER BY c.name`,
    [addDays(today, -45), to]
  )).rows;
  add('old_unbilled', 'warn', 'Tijdig gefactureerd', 'Er staan geen goedgekeurde uren ouder dan 45 dagen open.',
    old.map((x) => ({ label: x.client_name, value: `${fh(x.hours)} uur, ${eur(x.value)}, oudste ${x.oldest}` })),
    'Goedgekeurde declarabele uren van meer dan 45 dagen geleden zijn nog niet gefactureerd.');

  // 6. Ingediende uren die al lang wachten op beoordeling.
  const stale = (await query(
    `SELECT u.name, sum(e.hours) AS hours, min(e.work_date) AS oldest
       FROM time_entries e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'submitted' AND e.work_date < $1
      GROUP BY u.name ORDER BY u.name`,
    [addDays(today, -14)]
  )).rows;
  add('stale_submitted', 'warn', 'Uren op tijd beoordeeld', 'Er wachten geen uren langer dan 14 dagen op goedkeuring.',
    stale.map((x) => ({ label: x.name, value: `${fh(x.hours)} uur, oudste ${x.oldest}` })),
    'Deze uren zijn ingediend maar na 14 dagen nog niet goedgekeurd of afgekeurd.');

  // 7. Goedgekeurde declarabele uren zonder tarief.
  const zero = (await query(
    `SELECT c.name AS client_name, p.name AS project_name, sum(e.hours) AS hours
       FROM time_entries e JOIN projects p ON p.id = e.project_id AND p.billable LEFT JOIN clients c ON c.id = p.client_id
      WHERE e.status IN ('approved', 'invoiced') AND coalesce(e.rate, 0) = 0 AND e.work_date BETWEEN $1 AND $2
      GROUP BY c.name, p.name ORDER BY 1, 2`,
    [from, to]
  )).rows;
  add('zero_rate', 'warn', 'Tarief op declarabele uren', 'Alle goedgekeurde declarabele uren hebben een tarief.',
    zero.map((x) => ({ label: `${x.client_name || 'Intern'} / ${x.project_name}`, value: `${fh(x.hours)} uur zonder tarief` })),
    'Deze goedgekeurde declarabele uren hebben tarief € 0 of geen tarief.');

  // 8. Klanten met te factureren uren maar zonder koppeling met e-Boekhouden.
  const unlinked = (await query(
    `SELECT c.name, sum(e.hours) AS hours
       FROM time_entries e JOIN projects p ON p.id = e.project_id AND p.billable JOIN clients c ON c.id = p.client_id
      WHERE c.eb_relation_id IS NULL AND e.status IN ('approved', 'submitted') AND e.invoice_id IS NULL
      GROUP BY c.name ORDER BY c.name`
  )).rows;
  add('unlinked_clients', 'warn', 'Klanten gekoppeld aan e-Boekhouden', 'Alle klanten met te factureren uren zijn gekoppeld aan een relatie.',
    unlinked.map((x) => ({ label: x.name, value: `${fh(x.hours)} uur open` })),
    'Deze klanten hebben uren om te factureren, maar zijn nog niet aan een relatie in e-Boekhouden gekoppeld.');

  // 9. Functiescheiding: eigen uren zelf goedgekeurd (bij een eenmanszaak normaal, ter informatie).
  const self = (await query(
    `SELECT u.name, sum(e.hours) AS hours
       FROM time_entries e JOIN users u ON u.id = e.user_id
      WHERE e.approved_by = e.user_id AND e.status IN ('approved', 'invoiced') AND e.work_date BETWEEN $1 AND $2
      GROUP BY u.name ORDER BY u.name`,
    [from, to]
  )).rows;
  add('self_approved', 'info', 'Functiescheiding bij goedkeuren', 'Niemand heeft zijn eigen uren goedgekeurd.',
    self.map((x) => ({ label: x.name, value: `${fh(x.hours)} uur zelf goedgekeurd` })),
    'Deze uren zijn goedgekeurd door de medewerker zelf.');

  // 10. Uren die bij de import als gefactureerd zijn gemarkeerd (geen factuur in de app).
  const imported = (await query(
    `SELECT count(*)::int AS n, coalesce(sum(hours), 0) AS hours FROM time_entries
      WHERE status = 'invoiced' AND invoice_id IS NULL AND work_date BETWEEN $1 AND $2`,
    [from, to]
  )).rows[0];
  add('imported_invoiced', 'info', 'Gefactureerd buiten de app', 'Alle gefactureerde uren in deze periode horen bij een factuur uit de app.',
    imported.n ? [{ label: `${imported.n} uurregels`, value: `${fh(imported.hours)} uur` }] : [],
    'Deze uren zijn bij de import uit e-Boekhouden als gefactureerd gemarkeerd; de facturen staan alleen in e-Boekhouden.');

  // 11. Ingehuurde zzp'ers: goedgekeurde uren die na 45 dagen nog niet zijn afgerekend.
  const zzpOld = (await query(
    `SELECT u.name, sum(e.hours) AS hours, sum(e.hours * e.cost_rate) AS value, min(e.work_date) AS oldest
       FROM time_entries e JOIN users u ON u.id = e.user_id JOIN contractors c ON c.user_id = e.user_id
      WHERE e.status IN ('approved', 'invoiced') AND e.self_bill_id IS NULL AND e.work_date < $1 AND e.work_date <= $2
      GROUP BY u.name ORDER BY u.name`,
    [addDays(today, -45), to]
  )).rows;
  add('zzp_unbilled', 'warn', 'zzp\'ers tijdig afgerekend', 'Er staan geen goedgekeurde zzp-uren ouder dan 45 dagen open.',
    zzpOld.map((x) => ({ label: x.name, value: `${fh(x.hours)} uur, ${eur(x.value)}, oudste ${x.oldest}` })),
    'Goedgekeurde uren van ingehuurde zzp\'ers van meer dan 45 dagen geleden zijn nog niet met een zelffactuur afgerekend.');

  // 12. Goedgekeurde zzp-uren zonder inkooptarief.
  const zzpNoRate = (await query(
    `SELECT u.name, sum(e.hours) AS hours
       FROM time_entries e JOIN users u ON u.id = e.user_id JOIN contractors c ON c.user_id = e.user_id
      WHERE e.status IN ('approved', 'invoiced') AND e.cost_rate IS NULL AND e.work_date BETWEEN $1 AND $2
      GROUP BY u.name ORDER BY u.name`,
    [from, to]
  )).rows;
  add('zzp_cost_rate', 'warn', 'Inkooptarief op zzp-uren', 'Alle goedgekeurde zzp-uren hebben een inkooptarief.',
    zzpNoRate.map((x) => ({ label: x.name, value: `${fh(x.hours)} uur zonder inkooptarief` })),
    'Deze goedgekeurde uren van ingehuurde zzp\'ers hebben geen inkooptarief.');

  // 13. Zelffacturen met bezwaar of zonder akkoord na 14 dagen.
  const sb = (await query(
    `SELECT s.id, s.number, s.status, s.bill_date, s.total_excl, s.dispute_reason, s.snapshot->'supplier'->>'name' AS supplier
       FROM self_bills s
      WHERE s.reverted_at IS NULL AND (s.status = 'disputed' OR (s.status = 'open' AND s.bill_date < $1))
      ORDER BY s.bill_date`,
    [addDays(today, -14)]
  )).rows;
  add('selfbill_acceptance', 'warn', 'Zelffacturen geaccepteerd', 'Alle zelffacturen zijn geaccepteerd of nog geen 14 dagen oud.',
    sb.map((x) => ({ label: `${x.number} ${x.supplier}`, value: x.status === 'disputed' ? `bezwaar: ${x.dispute_reason || ''}`.slice(0, 120) : `wacht sinds ${x.bill_date} op akkoord` })),
    'Bij deze zelffacturen heeft de zzp\'er bezwaar gemaakt of na 14 dagen nog geen akkoord gegeven.');

  return out;
}

/* ---------- Uren ---------- */

function entryFilters(q) {
  const { from, to } = period(q);
  const where = ['e.work_date BETWEEN $1 AND $2'];
  const params = [from, to];
  const push = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.status) {
    const st = String(q.status).split(',').filter((s) => STATUS_NL[s]);
    if (st.length) push('e.status = ANY(?)', st);
  }
  if (q.user_id) push('e.user_id = ?', intParam(q.user_id, 'medewerker'));
  if (q.client_id === 'intern') where.push('p.client_id IS NULL');
  else if (q.client_id) push('p.client_id = ?', intParam(q.client_id, 'klant'));
  if (q.project_id) push('e.project_id = ?', intParam(q.project_id, 'project'));
  if (q.billable === 'true') where.push('p.billable');
  if (q.billable === 'false') where.push('NOT p.billable');
  if (q.invoice_id) push('e.invoice_id = ?', intParam(q.invoice_id, 'factuur'));
  return { from, to, where: where.join(' AND '), params };
}

const ENTRY_SQL = (where, limit) => `
  SELECT e.id, e.work_date, e.hours, e.rate, round(e.hours * coalesce(e.rate, 0), 2) AS value, e.status, e.description,
         u.name AS user_name, c.name AS client_name, p.name AS project_name, p.code AS project_code, p.billable,
         ac.name AS activity_name, ab.name AS approved_by_name, e.approved_at,
         e.invoice_id, i.eb_invoice_number AS invoice_number
    FROM time_entries e
    JOIN users u ON u.id = e.user_id
    JOIN projects p ON p.id = e.project_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN activities ac ON ac.id = e.activity_id
    LEFT JOIN users ab ON ab.id = e.approved_by
    LEFT JOIN invoices i ON i.id = e.invoice_id
   WHERE ${where}
   ORDER BY e.work_date, u.name, c.name NULLS LAST, p.name
   ${limit ? `LIMIT ${limit}` : ''}`;

const MAX_ROWS = 5000;

r.get('/entries', ah(async (req, res) => {
  const f = entryFilters(req.query);
  const { rows } = await query(ENTRY_SQL(f.where, MAX_ROWS + 1), f.params);
  const totals = (await query(
    `SELECT count(*)::int AS count, coalesce(sum(e.hours), 0) AS hours, coalesce(sum(e.hours * e.rate), 0) AS value
       FROM time_entries e JOIN projects p ON p.id = e.project_id WHERE ${f.where}`,
    f.params
  )).rows[0];
  res.json({ rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS, totals: { ...totals, value: round2(totals.value) } });
}));

r.get('/entries.csv', ah(async (req, res) => {
  const f = entryFilters(req.query);
  const { rows } = await query(ENTRY_SQL(f.where), f.params);
  sendCsv(res, `uren_${f.from}_${f.to}.csv`,
    ['Datum', 'Medewerker', 'Klant', 'Projectcode', 'Project', 'Activiteit', 'Declarabel', 'Uren', 'Tarief', 'Bedrag', 'Status',
      'Goedgekeurd door', 'Goedgekeurd op', 'Factuur', 'Omschrijving'],
    rows.map((x) => [
      x.work_date, x.user_name, x.client_name || 'Intern', x.project_code, x.project_name, x.activity_name, x.billable ? 'ja' : 'nee',
      x.hours, x.rate, x.rate === null ? null : x.value, STATUS_NL[x.status], x.approved_by_name,
      x.approved_at ? new Date(x.approved_at).toISOString().slice(0, 10) : null, x.invoice_number, x.description,
    ]));
}));

/* ---------- Facturen ---------- */

const INVOICE_SQL = `
  SELECT i.id, i.eb_invoice_id, i.eb_invoice_number AS number, ${INV_DATE} AS invoice_date, i.period_from, i.period_to,
         i.hours, i.total_excl, i.pdf_url, i.created_at, i.reverted_at,
         c.name AS client_name, c.eb_relation_code, u.name AS created_by_name, rv.name AS reverted_by_name,
         (SELECT count(*)::int FROM time_entries e WHERE e.invoice_id = i.id) AS entry_count,
         (SELECT coalesce(sum(e.hours * e.rate), 0) FROM time_entries e WHERE e.invoice_id = i.id) AS entry_value
    FROM invoices i JOIN clients c ON c.id = i.client_id
    LEFT JOIN users u ON u.id = i.created_by
    LEFT JOIN users rv ON rv.id = i.reverted_by
   WHERE ${INV_DATE} BETWEEN $1 AND $2
   ORDER BY ${INV_DATE}, i.eb_invoice_number`;

const invoiceRow = (x) => ({
  ...x, entry_value: round2(x.entry_value),
  matches: x.reverted_at ? null : x.entry_count > 0 && Math.abs(x.entry_value - x.total_excl) <= 0.01,
});

r.get('/invoices', ah(async (req, res) => {
  const { from, to } = period(req.query);
  res.json((await query(INVOICE_SQL, [from, to])).rows.map(invoiceRow));
}));

r.get('/invoices.csv', ah(async (req, res) => {
  const { from, to } = period(req.query);
  const rows = (await query(INVOICE_SQL, [from, to])).rows.map(invoiceRow);
  sendCsv(res, `facturen_${from}_${to}.csv`,
    ['Factuurnummer', 'Factuurdatum', 'Klant', 'Relatiecode', 'Periode van', 'Periode tot en met', 'Uren', 'Bedrag excl. btw',
      'Gemaakt door', 'Teruggedraaid op', 'Teruggedraaid door', 'Sluit aan op uren'],
    rows.map((x) => [
      x.number, x.invoice_date, x.client_name, x.eb_relation_code, x.period_from, x.period_to, x.hours, x.total_excl,
      x.created_by_name, x.reverted_at ? new Date(x.reverted_at).toISOString().slice(0, 10) : null, x.reverted_by_name,
      x.matches === null ? '' : (x.matches ? 'ja' : 'nee'),
    ]));
}));

/* ---------- Logboek ---------- */

r.get('/audit', ah(async (req, res) => {
  const { from, to } = period(req.query);
  const params = [from, to];
  let extra = '';
  if (req.query.action) { params.push(`${String(req.query.action).replace(/[^a-z_.]/g, '')}%`); extra = `AND l.action LIKE $${params.length}`; }
  const { rows } = await query(
    `SELECT l.id, l.at, l.action, l.summary, l.details, u.name AS user_name
       FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE (l.at AT TIME ZONE 'Europe/Amsterdam')::date BETWEEN $1 AND $2 ${extra}
      ORDER BY l.at DESC LIMIT 2000`,
    params
  );
  res.json(rows);
}));

r.get('/audit.csv', ah(async (req, res) => {
  const { from, to } = period(req.query);
  const { rows } = await query(
    `SELECT l.at, l.action, l.summary, u.name AS user_name
       FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE (l.at AT TIME ZONE 'Europe/Amsterdam')::date BETWEEN $1 AND $2
      ORDER BY l.at`,
    [from, to]
  );
  const fmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' });
  sendCsv(res, `logboek_${from}_${to}.csv`, ['Tijdstip', 'Door', 'Soort', 'Omschrijving'],
    rows.map((x) => [fmt.format(new Date(x.at)), x.user_name, x.action, x.summary]));
}));

/* ---------- Keuzelijsten voor de filters ---------- */

r.get('/filters', ah(async (req, res) => {
  const [users, clients, projects] = await Promise.all([
    query(`SELECT id, name, active FROM users WHERE role <> 'accountant' ORDER BY active DESC, name`),
    query('SELECT id, name, active FROM clients ORDER BY active DESC, name'),
    query(`SELECT p.id, p.name, p.client_id, p.active, c.name AS client_name
             FROM projects p LEFT JOIN clients c ON c.id = p.client_id ORDER BY c.name NULLS LAST, p.name`),
  ]);
  res.json({ users: users.rows, clients: clients.rows, projects: projects.rows });
}));

module.exports = r;
