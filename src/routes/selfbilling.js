// Zelffacturering voor ingehuurde zzp'ers ("factuur uitgereikt door afnemer").
// De zzp'er schrijft uren, de beheerder keurt goed en maakt daarna namens de zzp'er de factuur.
// Optioneel wordt die als inkoopfactuur (mutatie type 1) in e-Boekhouden geboekt.
// De zzp'er ziet zijn facturen in de app en geeft akkoord of maakt bezwaar.
const express = require('express');
const { query, tx, getSelfBillSettings } = require('../db');
const { ah, HttpError, isoDate, intParam, str, todayIso, fmtDateNl, round2 } = require('../util');
const eb = require('../eboekhouden');
const { audit, fhNl } = require('../audit');
const { sendCsv } = require('../csv');

const r = express.Router();

const VAT = {
  hoog: { rate: 21, code: 'HOOG_INK_21', label: '21% btw' },
  kor: { rate: 0, code: 'GEEN', label: 'Geen btw: kleineondernemersregeling' },
  verlegd: { rate: 0, code: 'VERL_INK', label: 'Btw verlegd' },
};

const isAdmin = (req) => req.user.role === 'admin';
const requireAdminHere = (req) => { if (!isAdmin(req)) throw new HttpError(403, 'Alleen voor beheerders'); };

function period(q) {
  const from = isoDate(q.from, 'begindatum');
  const to = isoDate(q.to, 'einddatum');
  if (from > to) throw new HttpError(400, 'Begindatum ligt na de einddatum');
  return { from, to };
}

// Goedgekeurde (of al aan de klant gefactureerde) uren van een zzp'er die nog niet zijn afgerekend.
const OPEN_SQL = (lock) => `
  SELECT e.id, e.work_date, e.hours, e.cost_rate, e.description, e.project_id, p.name AS project_name,
         c.name AS client_name, e.activity_id, ac.name AS activity_name
    FROM time_entries e
    JOIN projects p ON p.id = e.project_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN activities ac ON ac.id = e.activity_id
   WHERE e.user_id = $1 AND e.self_bill_id IS NULL AND e.status IN ('approved', 'invoiced')
     AND e.work_date BETWEEN $2 AND $3
   ORDER BY e.work_date, p.name, ac.name NULLS FIRST
   ${lock ? 'FOR UPDATE OF e' : ''}`;

// Factuurregels: per project, activiteit en tarief.
function buildLines(entries, from, to) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.project_id}|${e.activity_id || 0}|${e.cost_rate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        description: `${e.client_name ? `${e.client_name} / ` : ''}${e.project_name}${e.activity_name ? `, ${e.activity_name}` : ''}`,
        rate: e.cost_rate, hours: 0, first: e.work_date, last: e.work_date,
      });
    }
    const g = groups.get(key);
    g.hours = round2(g.hours + Number(e.hours));
    if (e.work_date < g.first) g.first = e.work_date;
    if (e.work_date > g.last) g.last = e.work_date;
  }
  return [...groups.values()].map((g) => ({
    description: `${g.description} (${g.first === g.last ? fmtDateNl(g.first) : `${fmtDateNl(g.first)} t/m ${fmtDateNl(g.last)}`})`,
    hours: g.hours, rate: g.rate, amount: round2(g.hours * (g.rate || 0)),
  }));
}

function totalsFor(lines, vatMode) {
  const vat = VAT[vatMode] || VAT.hoog;
  const excl = round2(lines.reduce((t, l) => t + l.amount, 0));
  const vatAmount = round2((excl * vat.rate) / 100);
  return { hours: round2(lines.reduce((t, l) => t + l.hours, 0)), total_excl: excl, vat_rate: vat.rate, vat_amount: vatAmount, total_incl: round2(excl + vatAmount) };
}

async function loadContractor(userId) {
  const { rows } = await query(
    `SELECT c.*, u.name AS user_name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1`,
    [userId]
  );
  if (!rows[0]) throw new HttpError(404, 'Deze medewerker is geen ingehuurde zzp\'er');
  return rows[0];
}

