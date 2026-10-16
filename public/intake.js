// Intake voor een zzp'er via de persoonlijke link van Coretic (geen account nodig).
(() => {
  'use strict';

  const R = window.OnboardingRules;
  const root = document.getElementById('intake');
  const token = location.pathname.split('/').filter(Boolean).pop() || '';
  const esc = R.esc;
  let view = null;
  let saveTimer = null;
  let saving = Promise.resolve();

  const logo = '<picture class="logo"><source srcset="/assets/logo-light.png" media="(prefers-color-scheme: dark)"><img src="/assets/logo.png" alt="Coretic" width="126" height="40"></picture>';
  const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

  function toast(message, isError = false) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = message;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), isError ? 7000 : 3000);
  }

  async function call(method, path = '', { body, file } = {}) {
    const headers = { 'X-Requested-With': 'fetch' };
    if (file) { headers['Content-Type'] = 'application/octet-stream'; headers['X-Filename'] = encodeURIComponent(file.name); }
    else if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api/public/intake/${encodeURIComponent(token)}${path}`, {
      method, headers, credentials: 'omit', body: file || (body ? JSON.stringify(body) : undefined),
    });
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
    if (!res.ok) { const e = new Error(data.error || `Fout ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  /* ---------- weergave ---------- */

  const locked = () => Boolean(view && view.submitted_at);
  const dis = () => (locked() ? ' disabled' : '');

  function field(path, label, { type = 'text', hint = '', attrs = '', full = false } = {}) {
    const [sec, key] = path.split('.');
    const val = view[sec][key] ?? '';
    return `<label class="field${full ? ' full' : ''}">${label}${hint ? `<span class="hint">${hint}</span>` : ''}
      <input type="${type}" id="f_${sec}_${key}" data-path="${path}" value="${esc(val)}" ${attrs}${dis()}></label>`;
  }

  function question(q) {
    const v = view.intake.answers[q.id];
    return `<fieldset class="iq"><legend>${esc(q.tz || q.t)}</legend>${q.why ? `<p class="hint">${esc(q.why)}</p>` : ''}
      <div class="iq-opts">${q.o.map((o, i) => `<label><input type="radio" name="q_${q.id}" id="q_${q.id}_${i}" value="${i}"${v === i ? ' checked' : ''}${dis()}><span>${esc(o[2] || o[0])}</span></label>`).join('')}</div></fieldset>`;
  }

  function docsHTML() {
    return view.docs.map((x) => {
      const files = view.files.filter((f) => f.doc_key === x.k);
      const state = x.state === 'ok' ? '<span class="badge approved">Gecontroleerd</span>'
        : x.state === 'nvt' ? '<span class="badge">Niet nodig</span>'
          : files.length ? '<span class="badge submitted">Aangeleverd</span>'
            : x.req ? '<span class="badge rejected">Nog nodig</span>' : '<span class="badge">Optioneel</span>';
      return `<div class="idoc">
        <div class="idoc-head"><div><strong>${esc(x.t)}</strong><p class="hint">${esc(x.why)}</p></div>${state}</div>
        ${files.length ? `<ul class="idoc-files">${files.map((f) => `<li><span>${esc(f.filename)} <span class="muted small">${kb(f.size)}</span></span>${f.mine && x.state !== 'ok' ? `<button type="button" class="btn small ghost" data-del="${f.id}">Verwijderen</button>` : ''}</li>`).join('')}</ul>` : ''}
        ${x.state !== 'nvt' ? `<label class="btn small idoc-up">Bestand kiezen<input type="file" accept="application/pdf,image/png,image/jpeg" data-up="${x.k}" multiple hidden></label>` : ''}
      </div>`;
    }).join('');
  }

  function progress() {
    const answered = R.ALLQ.filter((q) => view.intake.answers[q.id] != null).length;
    const reqDocs = view.docs.filter((x) => x.req);
    const docsIn = reqDocs.filter((x) => x.state === 'ok' || x.state === 'nvt' || view.files.some((f) => f.doc_key === x.k)).length;
    return { answered, total: R.ALLQ.length, docsIn, docsTotal: reqDocs.length };
  }

  function render() {
    const o = view.opdracht;
    const p = progress();
    const period = R.isIso(o.start) || R.isIso(o.eind) ? `${R.fmtShort(o.start)} t/m ${R.fmtShort(o.eind)}` : 'nog niet vastgesteld';
    root.innerHTML = `
      <header class="intake-top">${logo}<span class="muted small">Intake zelfstandige</span></header>
      <main class="intake-main stack">
        <div class="stack">
          <h1>Welkom${view.zzp.naam ? `, ${esc(view.zzp.naam.split(' ')[0])}` : ''}</h1>
          <p class="muted">Met deze intake leggen we vast dat je als zelfstandig ondernemer voor Coretic werkt en niet als werknemer. Je antwoorden en documenten komen in je dossier bij Coretic. Dat dossier is nodig voor een controle door de Belastingdienst. Zodra het dossier compleet is, kun je in de app uren schrijven.</p>
          <p class="muted small">Je antwoorden worden automatisch bewaard. Je kunt de pagina sluiten en later verder gaan via dezelfde link${view.expires ? `, tot ${R.fmtShort(String(view.expires).slice(0, 10))}` : ''}.</p>
        </div>
        ${locked() ? `<div class="notice"><strong>Je intake is ingediend op ${R.fmtShort(String(view.submitted_at).slice(0, 10))}.</strong> Dank je wel. Coretic neemt contact op over de overeenkomst. Ontbrekende documenten kun je hieronder nog aanleveren.</div>` : ''}
        <div class="intake-progress panel panel-pad row spread"><span><strong>${p.answered}/${p.total}</strong> vragen beantwoord</span><span><strong>${p.docsIn}/${p.docsTotal}</strong> verplichte documenten</span></div>

        <section class="panel panel-pad stack">
          <h2>1. Je onderneming</h2>
          <div class="form-grid">
            ${field('zzp.naam', 'Naam', { attrs: 'autocomplete="name" maxlength="120"' })}
            ${field('zzp.bedrijf', 'Bedrijfsnaam', { attrs: 'autocomplete="organization" maxlength="200"' })}
            ${field('zzp.kvk', 'KvK-nummer', { attrs: 'inputmode="numeric" maxlength="8" pattern="\\d{8}"', hint: '<a href="https://www.kvk.nl/zoeken/" target="_blank" rel="noopener noreferrer" data-kvk>Zoek in het KvK-register</a>' })}
            ${field('zzp.kvkDatum', 'Ingeschreven sinds', { type: 'date' })}
            ${field('zzp.btw', 'Btw-identificatienummer', { attrs: 'maxlength="30" placeholder="NL000000000B01"' })}
            ${field('zzp.web', 'Website of bedrijfspagina', { attrs: 'maxlength="200"' })}
            ${field('zzp.email', 'E-mail', { type: 'email', attrs: 'autocomplete="email" maxlength="200"' })}
            ${field('zzp.tel', 'Telefoon', { type: 'tel', attrs: 'autocomplete="tel" maxlength="40"' })}
            ${field('zzp.adres', 'Adres, postcode en plaats', { attrs: 'autocomplete="street-address" maxlength="300" placeholder="Straat 1, 1234 AB Plaats"', full: true })}
          </div>
          ${R.Q.profiel.map(question).join('')}
        </section>

        <section class="panel panel-pad stack">
          <h2>2. De opdracht</h2>
          <dl class="facts"><dt>Eindklant</dt><dd>${esc(o.klant) || 'Coretic zelf'}</dd><dt>Looptijd</dt><dd>${period}</dd></dl>
          <label class="field">Op te leveren resultaat<span class="hint">Beschrijf wat er af is als de opdracht klaar is, niet een functie.</span>
            <textarea id="f_opdracht_resultaat" data-path="opdracht.resultaat" maxlength="4000"${dis()}>${esc(o.resultaat)}</textarea></label>
          <div class="form-grid">
            ${field('opdracht.tarief', 'Je uurtarief excl. btw (€)', { attrs: 'inputmode="decimal" maxlength="10"' })}
            ${field('opdracht.uren', 'Inschatting uren (totaal)', { attrs: 'inputmode="decimal" maxlength="10"' })}
          </div>
          ${R.Q.opdracht.map(question).join('')}
        </section>

        <section class="panel panel-pad stack">
          <h2>3. Hoe het werk wordt ingericht</h2>
          <p class="muted small">Wie bepaalt hoe, wanneer en waar je werkt, en hoe je werk zich verhoudt tot dat van werknemers.</p>
          ${R.Q.gezag.map(question).join('')}${R.Q.inbed.map(question).join('')}
        </section>

        <section class="panel panel-pad stack">
          <h2>4. Je ondernemerschap</h2>
          ${R.Q.ond.map(question).join('')}
        </section>

        <section class="panel panel-pad stack">
          <h2>5. Documenten</h2>
          <p class="muted small">Pdf, png of jpg, maximaal 5 MB per bestand. Bedragen op bankafschriften mag je afschermen. Stuur geen kopie van je identiteitsbewijs.</p>
          <div class="stack" id="docs">${docsHTML()}</div>
        </section>

        <section class="panel panel-pad stack">
          <h2>6. Verklaring</h2>
          <label class="check"><input type="checkbox" id="f_akkoord"${view.intake.akkoord ? ' checked' : ''}${dis()}> Ik verklaar dat ik deze intake naar waarheid heb ingevuld en dat ik Coretic meld als mijn situatie wezenlijk verandert.</label>
          <div class="form-grid">
            ${field('intake.plaats', 'Plaats', { attrs: 'maxlength="100"' })}
            ${field('intake.datum', 'Datum', { type: 'date' })}
          </div>
          ${locked() ? '' : `<div class="row"><button type="button" class="btn primary" data-submit>Intake indienen</button><span class="muted small" id="save-state"></span></div>
          <p class="muted small">Na het indienen kun je je antwoorden niet meer wijzigen. Documenten kun je daarna nog aanleveren.</p>`}
        </section>
        <p class="muted small">Je gegevens worden alleen gebruikt voor je samenwerking met Coretic en 7 jaar na het einde van de opdracht bewaard, zoals de fiscale bewaarplicht voorschrijft.</p>
      </main>`;
    if (!view.intake.datum && !locked()) {
      const d = root.querySelector('[data-path="intake.datum"]');
      if (d) d.value = R.todayIso();
    }
    updateKvkLink();
  }

  function updateKvkLink() {
    const a = root.querySelector('[data-kvk]');
    if (!a) return;
    const kvk = root.querySelector('[data-path="zzp.kvk"]').value.trim();
    const q = /^\d{8}$/.test(kvk) ? kvk : (root.querySelector('[data-path="zzp.bedrijf"]').value.trim() || root.querySelector('[data-path="zzp.naam"]').value.trim());
    a.href = `https://www.kvk.nl/zoeken/${q ? `?source=all&q=${encodeURIComponent(q)}` : ''}`;
    a.textContent = /^\d{8}$/.test(kvk) ? 'Controleer in het KvK-register' : 'Zoek in het KvK-register';
  }

  /* ---------- opslaan ---------- */

  function collect() {
    const body = { zzp: {}, opdracht: {}, intake: { answers: {} } };
    root.querySelectorAll('[data-path]').forEach((el) => {
      const [sec, key] = el.dataset.path.split('.');
      body[sec][key] = el.value;
    });
    for (const q of R.ALLQ) {
      const c = root.querySelector(`input[name="q_${q.id}"]:checked`);
      if (c) body.intake.answers[q.id] = Number(c.value);
    }
    body.intake.akkoord = root.querySelector('#f_akkoord').checked;
    return body;
  }

  function setSaveState(t) { const el = root.querySelector('#save-state'); if (el) el.textContent = t; }

  function save(submit = false) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (locked()) return Promise.resolve();
    const body = collect();
    if (submit) body.submit = true;
    setSaveState('Opslaan…');
    saving = saving.then(async () => {
      try {
        const next = await call('PUT', '', { body });
        const wasLocked = locked();
        // Alleen de status en documenten bijwerken; de velden staan al goed op het scherm.
        view = { ...next };
        if (submit || wasLocked !== locked()) render();
        else setSaveState(`Bewaard om ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`);
      } catch (e) {
        setSaveState('');
        toast(e.message, true);
        if (e.status === 409) await load();
        if (submit) throw e;
      }
    });
    return saving;
  }

  async function upload(key, files) {
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is groter dan 5 MB`, true); continue; }
      try {
        view = await call('POST', `/files?doc=${encodeURIComponent(key)}`, { file });
        toast(`${file.name} is aangeleverd`);
      } catch (e) { toast(`${file.name}: ${e.message}`, true); }
    }
    await save();
    root.querySelector('#docs').innerHTML = docsHTML();
    refreshProgress();
  }

  function refreshProgress() {
    const p = progress();
    const el = root.querySelector('.intake-progress');
    if (el) el.innerHTML = `<span><strong>${p.answered}/${p.total}</strong> vragen beantwoord</span><span><strong>${p.docsIn}/${p.docsTotal}</strong> verplichte documenten</span>`;
  }

  /* ---------- events ---------- */

  root.addEventListener('input', (e) => {
    if (e.target.matches('[data-path]')) {
      if (/zzp\.(kvk|bedrijf|naam)/.test(e.target.dataset.path)) updateKvkLink();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(), 1200);
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('input[type="radio"], #f_akkoord')) {
      if (e.target.type === 'radio') view.intake.answers[e.target.name.slice(2)] = Number(e.target.value);
      refreshProgress();
      save();
    }
    if (e.target.matches('[data-up]') && e.target.files.length) upload(e.target.dataset.up, [...e.target.files]);
  });
  root.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      try { view = await call('DELETE', `/files/${del.dataset.del}`); root.querySelector('#docs').innerHTML = docsHTML(); refreshProgress(); } catch (ex) { toast(ex.message, true); }
    }
    if (e.target.closest('[data-submit]')) {
      const btn = e.target.closest('[data-submit]');
      btn.disabled = true;
      try { await save(true); toast('Je intake is ingediend'); window.scrollTo(0, 0); } catch { /* melding staat al in beeld */ } finally { btn.disabled = false; }
    }
  });
  window.addEventListener('beforeunload', () => { if (saveTimer) save(); });

  async function load() {
    try {
      view = await call('GET');
      render();
    } catch (e) {
      root.innerHTML = `<header class="intake-top">${logo}</header><main class="intake-main"><div class="panel panel-pad empty"><h2>Link niet geldig</h2><p>${esc(e.message)}</p></div></main>`;
    }
  }
  load();
})();
