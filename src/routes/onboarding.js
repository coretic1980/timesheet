// Inhuur van zzp'ers: dossiers met intake, overeenkomst, documenten en praktijkchecks.
// Beheerders wijzigen; de accountant kan alles inzien maar niets wijzigen.
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { ah, HttpError, str, num, intParam } = require('../util');
const { audit } = require('../audit');
const O = require('../onboarding');

const { R } = O;
const r = express.Router();

const adminOnly = (req) => { if (req.user.role !== 'admin') throw new HttpError(403, 'Alleen voor beheerders'); };
const ROW_COLS = `d.id, d.user_id, d.status, d.data, d.invite_expires, d.invited_at, d.submitted_at, d.released_at,
  d.released_by, d.release_note, d.created_at, d.updated_at, (d.invite_hash IS NOT NULL AND d.invite_expires > now()) AS invite_active`;

async function getRow(id, db = null) {
  const run = db ? (s, p) => db.query(s, p) : query;
  const row = (await run(`SELECT ${ROW_COLS} FROM onboarding_dossiers d WHERE d.id = $1`, [id])).rows[0];
  if (!row) throw new HttpError(404, 'Dossier niet gevonden');
  return row;
}

async function userCtx(userId) {
  if (!userId) return { userId: null };
  const u = (await query(
    `SELECT u.id, u.name, u.email, u.role, u.active, c.user_id IS NOT NULL AS is_contractor, c.agreement_date
       FROM users u LEFT JOIN contractors c ON c.user_id = u.id WHERE u.id = $1`,
    [userId]
  )).rows[0];
  if (!u) return { userId: null };
  return { userId: u.id, isContractor: u.is_contractor && u.role === 'employee', agreementDate: u.agreement_date, user: u };
}

const dossierName = (row) => { const z = (row.data && row.data.zzp) || {}; return z.naam || z.bedrijf || `dossier ${row.id}`; };

// Samenvatting voor de lijst en de actiepunten (zelfde regels als in de browser).
function summarize(row, files = 0) {
  const d = R.normalize(row.data);
  const a = R.assess(d);
  const s = R.docCount(d, 'start');
  return {
    id: row.id, user_id: row.user_id, user_name: row.user_name || null, status: row.status,
    naam: d.zzp.naam, bedrijf: d.zzp.bedrijf, klant: d.opdracht.klant, start: d.opdracht.start, eind: d.opdracht.eind,
    verdict: a.verdict, docs_done: s.done, docs_total: s.total,
    next_check: row.status === 'actief' ? R.nextCheck(d) : null,
    actions: R.actions(d, row.status),
    invited_at: row.invited_at, invite_active: row.invite_active, submitted_at: row.submitted_at, released_at: row.released_at,
    files, updated_at: row.updated_at,
  };
}

/* ---------- lijst en instellingen ---------- */

r.get('/', ah(async (req, res) => {
  const rows = (await query(
    `SELECT ${ROW_COLS}, u.name AS user_name, (SELECT count(*)::int FROM onboarding_files f WHERE f.dossier_id = d.id) AS nfiles
       FROM onboarding_dossiers d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.updated_at DESC`
  )).rows;
  const settings = await O.getOnboardingSettings();
  // ingehuurde zzp'ers zonder enig dossier (bijvoorbeeld van vóór deze functie): zij kunnen geen uren schrijven
  const unmanaged = (await query(
    `SELECT u.id, u.name FROM contractors c JOIN users u ON u.id = c.user_id
      WHERE u.active AND NOT EXISTS (SELECT 1 FROM onboarding_dossiers d WHERE d.user_id = u.id AND d.status <> 'afgewezen')
      ORDER BY u.name`
  )).rows;
  res.json({ dossiers: rows.map((x) => summarize(x, x.nfiles)), enforce: settings.enforce, unmanaged });
}));

r.get('/meta', ah(async (req, res) => {
  const users = (await query(
    `SELECT u.id, u.name, u.email, u.active, c.user_id IS NOT NULL AS is_contractor, c.agreement_date,
            (SELECT d.id FROM onboarding_dossiers d WHERE d.user_id = u.id AND d.status = 'actief' LIMIT 1) AS active_dossier
       FROM users u LEFT JOIN contractors c ON c.user_id = u.id
      WHERE u.role = 'employee' ORDER BY u.active DESC, u.name`
  )).rows;
  res.json({ settings: await O.getOnboardingSettings(), users, can_edit: req.user.role === 'admin' });
}));