async function nextNumber(settings, db = null) {
  const run = db ? (s, p) => db.query(s, p) : query;
  const prefix = settings.prefix || '';
  const { rows } = await run('SELECT number FROM self_bills WHERE number LIKE $1', [`${prefix}%`]);
  const re = new RegExp(`^${prefix.replace(/-/g, '\\-')}(\\d+)$`);
  let max = 0;
  for (const x of rows) { const m = x.number.match(re); if (m) max = Math.max(max, Number(m[1])); }
  return `${prefix}${String(max + 1).padStart(Number(settings.digits) || 4, '0')}`;
}

// Wat er (nog) ontbreekt om een geldige zelffactuur te maken.
function problems(c, settings, entries) {
  const out = [];
  if (!settings.companyName || !settings.companyAddress || !settings.companyVat) out.push('Vul de gegevens van je eigen bedrijf in (Beheer › Koppeling › Zelffacturering zzp).');
  if (!c.agreement_date) out.push('Leg de datum vast waarop de zzp\'er akkoord ging met zelffacturering (Beheer › Medewerkers).');
  if (c.vat_mode !== 'kor' && !c.vat_number) out.push('Het btw-nummer van de zzp\'er ontbreekt.');
  if (!c.address || !c.city) out.push('Het adres van de zzp\'er ontbreekt.');
  const noRate = entries.filter((e) => e.cost_rate === null || e.cost_rate === undefined).length;
  if (noRate) out.push(`${noRate} ${noRate === 1 ? 'uurregel heeft' : 'uurregels hebben'} geen inkooptarief. Stel het inkooptarief in en keur de uren opnieuw goed.`);
  return out;
}

/* ---------- Beheerder: te factureren ---------- */

r.get('/candidates', ah(async (req, res) => {
  requireAdminHere(req);
  const { from, to } = period(req.query);
  const { rows } = await query(
    `SELECT u.id AS user_id, u.name, c.company_name, c.vat_mode, c.agreement_date, c.eb_relation_code,
            coalesce(sum(e.hours) FILTER (WHERE e.status IN ('approved', 'invoiced') AND e.self_bill_id IS NULL), 0) AS hours,
            coalesce(sum(e.hours * e.cost_rate) FILTER (WHERE e.status IN ('approved', 'invoiced') AND e.self_bill_id IS NULL), 0) AS amount,
            count(*) FILTER (WHERE e.status IN ('approved', 'invoiced') AND e.self_bill_id IS NULL AND e.cost_rate IS NULL)::int AS missing_rate,
            coalesce(sum(e.hours) FILTER (WHERE e.status IN ('draft', 'submitted', 'rejected')), 0) AS open_hours
       FROM contractors c JOIN users u ON u.id = c.user_id
       LEFT JOIN time_entries e ON e.user_id = u.id AND e.work_date BETWEEN $1 AND $2
      GROUP BY u.id, c.user_id
      ORDER BY u.name`,
    [from, to]
  );
  res.json(rows.map((x) => ({ ...x, amount: round2(x.amount) })));
}));

r.get('/preview', ah(async (req, res) => {
  requireAdminHere(req);
  const { from, to } = period(req.query);
  const c = await loadContractor(intParam(req.query.user_id, 'zzp\'er'));
  const settings = await getSelfBillSettings();
  const entries = (await query(OPEN_SQL(false), [c.user_id, from, to])).rows;
  const lines = buildLines(entries, from, to);
  res.json({
    contractor: c, from, to, lines, entries, ...totalsFor(lines, c.vat_mode), vat_label: VAT[c.vat_mode].label,
    number: await nextNumber(settings), problems: problems(c, settings, entries),
    booking: settings.process ? (eb.configured() && settings.costLedgerId && settings.creditorLedgerId && c.eb_relation_id ? 'ready' : 'incomplete') : 'off',
  });
}));

