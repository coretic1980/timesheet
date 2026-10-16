// Publieke intake voor een zzp'er, bereikbaar via de persoonlijke intakelink (zonder account).
// De zzp'er ziet en wijzigt alleen zijn eigen gegevens, antwoorden en documenten; geen notities of risico-indicatie.
const express = require('express');
const { query } = require('../db');
const { ah, HttpError, str, intParam } = require('../util');
const { audit } = require('../audit');
const O = require('../onboarding');

const { R } = O;
const r = express.Router();

// Rem per IP, los van het inloggen.
const hits = new Map();
const WINDOW = 15 * 60 * 1000;
r.use((req, res, next) => {
  const now = Date.now();
  const a = hits.get(req.ip);
  if (!a || a.reset < now) hits.set(req.ip, { count: 1, reset: now + WINDOW });
  else if (++a.count > 300) return next(new HttpError(429, 'Te veel verzoeken. Probeer het over een kwartier opnieuw.'));
  if (hits.size > 5000) for (const [ip, x] of hits) if (x.reset < now) hits.delete(ip);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
});

function publicView(row, files) {
  const d = R.normalize(row.data);
  return {
    status: row.status,
    submitted_at: row.submitted_at,
    expires: row.invite_expires,
    zzp: d.zzp,
    opdracht: { resultaat: d.opdracht.resultaat, klant: d.opdracht.klant, start: d.opdracht.start, eind: d.opdracht.eind, uren: d.opdracht.uren, tarief: d.opdracht.tarief },
    intake: { answers: d.intake.answers, akkoord: d.intake.akkoord, plaats: d.intake.plaats, datum: d.intake.datum },
    docs: R.uploadableByZzp(d).map((x) => ({ k: x.k, t: x.t, why: x.why, req: !!x.req, exp: !!x.exp, state: R.docState(x, d) })),
    files: files.map((f) => ({ id: f.id, doc_key: f.doc_key, filename: f.filename, size: f.size, uploaded_at: f.uploaded_at, mine: f.uploaded_by === null })),
  };
}

r.get('/:token', ah(async (req, res) => {
  const row = await O.dossierByToken(req.params.token);
  res.json(publicView(row, await O.listFiles(row.id)));
}));

const ZZP_FIELDS = { naam: 120, bedrijf: 200, kvk: 20, kvkDatum: 10, btw: 30, web: 200, email: 200, tel: 40, adres: 300 };