r.put('/settings', ah(async (req, res) => {
  adminOnly(req);
  const b = req.body || {};
  const before = await O.getOnboardingSettings();
  const s = {
    enforce: b.enforce !== false,
    og: b.og === 'cor' ? 'cor' : 'dvn',
    dvnKvk: str(b.dvnKvk, { name: 'KvK DVN Technology', max: 20, required: false }),
    corKvk: str(b.corKvk, { name: 'KvK Coretic', max: 20, required: false }),
    ogAdres: str(b.ogAdres, { name: 'Adres', max: 200, required: false }),
    ogPlaats: str(b.ogPlaats, { name: 'Plaats', max: 100, required: false }),
    ogRep: str(b.ogRep, { name: 'Vertegenwoordiger', max: 120, required: false }),
    betaal: String(num(b.betaal || 30, { min: 0, max: 120, name: 'betalingstermijn' })),
    opzeg: String(num(b.opzeg || 30, { min: 0, max: 365, name: 'opzegtermijn' })),
  };
  await O.setOnboardingSettings(s);
  if (before.enforce !== s.enforce) {
    await audit(null, req.user.id, 'onboarding.settings', s.enforce
      ? "Urenblokkade voor zzp'ers zonder vrijgegeven dossier aangezet"
      : "Urenblokkade voor zzp'ers zonder vrijgegeven dossier uitgezet");
  }
  res.json(s);
}));

/* ---------- dossiers ---------- */