r.post('/create', ah(async (req, res) => {
  requireAdminHere(req);
  const { from, to } = period(req.body);
  const userId = intParam(req.body.user_id, 'zzp\'er');
  const date = req.body.date ? isoDate(req.body.date, 'factuurdatum') : todayIso();
  const settings = await getSelfBillSettings();
  const c = await loadContractor(userId);

  const result = await tx(async (db) => {
    const entries = (await db.query(OPEN_SQL(true), [userId, from, to])).rows;
    if (!entries.length) throw new HttpError(400, 'Geen goedgekeurde uren om af te rekenen in deze periode');
    const missing = problems(c, settings, entries);
    if (missing.length) throw new HttpError(400, missing[0]);
    const lines = buildLines(entries, from, to);
    const sum = totalsFor(lines, c.vat_mode);
    // Periode op de factuur: de eerste en laatste gewerkte dag, niet het gekozen filter.
    const workFrom = entries.reduce((m, e) => (e.work_date < m ? e.work_date : m), entries[0].work_date);
    const workTo = entries.reduce((m, e) => (e.work_date > m ? e.work_date : m), entries[0].work_date);
    const number = str(req.body.number, { name: 'Factuurnummer', max: 30, required: false }) || await nextNumber(settings, db);
    if ((await db.query('SELECT 1 FROM self_bills WHERE number = $1', [number])).rows[0]) throw new HttpError(400, `Factuurnummer ${number} is al gebruikt`);

    const snapshot = {
      supplier: {
        name: c.company_name, contact: c.user_name, address: c.address, postal_code: c.postal_code, city: c.city,
        kvk: c.kvk, vat_number: c.vat_number, iban: c.iban, vat_mode: c.vat_mode, agreement_date: c.agreement_date,
      },
      customer: {
        name: settings.companyName, address: settings.companyAddress, postal_code: settings.companyPostalCode,
        city: settings.companyCity, kvk: settings.companyKvk, vat_number: settings.companyVat,
      },
      lines,
      entries: entries.map((e) => ({ date: e.work_date, project: e.project_name, activity: e.activity_name, hours: Number(e.hours), description: e.description })),
      vat_label: VAT[c.vat_mode].label,
      payment_term: c.payment_term,
    };

    const ins = await db.query(
      `INSERT INTO self_bills (user_id, number, bill_date, period_from, period_to, hours, total_excl, vat_mode, vat_rate,
                               vat_amount, total_incl, snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13) RETURNING *`,
      [userId, number, date, workFrom, workTo, sum.hours, sum.total_excl, c.vat_mode, sum.vat_rate, sum.vat_amount, sum.total_incl,
        JSON.stringify(snapshot), req.user.id]
    );
    const bill = ins.rows[0];
    await db.query('UPDATE time_entries SET self_bill_id = $1, updated_at = now() WHERE id = ANY($2)', [bill.id, entries.map((e) => e.id)]);

    // Inkoopboeking in e-Boekhouden (alleen als alles is ingesteld). Mislukt die, dan wordt niets opgeslagen.
    let booked = false;
    if (settings.process && eb.configured() && settings.costLedgerId && settings.creditorLedgerId && c.eb_relation_id) {
      const created = await eb.createMutation({
        type: 1,
        date,
        ledgerId: settings.creditorLedgerId,
        relationId: c.eb_relation_id,
        invoiceNumber: number,
        termOfPayment: c.payment_term,
        description: `Zelffactuur ${c.company_name} ${fmtDateNl(workFrom)} t/m ${fmtDateNl(workTo)}`.slice(0, 200),
        inExVat: 'EX',
        rows: lines.map((l) => ({
          ledgerId: settings.costLedgerId, vatCode: VAT[c.vat_mode].code, amount: l.amount, description: l.description.slice(0, 200),
        })),
      });
      const mutId = created && (created.id || created.mutationId || created.entryNumber);
      if (mutId) await db.query('UPDATE self_bills SET eb_mutation_id = $1 WHERE id = $2', [Number(mutId) || null, bill.id]);
      booked = true;
    }

    await audit(db, req.user.id, 'selfbill.create',
      `Zelffactuur ${number} gemaakt voor ${c.company_name} (${c.user_name}): ${fhNl(sum.hours)} uur, € ${fhNl(sum.total_excl)} excl. btw`
        + `${booked ? ', geboekt in e-Boekhouden' : ''}`,
      { self_bill_id: bill.id, user_id: userId, entry_ids: entries.map((e) => e.id) });
    return { self_bill: bill, booked };
  });
  res.status(201).json(result);
}));

