// Inhuur van zzp'ers: instellingen, urenblokkade, intakelinks, bestanden en printbare documenten.
const crypto = require('crypto');
const { query, getSelfBillSettings } = require('./db');
const { HttpError } = require('./util');
const R = require('../public/onboarding-rules');

/* ---------- instellingen ---------- */

const ONB_DEFAULTS = {
  enforce: true,     // zzp'ers zonder vrijgegeven dossier kunnen geen uren schrijven
  og: 'dvn',         // contracterende partij: dvn = DVN Technology B.V. h.o.d.n. Coretic, cor = Coretic B.V.
  dvnKvk: '99083523',          // DVN Technology B.V.
  dvnBtw: 'NL868787255B01',
  corBtw: '',
  corKvk: '',
  ogAdres: '',
  ogPlaats: '',
  ogRep: '',
  betaal: '30',
  opzeg: '30',
};

async function getOnboardingSettings() {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'onboarding'`);
  const s = { ...ONB_DEFAULTS, ...(rows[0] ? rows[0].value : {}) };
  for (const k of ['dvnKvk', 'dvnBtw']) if (!s[k]) s[k] = ONB_DEFAULTS[k];
  // Lege velden aanvullen met de bedrijfsgegevens uit de zelffacturering.
  if (!s.dvnKvk || !s.ogAdres || !s.ogPlaats) {
    const sb = await getSelfBillSettings();
    if (!s.dvnKvk && sb.companyKvk) s.dvnKvk = sb.companyKvk;
    if (!s.ogAdres && sb.companyAddress) s.ogAdres = [sb.companyAddress, sb.companyPostalCode].filter(Boolean).join(', ');
    if (!s.ogPlaats && sb.companyCity) s.ogPlaats = sb.companyCity;
  }
  return s;
}

async function setOnboardingSettings(value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ('onboarding', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)]
  );
}

/* ---------- urenblokkade ---------- */

// Mag deze gebruiker uren schrijven, en in welke periodes?
// Alleen ingehuurde zzp'ers worden gecontroleerd; medewerkers en beheerders niet.
async function hoursAccess(userId) {
  const isContractor = (await query('SELECT 1 FROM contractors WHERE user_id = $1', [userId])).rowCount > 0;
  if (!isContractor) return { required: false, periods: [] };
  const s = await getOnboardingSettings();
  if (!s.enforce) return { required: false, periods: [] };
  const { rows } = await query(
    `SELECT id, data->'opdracht'->>'start' AS start, data->'opdracht'->>'eind' AS eind, data->'toewijzing' AS toewijzing
       FROM onboarding_dossiers WHERE user_id = $1 AND status = 'actief' ORDER BY data->'opdracht'->>'start'`,
    [userId]
  );
  const finished = rows.length ? false
    : (await query(`SELECT 1 FROM onboarding_dossiers WHERE user_id = $1 AND status = 'afgerond' LIMIT 1`, [userId])).rowCount > 0;
  return {
    required: true,
    finished,
    periods: rows.map((r) => ({
      start: R.isIso(r.start) ? r.start : null,
      eind: R.isIso(r.eind) ? r.eind : null,
      // Lege toewijzing (dossiers van vóór deze functie): alle projecten uit het team.
      projects: R.normalizeAssignments(r.toewijzing),
    })),
  };
}

const inPeriod = (p, date) => (!p.start || date >= p.start) && (!p.eind || date <= p.eind);
const allowedOn = (access, date) => !access.required || access.periods.some((p) => inPeriod(p, date));

// Mag op dit project en deze activiteit worden geschreven binnen deze periode?
function coversWork(p, projectId, activityId) {
  if (!p.projects.length) return true;
  const a = p.projects.find((x) => x.project_id === projectId);
  if (!a) return false;
  return !a.activity_ids.length || (activityId != null && a.activity_ids.includes(activityId));
}
const allowedWork = (access, date, projectId, activityId) => !access.required
  || access.periods.some((p) => inPeriod(p, date) && coversWork(p, projectId, activityId));

// Projecten en activiteiten die de zzp'er in een periode mag zien: Map project_id -> Set(activity) of 'all'.
function scopeFor(access, from, to) {
  if (!access.required) return null;
  const m = new Map();
  for (const p of access.periods) {
    if ((p.start && p.start > to) || (p.eind && p.eind < from)) continue;
    if (!p.projects.length) return null;
    for (const x of p.projects) {
      const cur = m.get(x.project_id);
      if (cur === 'all' || !x.activity_ids.length) m.set(x.project_id, 'all');
      else m.set(x.project_id, new Set([...(cur || []), ...x.activity_ids]));
    }
  }
  return m;
}

function gateMessage(access, date) {
  if (!access.periods.length) {
    return access.finished
      ? 'Je opdracht is afgerond, dus je kunt geen uren meer schrijven. Voor nieuw werk maakt Coretic eerst een nieuwe opdracht met je af.'
      : 'Je kunt nog geen uren schrijven: je onboarding bij Coretic is nog niet afgerond. Neem contact op met Coretic.';
  }
  if (allowedOn(access, date)) return 'Dit project of deze activiteit hoort niet bij je opdracht. Neem contact op met Coretic als dat wel zo zou moeten zijn.';
  const list = access.periods.map((p) => `${p.start ? R.fmtShort(p.start) : 'start'} t/m ${p.eind ? R.fmtShort(p.eind) : 'einde'}`).join(', ');
  return `Op ${R.fmtShort(date)} kun je geen uren schrijven: die datum valt buiten de looptijd van je opdracht (${list}).`;
}

async function assertHoursAllowed(userId, date, projectId = null, activityId = null) {
  const access = await hoursAccess(userId);
  const ok = projectId == null ? allowedOn(access, date) : allowedWork(access, date, projectId, activityId);
  if (!ok) {
    const err = new HttpError(403, gateMessage(access, date));
    err.code = 'ONBOARDING_REQUIRED';
    throw err;
  }
}

// Teams van projecten gelijktrekken met de vrijgegeven dossiers van deze gebruiker:
// projecten uit een vrijgegeven dossier krijgen de zzp'er in het team, projecten die alleen
// in niet-actieve dossiers staan gaan eruit. Handmatig toegevoegde projecten blijven staan.
// previous: projecten die net uit een dossier zijn gehaald (die tellen nog als beheerd door de inhuur).
async function syncAssignments(db, userId, previous = []) {
  if (!userId) return { added: [], removed: [] };
  const { rows } = await db.query(`SELECT status, data->'toewijzing' AS t FROM onboarding_dossiers WHERE user_id = $1`, [userId]);
  const active = new Set();
  const managed = new Set(previous);
  for (const r of rows) {
    for (const x of R.normalizeAssignments(r.t)) {
      managed.add(x.project_id);
      if (r.status === 'actief') active.add(x.project_id);
    }
  }
  const current = new Set((await db.query('SELECT project_id FROM assignments WHERE user_id = $1', [userId])).rows.map((x) => x.project_id));
  const added = [...active].filter((p) => !current.has(p));
  const removed = [...managed].filter((p) => !active.has(p) && current.has(p));
  for (const p of added) await db.query('INSERT INTO assignments (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p, userId]);
  if (removed.length) await db.query('DELETE FROM assignments WHERE user_id = $1 AND project_id = ANY($2)', [userId, removed]);
  return { added, removed };
}

/* ---------- intakelinks ---------- */

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{30,64}$/;
const INVITE_DAYS = 30;

function newInviteToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token) };
}

async function dossierByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new HttpError(404, 'Deze link is ongeldig of verlopen');
  const { rows } = await query(
    `SELECT * FROM onboarding_dossiers WHERE invite_hash = $1 AND invite_expires > now()
        AND status NOT IN ('afgerond', 'afgewezen')`,
    [hashToken(token)]
  );
  if (!rows[0]) throw new HttpError(404, 'Deze link is ongeldig of verlopen. Vraag Coretic om een nieuwe link.');
  return rows[0];
}

/* ---------- bestanden ---------- */

const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES_PER_DOSSIER = 60;

// Alleen pdf, png en jpg; het type wordt bepaald op de inhoud, niet op de naam.
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

function cleanFilename(raw, ext) {
  let name = '';
  try { name = decodeURIComponent(String(raw || '')); } catch { name = String(raw || ''); }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) name = `document.${ext}`;
  if (!new RegExp(`\\.${ext === 'jpg' ? 'jpe?g' : ext}$`, 'i').test(name)) name = `${name.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.${ext}`;
  return name.slice(-120);
}

async function storeFile(dossierId, docKey, body, rawName, uploadedBy) {
  if (!R.DOC_KEYS.includes(docKey)) throw new HttpError(400, 'Onbekend document');
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Geen bestand ontvangen');
  if (body.length > MAX_FILE) throw new HttpError(413, 'Bestand is groter dan 5 MB');
  const type = sniff(body);
  if (!type) throw new HttpError(415, 'Alleen pdf, png of jpg');
  const n = (await query('SELECT count(*)::int AS n FROM onboarding_files WHERE dossier_id = $1', [dossierId])).rows[0].n;
  if (n >= MAX_FILES_PER_DOSSIER) throw new HttpError(400, 'Er zitten al te veel bestanden in dit dossier');
  const filename = cleanFilename(rawName, type.ext);
  const { rows } = await query(
    `INSERT INTO onboarding_files (dossier_id, doc_key, filename, mime, size, content, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, doc_key, filename, mime, size, uploaded_by, uploaded_at`,
    [dossierId, docKey, filename, type.mime, body.length, body, uploadedBy || null]
  );
  return rows[0];
}

async function listFiles(dossierId) {
  return (await query(
    `SELECT id, doc_key, filename, mime, size, uploaded_by, uploaded_at FROM onboarding_files
      WHERE dossier_id = $1 ORDER BY uploaded_at`,
    [dossierId]
  )).rows;
}

function sendFile(res, f) {
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', f.size);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'no-store');
  res.end(f.content);
}

/* ---------- printbare documenten ---------- */

const DOC_CSS = `
  body { font-family: Georgia, 'Times New Roman', serif; color: #001D45; margin: 0; background: #F3F5F9; font-size: 15px; line-height: 1.6; }
  .page { max-width: 800px; margin: 24px auto; background: #fff; padding: 48px 56px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  .bar { max-width: 800px; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; font-family: system-ui, sans-serif; }
  .bar button { font: inherit; padding: 8px 16px; border: 1px solid #001D45; background: #001D45; color: #fff; border-radius: 4px; cursor: pointer; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font: 600 14px system-ui, sans-serif; margin: 28px 0 8px; border-bottom: 1px solid #CDD5E1; padding-bottom: 4px; }
  h3 { font-size: 15px; margin: 20px 0 6px; } p, li { margin: 0 0 6px; } ol { padding-left: 22px; }
  .psub, .m { color: #4A5872; font-size: 13px; } mark { background: #FFE6C7; color: #001D45; padding: 0 3px; }
  table { width: 100%; border-collapse: collapse; font: 13px system-ui, sans-serif; } td, th { border-bottom: 1px solid #E6EAEE; padding: 6px 4px; text-align: left; vertical-align: top; }
  .sig { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 40px; } .sig div { border-top: 1px solid #001D45; padding-top: 6px; font-size: 13px; }
  .ok { color: #2F7D4F; } .warn { color: #A86A00; } .bad { color: #B3412E; }
  .contract h1, .contract .psub { text-align: center; }
  @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; padding: 0; max-width: none; } .bar { display: none; } }
  @media (max-width: 640px) { .page { padding: 24px 18px; margin: 0; } .sig { grid-template-columns: 1fr; } }`;

const page = (title, body) => `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${R.esc(title)}</title><style>${DOC_CSS}</style></head><body>
<div class="bar"><button type="button" data-print>Afdrukken of opslaan als pdf</button></div>
<main class="page">${body}</main>
<script src="/print.js"></script>
</body></html>`;

function contractPage(row, settings) {
  const d = R.normalize(row.data);
  return page(`Opdrachtovereenkomst ${d.zzp.bedrijf || d.zzp.naam}`, `<div class="contract">${R.contractHtml(R.contractData(d, settings, row.id))}</div>`);
}

function dossierPage(row, settings, files, userName) {
  const d = R.normalize(row.data);
  const r = R.assess(d);
  const z = d.zzp;
  const o = d.opdracht;
  const e = R.esc;
  const ans = R.ALLQ.map((q) => {
    const v = d.intake.answers[q.id];
    const sc = v == null ? null : q.o[v][1];
    return `<tr><td>${e(q.t)}</td><td>${v == null ? '<em>niet beantwoord</em>' : e(q.o[v][0])}</td><td class="${['ok', 'warn', 'bad'][sc] || ''}">${q.dom && sc != null ? ['goed', 'let op', 'risico'][sc] : ''}</td></tr>`;
  }).join('');
  const docs = R.DOCS.filter((x) => R.applies(x, d)).map((x) => {
    const st = R.docState(x, d);
    const rec = d.docs[x.k] || {};
    const fl = files.filter((f) => f.doc_key === x.k).map((f) => e(f.filename)).join(', ');
    return `<tr><td>${e(x.t)}${x.req ? '' : ' <span class="m">(optioneel)</span>'}</td><td>${R.FASE[x.f]}</td><td>${e(R.DSTAT[st])}</td><td>${R.fmtShort(rec.d)}${rec.exp ? ` · geldig tot ${R.fmtShort(rec.exp)}` : ''}</td><td>${fl}</td></tr>`;
  }).join('');
  const checks = d.checks.map((c) => `<tr><td>${R.fmtShort(c.datum)}</td><td class="${e(c.uitkomst)}">${e(R.LBL[c.uitkomst] || '')}</td><td>${e((c.punten || []).join('; '))} ${e(c.notes || '')}</td></tr>`).join('')
    || '<tr><td colspan="3">Nog geen praktijkcheck vastgelegd.</td></tr>';
  const arch = R.isIso(o.eind) ? R.addMonths(o.eind, 84) : null;
  return page(`Dossier ${z.naam}`, `
  <h1>Dossier zelfstandige: ${e(z.naam || 'naam onbekend')}</h1>
  <p class="m">${e(z.bedrijf)} · KvK ${e(z.kvk)} · btw ${e(z.btw)} · status ${e(R.STATUS[row.status])}${userName ? ` · account ${e(userName)}` : ''} · afgedrukt ${R.fmtShort(R.todayIso())}</p>
  <p><b>Risico-indicatie:</b> ${r.verdict ? R.VTXT[r.verdict][0] : 'onvolledig'} (gezag ${r.L.G ? R.LBL[r.L.G] : '–'}, inbedding ${r.L.I ? R.LBL[r.L.I] : '–'}, ondernemerschap ${r.L.O ? R.LBL[r.L.O] : '–'})</p>
  ${row.released_at ? `<p><b>Vrijgegeven voor urenregistratie:</b> ${R.fmtShort(new Date(row.released_at).toISOString().slice(0, 10))}${row.release_note ? `. Motivering: ${e(row.release_note)}` : ''}</p>` : ''}
  <h2>Opdracht</h2><table>
    <tr><th>Resultaat</th><td>${e(o.resultaat).replace(/\n/g, '<br>')}</td></tr>
    <tr><th>Eindklant</th><td>${e(o.klant) || '–'}</td></tr>
    <tr><th>Looptijd</th><td>${R.fmtShort(o.start)} t/m ${R.fmtShort(o.eind)}</td></tr>
    <tr><th>Tarief</th><td>${e(R.money(o.tarief)) || '–'} per uur excl. btw</td></tr></table>
  <h2>Intake</h2><p class="m">${e(d.intake.bron || '')}${row.submitted_at ? ` · ingediend ${R.fmtShort(new Date(row.submitted_at).toISOString().slice(0, 10))}` : ''} · verklaring ${d.intake.akkoord ? 'bevestigd' : 'niet bevestigd'} · ${e(d.intake.plaats)} ${R.fmtShort(d.intake.datum)}</p>
  <table><tr><th>Vraag</th><th>Antwoord</th><th></th></tr>${ans}</table>
  ${r.flags.length ? `<h2>Aandachtspunten</h2><ul>${r.flags.map((f) => `<li><b>${e(f[1])}</b>: ${e(f[2])}</li>`).join('')}</ul>` : ''}
  ${d.intake.notes ? `<h2>Notities Coretic</h2><p>${e(d.intake.notes)}</p>` : ''}
  <h2>Documenten</h2><table><tr><th>Document</th><th>Fase</th><th>Status</th><th>Datum</th><th>Bestanden</th></tr>${docs}</table>
  <h2>Praktijkchecks</h2><table><tr><th>Datum</th><th>Uitkomst</th><th>Punten en notities</th></tr>${checks}</table>
  <h2>Opdrachtovereenkomst ${R.isIso(d.contract.getekend) ? `(getekend ${R.fmtShort(d.contract.getekend)})` : '(concept)'}</h2>
  <div class="contract">${R.contractHtml(R.contractData(d, settings, row.id))}</div>
  <p class="m" style="margin-top:30px">Indicatie op basis van gezag, inbedding en ondernemerschap en het handhavingskader van de Belastingdienst. Geen juridisch oordeel. Bewaren tot ${arch ? R.fmtShort(arch) : '7 jaar na het einde van de opdracht'}.</p>`);
}

module.exports = {
  R, getOnboardingSettings, setOnboardingSettings, ONB_DEFAULTS,
  hoursAccess, allowedOn, allowedWork, scopeFor, gateMessage, assertHoursAllowed, syncAssignments,
  hashToken, newInviteToken, dossierByToken, INVITE_DAYS,
  storeFile, listFiles, sendFile, MAX_FILE,
  contractPage, dossierPage,
};