r.post('/', ah(async (req, res) => {
  adminOnly(req);
  const d = R.emptyDossier();
  d.zzp.naam = str(req.body.naam, { name: 'Naam', max: 120 });
  d.zzp.email = str(req.body.email, { name: 'E-mail', max: 200, required: false }).toLowerCase();
  d.zzp.bedrijf = str(req.body.bedrijf, { name: 'Bedrijfsnaam', max: 200, required: false });
  d.intake.bron = 'Aangemaakt door Coretic';
  const userId = req.body.user_id ? intParam(req.body.user_id, 'gebruiker') : null;
  const { rows } = await query(
    `INSERT INTO onboarding_dossiers (user_id, data, created_by) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [userId, JSON.stringify(d), req.user.id]
  );
  await audit(null, req.user.id, 'onboarding.create', `Inhuurdossier aangemaakt voor ${d.zzp.naam}`, { dossier_id: rows[0].id });
  res.status(201).json({ id: rows[0].id });
}));

r.get('/:id', ah(async (req, res) => {
  const row = await getRow(intParam(req.params.id));
  const ctx = await userCtx(row.user_id);
  const files = await O.listFiles(row.id);
  res.json({ ...row, data: R.normalize(row.data), files, user: ctx.user || null });
}));

r.put('/:id', ah(async (req, res) => {
  adminOnly(req);
  const id = intParam(req.params.id);
  const body = req.body || {};
  if (!body.data || typeof body.data !== 'object') throw new HttpError(400, 'Geen dossiergegevens');
  const data = R.normalize(body.data);
  if (JSON.stringify(data).length > 300000) throw new HttpError(400, 'Het dossier is te groot');
  const out = await tx(async (db) => {
    const row = (await db.query('SELECT id, status, data, updated_at FROM onboarding_dossiers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new HttpError(404, 'Dossier niet gevonden');
    if (body.updated_at && new Date(body.updated_at).getTime() !== new Date(row.updated_at).getTime()) {
      const err = new HttpError(409, 'Het dossier is intussen gewijzigd, bijvoorbeeld door de zzp\'er via de intakelink. Herlaad de pagina.');
      err.code = 'STALE';
      throw err;
    }
    const prev = R.normalize(row.data);
    if (row.status === 'actief' && (prev.opdracht.start !== data.opdracht.start || prev.opdracht.eind !== data.opdracht.eind)) {
      await audit(db, req.user.id, 'onboarding.period', `Looptijd van vrijgegeven dossier ${data.zzp.naam || id} gewijzigd: ${prev.opdracht.start || '?'} t/m ${prev.opdracht.eind || '?'} → ${data.opdracht.start || '?'} t/m ${data.opdracht.eind || '?'}`, { dossier_id: id });
    }
    if (prev.checks.length < data.checks.length) {
      const c = data.checks[data.checks.length - 1];
      await audit(db, req.user.id, 'onboarding.check', `Praktijkcheck vastgelegd voor ${data.zzp.naam || id}: ${R.LBL[c.uitkomst] || c.uitkomst}`, { dossier_id: id });
    }
    return (await db.query('UPDATE onboarding_dossiers SET data = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING updated_at', [JSON.stringify(data), id])).rows[0];
  });
  res.json(out);
}));

r.delete('/:id', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  if (row.status === 'actief') throw new HttpError(400, 'Zet het dossier eerst op Afgerond of Niet doorgegaan');
  await query('DELETE FROM onboarding_dossiers WHERE id = $1', [row.id]);
  await audit(null, req.user.id, 'onboarding.delete', `Inhuurdossier ${dossierName(row)} verwijderd`, { dossier_id: row.id });
  res.json({ ok: true });
}));

const STATUS_TARGETS = ['intake', 'contract', 'afgerond', 'afgewezen'];
r.post('/:id/status', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  const to = req.body.status;
  if (!STATUS_TARGETS.includes(to)) throw new HttpError(400, 'Gebruik Vrijgeven om een dossier actief te maken');
  await query('UPDATE onboarding_dossiers SET status = $1, updated_at = now() WHERE id = $2', [to, row.id]);
  const msg = row.status === 'actief'
    ? `Inhuurdossier ${dossierName(row)} op ${R.STATUS[to]} gezet; uren schrijven is niet meer mogelijk`
    : `Inhuurdossier ${dossierName(row)}: ${R.STATUS[row.status]} → ${R.STATUS[to]}`;
  await audit(null, req.user.id, 'onboarding.status', msg, { dossier_id: row.id, from: row.status, to });
  res.json({ ok: true });
}));

// Vrijgeven voor urenregistratie. De server controleert dezelfde voorwaarden als het scherm.
r.post('/:id/release', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  if (row.status === 'actief') throw new HttpError(400, 'Dit dossier is al vrijgegeven');
  if (['afgerond', 'afgewezen'].includes(row.status)) throw new HttpError(400, 'Zet het dossier eerst terug op Contract');
  const d = R.normalize(row.data);
  const p = R.releaseProblems(d, await userCtx(row.user_id));
  if (p.hard.length) return res.status(400).json({ error: 'Het dossier is nog niet compleet', problems: p.hard, soft: p.soft });
  const note = str(req.body.note, { name: 'Motivering', max: 1000, required: false });
  if (p.soft.length && note.length < 15) {
    return res.status(409).json({ error: 'Leg vast waarom je ondanks de waarschuwingen vrijgeeft', code: 'NEEDS_NOTE', soft: p.soft });
  }
  await query(
    `UPDATE onboarding_dossiers SET status = 'actief', released_at = now(), released_by = $1, release_note = $2, updated_at = now() WHERE id = $3`,
    [req.user.id, note || null, row.id]
  );
  await audit(null, req.user.id, 'onboarding.release',
    `${dossierName(row)} vrijgegeven voor urenregistratie (${d.opdracht.start} t/m ${d.opdracht.eind})${p.soft.length ? `, ondanks: ${p.soft.join(' ')} Motivering: ${note}` : ''}`,
    { dossier_id: row.id, user_id: row.user_id });
  res.json({ ok: true });
}));

/* ---------- intakelink ---------- */

r.post('/:id/invite', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  if (['afgerond', 'afgewezen'].includes(row.status)) throw new HttpError(400, 'Dit dossier is afgesloten');
  const { token, hash } = O.newInviteToken();
  const { rows } = await query(
    `UPDATE onboarding_dossiers SET invite_hash = $1, invite_expires = now() + ($2::int * interval '1 day'),
            invited_at = now(), updated_at = now() WHERE id = $3 RETURNING invite_expires`,
    [hash, O.INVITE_DAYS, row.id]
  );
  await audit(null, req.user.id, 'onboarding.invite', `Intakelink gemaakt voor ${dossierName(row)}`, { dossier_id: row.id });
  res.json({ url: `${req.protocol}://${req.get('host')}/intake/${token}`, expires: rows[0].invite_expires });
}));

r.delete('/:id/invite', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  await query('UPDATE onboarding_dossiers SET invite_hash = NULL, invite_expires = NULL, updated_at = now() WHERE id = $1', [row.id]);
  await audit(null, req.user.id, 'onboarding.invite', `Intakelink ingetrokken voor ${dossierName(row)}`, { dossier_id: row.id });
  res.json({ ok: true });
}));