const LIST_SQL = (where) => `
  SELECT s.id, s.user_id, s.number, s.bill_date, s.period_from, s.period_to, s.hours, s.total_excl, s.vat_mode, s.vat_rate,
         s.vat_amount, s.total_incl, s.eb_mutation_id, s.status, s.status_at, s.dispute_reason, s.created_at, s.reverted_at,
         s.snapshot->'supplier'->>'name' AS company_name, u.name AS user_name, cb.name AS created_by_name, rb.name AS reverted_by_name
    FROM self_bills s JOIN users u ON u.id = s.user_id
    LEFT JOIN users cb ON cb.id = s.created_by
    LEFT JOIN users rb ON rb.id = s.reverted_by
   WHERE ${where}
   ORDER BY s.bill_date DESC, s.number DESC`;

// Overzicht voor beheerder en accountant (optioneel per periode op factuurdatum).
r.get('/history', ah(async (req, res) => {
  if (!['admin', 'accountant'].includes(req.user.role)) throw new HttpError(403, 'Alleen voor beheerders en de accountant');
  if (req.query.from || req.query.to) {
    const { from, to } = period(req.query);
    return res.json((await query(LIST_SQL('s.bill_date BETWEEN $1 AND $2'), [from, to])).rows);
  }
  res.json((await query(`${LIST_SQL('TRUE')} LIMIT 200`)).rows);
}));

r.get('/history.csv', ah(async (req, res) => {
  if (!['admin', 'accountant'].includes(req.user.role)) throw new HttpError(403, 'Alleen voor beheerders en de accountant');
  const { from, to } = period(req.query);
  const { rows } = await query(LIST_SQL('s.bill_date BETWEEN $1 AND $2'), [from, to]);
  const ST = { open: 'Wacht op akkoord', accepted: 'Akkoord', disputed: 'Bezwaar' };
  sendCsv(res, `zelffacturen_${from}_${to}.csv`,
    ['Factuurnummer', 'Factuurdatum', 'Leverancier', 'Medewerker', 'Periode van', 'Periode tot en met', 'Uren', 'Excl. btw', 'Btw %', 'Btw', 'Incl. btw',
      'Status', 'Ingetrokken op', 'Geboekt in e-Boekhouden'],
    rows.map((x) => [x.number, x.bill_date, x.company_name, x.user_name, x.period_from, x.period_to, x.hours, x.total_excl, x.vat_rate,
      x.vat_amount, x.total_incl, x.reverted_at ? 'Ingetrokken' : ST[x.status], x.reverted_at ? new Date(x.reverted_at).toISOString().slice(0, 10) : null,
      x.eb_mutation_id ? 'ja' : 'nee']));
}));