r.put('/:token', ah(async (req, res) => {
  const row = await O.dossierByToken(req.params.token);
  if (row.submitted_at) throw new HttpError(409, 'Je intake is al ingediend. Wil je iets wijzigen? Neem contact op met Coretic.');
  const b = req.body || {};
  const d = R.normalize(row.data);
  const z = b.zzp || {};
  for (const [k, max] of Object.entries(ZZP_FIELDS)) if (z[k] !== undefined) d.zzp[k] = str(z[k], { name: k, max, required: false });
  if (d.zzp.kvkDatum && !R.isIso(d.zzp.kvkDatum)) d.zzp.kvkDatum = '';
  const o = b.opdracht || {};
  if (o.resultaat !== undefined) d.opdracht.resultaat = str(o.resultaat, { name: 'Resultaat', max: 4000, required: false });
  if (o.uren !== undefined) d.opdracht.uren = str(o.uren, { name: 'Uren', max: 10, required: false }).replace(/[^\d.,]/g, '');
  if (o.tarief !== undefined) d.opdracht.tarief = str(o.tarief, { name: 'Tarief', max: 10, required: false }).replace(',', '.').replace(/[^\d.]/g, '');
  const i = b.intake || {};
  if (i.answers && typeof i.answers === 'object') {
    for (const q of R.ALLQ) {
      const v = i.answers[q.id];
      if (Number.isInteger(v) && v >= 0 && v < q.o.length) d.intake.answers[q.id] = v;
    }
  }
  if (i.akkoord !== undefined) d.intake.akkoord = i.akkoord === true;
  if (i.plaats !== undefined) d.intake.plaats = str(i.plaats, { name: 'Plaats', max: 100, required: false });
  if (i.datum !== undefined) d.intake.datum = R.isIso(i.datum) ? i.datum : '';

  let submit = false;
  if (b.submit) {
    const missing = [];
    if (!d.zzp.naam) missing.push('naam');
    if (!d.zzp.bedrijf) missing.push('bedrijfsnaam');
    if (!/^\d{8}$/.test(d.zzp.kvk)) missing.push('KvK-nummer (8 cijfers)');
    if (!d.zzp.btw && d.intake.answers.kor !== 1 && d.intake.answers.rechtsvorm !== 1) missing.push('btw-identificatienummer');
    if (!d.zzp.adres) missing.push('adres');
    if (!d.zzp.email) missing.push('e-mailadres');
    if (!(+d.opdracht.tarief > 0)) missing.push('uurtarief');
    const open = R.ALLQ.filter((q) => d.intake.answers[q.id] == null).length;
    if (open) missing.push(`${open} ${open === 1 ? 'vraag' : 'vragen'}`);
    if (!d.intake.plaats || !d.intake.datum) missing.push('plaats en datum');
    if (!d.intake.akkoord) missing.push('de verklaring');
    if (missing.length) throw new HttpError(400, `Nog niet compleet: ${missing.join(', ')}.`);
    d.intake.bron = `Ingevuld door de zzp'er via de intakelink, ingediend op ${R.fmtShort(R.todayIso())}`;
    submit = true;
  }
  const { rows } = await query(
    `UPDATE onboarding_dossiers SET data = $1::jsonb, updated_at = now()${submit ? ', submitted_at = now()' : ''}
      WHERE id = $2 AND submitted_at IS NULL RETURNING *`,
    [JSON.stringify(d), row.id]
  );
  if (!rows[0]) throw new HttpError(409, 'Je intake is al ingediend.');
  if (submit) await audit(null, null, 'onboarding.submit', `Intake ingediend door ${d.zzp.naam} (${d.zzp.bedrijf}) via de intakelink`, { dossier_id: row.id });
  res.json(publicView(rows[0], await O.listFiles(row.id)));
}));

r.post('/:token/files', express.raw({ type: () => true, limit: O.MAX_FILE + 1024 }), ah(async (req, res) => {
  const row = await O.dossierByToken(req.params.token);
  const d = R.normalize(row.data);
  const key = String(req.query.doc || '');
  if (!R.uploadableByZzp(d).some((x) => x.k === key)) throw new HttpError(400, 'Dit document kun je hier niet aanleveren');
  await O.storeFile(row.id, key, req.body, req.get('x-filename'), null);
  const cur = d.docs[key] || {};
  if (!cur.s) d.docs[key] = { ...cur, s: 'gemeld', d: R.todayIso() };
  const { rows } = await query('UPDATE onboarding_dossiers SET data = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING *', [JSON.stringify(d), row.id]);
  res.status(201).json(publicView(rows[0], await O.listFiles(row.id)));
}));

r.delete('/:token/files/:fid', ah(async (req, res) => {
  const row = await O.dossierByToken(req.params.token);
  const d = R.normalize(row.data);
  const f = (await query('SELECT id, doc_key FROM onboarding_files WHERE id = $1 AND dossier_id = $2 AND uploaded_by IS NULL', [intParam(req.params.fid), row.id])).rows[0];
  if (!f) throw new HttpError(404, 'Bestand niet gevonden');
  if (d.docs[f.doc_key] && d.docs[f.doc_key].s === 'ok') throw new HttpError(400, 'Coretic heeft dit document al gecontroleerd. Neem contact op als het moet worden vervangen.');
  await query('DELETE FROM onboarding_files WHERE id = $1', [f.id]);
  const left = (await query('SELECT 1 FROM onboarding_files WHERE dossier_id = $1 AND doc_key = $2', [row.id, f.doc_key])).rowCount;
  if (!left && d.docs[f.doc_key] && d.docs[f.doc_key].s === 'gemeld') d.docs[f.doc_key].s = '';
  const { rows } = await query('UPDATE onboarding_dossiers SET data = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING *', [JSON.stringify(d), row.id]);
  res.json(publicView(rows[0], await O.listFiles(row.id)));
}));

module.exports = r;