r.post('/:id/reopen', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  await query('UPDATE onboarding_dossiers SET submitted_at = NULL, updated_at = now() WHERE id = $1', [row.id]);
  res.json({ ok: true });
}));

/* ---------- account en zzp-gegevens ---------- */

r.post('/:id/link', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  const userId = req.body.user_id ? intParam(req.body.user_id, 'gebruiker') : null;
  if (row.status === 'actief') throw new HttpError(400, 'Een vrijgegeven dossier kun je niet aan iemand anders koppelen');
  if (userId) {
    const u = (await query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
    if (!u) throw new HttpError(404, 'Gebruiker niet gevonden');
    if (u.role !== 'employee') throw new HttpError(400, 'Koppel een medewerker-account, geen beheerder of accountant');
  }
  await query('UPDATE onboarding_dossiers SET user_id = $1, updated_at = now() WHERE id = $2', [userId, row.id]);
  res.json({ ok: true });
}));

// Leveranciersgegevens voor de zelffactuur vullen vanuit het dossier.
async function syncContractor(db, userId, d, actorId) {
  const z = d.zzp;
  const company = (z.bedrijf || z.naam || '').trim();
  if (!company) throw new HttpError(400, 'Vul eerst de bedrijfsnaam in');
  let address = z.adres || null;
  let postal = null;
  let city = null;
  const m = String(z.adres || '').match(/^(.*?)[,\s]+(\d{4}\s?[A-Za-z]{2})\s+(.+)$/);
  if (m) { address = m[1].trim(); postal = m[2].toUpperCase().replace(/^(\d{4})([A-Z]{2})$/, '$1 $2'); city = m[3].trim(); }
  const rate = Number(String(d.opdracht.tarief).replace(',', '.'));
  const zf = d.docs.zelffacturering;
  const agreement = zf && ['ok'].includes(zf.s) && R.isIso(zf.d) ? zf.d : null;
  const before = (await db.query('SELECT * FROM contractors WHERE user_id = $1', [userId])).rows[0];
  const f = {
    company_name: company.slice(0, 200),
    address: address ? address.slice(0, 200) : (before && before.address) || null,
    postal_code: postal || (before && before.postal_code) || null,
    city: city ? city.slice(0, 100) : (before && before.city) || null,
    kvk: z.kvk || (before && before.kvk) || null,
    vat_number: z.btw || (before && before.vat_number) || null,
    vat_mode: d.intake.answers.kor === 1 ? 'kor' : ((before && before.vat_mode) || 'hoog'),
    default_cost_rate: (before && before.default_cost_rate != null) ? before.default_cost_rate : (Number.isFinite(rate) && rate > 0 ? rate : null),
    agreement_date: (before && before.agreement_date) || agreement,
    payment_term: Number(d.contract.betaal) || (before && before.payment_term) || 30,
  };
  const cols = Object.keys(f);
  await db.query(
    `INSERT INTO contractors (user_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (user_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
    [userId, ...cols.map((c) => f[c])]
  );
  await audit(db, actorId, 'contractor.update', `zzp-gegevens van ${company} overgenomen uit het inhuurdossier${before ? '' : ' (nieuw als ingehuurde zzp\'er)'}`, { user_id: userId });
}

r.post('/:id/sync-contractor', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  if (!row.user_id) throw new HttpError(400, 'Koppel het dossier eerst aan een gebruiker');
  const u = (await query('SELECT role FROM users WHERE id = $1', [row.user_id])).rows[0];
  if (!u || u.role !== 'employee') throw new HttpError(400, 'De gekoppelde gebruiker moet een medewerker zijn');
  await tx((db) => syncContractor(db, row.user_id, R.normalize(row.data), req.user.id));
  res.json({ ok: true });
}));

// Account voor de zzp'er aanmaken, als ingehuurde zzp'er instellen en aan het dossier koppelen.
r.post('/:id/account', ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  if (row.user_id) throw new HttpError(400, 'Dit dossier is al aan een gebruiker gekoppeld');
  const email = str(req.body.email, { name: 'E-mail', max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Ongeldig e-mailadres');
  const name = str(req.body.name, { name: 'Naam', max: 120 });
  const pw = String(req.body.password || '');
  if (pw.length < 10) throw new HttpError(400, 'Wachtwoord moet minstens 10 tekens zijn');
  const hash = await bcrypt.hash(pw, 12);
  const d = R.normalize(row.data);
  const userId = await tx(async (db) => {
    let id;
    try {
      id = (await db.query(
        `INSERT INTO users (email, name, password_hash, role, weekly_hours) VALUES ($1, $2, $3, 'employee', 0) RETURNING id`,
        [email, name, hash]
      )).rows[0].id;
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'Dit e-mailadres is al in gebruik. Koppel het bestaande account.');
      throw err;
    }
    await audit(db, req.user.id, 'user.create', `Gebruiker ${name} (${email}) aangemaakt als medewerker vanuit het inhuurdossier`, { user_id: id });
    await db.query('UPDATE onboarding_dossiers SET user_id = $1, updated_at = now() WHERE id = $2', [id, row.id]);
    await syncContractor(db, id, d, req.user.id);
    return id;
  });
  res.status(201).json({ user_id: userId });
}));

/* ---------- documenten en bestanden ---------- */

r.get('/:id/contract', ah(async (req, res) => {
  const row = await getRow(intParam(req.params.id));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(O.contractPage(row, await O.getOnboardingSettings()));
}));

r.get('/:id/document', ah(async (req, res) => {
  const row = await getRow(intParam(req.params.id));
  const ctx = await userCtx(row.user_id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(O.dossierPage(row, await O.getOnboardingSettings(), await O.listFiles(row.id), ctx.user && ctx.user.name));
}));

r.get('/:id/files/:fid', ah(async (req, res) => {
  const f = (await query('SELECT * FROM onboarding_files WHERE id = $1 AND dossier_id = $2', [intParam(req.params.fid), intParam(req.params.id)])).rows[0];
  if (!f) throw new HttpError(404, 'Bestand niet gevonden');
  O.sendFile(res, f);
}));

r.post('/:id/files', express.raw({ type: () => true, limit: O.MAX_FILE + 1024 }), ah(async (req, res) => {
  adminOnly(req);
  const row = await getRow(intParam(req.params.id));
  const f = await O.storeFile(row.id, String(req.query.doc || ''), req.body, req.get('x-filename'), req.user.id);
  const u = (await query('UPDATE onboarding_dossiers SET updated_at = now() WHERE id = $1 RETURNING updated_at', [row.id])).rows[0];
  await audit(null, req.user.id, 'onboarding.file', `Bestand ${f.filename} toegevoegd aan inhuurdossier ${dossierName(row)}`, { dossier_id: row.id, doc: f.doc_key });
  res.status(201).json({ ...f, updated_at: u.updated_at });
}));

r.delete('/:id/files/:fid', ah(async (req, res) => {
  adminOnly(req);
  const id = intParam(req.params.id);
  const f = (await query('DELETE FROM onboarding_files WHERE id = $1 AND dossier_id = $2 RETURNING filename, doc_key', [intParam(req.params.fid), id])).rows[0];
  if (!f) throw new HttpError(404, 'Bestand niet gevonden');
  const u = (await query('UPDATE onboarding_dossiers SET updated_at = now() WHERE id = $1 RETURNING updated_at', [id])).rows[0];
  await audit(null, req.user.id, 'onboarding.file', `Bestand ${f.filename} verwijderd uit inhuurdossier ${id}`, { dossier_id: id, doc: f.doc_key });
  res.json({ ok: true, updated_at: u.updated_at });
}));

module.exports = r;