// Intrekken: uren komen weer vrij. Een eventuele boeking in e-Boekhouden moet je zelf crediteren.
r.post('/:id/revert', ah(async (req, res) => {
  requireAdminHere(req);
  const id = intParam(req.params.id, 'factuur');
  const out = await tx(async (db) => {
    const s = (await db.query('SELECT * FROM self_bills WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Zelffactuur niet gevonden');
    if (s.reverted_at) throw new HttpError(400, 'Deze zelffactuur is al ingetrokken');
    const upd = await db.query('UPDATE time_entries SET self_bill_id = NULL, updated_at = now() WHERE self_bill_id = $1', [id]);
    await db.query('UPDATE self_bills SET reverted_at = now(), reverted_by = $2 WHERE id = $1', [id, req.user.id]);
    await audit(db, req.user.id, 'selfbill.revert',
      `Zelffactuur ${s.number} van ${s.snapshot.supplier.name} ingetrokken: ${fhNl(s.hours)} uur, € ${fhNl(s.total_excl)} excl. btw weer af te rekenen`,
      { self_bill_id: id });
    return { reverted: upd.rowCount, booked: Boolean(s.eb_mutation_id) };
  });
  res.json(out);
}));

/* ---------- zzp'er: eigen facturen, akkoord of bezwaar ---------- */

r.get('/mine', ah(async (req, res) => {
  res.json((await query(LIST_SQL('s.user_id = $1'), [req.user.id])).rows);
}));

async function ownBill(req) {
  const id = intParam(req.params.id, 'factuur');
  const s = (await query('SELECT * FROM self_bills WHERE id = $1', [id])).rows[0];
  if (!s || s.user_id !== req.user.id) throw new HttpError(404, 'Factuur niet gevonden');
  if (s.reverted_at) throw new HttpError(400, 'Deze factuur is ingetrokken');
  return s;
}

r.post('/:id/accept', ah(async (req, res) => {
  const s = await ownBill(req);
  await query(`UPDATE self_bills SET status = 'accepted', status_at = now(), dispute_reason = NULL WHERE id = $1`, [s.id]);
  await audit(null, req.user.id, 'selfbill.accept', `${req.user.name} gaf akkoord op zelffactuur ${s.number}`, { self_bill_id: s.id });
  res.json({ ok: true });
}));

r.post('/:id/dispute', ah(async (req, res) => {
  const s = await ownBill(req);
  if (s.status === 'accepted') throw new HttpError(400, 'Je hebt al akkoord gegeven op deze factuur. Neem contact op als er iets niet klopt.');
  const reason = str(req.body.reason, { name: 'Toelichting', max: 1000 });
  await query(`UPDATE self_bills SET status = 'disputed', status_at = now(), dispute_reason = $2 WHERE id = $1`, [s.id, reason]);
  await audit(null, req.user.id, 'selfbill.dispute', `${req.user.name} maakte bezwaar tegen zelffactuur ${s.number}: ${reason}`, { self_bill_id: s.id });
  res.json({ ok: true });
}));

/* ---------- Factuurdocument (afdrukken of opslaan als pdf) ---------- */

const h = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const euro = (n) => `€ ${(round2(Number(n) || 0)).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const uur = (n) => String(round2(Number(n) || 0)).replace('.', ',');

function documentHtml(s) {
  const sp = s.snapshot.supplier;
  const cu = s.snapshot.customer;
  const addr = (x) => [x.address, [x.postal_code, x.city].filter(Boolean).join(' ')].filter(Boolean).map(h).join('<br>');
  const due = new Date(`${s.bill_date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + Number(s.snapshot.payment_term || 30));
  const vatLine = s.vat_mode === 'hoog' ? `Btw ${uur(s.vat_rate)}%` : h(s.snapshot.vat_label);
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factuur ${h(s.number)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #17212B; margin: 0; background: #EEF1F4; font-size: 14px; line-height: 1.45; }
  .page { max-width: 800px; margin: 24px auto; background: #fff; padding: 48px 56px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  .bar { max-width: 800px; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .bar button { font: inherit; padding: 8px 16px; border: 1px solid #0F5E7A; background: #0F5E7A; color: #fff; border-radius: 4px; cursor: pointer; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.01em; }
  .tag { display: inline-block; margin-top: 6px; padding: 2px 10px; border-radius: 99px; background: #DCEBF0; color: #0F5E7A; font-weight: 600; font-size: 12px; }
  .void { display: inline-block; margin-top: 6px; margin-left: 6px; padding: 2px 10px; border-radius: 99px; background: #F6DCD6; color: #B3412E; font-weight: 700; font-size: 12px; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin: 32px 0 24px; }
  .parties h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5B6773; margin: 0 0 6px; }
  .meta { display: grid; grid-template-columns: repeat(4, auto); gap: 4px 24px; justify-content: start; margin-bottom: 24px; }
  .meta dt { color: #5B6773; font-size: 12px; } .meta dd { margin: 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #E6EAEE; vertical-align: top; }
  th { font-size: 12px; color: #5B6773; font-weight: 600; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 300px; margin-top: 12px; }
  .totals td { border: 0; padding: 4px 6px; } .totals tr.grand td { border-top: 2px solid #17212B; font-weight: 700; font-size: 16px; padding-top: 8px; }
  .note { margin-top: 28px; padding: 12px 14px; background: #EEF1F4; border-radius: 6px; font-size: 13px; }
  .spec { margin-top: 36px; } .spec h2 { font-size: 15px; } .spec td, .spec th { font-size: 12px; padding: 5px 6px; }
  @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; padding: 0; max-width: none; } .bar { display: none; } }
  @media (max-width: 640px) { .page { padding: 24px 18px; margin: 0; } .parties { grid-template-columns: 1fr; gap: 16px; } .meta { grid-template-columns: auto auto; } .totals { width: 100%; } }
</style></head><body>
<div class="bar"><button type="button" data-print>Afdrukken of opslaan als pdf</button></div>
<main class="page">
  <h1>Factuur</h1>
  <span class="tag">Factuur uitgereikt door afnemer</span>${s.reverted_at ? '<span class="void">INGETROKKEN</span>' : ''}
  <div class="parties">
    <section><h2>Leverancier</h2><strong>${h(sp.name)}</strong><br>${sp.contact && sp.contact !== sp.name ? `${h(sp.contact)}<br>` : ''}${addr(sp)}
      ${sp.kvk ? `<br>KvK ${h(sp.kvk)}` : ''}${sp.vat_number ? `<br>Btw-nummer ${h(sp.vat_number)}` : ''}</section>
    <section><h2>Afnemer</h2><strong>${h(cu.name)}</strong><br>${addr(cu)}
      ${cu.kvk ? `<br>KvK ${h(cu.kvk)}` : ''}${cu.vat_number ? `<br>Btw-nummer ${h(cu.vat_number)}` : ''}</section>
  </div>
  <dl class="meta">
    <dt>Factuurnummer</dt><dt>Factuurdatum</dt><dt>Periode</dt><dt>Vervaldatum</dt>
    <dd>${h(s.number)}</dd><dd>${fmtDateNl(s.bill_date)}</dd><dd>${fmtDateNl(s.period_from)} t/m ${fmtDateNl(s.period_to)}</dd><dd>${fmtDateNl(due.toISOString().slice(0, 10))}</dd>
  </dl>
  <table>
    <thead><tr><th>Omschrijving</th><th class="num">Uren</th><th class="num">Tarief</th><th class="num">Bedrag</th></tr></thead>
    <tbody>${s.snapshot.lines.map((l) => `<tr><td>${h(l.description)}</td><td class="num">${uur(l.hours)}</td><td class="num">${euro(l.rate)}</td><td class="num">${euro(l.amount)}</td></tr>`).join('')}</tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotaal</td><td class="num">${euro(s.total_excl)}</td></tr>
    <tr><td>${vatLine}</td><td class="num">${euro(s.vat_amount)}</td></tr>
    <tr class="grand"><td>Totaal</td><td class="num">${euro(s.total_incl)}</td></tr>
  </table>
  <div class="note">
    ${s.vat_mode === 'kor' ? 'De leverancier maakt gebruik van de kleineondernemersregeling; er is geen btw berekend.<br>' : ''}
    ${s.vat_mode === 'verlegd' ? 'Btw verlegd naar de afnemer.<br>' : ''}
    Deze factuur is opgemaakt en uitgereikt door ${h(cu.name)} namens ${h(sp.name)}, op grond van de afspraak over zelffacturering${sp.agreement_date ? ` van ${fmtDateNl(sp.agreement_date)}` : ''}.
    ${sp.iban ? `<br>Het totaalbedrag wordt uiterlijk ${fmtDateNl(due.toISOString().slice(0, 10))} overgemaakt naar ${h(sp.iban)} t.n.v. ${h(sp.name)}.` : ''}
  </div>
  <section class="spec">
    <h2>Urenspecificatie</h2>
    <table><thead><tr><th>Datum</th><th>Project</th><th class="num">Uren</th><th>Omschrijving</th></tr></thead>
      <tbody>${(s.snapshot.entries || []).map((e) => `<tr><td>${fmtDateNl(e.date)}</td><td>${h(e.project)}${e.activity ? `, ${h(e.activity)}` : ''}</td><td class="num">${uur(e.hours)}</td><td>${h(e.description)}</td></tr>`).join('')}</tbody>
    </table>
  </section>
</main>
<script src="/print.js"></script>
</body></html>`;
}

r.get('/:id/document', ah(async (req, res) => {
  const id = intParam(req.params.id, 'factuur');
  const s = (await query('SELECT * FROM self_bills WHERE id = $1', [id])).rows[0];
  const allowed = s && (['admin', 'accountant'].includes(req.user.role) || s.user_id === req.user.id);
  if (!allowed) throw new HttpError(404, 'Factuur niet gevonden');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(documentHtml(s));
}));

module.exports = r;
module.exports.documentHtml = documentHtml;
