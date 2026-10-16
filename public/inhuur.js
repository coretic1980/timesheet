// Inhuur van zzp'ers (Wet DBA): dossiers met intake, overeenkomst, documenten en praktijkcheck.
// Wordt vanuit app.js aangeroepen met de gedeelde hulpfuncties (ctx).
window.CoreticInhuur = (() => {
  'use strict';

  const R = window.OnboardingRules;
  const esc = R.esc;
  let ctx = null;
  const canEdit = () => ctx.user.role === 'admin';
  const STEPS = [['intake', 'Intake'], ['overeenkomst', 'Overeenkomst'], ['documenten', 'Documenten'], ['projecten', 'Projecten'], ['praktijk', 'Praktijkcheck']];
  const STATUS_BADGE = { intake: 'submitted', contract: 'invoiced', actief: 'approved', afgerond: '', afgewezen: 'rejected' };
  const statusBadge = (s) => `<span class="badge ${STATUS_BADGE[s] || ''}">${esc(R.STATUS[s] || s)}</span>`;
  const verdictBadge = (v) => (v ? `<span class="badge ${{ ok: 'approved', warn: 'submitted', bad: 'rejected' }[v]}">${R.LBL[v]}</span>` : '<span class="badge">onvolledig</span>');
  const LVL_CLASS = { bad: 'error', warn: 'warn', info: '', ok: 'ok' };
  const listHTML = (items) => `<ul class="ib-list">${items.map(([l, t, x]) => `<li class="ib-${l}"><strong>${esc(t)}</strong><span>${esc(x)}</span></li>`).join('')}</ul>`;
  const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

  async function view(el, params, c) {
    ctx = c;
    const [a, b] = params;
    if (a === 'advies') return viewAdvice(el);
    if (/^\d+$/.test(a || '')) return viewDossier(el, Number(a), STEPS.some(([k]) => k === b) ? b : 'intake');
    return viewList(el);
  }

  const tabsHTML = (active) => `<div class="tabs" role="tablist">
      <button role="tab" aria-selected="${active === 'list'}" data-go="#/inhuur">Dossiers</button>
      <button role="tab" aria-selected="${active === 'advies'}" data-go="#/inhuur/advies">Advies en documenten</button></div>`;
  const bindGo = (el) => el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));

  /* ================= Overzicht ================= */

  async function viewList(el) {
    const [list, meta] = await Promise.all([ctx.api('/onboarding'), ctx.api('/onboarding/meta')]);
    const all = list.dossiers;
    const open = all.filter((d) => !['afgerond', 'afgewezen'].includes(d.status));
    const kActief = all.filter((d) => d.status === 'actief').length;
    const kNiet = open.filter((d) => d.status !== 'actief').length;
    const kCheck = all.filter((d) => d.next_check && R.daysUntil(d.next_check) <= 14).length;
    const kEind = all.filter((d) => d.status === 'actief' && R.isIso(d.eind) && R.daysUntil(d.eind) <= 30).length;
    const todo = [];
    for (const d of all) for (const a of d.actions) todo.push([...a, d]);
    if (list.enforce && list.unmanaged.length) {
      todo.unshift(['bad', `${list.unmanaged.map((u) => u.name).join(', ')} ${list.unmanaged.length === 1 ? 'kan' : 'kunnen'} geen uren schrijven`, 'Ingehuurde zzp\'er zonder inhuurdossier. Maak een dossier aan en geef het vrij, of zet de urenblokkade tijdelijk uit bij Instellingen.', null]);
    }
    if (!meta.settings.dvnKvk && !meta.settings.corKvk) todo.unshift(['warn', 'KvK-gegevens van Coretic ontbreken', 'Vul ze in bij Instellingen. Ze komen in elke overeenkomst.', null]);
    if (all.some((d) => d.status !== 'afgewezen' && d.actions.some((x) => /Wtta/.test(x[2])))) todo.unshift(['bad', 'Wtta: Coretic leent arbeid uit', 'Meld je vóór 1 januari 2027 bij de NAU of zet de opdracht om naar een resultaatopdracht.', null]);
    const order = { bad: 0, warn: 1, info: 2 };
    todo.sort((x, y) => order[x[0]] - order[y[0]]);

    const tile = (label, value, sub, lvl) => `<div class="panel tile tile-${lvl}"><span class="tile-label">${label}</span><strong class="tile-value">${value}</strong><span class="tile-sub muted small">${sub}</span></div>`;
    el.innerHTML = `
      <div class="stack">
        <div class="row spread"><h1>Inhuur zzp'ers</h1>
          ${canEdit() ? '<div class="row"><button class="btn" type="button" data-settings>Instellingen</button><button class="btn primary" type="button" data-new>Nieuwe zzp\'er</button></div>' : '<span class="badge readonly">Alleen inzien</span>'}</div>
        ${tabsHTML('list')}
        ${list.enforce ? '' : '<div class="notice warn"><strong>De urenblokkade staat uit.</strong> Zzp\'ers kunnen uren schrijven zonder vrijgegeven dossier. Zet hem aan bij Instellingen.</div>'}
        <p class="muted">Een zzp'er kan pas uren schrijven als zijn dossier is vrijgegeven, en alleen binnen de looptijd van de opdracht. Vrijgeven kan pas als de intake, de getekende overeenkomst en de startdocumenten compleet zijn.</p>
        <div class="tiles">
          ${tile('Vrijgegeven opdrachten', kActief, 'Kunnen uren schrijven', 'ok')}
          ${tile('Nog niet vrijgegeven', kNiet, 'In intake of contract', kNiet ? 'warn' : 'ok')}
          ${tile('Praktijkcheck binnen 14 dagen', kCheck, 'Elk half jaar per opdracht', kCheck ? 'warn' : 'ok')}
          ${tile('Eindigt binnen 30 dagen', kEind, 'Verlengen alleen met nieuw resultaat', kEind ? 'warn' : 'ok')}
        </div>
        <div class="dash-cols">
          <section class="panel">
            <div class="panel-pad"><h2>Dossiers</h2></div>
            ${all.length ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>Zzp'er</th><th>Status</th><th>Risico</th><th class="num">Startdocs</th><th>Looptijd</th><th>Intake</th></tr></thead>
              <tbody>${all.map((d) => `<tr class="ib-row" data-open="${d.id}" tabindex="0">
                <td><strong>${esc(d.naam || 'Naamloos')}</strong><br><span class="muted small">${esc(d.bedrijf || '')}${d.klant ? ` · voor ${esc(d.klant)}` : ''}${d.user_name ? ` · account ${esc(d.user_name)}` : ''}</span></td>
                <td>${statusBadge(d.status)}</td><td>${verdictBadge(d.verdict)}</td>
                <td class="num"><span class="badge ${d.docs_done === d.docs_total ? 'approved' : 'submitted'}">${d.docs_done}/${d.docs_total}</span></td>
                <td class="nowrap">${R.fmtShort(d.start)} – ${R.fmtShort(d.eind)}</td>
                <td class="small">${d.submitted_at ? 'Ingediend' : d.invite_active ? 'Link verstuurd' : '–'}</td></tr>`).join('')}</tbody></table></div>`
              : `<div class="empty"><h2>Nog geen dossiers</h2><p>Maak een dossier aan en stuur de zzp'er een intakelink. Hij vult dan zelf zijn gegevens en antwoorden in en levert documenten aan.</p>${canEdit() ? '<button class="btn primary" type="button" data-new>Nieuwe zzp\'er</button>' : ''}</div>`}
          </section>
          <section class="panel">
            <div class="panel-pad"><h2>Te doen</h2></div>
            <div class="panel-pad" style="padding-top:0">${todo.length ? `<ul class="ib-list">${todo.slice(0, 16).map(([l, t, x, d]) => `<li class="ib-${l}">${d ? `<a href="#/inhuur/${d.id}">${esc(d.naam || 'Naamloos')}</a>` : ''}<strong>${esc(t)}</strong><span>${esc(x)}</span></li>`).join('')}</ul>`
              : '<p class="muted small">Niets openstaand. Hier verschijnen ontbrekende documenten, verlopen polissen, praktijkchecks en aflopende opdrachten.</p>'}</div>
          </section>
        </div>
      </div>`;
    bindGo(el);
    ctx.labelTables(el);
    el.querySelectorAll('[data-open]').forEach((tr) => {
      const go = () => { location.hash = `#/inhuur/${tr.dataset.open}`; };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
    el.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => newDossier(meta)));
    el.querySelector('[data-settings]')?.addEventListener('click', () => settingsDialog(meta.settings));
  }

  function newDossier(meta) {
    const free = meta.users.filter((u) => u.active);
    ctx.openDialog({
      title: "Nieuwe zzp'er",
      submit: 'Dossier aanmaken',
      body: `
        <div class="form-grid">
          <label class="field">Naam<input name="naam" required maxlength="120"></label>
          <label class="field">E-mail<input name="email" type="email" maxlength="200"></label>
          <label class="field">Bedrijfsnaam<input name="bedrijf" maxlength="200"></label>
        </div>
        <label class="field">Bestaand account in de app<span class="hint">Optioneel. Werkt de zzp'er al bij je, kies dan zijn account. Anders maak je het account later vanuit het dossier aan.</span>
          <select name="user_id"><option value="">Nog geen account</option>${free.map((u) => `<option value="${u.id}">${esc(u.name)}${u.is_contractor ? ' (zzp\'er)' : ''}</option>`).join('')}</select></label>`,
      onSubmit: async (fd) => {
        const res = await ctx.api('/onboarding', { method: 'POST', body: { naam: fd.get('naam'), email: fd.get('email'), bedrijf: fd.get('bedrijf'), user_id: fd.get('user_id') || null } });
        location.hash = `#/inhuur/${res.id}`;
      },
    });
  }

  function settingsDialog(s) {
    ctx.openDialog({
      title: 'Instellingen inhuur',
      wide: true,
      body: `
        <label class="check"><input type="checkbox" name="enforce"${s.enforce ? ' checked' : ''}> Urenblokkade: zzp'ers schrijven alleen uren binnen een vrijgegeven dossier</label>
        <p class="hint small">Geldt alleen voor medewerkers die bij Beheer › Medewerkers als ingehuurde zzp'er staan.</p>
        <h3>Opdrachtgever in de overeenkomst</h3>
        <div class="form-grid">
          <label class="field">Standaard contracterende partij<select name="og">
            <option value="dvn"${s.og !== 'cor' ? ' selected' : ''}>DVN Technology B.V. (Coretic)</option>
            <option value="cor"${s.og === 'cor' ? ' selected' : ''}>Coretic B.V.</option></select></label>
          <label class="field">KvK DVN Technology B.V.<input name="dvnKvk" value="${esc(s.dvnKvk)}" inputmode="numeric" maxlength="20"></label>
          <label class="field">KvK Coretic B.V.<span class="hint">Na inschrijving van de werkmaatschappij</span><input name="corKvk" value="${esc(s.corKvk)}" inputmode="numeric" maxlength="20"></label>
          <label class="field">Adres<input name="ogAdres" value="${esc(s.ogAdres)}" maxlength="200"></label>
          <label class="field">Vestigingsplaats<input name="ogPlaats" value="${esc(s.ogPlaats)}" maxlength="100"></label>
          <label class="field">Vertegenwoordigd door<input name="ogRep" value="${esc(s.ogRep)}" maxlength="120" placeholder="Naam, directeur"></label>
          <label class="field">Betalingstermijn (dagen)<input name="betaal" value="${esc(s.betaal)}" inputmode="numeric"></label>
          <label class="field">Opzegtermijn (dagen)<input name="opzeg" value="${esc(s.opzeg)}" inputmode="numeric"></label>
        </div>`,
      onSubmit: async (fd) => {
        const body = Object.fromEntries(['og', 'dvnKvk', 'corKvk', 'ogAdres', 'ogPlaats', 'ogRep', 'betaal', 'opzeg'].map((k) => [k, fd.get(k)]));
        body.enforce = fd.get('enforce') === 'on';
        await ctx.api('/onboarding/settings', { method: 'PUT', body });
        ctx.toast('Instellingen opgeslagen');
        ctx.render();
      },
    });
  }

  /* ================= Dossier ================= */

  async function viewDossier(el, id, step) {
    const [row, meta] = await Promise.all([ctx.api(`/onboarding/${id}`), ctx.api('/onboarding/meta')]);
    const S = meta.settings;
    const d = row.data; // werkkopie
    let updatedAt = row.updated_at;
    let files = row.files;
    const ro = !canEdit();

    const ctxRelease = () => ({ userId: row.user_id, isContractor: !!(row.user && meta.users.find((u) => u.id === row.user_id && u.is_contractor)), agreementDate: (meta.users.find((u) => u.id === row.user_id) || {}).agreement_date });

    function headerHTML() {
      const a = R.assess(d);
      const dc = R.docCount(d);
      const nx = row.status === 'actief' ? R.nextCheck(d) : null;
      const steps = {
        intake: a.verdict ? R.LBL[a.verdict] : `${a.answered}/${R.SCORED.length} vragen`,
        overeenkomst: R.isIso(d.contract.getekend) ? `getekend ${R.fmtShort(d.contract.getekend)}` : 'niet getekend',
        documenten: `${dc.done}/${dc.total} compleet`,
        projecten: d.toewijzing.length ? `${d.toewijzing.length} ${d.toewijzing.length === 1 ? 'project' : 'projecten'}` : 'nog geen',
        praktijk: nx ? `volgende ${R.fmtShort(nx)}` : `${d.checks.length} vastgelegd`,
      };
      return { steps };
    }

    function accessHTML() {
      const u = row.user;
      const userMeta = u ? meta.users.find((x) => x.id === u.id) : null;
      const p = R.releaseProblems(d, ctxRelease());
      const invite = row.invite_active
        ? `Intakelink actief tot ${R.fmtShort(String(row.invite_expires).slice(0, 10))}${row.submitted_at ? ` · ingediend ${R.fmtShort(String(row.submitted_at).slice(0, 10))}` : ' · nog niet ingediend'}`
        : row.submitted_at ? `Intake ingediend ${R.fmtShort(String(row.submitted_at).slice(0, 10))}` : 'Nog geen intakelink verstuurd';
      return `
        <section class="panel panel-pad stack ib-access">
          <div class="row spread"><h2>Toegang tot uren</h2>${statusBadge(row.status)}</div>
          <dl class="facts">
            <dt>Account</dt><dd>${u ? `${esc(u.name)} <span class="muted small">${esc(u.email)}</span>${userMeta && userMeta.is_contractor ? ' <span class="badge">zzp\'er</span>' : ' <span class="badge rejected">nog geen zzp\'er</span>'}` : '<span class="muted">Nog niet gekoppeld</span>'}</dd>
            <dt>Intake</dt><dd>${invite}</dd>
            <dt>Projecten</dt><dd>${d.toewijzing.length ? esc(projectLabels()) : '<span class="muted">Nog niet toegewezen</span>'}</dd>
            ${row.status === 'actief' ? `<dt>Vrijgegeven</dt><dd>${R.fmtShort(String(row.released_at).slice(0, 10))} · uren van ${R.fmtShort(d.opdracht.start)} t/m ${R.fmtShort(d.opdracht.eind)}${row.release_note ? `<br><span class="muted small">Motivering: ${esc(row.release_note)}</span>` : ''}</dd>` : ''}
          </dl>
          ${ro ? '' : `<div class="row">
            ${row.status !== 'actief' ? (u ? '<button class="btn small" type="button" data-unlink>Ontkoppelen</button>' : '<button class="btn small" type="button" data-account>Account aanmaken</button><button class="btn small" type="button" data-link>Bestaand account koppelen</button>') : ''}
            ${u ? '<button class="btn small" type="button" data-sync title="Bedrijfsgegevens, btw, tarief en akkoord zelffacturering naar Beheer › Medewerkers">Zzp-gegevens overnemen</button>' : ''}
            ${['afgerond', 'afgewezen'].includes(row.status) ? '' : `<button class="btn small" type="button" data-invite>${row.invite_active ? 'Nieuwe intakelink' : 'Intakelink maken'}</button>`}
            ${row.invite_active ? '<button class="btn small ghost" type="button" data-revoke>Link intrekken</button>' : ''}
            ${row.submitted_at && row.status !== 'actief' ? '<button class="btn small ghost" type="button" data-reopen title="De zzp\'er kan zijn antwoorden weer aanpassen">Intake heropenen</button>' : ''}
          </div>
          <div class="row">
            ${['intake', 'contract'].includes(row.status) ? `<button class="btn${p.hard.length ? '' : ' primary'}" type="button" data-release title="${p.hard.length ? 'Laat zien wat er nog ontbreekt' : 'De zzp\'er kan daarna uren schrijven binnen de looptijd'}">Vrijgeven voor uren</button>` : ''}
            ${row.status === 'intake' ? '<button class="btn" type="button" data-status="contract">Naar contract</button>' : ''}
            ${row.status === 'actief' ? '<button class="btn" type="button" data-status="afgerond">Opdracht afronden</button>' : ''}
            ${['afgerond', 'afgewezen'].includes(row.status) ? '<button class="btn" type="button" data-status="contract">Heropenen</button>' : ''}
            ${['intake', 'contract'].includes(row.status) ? '<button class="btn ghost danger" type="button" data-status="afgewezen">Niet doorgegaan</button>' : ''}
          </div>
          ${['intake', 'contract'].includes(row.status) && p.hard.length ? `<details class="small"><summary>${p.hard.length} ${p.hard.length === 1 ? 'punt' : 'punten'} voordat je kunt vrijgeven</summary><ul class="tight">${p.hard.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}`}
        </section>`;
    }

    function render() {
      const { steps } = headerHTML();
      const A = R.actions(d, row.status);
      el.innerHTML = `
        <div class="stack">
          <a href="#/inhuur" class="small">← Alle dossiers</a>
          <div class="row spread">
            <div><h1 data-name>${esc(d.zzp.naam || 'Naamloos dossier')}</h1><span class="muted" data-co>${esc(d.zzp.bedrijf || '')}</span></div>
            <div class="row">
              <a class="btn" href="/api/onboarding/${id}/document" target="_blank" rel="noopener">Dossier afdrukken</a>
              ${ro || row.status === 'actief' ? '' : '<button class="btn ghost danger" type="button" data-delete>Verwijderen</button>'}
            </div>
          </div>
          <div class="ib-top">
            ${accessHTML()}
            <section class="panel panel-pad stack"><h2>Aandachtspunten</h2>${A.length ? listHTML(A) : '<p class="muted small">Geen openstaande punten.</p>'}</section>
          </div>
          <div class="tabs" role="tablist">${STEPS.map(([k, t]) => `<button role="tab" aria-selected="${k === step}" data-step="${k}">${t} <span class="muted small">${esc(steps[k])}</span></button>`).join('')}</div>
          <form id="ib-form" data-guard novalidate>${stepHTML()}</form>
        </div>`;
      bind();
    }

    /* ---------- formulieronderdelen ---------- */
    const dis = ro ? ' disabled' : '';
    const get = (p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), d);
    const inp = (p, label, { type = 'text', hint = '', attrs = '', full = false } = {}) => `<label class="field${full ? ' full' : ''}">${label}${hint ? `<span class="hint">${hint}</span>` : ''}<input type="${type}" data-p="${p}" value="${esc(get(p) ?? '')}" ${attrs}${dis}></label>`;
    const ta = (p, label, hint = '') => `<label class="field">${label}${hint ? `<span class="hint">${hint}</span>` : ''}<textarea data-p="${p}"${dis}>${esc(get(p) ?? '')}</textarea></label>`;
    const chk = (p, label, small = '') => `<label class="check ib-check"><input type="checkbox" data-p="${p}"${get(p) ? ' checked' : ''}${dis}><span>${label}${small ? `<span class="hint block">${small}</span>` : ''}</span></label>`;
    const sel = (p, label, opts) => `<label class="field">${label}<select data-p="${p}"${dis}>${opts.map(([v, t]) => `<option value="${esc(v)}"${String(get(p) ?? '') === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const q = (x) => {
      const v = d.intake.answers[x.id];
      return `<fieldset class="iq"><legend>${esc(x.t)}</legend>${x.why ? `<p class="hint">${esc(x.why)}</p>` : ''}<div class="iq-opts">${x.o.map((o, i) => `<label><input type="radio" name="q_${x.id}" data-q="${x.id}" value="${i}"${v === i ? ' checked' : ''}${dis}><span>${esc(o[0])}</span></label>`).join('')}</div></fieldset>`;
    };
    const saveBar = () => (ro ? '' : '<div class="ib-savebar"><span class="muted small" data-dirty-note></span><button class="btn primary" type="submit">Opslaan</button></div>');

    function riskHTML() {
      const r = R.assess(d);
      const lvlColor = { ok: 'var(--approved)', warn: 'var(--submitted)', bad: 'var(--rejected)' };
      return `<div class="notice ${{ ok: 'ok', warn: 'warn', bad: 'error' }[r.verdict] || ''}"><strong>${r.verdict ? R.VTXT[r.verdict][0] : 'Nog geen oordeel'}</strong><br><span class="small">${r.verdict ? R.VTXT[r.verdict][1] : `Beantwoord de vragen over gezag, inbedding en ondernemerschap (${r.answered} van ${R.SCORED.length}).`}</span></div>
        <div class="stack">${['G', 'I', 'O'].map((k) => { const x = r.dom[k]; const l = r.L[k]; const pct = x[1] ? Math.round((x[0] / x[1]) * 100) : 0; return `<div><div class="row spread small"><strong>${R.DNAME[k]}</strong><span class="muted">${l ? R.LBL[l] : 'geen antwoorden'}</span></div><div class="bar"><span style="width:${l ? Math.max(pct, 4) : 0}%;background:${l ? lvlColor[l] : 'transparent'}"></span></div></div>`; }).join('')}</div>
        ${r.flags.length ? listHTML(r.flags) : ''}`;
    }

    function stepHTML() {
      if (step === 'overeenkomst') {
        const s = R.contractData(d, S, id);
        return `<div class="ib-split">
          <div class="stack">
            <section class="panel panel-pad stack"><h2>Afspraken</h2>
              <div class="form-grid">
                ${sel('contract.og', 'Contracterende partij', [['', `Standaard (${R.OG_SHORT[S.og] || 'DVN Technology B.V.'})`], ['dvn', 'DVN Technology B.V. (Coretic)'], ['cor', 'Coretic B.V.']])}
                ${sel('contract.prijsvorm', 'Prijsvorm', [['uur', 'Uurtarief uit de intake'], ['vast', 'Vaste prijs']])}
                ${d.contract.prijsvorm === 'vast' ? inp('contract.vast', 'Vaste prijs excl. btw (€)', { attrs: 'inputmode="decimal"' }) : `<label class="field">Uurtarief<span class="hint">Uit de intake</span><input value="${esc(R.money(d.opdracht.tarief) || 'nog niet ingevuld')}" disabled></label>`}
                ${inp('contract.betaal', 'Betalingstermijn (dagen)', { attrs: `inputmode="numeric" placeholder="${esc(S.betaal)}"` })}
                ${inp('contract.opzeg', 'Opzegtermijn (dagen)', { attrs: `inputmode="numeric" placeholder="${esc(S.opzeg)}"` })}
                ${sel('contract.aansprak', 'Aansprakelijkheid maximaal', [['opdracht', 'Totaal opdrachtbedrag'], ['verzekerd', 'Verzekerde som'], ['jaar', 'Gefactureerd in 12 maanden']])}
              </div>
              ${chk('contract.zelffacturering', 'Zelffacturering', "Coretic maakt de facturen namens de zzp'er in deze app. Voegt het artikel en het document akkoord zelffacturering toe.")}
              ${chk('contract.vervanging', 'Vrije vervanging', "De zzp'er mag een gelijkwaardige vervanger inzetten. Sterk signaal van zelfstandigheid.")}
              ${chk('contract.relatie', 'Relatiebeding met eindklant', '12 maanden niet rechtstreeks voor de eindklant werken. Een concurrentiebeding staat er bewust niet in.')}
              ${chk('contract.avg', "De zzp'er verwerkt persoonsgegevens", 'Voegt een artikel en het document verwerkersovereenkomst toe.')}
              ${inp('contract.getekend', 'Getekend op', { type: 'date', hint: 'Vul in zodra beide partijen hebben getekend.' })}
              <p class="hint small">Gegevens van Coretic als opdrachtgever wijzig je bij Inhuur › Instellingen.</p>
            </section>
            <div data-cchecks>${listHTML(R.contractChecks(d, S, id))}</div>
            <div class="row"><a class="btn" href="/api/onboarding/${id}/contract" target="_blank" rel="noopener" data-open-contract>Overeenkomst openen en afdrukken</a></div>
          </div>
          <article class="ib-paper" data-paper>${R.contractHtml(s)}</article>
        </div>${saveBar()}`;
      }
      if (step === 'documenten') {
        const groups = ['start', 'tijdens', 'einde'].map((f) => {
          const items = R.DOCS.filter((x) => x.f === f && R.applies(x, d));
          const c = R.docCount(d, f);
          return `<section class="panel panel-pad stack"><div class="row spread"><h2>${R.FASE[f]}</h2><span class="badge ${c.open.length ? 'submitted' : 'approved'}">${c.done}/${c.total}</span></div>
            ${items.map((x) => {
              const st = R.docState(x, d);
              const rec = d.docs[x.k] || {};
              const fl = files.filter((y) => y.doc_key === x.k);
              const ctl = x.auto
                ? `<span class="badge ${st === 'ok' ? 'approved' : ''}">${st === 'ok' ? 'Afgevinkt' : (x.k === 'intake' ? 'Via de intake' : 'Via de tekendatum')}</span>`
                : `<select data-p="docs.${x.k}.s" aria-label="Status"${dis}>${Object.entries(R.DSTAT).map(([v, t]) => `<option value="${v}"${st === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
                   <input type="date" data-p="docs.${x.k}.d" value="${esc(rec.d || '')}" aria-label="Datum"${dis}>`;
              return `<div class="ib-doc${['ok', 'nvt'].includes(st) ? ' done' : ''}">
                <div class="ib-doc-t"><strong>${esc(x.t)}</strong>${x.req ? '' : ' <span class="badge">optioneel</span>'}<span class="hint block">${esc(R.WHO[x.who])} · ${esc(x.why)}</span>
                  ${fl.length ? `<ul class="ib-files">${fl.map((y) => `<li><a href="/api/onboarding/${id}/files/${y.id}">${esc(y.filename)}</a> <span class="muted small">${kb(y.size)} · ${y.uploaded_by ? 'Coretic' : "zzp'er"}</span>${ro ? '' : ` <button type="button" class="btn small ghost" data-delfile="${y.id}">Verwijderen</button>`}</li>`).join('')}</ul>` : ''}</div>
                <div class="ib-doc-c">${ctl}${x.exp ? `<label class="field small">Polis geldig tot<input type="date" data-p="docs.${x.k}.exp" value="${esc(rec.exp || '')}"${dis}></label>` : ''}
                  ${ro || x.auto ? '' : `<label class="btn small">Bestand toevoegen<input type="file" accept="application/pdf,image/png,image/jpeg" data-upload="${x.k}" hidden></label>`}</div>
              </div>`;
            }).join('')}</section>`;
        }).join('');
        const arch = R.isIso(d.opdracht.eind) ? R.addMonths(d.opdracht.eind, 84) : null;
        return `<div class="stack">
          ${groups}
          ${ro ? '' : `<section class="panel panel-pad stack"><h2>Documenten opvragen</h2><p class="muted small">Stuur liever de intakelink: dan levert de zzp'er de documenten zelf aan in zijn dossier. Of kopieer dit verzoek:</p><pre class="ib-pre" data-ask>${esc(askText())}</pre><div><button class="btn small" type="button" data-copy-ask>Kopieer verzoek</button></div></section>`}
          <p class="muted small">Bewaar het dossier ${arch ? `tot minimaal ${R.fmtShort(arch)}` : '7 jaar na het einde van de opdracht'}. Bewaar geen kopie van het identiteitsbewijs. Het BSN vraag je alleen op als er een UBD-opgaaf nodig is.</p>
        </div>${saveBar()}`;
      }
      if (step === 'projecten') {
        const chosen = new Map(d.toewijzing.map((x) => [x.project_id, x.activity_ids]));
        const groups = new Map();
        for (const p of meta.projects) {
          const k = p.client_name || 'Intern';
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(p);
        }
        return `<section class="panel panel-pad stack">
          <div class="row spread"><h2>Projecten en activiteiten</h2>${row.status === 'actief' ? '<span class="badge approved">Wijzigingen gelden direct</span>' : ''}</div>
          <p class="muted small">Kies waarop de zzp'er uren mag schrijven. Bij vrijgeven komt hij automatisch in het team van deze projecten en ziet hij in zijn urenstaat alleen deze projecten en activiteiten, binnen de looptijd ${R.isIso(d.opdracht.start) ? `${R.fmtShort(d.opdracht.start)} t/m ${R.fmtShort(d.opdracht.eind)}` : 'van de opdracht'}. Bij afronden gaat hij weer uit het team.</p>
          ${meta.projects.length ? [...groups.entries()].map(([client, list]) => `
            <div class="ib-proj-group"><h3>${esc(client)}</h3>
              ${list.map((p) => {
                const on = chosen.has(p.id);
                const acts = chosen.get(p.id) || [];
                return `<div class="ib-proj${on ? ' on' : ''}">
                  <label class="check"><input type="checkbox" data-proj="${p.id}"${on ? ' checked' : ''}${dis}> <strong>${esc(p.name)}</strong>${p.code ? ` <span class="muted small">${esc(p.code)}</span>` : ''}${p.billable ? '' : ' <span class="badge">intern</span>'}</label>
                  ${p.activities.length ? `<div class="ib-acts" data-acts="${p.id}"${on ? '' : ' hidden'}>
                    <span class="hint small">Activiteiten${acts.length ? '' : ' (nu alle)'}:</span>
                    ${p.activities.map((a) => `<label class="check small"><input type="checkbox" data-act-of="${p.id}" value="${a.id}"${!acts.length || acts.includes(a.id) ? ' checked' : ''}${dis}> ${esc(a.name)}</label>`).join('')}
                  </div>` : ''}
                </div>`;
              }).join('')}
            </div>`).join('') : '<div class="notice warn">Er zijn nog geen actieve projecten. Maak eerst een project aan bij <a href="#/beheer/projecten">Beheer › Projecten</a>.</div>'}
          ${ro ? '' : '<div class="row"><button class="btn primary" type="button" data-save-projects>Projecten opslaan</button><span class="muted small" data-proj-note></span></div>'}
        </section>`;
      }
      if (step === 'praktijk') {
        const nx = R.nextCheck(d);
        const hist = [...d.checks].sort((a, b) => b.datum.localeCompare(a.datum));
        return `<div class="ib-split narrow">
          <section class="panel panel-pad stack"><h2>Nieuwe praktijkcheck</h2>
            <p class="muted small">Loop dit elk half jaar en bij elke verlenging samen met de zzp'er door. De Belastingdienst kijkt naar hoe er gewerkt wordt, niet alleen naar het contract.</p>
            ${R.PC.map((x) => `<fieldset class="iq"><legend>${esc(x.t)}</legend><div class="iq-opts">${x.o.map((o, i) => `<label><input type="radio" name="pc_${x.id}" value="${i}"${dis}><span>${esc(o)}</span></label>`).join('')}</div></fieldset>`).join('')}
            <div class="form-grid"><label class="field">Datum<input type="date" id="pc-datum" value="${R.todayIso()}"${dis}></label></div>
            <label class="field">Notities en afspraken<textarea id="pc-notes"${dis}></textarea></label>
            ${ro ? '' : '<div><button class="btn primary" type="button" data-save-check>Praktijkcheck vastleggen</button></div>'}
          </section>
          <div class="stack">
            <section class="panel panel-pad stack"><h2>Planning</h2><p>${row.status !== 'actief' ? 'De planning start zodra het dossier is vrijgegeven.' : nx ? `Volgende check: <strong>${R.fmtShort(nx)}</strong> (${R.daysUntil(nx) < 0 ? 'verlopen' : `over ${R.plural(R.daysUntil(nx), 'dag', 'dagen')}`}).` : 'Vul een startdatum in bij Intake.'}</p></section>
            <section class="panel panel-pad stack"><h2>Eerdere checks</h2>${hist.length ? `<ul class="ib-hist">${hist.map((c) => `<li><div class="row spread"><strong>${R.fmtShort(c.datum)}</strong>${verdictBadge(c.uitkomst)}</div>${(c.punten || []).length ? `<span class="muted small">${esc(c.punten.join(' · '))}</span>` : ''}${c.notes ? `<span class="small">${esc(c.notes)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Nog geen praktijkcheck vastgelegd.</p>'}</section>
          </div>
        </div>`;
      }
      // intake
      return `<div class="ib-split">
        <div class="stack">
          <p class="muted small">${esc(d.intake.bron || '')}</p>
          <section class="panel panel-pad stack"><h2>Onderneming</h2>
            <div class="form-grid">
              ${inp('zzp.naam', 'Naam', { attrs: 'maxlength="120"' })}${inp('zzp.bedrijf', 'Bedrijfsnaam', { attrs: 'maxlength="200"' })}
              <label class="field">KvK-nummer<input data-p="zzp.kvk" value="${esc(d.zzp.kvk)}" inputmode="numeric" maxlength="8"${dis}><a class="small" data-kvk target="_blank" rel="noopener noreferrer" href="https://www.kvk.nl/zoeken/">Zoek in het KvK-register</a></label>
              ${inp('zzp.kvkDatum', 'Ingeschreven sinds', { type: 'date' })}${inp('zzp.btw', 'Btw-id', { attrs: 'maxlength="30"' })}
              ${inp('zzp.email', 'E-mail', { type: 'email' })}${inp('zzp.tel', 'Telefoon')}${inp('zzp.web', 'Website')}
              ${inp('zzp.adres', 'Adres, postcode en plaats', { attrs: 'placeholder="Straat 1, 1234 AB Plaats"', full: true })}
            </div>
            ${R.Q.profiel.map(q).join('')}
          </section>
          <section class="panel panel-pad stack"><h2>Opdracht</h2>
            ${ta('opdracht.resultaat', 'Op te leveren resultaat', 'Beschrijf wat er af is, niet een rol. Elke regel wordt een deelresultaat in de overeenkomst.')}
            <div class="form-grid">
              ${inp('opdracht.klant', 'Eindklant', { hint: 'Leeg als het werk voor Coretic zelf is' })}
              ${inp('opdracht.start', 'Startdatum', { type: 'date', hint: 'Vanaf deze dag kan de zzp\'er uren schrijven' })}
              ${inp('opdracht.eind', 'Einddatum', { type: 'date', hint: 'Tot en met deze dag' })}
              ${inp('opdracht.tarief', 'Uurtarief zzp\'er excl. btw (€)', { attrs: 'inputmode="decimal"' })}
              ${inp('opdracht.uren', 'Inschatting uren (totaal)', { attrs: 'inputmode="decimal"' })}
            </div>
            ${R.Q.opdracht.map(q).join('')}
          </section>
          <section class="panel panel-pad stack"><h2>Gezag</h2>${R.Q.gezag.map(q).join('')}</section>
          <section class="panel panel-pad stack"><h2>Inbedding</h2>${R.Q.inbed.map(q).join('')}</section>
          <section class="panel panel-pad stack"><h2>Ondernemerschap</h2>${R.Q.ond.map(q).join('')}</section>
          <section class="panel panel-pad stack"><h2>Verklaring en beoordeling</h2>
            ${chk('intake.akkoord', "De zzp'er verklaart de intake naar waarheid te hebben ingevuld", 'En meldt het als de situatie wezenlijk verandert.')}
            <div class="form-grid">${inp('intake.plaats', 'Plaats')}${inp('intake.datum', 'Datum', { type: 'date' })}</div>
            ${ta('intake.notes', 'Notities van Coretic', "Niet zichtbaar voor de zzp'er. Bijvoorbeeld de uitslag van de Webmodule en wat je hebt afgesproken.")}
          </section>
        </div>
        <aside class="ib-side"><section class="panel panel-pad stack" data-risk>${riskHTML()}</section></aside>
      </div>${saveBar()}`;
    }

    function askText() {
      const need = R.DOCS.filter((x) => x.who === 'zzp' && !x.auto && R.applies(x, d) && x.f === 'start' && !R.docDone(x, d));
      return `Hoi ${d.zzp.naam ? d.zzp.naam.split(' ')[0] : ''},\n\nVoor de opdracht${d.opdracht.klant ? ` bij ${d.opdracht.klant}` : ''} leg ik een dossier aan, zodat we kunnen laten zien dat je als zelfstandige werkt. Wil je mij het volgende sturen?\n\n${need.map((x) => `- ${x.t}`).join('\n') || '- Alles is binnen, dank je.'}\n\nAlvast bedankt,\n${ctx.user.name.split(' ')[0]}`;
    }

    /* ---------- live bijwerken ---------- */
    function refresh() {
      el.querySelector('[data-name]').textContent = d.zzp.naam || 'Naamloos dossier';
      el.querySelector('[data-co]').textContent = d.zzp.bedrijf || '';
      const risk = el.querySelector('[data-risk]');
      if (risk) risk.innerHTML = riskHTML();
      const paper = el.querySelector('[data-paper]');
      if (paper) paper.innerHTML = R.contractHtml(R.contractData(d, S, id));
      const cc = el.querySelector('[data-cchecks]');
      if (cc) cc.innerHTML = listHTML(R.contractChecks(d, S, id));
      const kvk = el.querySelector('[data-kvk]');
      if (kvk) {
        const ok = /^\d{8}$/.test(d.zzp.kvk);
        const term = ok ? d.zzp.kvk : (d.zzp.bedrijf || d.zzp.naam);
        kvk.href = `https://www.kvk.nl/zoeken/${term ? `?source=all&q=${encodeURIComponent(term)}` : ''}`;
        kvk.textContent = ok ? 'Controleer in het KvK-register' : 'Zoek in het KvK-register';
      }
    }
    const setPath = (p, v) => { const ks = p.split('.'); let a = d; for (let i = 0; i < ks.length - 1; i += 1) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = {}; a = a[ks[i]]; } a[ks[ks.length - 1]] = v; };
    const markDirty = () => { const f = el.querySelector('#ib-form'); f.dataset.dirty = '1'; const n = el.querySelector('[data-dirty-note]'); if (n) n.textContent = 'Niet opgeslagen wijzigingen'; };
    const isDirty = () => Boolean(el.querySelector('#ib-form[data-dirty]'));

    async function save({ quiet = false } = {}) {
      const res = await ctx.api(`/onboarding/${id}`, { method: 'PUT', body: { data: d, updated_at: updatedAt } });
      updatedAt = res.updated_at;
      const f = el.querySelector('#ib-form');
      if (f) delete f.dataset.dirty;
      if (!quiet) ctx.toast('Dossier opgeslagen');
    }
    async function act(fn, okMsg) {
      try {
        if (isDirty()) await save({ quiet: true });
        await fn();
        if (okMsg) ctx.toast(okMsg);
        await ctx.render();
      } catch (e) { ctx.toast(e.message, true); }
    }

    function bind() {
      const form = el.querySelector('#ib-form');
      form.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.p && t.type !== 'checkbox' && t.type !== 'radio' && t.tagName !== 'SELECT') { setPath(t.dataset.p, t.value); markDirty(); refresh(); }
      });
      form.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.q) { d.intake.answers[t.dataset.q] = Number(t.value); markDirty(); refresh(); return; }
        if (t.dataset.upload) { upload(t.dataset.upload, t.files[0]); return; }
        if (!t.dataset.p) return;
        const v = t.type === 'checkbox' ? t.checked : t.value;
        setPath(t.dataset.p, v);
        if (t.dataset.p.startsWith('docs.') && t.dataset.p.endsWith('.s') && v) {
          const k = t.dataset.p.split('.')[1];
          if (!d.docs[k].d) { d.docs[k].d = R.todayIso(); const di = form.querySelector(`[data-p="docs.${k}.d"]`); if (di) di.value = d.docs[k].d; }
        }
        markDirty();
        // Velden die bepalen welke documenten of artikelen er zijn: scherm opnieuw opbouwen.
        if (['contract.prijsvorm', 'contract.avg', 'contract.zelffacturering', 'intake.akkoord', 'contract.getekend'].includes(t.dataset.p)) {
          const y = window.scrollY; const keep = form.dataset.dirty; render(); if (keep) markDirty(); window.scrollTo(0, y);
        } else refresh();
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await save(); render(); } catch (ex) { ctx.toast(ex.message, true); }
      });
      el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/inhuur/${id}/${b.dataset.step}`; }));
      el.querySelector('[data-open-contract]')?.addEventListener('click', async (e) => {
        if (!isDirty()) return;
        e.preventDefault();
        const w = window.open('about:blank', '_blank');
        try { await save({ quiet: true }); if (w) w.location = `/api/onboarding/${id}/contract`; } catch (ex) { if (w) w.close(); ctx.toast(ex.message, true); }
      });
      el.querySelector('[data-copy-ask]')?.addEventListener('click', () => copy(askText(), 'Verzoek gekopieerd'));
      el.querySelectorAll('[data-delfile]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await ctx.confirmDialog('Bestand verwijderen', 'Het bestand wordt definitief uit het dossier verwijderd.', 'Verwijderen', true))) return;
        try { const r = await ctx.api(`/onboarding/${id}/files/${b.dataset.delfile}`, { method: 'DELETE' }); updatedAt = r.updated_at; files = files.filter((f) => String(f.id) !== b.dataset.delfile); const keep = isDirty(); render(); if (keep) markDirty(); } catch (ex) { ctx.toast(ex.message, true); }
      }));
      el.querySelector('[data-save-check]')?.addEventListener('click', saveCheck);
      el.querySelectorAll('[data-proj]').forEach((cb) => cb.addEventListener('change', () => {
        const box = el.querySelector(`[data-acts="${cb.dataset.proj}"]`);
        if (box) box.hidden = !cb.checked;
        cb.closest('.ib-proj').classList.toggle('on', cb.checked);
        const n = el.querySelector('[data-proj-note]'); if (n) n.textContent = 'Niet opgeslagen';
      }));
      el.querySelectorAll('[data-act-of]').forEach((cb) => cb.addEventListener('change', () => { const n = el.querySelector('[data-proj-note]'); if (n) n.textContent = 'Niet opgeslagen'; }));
      el.querySelector('[data-save-projects]')?.addEventListener('click', saveProjects);

      // Toegang
      el.querySelector('[data-invite]')?.addEventListener('click', () => act(async () => {
        const r = await ctx.api(`/onboarding/${id}/invite`, { method: 'POST' });
        await inviteDialog(r.url);
      }));
      el.querySelector('[data-revoke]')?.addEventListener('click', () => act(() => ctx.api(`/onboarding/${id}/invite`, { method: 'DELETE' }), 'Intakelink ingetrokken'));
      el.querySelector('[data-reopen]')?.addEventListener('click', () => act(() => ctx.api(`/onboarding/${id}/reopen`, { method: 'POST' }), 'De zzp\'er kan de intake weer aanpassen'));
      el.querySelector('[data-sync]')?.addEventListener('click', () => act(() => ctx.api(`/onboarding/${id}/sync-contractor`, { method: 'POST' }), 'Zzp-gegevens overgenomen naar Beheer › Medewerkers'));
      el.querySelector('[data-unlink]')?.addEventListener('click', () => act(() => ctx.api(`/onboarding/${id}/link`, { method: 'POST', body: { user_id: null } }), 'Account ontkoppeld'));
      el.querySelector('[data-link]')?.addEventListener('click', () => linkDialog());
      el.querySelector('[data-account]')?.addEventListener('click', () => accountDialog());
      el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
        const to = b.dataset.status;
        const msg = to === 'afgerond' ? "Na afronden kan de zzp'er voor deze opdracht geen uren meer schrijven." : to === 'afgewezen' ? 'Het dossier wordt gemarkeerd als niet doorgegaan.' : `Status wordt ${R.STATUS[to]}.`;
        if (!(await ctx.confirmDialog(`${R.STATUS[to]}`, msg, 'Doorgaan', to === 'afgewezen'))) return;
        act(() => ctx.api(`/onboarding/${id}/status`, { method: 'POST', body: { status: to } }));
      }));
      el.querySelector('[data-release]')?.addEventListener('click', () => release());
      el.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await ctx.confirmDialog('Dossier verwijderen', 'Het dossier en alle bestanden worden definitief verwijderd. Bewaarplicht: verwijder geen dossiers van opdrachten die zijn uitgevoerd.', 'Verwijderen', true))) return;
        try { await ctx.api(`/onboarding/${id}`, { method: 'DELETE' }); const f = el.querySelector('#ib-form'); if (f) delete f.dataset.dirty; location.hash = '#/inhuur'; } catch (ex) { ctx.toast(ex.message, true); }
      });
    }

    async function copy(text, ok) {
      try { await navigator.clipboard.writeText(text); ctx.toast(ok); } catch { ctx.toast('Kopiëren lukt hier niet. Selecteer de tekst en kopieer hem zelf.', true); }
    }

    async function upload(key, file) {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { ctx.toast('Bestand is groter dan 5 MB', true); return; }
      try {
        const res = await fetch(`/api/onboarding/${id}/files?doc=${encodeURIComponent(key)}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
          body: file,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
        updatedAt = data.updated_at;
        files = [...files, data];
        if (!(d.docs[key] && d.docs[key].s)) { d.docs[key] = { ...(d.docs[key] || {}), s: 'ok', d: R.todayIso() }; }
        render(); markDirty();
        ctx.toast(`${file.name} toegevoegd. Sla het dossier op om de status vast te leggen.`);
      } catch (e) { ctx.toast(e.message, true); }
    }

    function projectLabels() {
      return d.toewijzing.map((x) => {
        const p = meta.projects.find((y) => y.id === x.project_id);
        if (!p) return `project ${x.project_id} (afgesloten)`;
        const acts = x.activity_ids.map((a) => (p.activities.find((y) => y.id === a) || {}).name).filter(Boolean);
        return `${p.client_name ? `${p.client_name} / ` : ''}${p.name}${acts.length ? ` (${acts.join(', ')})` : ''}`;
      }).join('; ');
    }

    async function saveProjects() {
      const items = [];
      for (const cb of el.querySelectorAll('[data-proj]:checked')) {
        const pid = Number(cb.dataset.proj);
        const acts = [...el.querySelectorAll(`[data-act-of="${pid}"]`)];
        const on = acts.filter((a) => a.checked).map((a) => Number(a.value));
        if (acts.length && !on.length) { ctx.toast('Kies per project minstens één activiteit', true); return; }
        items.push({ project_id: pid, activity_ids: on.length === acts.length ? [] : on });
      }
      try {
        if (isDirty() && el.querySelector('[data-p]')) await save({ quiet: true });
        const res = await ctx.api(`/onboarding/${id}/assignments`, { method: 'PUT', body: { items, updated_at: updatedAt } });
        d.toewijzing = res.toewijzing;
        updatedAt = res.updated_at;
        const f = el.querySelector('#ib-form'); if (f) delete f.dataset.dirty;
        ctx.toast(row.status === 'actief' ? 'Projecten opgeslagen. De urenstaat van de zzp\'er is bijgewerkt.' : 'Projecten opgeslagen');
        render();
      } catch (e) { ctx.toast(e.message, true); }
    }

    async function saveCheck() {
      const ans = {};
      const punten = [];
      let worst = 0;
      let missing = 0;
      for (const x of R.PC) {
        const c = el.querySelector(`input[name="pc_${x.id}"]:checked`);
        if (!c) { missing += 1; continue; }
        const i = Number(c.value);
        ans[x.id] = i;
        worst = Math.max(worst, x.s[i]);
        if (x.s[i] > 0) punten.push(`${x.t.replace(/\?$/, '')}: ${x.o[i].toLowerCase()}`);
      }
      if (missing) { ctx.toast(`Beantwoord nog ${R.plural(missing, 'vraag', 'vragen')}`, true); return; }
      d.checks.push({ datum: el.querySelector('#pc-datum').value || R.todayIso(), answers: ans, uitkomst: ['ok', 'warn', 'bad'][worst], punten, notes: el.querySelector('#pc-notes').value.trim() });
      try { await save({ quiet: true }); ctx.toast('Praktijkcheck vastgelegd'); render(); } catch (e) { d.checks.pop(); ctx.toast(e.message, true); }
    }

    function inviteDialog(url) {
      return new Promise((resolve) => {
        const text = `Hoi${d.zzp.naam ? ` ${d.zzp.naam.split(' ')[0]}` : ''},\n\nWil je via deze persoonlijke link de intake voor Coretic invullen en je documenten aanleveren? Het kost ongeveer 10 minuten. Daarna maak ik de overeenkomst in orde en krijg je toegang tot de urenregistratie.\n\n${url}\n\nDe link is 30 dagen geldig.\n\nGroet,\n${ctx.user.name.split(' ')[0]}`;
        const dlg = ctx.openDialog({
          title: 'Intakelink', submit: 'Kopieer bericht', wide: true,
          body: `<p class="muted small">Deze link zie je maar één keer. Een nieuwe link maken maakt de vorige ongeldig.</p>
            <label class="field">Link<input readonly value="${esc(url)}" data-url></label>
            <label class="field">Bericht<textarea readonly rows="9">${esc(text)}</textarea></label>`,
          onSubmit: async () => { await copy(text, 'Bericht met link gekopieerd'); return false; },
        });
        dlg.querySelector('[data-url]').addEventListener('focus', (e) => e.target.select());
        dlg.addEventListener('close', resolve);
      });
    }

    function linkDialog() {
      const users = meta.users.filter((u) => u.active);
      ctx.openDialog({
        title: 'Bestaand account koppelen', submit: 'Koppelen',
        body: `<label class="field">Account<select name="user_id" required><option value="">Kies…</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.email)})${u.is_contractor ? ' · zzp\'er' : ''}</option>`).join('')}</select></label>
          <p class="hint small">Alleen medewerker-accounts. Gebruik daarna Zzp-gegevens overnemen om het account als ingehuurde zzp'er in te stellen.</p>`,
        onSubmit: async (fd) => {
          if (!fd.get('user_id')) throw new Error('Kies een account');
          if (isDirty()) await save({ quiet: true });
          await ctx.api(`/onboarding/${id}/link`, { method: 'POST', body: { user_id: Number(fd.get('user_id')) } });
          ctx.toast('Account gekoppeld');
          ctx.render();
        },
      });
    }

    function accountDialog() {
      ctx.openDialog({
        title: "Account voor de zzp'er", submit: 'Account aanmaken',
        body: `<p class="muted small">Maakt een medewerker-account aan zonder contracturen, stelt het in als ingehuurde zzp'er met de gegevens uit dit dossier en koppelt het. Uren schrijven kan pas na vrijgeven.</p>
          <div class="form-grid">
            <label class="field">Naam<input name="name" value="${esc(d.zzp.naam)}" required maxlength="120"></label>
            <label class="field">E-mail<input name="email" type="email" value="${esc(d.zzp.email)}" required maxlength="200"></label>
          </div>
          <label class="field">Wachtwoord<span class="hint">Minstens 10 tekens. Geef het persoonlijk door.</span><input name="password" type="text" autocomplete="new-password" minlength="10" required></label>`,
        onSubmit: async (fd) => {
          if (isDirty()) await save({ quiet: true });
          await ctx.api(`/onboarding/${id}/account`, { method: 'POST', body: { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') } });
          ctx.toast('Account aangemaakt en gekoppeld');
          ctx.render();
        },
      });
    }

    async function release(note) {
      try {
        if (isDirty()) await save({ quiet: true });
        await ctx.api(`/onboarding/${id}/release`, { method: 'POST', body: note ? { note } : {} });
        ctx.toast("Vrijgegeven: de zzp'er kan uren schrijven binnen de looptijd");
        ctx.render();
      } catch (e) {
        const data = e.data || {};
        if (data.problems) {
          ctx.openDialog({ title: 'Nog niet compleet', submit: 'Sluiten', body: `<ul class="tight">${data.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, onSubmit: () => {} });
        } else if (data.code === 'NEEDS_NOTE') {
          ctx.openDialog({
            title: 'Vrijgeven ondanks waarschuwingen', submit: 'Vrijgeven', danger: true,
            body: `<div class="notice warn"><ul class="tight">${data.soft.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
              <label class="field">Waarom geef je toch vrij?<span class="hint">Komt in het logboek en in het dossier. Minstens 15 tekens.</span><textarea name="note" required minlength="15" maxlength="1000"></textarea></label>`,
            onSubmit: async (fd) => {
              const n = String(fd.get('note') || '').trim();
              if (n.length < 15) throw new Error('Geef een motivering van minstens 15 tekens');
              await ctx.api(`/onboarding/${id}/release`, { method: 'POST', body: { note: n } });
              ctx.toast('Vrijgegeven');
              ctx.render();
            },
          });
        } else ctx.toast(e.message, true);
      }
    }

    render();
  }

  /* ================= Advies ================= */

  function viewAdvice(el) {
    const card = (tag, lvl, t, body, why = '') => `<section class="panel panel-pad stack ib-card"><span class="badge ${lvl}">${tag}</span><h2>${t}</h2>${body}${why ? `<p class="muted small">${why}</p>` : ''}</section>`;
    el.innerHTML = `
      <div class="stack">
        <div class="row spread"><h1>Inhuur zzp'ers</h1></div>
        ${tabsHTML('advies')}
        <p class="muted">Aanvullingen op intake en overeenkomst, op basis van de stand van oktober 2026. Geen juridisch of fiscaal advies: laat de eerste opzet één keer toetsen door je belastingadviseur.</p>
        <div class="ib-cards">
          ${card('Vóór 1 januari 2027', 'rejected', 'De Wtta raakt ook je detacheringsplan', `<p>De Wtta geldt voor iedereen die arbeidskrachten ter beschikking stelt, ook zzp'ers. Dat zijn niet alleen zzp'ers die onder leiding van een klant werken, maar ook eigen medewerkers die je detacheert.</p><ul class="tight"><li>Meld je in principe vóór 1 januari 2027 bij de Nederlandse Autoriteit Uitleenmarkt (NAU).</li><li>Vraag tussen 1 mei en 30 juni 2027 een toelating aan. De aanvraag kost €1.960, daarna betaal je een jaarlijkse vergoeding.</li><li>Leen je in zeer beperkte mate uit, vraag dan ontheffing aan.</li><li>Een opdracht met een afgebakend resultaat en eigen leiding valt er niet onder.</li></ul>`, 'Inleners moeten controleren of hun uitlener een toelating heeft, dus klanten gaan erom vragen.')}
          ${card('Elk jaar in januari', 'submitted', 'UBD-opgaaf bij zzp\'ers met KOR', '<p>Factureert een zzp\'er zonder btw, bijvoorbeeld door de kleineondernemersregeling? Dan geef je de betalingen vóór 31 januari door aan de Belastingdienst, met BSN, geboortedatum en adres. Geen opgaaf bij facturen met btw of bij een zzp\'er met een eigen BV.</p>', 'Het dossier voegt het document met deze gegevens toe als de zzp\'er de KOR toepast.')}
          ${card('Bij zelffacturering', 'submitted', 'Zelffacturering mag, met een getekende afspraak', '<p>Coretic maakt in deze app de facturen namens de zzp\'er. Dat mag, maar alleen met een vooraf schriftelijk vastgelegde afspraak en een procedure waarin de zzp\'er elke factuur accepteert. De overeenkomst bevat daarvoor een artikel; de zzp\'er geeft in de app akkoord of maakt bezwaar.</p><p>De urenregistratie is een specificatie voor de factuur, geen controle op de werkwijze. Keur uren dus goed op juistheid, niet op hoe het werk is gedaan.</p>')}
          ${card('Bij elke klant', 'submitted', 'Check je klantcontracten op onderaanneming', '<ul class="tight"><li>Veel raamovereenkomsten verbieden onderaanneming zonder schriftelijke toestemming.</li><li>Stem IE, geheimhouding en aansprakelijkheid back-to-back af: wat jij de klant belooft, moet de zzp\'er aan jou beloven.</li><li>Klanten met beveiligde omgevingen eisen vaak screening of een VOG.</li></ul>')}
          ${card('Bij oprichting', 'submitted', 'Contracteer vanuit Coretic B.V.', '<p>Zolang de werkmaatschappij niet is ingeschreven, contracteer je vanuit DVN Technology B.V. Zet nieuwe overeenkomsten daarna op naam van Coretic B.V. (Instellingen) en zet bestaande over met een contractsovername die alle partijen tekenen.</p>')}
          ${card('Vanaf 2028 verwacht', '', 'Zelfstandigenwet', '<p>Het voorstel ligt sinds oktober 2026 in internetconsultatie en moet per 1 januari 2028 ingaan. Het vraagt onder meer:</p><ul class="tight"><li>KvK, btw-nummer en een zakelijke rekening</li><li>minimaal 3 opdrachtgevers in dit en vorig jaar</li><li>een vast minimumbedrag aan voorzieningen, zoals AOV, pensioen en aansprakelijkheid</li><li>per opdracht vastleggen dat de zzp\'er vrij is in hoe, waar en wanneer</li></ul>', 'De intake vraagt deze punten al uit.')}
          ${card('Eenmalig', '', 'Overeenkomst laten toetsen', '<p>De algemene modelovereenkomst \'geen werkgeversgezag\' van de Belastingdienst was goedgekeurd tot 1 juni 2026. Controleer of die is verlengd, of leg je eigen overeenkomst voor. Een goedgekeurde tekst helpt alleen als de praktijk overeenkomt.</p>')}
          ${card('Eenmalig', '', 'Je eigen verzekering en privacy', '<ul class="tight"><li>Vraag je verzekeraar of je beroepsaansprakelijkheid ook werk door onderaannemers dekt.</li><li>Bewaar geen kopie van het identiteitsbewijs. Vraag het BSN alleen op voor een UBD-opgaaf.</li><li>Bewaar dossiers 7 jaar na het einde van de opdracht.</li></ul>')}
          ${card('Dagelijkse praktijk', 'submitted', 'Wat in de praktijk het verschil maakt', '<ul class="tight"><li>Geef zzp\'ers geen @coretic.nl-adres, geen visitekaartjes, kleding of personeelsuitjes.</li><li>Voer geen functioneringsgesprekken. Bespreek de oplevering.</li><li>Verleng nooit stilzwijgend. Maak een nieuwe opdracht met een nieuw resultaat en een nieuwe looptijd.</li></ul>', 'Juist hier gaat het bij een bedrijfsbezoek vaak mis.')}
          ${card('Bij groei', '', 'Coöperatie en zzp\'ers', '<p>Bepaal vooraf of zzp\'ers lid kunnen worden van de coöperatie U.A., en met welke rechten en plichten. Laat de fiscale gevolgen van lidmaatschap en winstdeling toetsen voordat je het aanbiedt.</p>')}
        </div>
        <section class="panel">
          <div class="panel-pad"><h2>Documentenkaart</h2><p class="muted small">Alles wat in een volledig dossier hoort. Elk dossier toont dezelfde lijst, toegespitst op de situatie.</p></div>
          <div class="table-wrap"><table class="data"><thead><tr><th>Document</th><th>Wanneer</th><th>Van wie</th><th>Waarom</th></tr></thead><tbody>
            ${R.DOCS.map((x) => `<tr><td><strong>${esc(x.t)}</strong>${x.req ? '' : ' <span class="badge">optioneel</span>'}${x.cond ? ' <span class="badge invoiced">situatie</span>' : ''}</td><td>${R.FASE[x.f]}</td><td>${esc(R.WHO[x.who])}</td><td class="small muted">${esc(x.why)}</td></tr>`).join('')}
            <tr><td><strong>Praktijkcheck</strong></td><td>Elk half jaar en bij verlenging</td><td>Coretic en zzp'er</td><td class="small muted">Bewijs dat de praktijk overeenkomt met de overeenkomst.</td></tr>
          </tbody></table></div>
        </section>
        <section class="panel panel-pad stack"><h2>Tijdlijn</h2>
          <dl class="facts">
            <dt>1 jan 2025</dt><dd>Handhaving Wet DBA hervat. Naheffingen loonheffingen mogelijk vanaf deze datum.</dd>
            <dt>2026</dt><dd>Geen verzuimboetes, wel vergrijpboetes bij opzet of grove schuld. Controle start meestal met een bedrijfsbezoek.</dd>
            <dt>okt 2026</dt><dd>Internetconsultatie Zelfstandigenwet.</dd>
            <dt>1 jan 2027</dt><dd>Zachte landing vervalt. Wtta treedt in werking: melden bij de NAU.</dd>
            <dt>mei–jun 2027</dt><dd>Aanvraagperiode Wtta-toelating.</dd>
            <dt>1 jan 2028</dt><dd>Beoogde ingangsdatum Zelfstandigenwet.</dd>
            <dt>Nog onbekend</dt><dd>Rechtsvermoeden van werknemerschap bij een tarief tot €38 per uur.</dd>
          </dl>
        </section>
      </div>`;
    bindGo(el);
    ctx.labelTables(el);
  }

  return { view, LVL_CLASS };
})();
