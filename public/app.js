(() => {
  'use strict';

  const app = document.getElementById('app');
  const state = { user: null, pendingCount: 0, sheet: null, extraRows: {}, sheetFilter: { projects: [], activities: [], onlyHours: false }, filterOpen: false, invoicePeriod: null, reportPeriod: null };

  /* ================= Hulpfuncties ================= */

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const nl = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 });
  const eurFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
  const fh = (n) => nl.format(n || 0);
  const eur = (n) => eurFmt.format(n || 0);
  const eur0Fmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const eur0 = (n) => eur0Fmt.format(n || 0);
  const pct = (n) => (n === null || n === undefined ? '–' : `${Math.round(n * 100)}%`);
  const DAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
  const DAYS_LONG = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
  const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const STATUS = {
    draft: 'Concept', submitted: 'Ingediend', approved: 'Goedgekeurd', rejected: 'Afgekeurd', invoiced: 'Gefactureerd',
  };
  const EDITABLE = ['draft', 'rejected'];

  const pad = (n) => String(n).padStart(2, '0');
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const dow = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = (iso) => addDays(iso, -dow(iso));
  function isoWeek(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }
  function fmtDate(iso, withYear = false) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
  }
  function fmtRange(a, b) {
    const sameYear = a.slice(0, 4) === b.slice(0, 4);
    return `${fmtDate(a, !sameYear)} – ${fmtDate(b, true)}`;
  }
  function monthBounds(offset = 0) {
    const t = new Date();
    const first = new Date(t.getFullYear(), t.getMonth() + offset, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + offset + 1, 0);
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { from: iso(first), to: iso(last) };
  }
  // Accepteert 7,5 · 7.5 · 7:30
  function parseHours(raw) {
    const v = String(raw).trim();
    if (v === '') return 0;
    const time = v.match(/^(\d{1,2}):(\d{2})$/);
    if (time) return Number(time[1]) + Number(time[2]) / 60;
    if (!/^\d{0,2}([.,]\d{0,2})?$/.test(v)) return NaN;
    return Math.round(parseFloat(v.replace(',', '.')) * 100) / 100;
  }
  const fmtInput = (h) => (h ? String(h).replace('.', ',') : '');

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/auth/') && state.user) {
        state.user = null;
        render();
      }
      if (res.status === 403 && data && data.code === 'MFA_SETUP_REQUIRED' && state.user && !state.user.mfa_setup_required) {
        state.user.mfa_setup_required = true;
        render();
      }
      const err = new Error((data && data.error) || `Fout ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(message, isError = false) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = message;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3500);
  }

  function openDialog({ title, body, submit = 'Opslaan', danger = false, wide = false, onSubmit, onOpen }) {
    const dlg = document.createElement('dialog');
    if (wide) dlg.classList.add('wide');
    dlg.innerHTML = `
      <form novalidate>
        <h2>${esc(title)}</h2>
        <div class="dialog-body stack">${body}</div>
        <p class="err" hidden></p>
        <div class="actions">
          <button type="button" class="btn" data-cancel>Annuleren</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('.err');
    let dirty = false;
    form.addEventListener('input', () => { dirty = true; });
    const tryClose = () => {
      if (dirty && form.querySelector('input:not([type=checkbox]):not([type=hidden]), textarea, select')
        && !window.confirm('Wijzigingen in dit venster weggooien?')) return;
      dlg.close();
    };
    dlg.querySelector('[data-cancel]').addEventListener('click', tryClose);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); tryClose(); });
    dlg.addEventListener('close', () => dlg.remove());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      err.hidden = true;
      try {
        const result = await onSubmit(new FormData(form), form);
        if (result !== false) dlg.close();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    dlg.showModal();
    if (onOpen) onOpen(form);
    const first = form.querySelector('input:not([type="hidden"]):not(:disabled), select, textarea:not(:disabled)');
    if (first) first.focus();
    return dlg;
  }

  const confirmDialog = (title, text, submit, danger = false) => new Promise((resolve) => {
    let ok = false;
    const dlg = openDialog({
      title, submit, danger, body: `<p>${text}</p>`,
      onSubmit: () => { ok = true; },
    });
    dlg.addEventListener('close', () => resolve(ok));
  });

  const statusBadge = (s) => `<span class="badge ${s}">${STATUS[s] || s}</span>`;
  const bar = (ratio) => {
    const w = Math.max(0, Math.min(1, ratio || 0)) * 100;
    return `<div class="bar${ratio > 1 ? ' over' : ''}"><span style="width:${w.toFixed(1)}%"></span></div>`;
  };
  // Budgetbalk: kleur op basis van wat er nog over is. Groen 50-100%, oranje 25-50%, rood < 25% of overschreden.
  function budgetLevel(used, budget) {
    if (used > budget) return 'over';
    const left = 1 - used / budget;
    return left >= 0.5 ? 'ok' : left >= 0.25 ? 'warn' : 'low';
  }
  function budgetBar(used, budget, unit = 'hours', kind = '') {
    const money = unit === 'amount';
    const f = money ? eur : (x) => `${fh(x)} uur`;
    const lvl = budgetLevel(used, budget);
    const left = budget - used;
    const title = left >= 0
      ? `Nog ${f(left)} over (${Math.round((left / budget) * 100)}%)`
      : `${f(-left)} over budget`;
    const text = money ? `${eur0(used)} / ${eur0(budget)}` : `${fh(used)} / ${fh(budget)} uur`;
    const g = money ? eur0 : (x) => `${fh(x)} uur`;
    const leftText = left > 0.005 ? `Nog ${g(left)} beschikbaar` : left >= -0.005 ? 'Budget is op' : `${g(-left)} over budget`;
    return `<div class="budget-line lvl-${lvl}" title="${esc(title)}">
      <div class="bbar"><span style="width:${Math.min(100, (used / budget) * 100).toFixed(1)}%"></span></div>
      <span class="nowrap"${kind ? ` data-kind="${esc(kind)}"` : ''}>${text}</span>
      <span class="budget-left">${leftText}</span></div>`;
  }
  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

  /* ================= Router & shell ================= */

  // Eenvoudige lijn-iconen (24×24, currentColor).
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    check: '<path d="M4 12.5 9 17.5 20 6.5"/>',
    invoice: '<path d="M6.5 3.5h11v17l-2.75-1.6L12 20.5l-2.75-1.6L6.5 20.5z"/><path d="M9.5 8.5h5M9.5 12h5"/>',
    more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
    user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.7 4-5.5 7.5-5.5s6.3 1.8 7.5 5.5"/>',
    chart: '<path d="M4 20h16M7 16.5V11M12 16.5V6.5M17 16.5v-4"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
    logout: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
  };
  const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;

  const ROUTES = {
    overzicht: { title: 'Overzicht', admin: true, render: viewDashboard },
    uren: { title: 'Uren', render: viewTimesheet },
    goedkeuren: { title: 'Goedkeuren', admin: true, render: viewApprovals },
    facturen: { title: 'Facturen', admin: true, render: viewInvoicing },
    rapportage: { title: 'Rapportage', admin: true, render: viewReports },
    beheer: { title: 'Beheer', admin: true, render: viewAdmin },
    account: { title: 'Account', hidden: true, render: viewAccount },
  };

  function currentRoute() {
    const [name, ...params] = location.hash.replace(/^#\/?/, '').split('/');
    const fallback = state.user && state.user.role === 'admin' ? 'overzicht' : 'uren';
    return { name: ROUTES[name] ? name : fallback, params };
  }

  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).filter((c) => /[A-Za-z]/.test(c)).slice(0, 2).join('').toUpperCase() || '?';
  const pendingBadge = () => (state.pendingCount ? ` <span class="badge count" data-pending>${state.pendingCount}</span>` : '');

  function shellHTML(active) {
    const isAdmin = state.user.role === 'admin';
    const links = Object.entries(ROUTES)
      .filter(([, r]) => !r.hidden && (!r.admin || isAdmin))
      .map(([key, r]) => `<a href="#/${key}"${key === active ? ' aria-current="page"' : ''}>${r.title}${key === 'goedkeuren' ? pendingBadge() : ''}</a>`)
      .join('');
    // Tabbalk onderaan op mobiel: de vier belangrijkste plekken, de rest onder "Meer".
    const tabs = isAdmin
      ? [['overzicht', 'Overzicht', 'home'], ['uren', 'Uren', 'clock'], ['goedkeuren', 'Goedkeuren', 'check'], ['facturen', 'Facturen', 'invoice']]
      : [['uren', 'Uren', 'clock'], ['account', 'Account', 'user']];
    const moreActive = !tabs.some(([k]) => k === active);
    const tabbar = `
      <nav class="tabbar" aria-label="Hoofdmenu mobiel">
        ${tabs.map(([k, label, ic]) => `<a href="#/${k}"${k === active ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${k === 'goedkeuren' && state.pendingCount ? `<span class="tab-badge" data-pending>${state.pendingCount}</span>` : ''}</a>`).join('')}
        ${isAdmin ? `<button type="button" data-more${moreActive ? ' aria-current="page"' : ''}>${icon('more')}<span>Meer</span></button>` : ''}
      </nav>`;
    return `
      <header class="topbar">
        <a class="brand" href="#/">Coretic <span>uren</span></a>
        <nav class="nav" aria-label="Hoofdmenu">${links}</nav>
        <div class="userbox">
          <a href="#/account" class="user-link"><span class="avatar" aria-hidden="true">${esc(initials(state.user.name))}</span><span class="user-name">${esc(state.user.name)}</span></a>
          <button class="btn small ghost logout-btn" type="button" data-logout>Uitloggen</button>
        </div>
      </header>
      <main id="view"></main>
      ${tabbar}`;
  }

  // Bladmenu "Meer" op mobiel.
  function openMoreSheet() {
    const items = [['rapportage', 'Rapportage', 'chart'], ['beheer', 'Beheer', 'cog'], ['account', 'Account', 'user']];
    const sheet = document.createElement('div');
    sheet.className = 'sheet-backdrop';
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-label="Meer">
        <div class="sheet-handle" aria-hidden="true"></div>
        ${items.map(([k, label, ic]) => `<a href="#/${k}" class="sheet-item">${icon(ic)}<span>${label}</span>${icon('chevron', 'chev')}</a>`).join('')}
        <button type="button" class="sheet-item danger" data-logout-sheet>${icon('logout')}<span>Uitloggen</span></button>
      </div>`;
    const close = () => sheet.remove();
    sheet.addEventListener('click', async (e) => {
      if (e.target === sheet || e.target.closest('a')) close();
      if (e.target.closest('[data-logout-sheet]')) {
        close();
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        state.user = null;
        location.hash = '';
        render();
      }
    });
    document.addEventListener('keydown', function esc1(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc1); } });
    document.body.appendChild(sheet);
  }

  async function refreshPending() {
    if (!state.user || state.user.role !== 'admin') return;
    try {
      const rows = await api('/approvals?status=submitted');
      state.pendingCount = rows.length;
      const link = document.querySelector('.nav a[href="#/goedkeuren"]');
      if (link) link.innerHTML = `Goedkeuren${pendingBadge()}`;
      const tab = document.querySelector('.tabbar a[href="#/goedkeuren"]');
      if (tab) {
        tab.querySelector('.tab-badge')?.remove();
        if (state.pendingCount) tab.insertAdjacentHTML('beforeend', `<span class="tab-badge" data-pending>${state.pendingCount}</span>`);
      }
    } catch { /* niet kritiek */ }
  }

  async function render() {
    if (!state.user) return renderLogin();
    if (state.user.mfa_setup_required) return renderMfaSetupRequired();
    const { name, params } = currentRoute();
    const route = ROUTES[name];
    if (route.admin && state.user.role !== 'admin') {
      location.hash = '#/uren';
      return undefined;
    }
    app.innerHTML = shellHTML(name);
    app.querySelector('[data-more]')?.addEventListener('click', openMoreSheet);
    document.body.classList.toggle('has-tabbar', true);
    app.querySelector('[data-logout]').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      location.hash = '';
      render();
    });
    document.title = `${route.title} – Coretic uren`;
    const view = document.getElementById('view');
    view.innerHTML = '<p class="muted">Laden…</p>';
    refreshPending();
    try {
      await route.render(view, params);
    } catch (e) {
      view.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    }
    return undefined;
  }

  // Niet-opgeslagen wijzigingen: formulieren met data-guard waarschuwen bij weggaan.
  let lastHash = location.hash;
  let skipHash = false;
  const dirtyForm = () => document.querySelector('form[data-guard][data-dirty]');
  document.addEventListener('input', (e) => { const f = e.target.closest('form[data-guard]'); if (f) f.dataset.dirty = '1'; });
  document.addEventListener('change', (e) => { const f = e.target.closest('form[data-guard]'); if (f) f.dataset.dirty = '1'; });
  window.addEventListener('beforeunload', (e) => { if (dirtyForm()) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', () => {
    if (skipHash) { skipHash = false; return; }
    if (dirtyForm() && !window.confirm('Je hebt wijzigingen die nog niet zijn opgeslagen. Toch weggaan?')) {
      skipHash = true;
      location.hash = lastHash;
      return;
    }
    lastHash = location.hash;
    render();
  });

  // Op smalle schermen worden tabellen kaarten: elke cel krijgt de kolomnaam als label.
  function labelTables(root = document) {
    root.querySelectorAll('table.data').forEach((t) => {
      const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      if (!heads.length) return;
      t.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] || ''); });
      });
    });
  }
  let labelQueued = false;
  new MutationObserver(() => {
    if (labelQueued) return;
    labelQueued = true;
    requestAnimationFrame(() => { labelQueued = false; labelTables(); });
  }).observe(document.body, { childList: true, subtree: true });

  // Van smal naar breed (of andersom) op de urenstaat: juiste weergave tonen.
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => {
    if (state.user && currentRoute().name === 'uren' && state.sheet) {
      const view = document.getElementById('view');
      if (view && view.querySelector('#sheet-content')) renderSheetBody(view);
    }
  });

  /* ================= Inloggen ================= */

  function renderLogin() {
    document.body.classList.remove('has-tabbar');
    document.title = 'Inloggen – Coretic uren';
    app.innerHTML = `
      <div class="login">
        <div class="panel">
          <h1>Coretic uren</h1>
          <p class="muted">Log in om je uren te schrijven.</p>
          <form id="login-form">
            <label class="field">E-mailadres<input type="email" name="email" autocomplete="username" required></label>
            <label class="field">Wachtwoord<input type="password" name="password" autocomplete="current-password" required></label>
            <div class="notice error" hidden></div>
            <button class="btn primary" type="submit">Inloggen</button>
          </form>
        </div>
      </div>`;
    const form = document.getElementById('login-form');
    form.email.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.notice');
      err.hidden = true;
      try {
        const res = await api('/auth/login', {
          method: 'POST', body: { email: form.email.value, password: form.password.value },
        });
        if (res.mfa_required) { renderMfaCode(); return; }
        state.user = res;
        render();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  }

  /* ---------- Tweestapsverificatie ---------- */

  // Stap 2 bij inloggen: code uit de authenticator-app (of een herstelcode).
  function renderMfaCode() {
    document.title = 'Code invullen – Coretic uren';
    app.innerHTML = `
      <div class="login">
        <div class="panel">
          <h1>Tweestapsverificatie</h1>
          <p class="muted" data-hint>Vul de 6-cijferige code in uit je authenticator-app.</p>
          <form id="mfa-form">
            <label class="field" data-label>Code
              <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required class="code-input"></label>
            <div class="notice error" hidden></div>
            <button class="btn primary" type="submit">Inloggen</button>
            <div class="row spread small">
              <button type="button" class="btn ghost small" data-recovery>Herstelcode gebruiken</button>
              <button type="button" class="btn ghost small" data-cancel>Annuleren</button>
            </div>
          </form>
        </div>
      </div>`;
    const form = document.getElementById('mfa-form');
    form.code.focus();
    let recovery = false;
    form.querySelector('[data-recovery]').addEventListener('click', (e) => {
      recovery = !recovery;
      form.code.value = '';
      form.code.maxLength = recovery ? 20 : 6;
      form.code.inputMode = recovery ? 'text' : 'numeric';
      form.code.removeAttribute('pattern');
      form.code.autocomplete = recovery ? 'off' : 'one-time-code';
      form.querySelector('[data-hint]').textContent = recovery
        ? 'Vul een van je herstelcodes in (bijvoorbeeld abcde-fghjk). Elke code werkt één keer.'
        : 'Vul de 6-cijferige code in uit je authenticator-app.';
      e.target.textContent = recovery ? 'Code uit de app gebruiken' : 'Herstelcode gebruiken';
      form.code.focus();
    });
    form.querySelector('[data-cancel]').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      renderLogin();
    });
    form.code.addEventListener('input', () => {
      if (!recovery && /^\d{6}$/.test(form.code.value)) form.requestSubmit();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.notice');
      err.hidden = true;
      try {
        state.user = await api('/auth/mfa/verify', { method: 'POST', body: { code: form.code.value } });
        render();
        if (state.user.recovery_codes_left !== undefined) {
          toast(`Herstelcode gebruikt. Je hebt er nog ${state.user.recovery_codes_left}. Maak nieuwe aan onder Account.`, state.user.recovery_codes_left < 3);
        }
      } catch (ex) {
        if (ex.status === 401) { renderLogin(); toast(ex.message, true); return; }
        err.textContent = ex.message;
        err.hidden = false;
        form.code.select();
      }
    });
  }

  let qrPromise = null;
  function loadQr() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (!qrPromise) {
      qrPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
        s.onload = () => (window.QRCode ? resolve(window.QRCode) : reject(new Error('QR')));
        s.onerror = () => { qrPromise = null; reject(new Error('QR')); };
        document.head.appendChild(s);
      });
    }
    return qrPromise;
  }

  function recoveryCodesHTML(codes) {
    return `
      <div class="notice warn"><strong>Bewaar deze herstelcodes op een veilige plek</strong> (bijvoorbeeld je wachtwoordmanager). Elke code werkt één keer, voor als je je telefoon kwijt bent. Je ziet ze maar één keer.</div>
      <pre class="recovery-codes">${codes.map(esc).join('\n')}</pre>
      <div class="row"><button type="button" class="btn" data-copy-codes>Kopiëren</button></div>`;
  }
  function bindCopyCodes(box, codes) {
    const b = box.querySelector('[data-copy-codes]');
    if (b) {
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(codes.join('\n')); toast('Herstelcodes gekopieerd'); } catch { toast('Kopiëren lukte niet; selecteer de codes handmatig', true); }
      });
    }
  }

  // Instellen: QR-code scannen, eerste code invullen, herstelcodes bewaren. onDone wordt na "Klaar" aangeroepen.
  async function mountMfaSetup(box, onDone) {
    box.innerHTML = '<p class="muted">Bezig…</p>';
    const setup = await api('/auth/mfa/setup', { method: 'POST' });
    const pretty = setup.secret.replace(/(.{4})/g, '$1 ').trim();
    box.innerHTML = `
      <ol class="mfa-steps">
        <li>Installeer een authenticator-app op je telefoon, bijvoorbeeld Microsoft Authenticator, Google Authenticator of 1Password.</li>
        <li>Scan deze QR-code met de app.
          <div class="mfa-qr" data-qr></div>
          <details><summary class="small">Kun je niet scannen? Voer de sleutel handmatig in</summary>
            <p class="small">Sleutel: <code class="mfa-secret">${esc(pretty)}</code><br><span class="muted">Type: op tijd gebaseerd, 6 cijfers</span></p></details>
        </li>
        <li>Vul de code in die de app nu laat zien.
          <form class="row" data-enable style="margin-top:0.5rem">
            <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code-input" required aria-label="Code uit de app">
            <button class="btn primary" type="submit">Inschakelen</button>
          </form>
          <p class="err small" hidden></p>
        </li>
      </ol>`;
    loadQr().then((QRCode) => {
      const el = box.querySelector('[data-qr]');
      if (!el) return;
      // eslint-disable-next-line no-new
      new QRCode(el, { text: setup.otpauth, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
    }).catch(() => {
      const el = box.querySelector('[data-qr]');
      if (el) el.innerHTML = '<p class="muted small">QR-code kon niet worden geladen; voer de sleutel hieronder handmatig in.</p>';
    });
    const form = box.querySelector('[data-enable]');
    form.code.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = box.querySelector('.err');
      err.hidden = true;
      try {
        const res = await api('/auth/mfa/enable', { method: 'POST', body: { code: form.code.value } });
        box.innerHTML = `
          <p><strong>Tweestapsverificatie staat aan.</strong> Voortaan vraagt de app na je wachtwoord om een code uit je authenticator-app.</p>
          ${recoveryCodesHTML(res.recovery_codes)}
          <label class="check"><input type="checkbox" data-saved> Ik heb de herstelcodes bewaard</label>
          <div class="row"><button type="button" class="btn primary" data-done disabled>Klaar</button></div>`;
        bindCopyCodes(box, res.recovery_codes);
        const done = box.querySelector('[data-done]');
        box.querySelector('[data-saved]').addEventListener('change', (ev) => { done.disabled = !ev.target.checked; });
        done.addEventListener('click', () => onDone(res.user));
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        form.code.select();
      }
    });
  }

  // Verplicht instelscherm voor beheerders zonder 2FA.
  function renderMfaSetupRequired() {
    document.title = 'Tweestapsverificatie instellen – Coretic uren';
    app.innerHTML = `
      <div class="login">
        <div class="panel mfa-panel">
          <h1>Tweestapsverificatie instellen</h1>
          <p class="muted">Voor beheerders is een tweede stap bij het inloggen verplicht, omdat je facturen kunt maken en versturen. Dit duurt één minuut.</p>
          <div data-mfa-box></div>
          <div class="row spread small" style="margin-top:1rem"><span class="muted">Ingelogd als ${esc(state.user.email)}</span>
            <button type="button" class="btn ghost small" data-logout>Uitloggen</button></div>
        </div>
      </div>`;
    app.querySelector('[data-logout]').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      render();
    });
    mountMfaSetup(app.querySelector('[data-mfa-box]'), (user) => {
      state.user = user;
      toast('Tweestapsverificatie staat aan');
      render();
    }).catch((e) => toast(e.message, true));
  }

  /* ================= Urenstaat ================= */

  const MODE_KEY = 'coretic-uren:weergave';

  function sheetMode() {
    if (state.sheetMode) return state.sheetMode;
    let stored = null;
    try { stored = localStorage.getItem(MODE_KEY); } catch { /* geen opslag beschikbaar */ }
    // Zonder voorkeur: lijst op een smal scherm, raster op desktop.
    state.sheetMode = ['list', 'grid', 'day'].includes(stored) ? stored : (isNarrow() ? 'day' : 'grid');
    return state.sheetMode;
  }

  // Raster werkt niet op een telefoon en de dagweergave is voor kleine schermen: kies wat past.
  function effectiveMode() {
    const m = sheetMode();
    if (isNarrow()) return m === 'grid' ? 'day' : m;
    return m === 'day' ? 'grid' : m;
  }

  function setSheetMode(mode) {
    state.sheetMode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* geen opslag beschikbaar */ }
  }

  // Periode: week of maand.
  const PERIOD_KEY = 'coretic-uren:periode';
  function sheetPeriod() {
    if (state.sheetPeriod) return state.sheetPeriod;
    let stored = null;
    try { stored = localStorage.getItem(PERIOD_KEY); } catch { /* geen opslag beschikbaar */ }
    state.sheetPeriod = stored === 'month' ? 'month' : 'week';
    return state.sheetPeriod;
  }
  function setSheetPeriod(p) {
    state.sheetPeriod = p;
    try { localStorage.setItem(PERIOD_KEY, p); } catch { /* geen opslag beschikbaar */ }
  }
  const MONTHS_LONG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  function shiftMonth(iso, n) {
    const [y, m] = iso.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 10);
  }
  const workdayCount = (days) => days.filter((d) => dow(d) < 5).length;

  // Sleutels. Rij = project|activiteit, vak = project|activiteit|datum. Activiteit 0 = geen activiteit.
  const rowKey = (pid, aid) => `${pid}|${aid || 0}`;
  const cellKey = (pid, aid, date) => `${pid}|${aid || 0}|${date}`;
  const entryKey = (e) => cellKey(e.project_id, e.activity_id, e.work_date);
  const parseKey = (k) => {
    const [pid, aid, date] = k.split('|');
    return { pid: Number(pid), aid: Number(aid) || 0, date };
  };

  const projectOf = (pid) => state.sheet.projects.find((p) => p.id === pid);
  const activityOf = (p, aid) => (aid && p ? (p.activities || []).find((a) => a.id === aid) : null);
  const activeActivities = (p) => (p.activities || []).filter((a) => a.active);
  function rowLabel(pid, aid) {
    const p = projectOf(pid);
    const a = activityOf(p, aid);
    return `${p ? p.name : 'Project'}${a ? `, ${a.name}` : ''}`;
  }

  // Welke rijen staan in de urenstaat: elk actief project waaraan je bent toegewezen (één regel per
  // actieve activiteit, of één regel als het project geen activiteiten heeft), plus alles met uren deze week,
  // de combinaties van vorige week en zelf toegevoegde regels.
  function sheetRows(data) {
    const rows = [];
    const seen = new Set();
    const add = (pid, aid) => {
      const k = rowKey(pid, aid);
      if (seen.has(k)) return;
      const p = data.projects.find((x) => x.id === pid);
      if (!p) return;
      const a = activityOf(p, aid);
      if (aid && !a) return;
      seen.add(k);
      rows.push({ key: k, pid, aid: aid || 0, project: p, activity: a });
    };
    for (const e of data.map.values()) add(e.project_id, e.activity_id);
    for (const r of data.recent || []) {
      const p = data.projects.find((x) => x.id === r.project_id);
      if (!p || !p.active) continue;
      const a = activityOf(p, r.activity_id);
      if (r.activity_id ? (a && a.active) : !activeActivities(p).length) add(r.project_id, r.activity_id);
    }
    for (const k of state.extraRows[data.week_start] || []) { const { pid, aid } = parseKey(k); add(pid, aid); }
    for (const p of data.projects) {
      if (!p.active || p.assigned === false) continue;
      const acts = activeActivities(p);
      if (acts.length) acts.forEach((a) => add(p.id, a.id));
      else add(p.id, 0);
    }
    const label = (r) => `${r.project.client_name || ''}|${r.project.name}|${r.activity ? r.activity.name : ''}`;
    rows.sort((x, y) => (Number(!x.project.client_name) - Number(!y.project.client_name)) || label(x).localeCompare(label(y), 'nl'));
    return rows;
  }

  // Budget per regel: activiteitbudget, of projectbudget bij projecten zonder activiteiten.
  // Verbruik = alle eerdere uren (van iedereen) + wat er nu deze week van jou staat, zodat het live meeloopt.
  function weekHours(pid, aid) {
    return [...state.sheet.map.values()]
      .filter((e) => e.project_id === pid && (aid === null || (e.activity_id || 0) === aid))
      .reduce((s, e) => s + e.hours, 0);
  }
  function prepareBudgets(data) {
    for (const p of data.projects) {
      p.baseUsed = (p.used_hours || 0) - weekHours(p.id, null);
      for (const a of p.activities || []) a.baseUsed = (a.used_hours || 0) - weekHours(p.id, a.id);
    }
  }
  // Budgetten voor een regel: het projectbudget (alle activiteiten samen) en, als die er is,
  // het budget van de activiteit op dit project.
  function budgetInfos(pid, aid) {
    const p = projectOf(pid);
    if (!p) return [];
    const out = [];
    if (p.budget_hours) {
      out.push({ kind: 'Project', used: (p.baseUsed || 0) + weekHours(pid, null), budget: p.budget_hours, unit: 'hours' });
    }
    const a = activityOf(p, aid);
    if (a && a.budget_hours) {
      out.push({ kind: 'Activiteit', used: (a.baseUsed || 0) + weekHours(pid, aid), budget: a.budget_hours, unit: 'hours' });
    } else if (a && a.budget_amount) {
      out.push({ kind: 'Activiteit', used: a.used_amount || 0, budget: a.budget_amount, unit: 'amount' });
    }
    return out;
  }
  const budgetSlot = (key, compact = false) => `<div class="budget-slot${compact ? ' compact' : ''}" data-budget="${key}"${compact ? ' data-compact' : ''} hidden></div>`;

  // Compacte budgetregel: dunne balk + wat er nog over is, details bij aanwijzen.
  function budgetMini(i) {
    const money = i.unit === 'amount';
    const f = money ? eur0 : (x) => `${fh(x)} u`;
    const left = i.budget - i.used;
    const lvl = budgetLevel(i.used, i.budget);
    const leftText = left > 0.005 ? `nog ${f(left)}` : left >= -0.005 ? 'op' : `${f(-left)} over`;
    const full = money ? `${eur0(i.used)} / ${eur0(i.budget)}` : `${fh(i.used)} / ${fh(i.budget)} uur`;
    const title = `${i.kind}: ${full} · ${left > 0.005 ? `nog ${money ? eur0(left) : `${fh(left)} uur`} beschikbaar` : left >= -0.005 ? 'budget is op' : `${money ? eur0(-left) : `${fh(-left)} uur`} over budget`}`;
    return `<div class="bmini lvl-${lvl}" title="${esc(title)}">
      <span class="bmini-kind">${i.kind === 'Project' ? 'Proj.' : 'Act.'}</span>
      <span class="bbar"><span style="width:${Math.min(100, (i.used / i.budget) * 100).toFixed(1)}%"></span></span>
      <span class="bmini-left">${leftText}</span></div>`;
  }

  // Filter op projecten en/of activiteiten (meervoudig; activiteit werkt ook over projecten heen).
  function filterActive() {
    const f = state.sheetFilter;
    return Boolean(f.projects.length || f.activities.length || f.onlyHours);
  }
  const rowHasHours = (data, r) => data.days.some((d) => data.map.has(cellKey(r.pid, r.aid, d)));
  function visibleRows(data) {
    const f = state.sheetFilter;
    return sheetRows(data).filter((r) => (!f.projects.length || f.projects.includes(r.pid))
      && (!f.activities.length || f.activities.includes(r.aid))
      && (!f.onlyHours || rowHasHours(data, r)));
  }

  // Keuzes per filter: projecten uit alle regels, activiteiten uit de regels van de gekozen projecten.
  function filterOptions(kind, data) {
    const all = sheetRows(data);
    const f = state.sheetFilter;
    const out = new Map();
    for (const r of all) {
      if (kind === 'projects') {
        if (!out.has(r.pid)) out.set(r.pid, `${r.project.client_name || 'Intern'} / ${r.project.name}`);
      } else if (r.activity && (!f.projects.length || f.projects.includes(r.pid))) {
        out.set(r.activity.id, r.activity.name);
      }
    }
    return [...out.entries()].map(([id, label]) => ({ id, label }))
      .sort((x, y) => x.label.localeCompare(y.label, 'nl'));
  }

  function msText(kind, data) {
    const sel = state.sheetFilter[kind];
    const word = kind === 'projects' ? ['Alle projecten', 'project', 'projecten'] : ['Alle activiteiten', 'activiteit', 'activiteiten'];
    if (!sel.length) return word[0];
    if (sel.length === 1) {
      const o = filterOptions(kind, data).find((x) => x.id === sel[0]);
      return o ? o.label : `1 ${word[1]}`;
    }
    return `${sel.length} ${word[2]}`;
  }

  function msOptionsHTML(kind, data) {
    const opts = filterOptions(kind, data);
    if (!opts.length) return '<p class="muted small ms-empty">Geen keuzes</p>';
    const sel = state.sheetFilter[kind];
    return opts.map((o) => `
      <label class="check ms-option" data-label="${esc(o.label.toLowerCase())}">
        <input type="checkbox" value="${o.id}"${sel.includes(o.id) ? ' checked' : ''}> <span>${esc(o.label)}</span>
      </label>`).join('');
  }

  function msHTML(kind, label, data) {
    return `
      <div class="ms" data-ms="${kind}">
        <span class="ms-label">${label}</span>
        <button type="button" class="ms-button" aria-haspopup="true" aria-expanded="false">
          <span data-ms-text>${esc(msText(kind, data))}</span>
        </button>
        <div class="ms-panel" hidden>
          <input type="search" class="ms-search" placeholder="Zoeken" aria-label="Zoeken in ${label.toLowerCase()}">
          <div class="ms-actions">
            <button type="button" class="btn small ghost" data-ms-all>Alles selecteren</button>
            <button type="button" class="btn small ghost" data-ms-none>Wissen</button>
          </div>
          <div class="ms-options">${msOptionsHTML(kind, data)}</div>
        </div>
      </div>`;
  }

  function filterInfoHTML(data) {
    if (!filterActive()) return '';
    return `<span class="muted small">${visibleRows(data).length} van ${sheetRows(data).length} regels</span>
      <button type="button" class="btn small ghost" data-filter-clear>Filter wissen</button>`;
  }

  function filterHTML(data) {
    if (sheetRows(data).length < 2 && !filterActive()) return '';
    return `
      <div class="sheet-filter${state.filterOpen ? ' open' : ''}">
        ${msHTML('projects', 'Project', data)}
        ${msHTML('activities', 'Activiteit', data)}
        <label class="check only-hours"><input type="checkbox" data-only-hours${state.sheetFilter.onlyHours ? ' checked' : ''}> Alleen regels met uren</label>
        <div class="sheet-filter-info" data-filter-info>${filterInfoHTML(data)}</div>
      </div>`;
  }

  function closeMs(except) {
    document.querySelectorAll('.ms-panel:not([hidden])').forEach((panel) => {
      if (panel.closest('.ms') === except) return;
      panel.hidden = true;
      panel.closest('.ms').querySelector('.ms-button').setAttribute('aria-expanded', 'false');
    });
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.ms')) closeMs(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMs(); });

  // Filter toepassen zonder de filterbalk opnieuw op te bouwen, zodat een open menu open blijft.
  function applyFilter(view, changedKind) {
    const data = state.sheet;
    if (changedKind === 'projects') {
      const allowed = new Set(filterOptions('activities', data).map((o) => o.id));
      state.sheetFilter.activities = state.sheetFilter.activities.filter((id) => allowed.has(id));
      const box = view.querySelector('[data-ms="activities"] .ms-options');
      if (box) box.innerHTML = msOptionsHTML('activities', data);
    }
    for (const kind of ['projects', 'activities']) {
      const t = view.querySelector(`[data-ms="${kind}"] [data-ms-text]`);
      if (t) t.textContent = msText(kind, data);
      view.querySelector(`[data-ms="${kind}"]`)?.classList.toggle('active', state.sheetFilter[kind].length > 0);
    }
    const info = view.querySelector('[data-filter-info]');
    if (info) info.innerHTML = filterInfoHTML(data);
    renderSheetContent(view);
  }

  function bindFilterEvents(view) {
    view.addEventListener('click', (e) => {
      const btn = e.target.closest('.ms-button');
      if (btn) {
        const ms = btn.closest('.ms');
        const panel = ms.querySelector('.ms-panel');
        closeMs(ms);
        panel.hidden = !panel.hidden;
        btn.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden) panel.querySelector('.ms-search').focus();
        return;
      }
      const all = e.target.closest('[data-ms-all]');
      const none = e.target.closest('[data-ms-none]');
      if (all || none) {
        const ms = e.target.closest('.ms');
        const kind = ms.dataset.ms;
        if (none) state.sheetFilter[kind] = [];
        else {
          const ids = [...ms.querySelectorAll('.ms-option:not([hidden]) input')].map((i) => Number(i.value));
          state.sheetFilter[kind] = [...new Set([...state.sheetFilter[kind], ...ids])];
        }
        ms.querySelectorAll('.ms-option input').forEach((i) => { i.checked = state.sheetFilter[kind].includes(Number(i.value)); });
        applyFilter(view, kind);
      }
      if (e.target.closest('[data-filter-clear]')) {
        state.sheetFilter = { projects: [], activities: [], onlyHours: false };
        renderSheetBody(view);
      }
      if (e.target.closest('[data-filter-toggle]')) {
        state.filterOpen = !state.filterOpen;
        view.querySelector('.sheet-filter')?.classList.toggle('open', state.filterOpen);
        e.target.closest('[data-filter-toggle]').setAttribute('aria-expanded', String(state.filterOpen));
      }
    });
    view.addEventListener('change', (e) => {
      if (e.target.matches('[data-only-hours]')) {
        state.sheetFilter.onlyHours = e.target.checked;
        applyFilter(view, null);
        return;
      }
      const cb = e.target.closest('.ms-option input');
      if (!cb) return;
      const kind = cb.closest('.ms').dataset.ms;
      const id = Number(cb.value);
      const list = state.sheetFilter[kind].filter((x) => x !== id);
      if (cb.checked) list.push(id);
      state.sheetFilter[kind] = list;
      applyFilter(view, kind);
    });
    view.addEventListener('input', (e) => {
      if (!e.target.matches('.ms-search')) return;
      const q = e.target.value.trim().toLowerCase();
      e.target.closest('.ms').querySelectorAll('.ms-option').forEach((o) => { o.hidden = Boolean(q) && !o.dataset.label.includes(q); });
    });
  }

  // Combinaties die je nog kunt toevoegen.
  function addableRows(data) {
    const shown = new Set(sheetRows(data).map((r) => r.key));
    const out = [];
    for (const p of data.projects.filter((x) => x.active)) {
      const acts = activeActivities(p);
      if (acts.length) {
        for (const a of acts) if (!shown.has(rowKey(p.id, a.id))) out.push({ pid: p.id, aid: a.id, project: p, activity: a });
      } else if (!shown.has(rowKey(p.id, 0))) {
        out.push({ pid: p.id, aid: 0, project: p, activity: null });
      }
    }
    return out;
  }

  async function viewTimesheet(view, params) {
    const requested = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : todayIso();
    const data = await api(sheetPeriod() === 'month'
      ? `/timesheet?month=${requested.slice(0, 7)}`
      : `/timesheet?week=${weekStart(requested)}`);
    data.period = data.period || 'week';
    data.map = new Map(data.entries.map((e) => [entryKey(e), e]));
    state.sheet = data;
    prepareBudgets(data);

    view.innerHTML = '<div id="sheet-head"></div><div id="sheet-notices"></div><div id="sheet-body"></div>';

    if (!data.projects.length) {
      refreshSheetChrome(view);
      view.querySelector('#sheet-body').innerHTML = `
        <div class="panel empty">
          <h2>Nog geen projecten</h2>
          <p>${state.user.role === 'admin'
            ? 'Maak een project aan en voeg jezelf toe aan het team via <a href="#/beheer/projecten">Beheer › Projecten</a>.'
            : 'Je bent nog niet aan een project gekoppeld. Vraag je beheerder om je toe te voegen.'}</p>
        </div>`;
      return;
    }

    renderSheetBody(view);
    bindFilterEvents(view);

    view.addEventListener('change', (e) => {
      if (e.target.matches('input.hrs')) saveCell(view, e.target);
      if (e.target.matches('.list-entry [data-field]')) saveListRow(view, e.target.closest('li'));
      if (e.target.matches('.day-card [data-field]')) saveDayCard(view, e.target.closest('.day-card'));
    });
    view.addEventListener('input', (e) => {
      if (e.target.matches('.le-desc-input, .dv-desc')) autoGrow(e.target);
    });
    view.addEventListener('keydown', (e) => {
      if (e.target.matches('input.hrs') && e.key === 'Enter') {
        e.preventDefault();
        const date = e.target.dataset.date;
        let tr = e.target.closest('tr').nextElementSibling;
        while (tr) {
          const next = tr.querySelector(`input.hrs[data-date="${date}"]:not(:disabled)`);
          if (next) { next.focus(); next.select(); return; }
          tr = tr.nextElementSibling;
        }
        e.target.blur();
        return;
      }
      if (e.target.matches('.dv-hours') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); return; }
      if (!e.target.matches('.list-entry [data-field]')) return;
      if (e.key === 'Escape') {
        const entry = state.sheet.map.get(e.target.closest('li').dataset.key);
        if (entry) {
          e.target.value = e.target.dataset.field === 'hours' ? fmtInput(entry.hours) : entry.description;
          if (e.target.dataset.field === 'description') autoGrow(e.target);
        }
        e.target.blur();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.target.blur();
      }
    });
    // Dagweergave: vegen naar links/rechts gaat naar de volgende/vorige dag.
    let touch = null;
    view.addEventListener('touchstart', (e) => {
      if (effectiveMode() !== 'day' || e.target.closest('input, textarea, .day-strip, .ms')) { touch = null; return; }
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    view.addEventListener('touchend', (e) => {
      if (!touch) return;
      const dx = e.changedTouches[0].clientX - touch.x;
      const dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const days = state.sheet.days;
      const i = days.indexOf(selectedDay(state.sheet)) + (dx < 0 ? 1 : -1);
      if (i < 0 || i >= days.length) return;
      state.sheetDay = days[i];
      renderSheetContent(view);
    }, { passive: true });
    view.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.grip');
      if (grip && e.button === 0) startDrag(view, grip, e);
    });
    view.addEventListener('submit', (e) => {
      if (!e.target.matches('form.list-quick')) return;
      e.preventDefault();
      addListEntry(view, e.target);
    });
    view.addEventListener('click', (e) => {
      const note = e.target.closest('button.note');
      if (note) openNote(view, note.closest('tr').dataset.row, note.dataset.date);
      const act = e.target.closest('[data-sheet-action]');
      if (act) sheetAction(view, act.dataset.sheetAction);
      const per = e.target.closest('[data-sheet-period]');
      if (per && per.dataset.sheetPeriod !== sheetPeriod()) {
        setSheetPeriod(per.dataset.sheetPeriod);
        // Zelfde dag blijven tonen: vandaag als die in de periode valt, anders het begin.
        const t = todayIso();
        const anchor = state.sheet.days.includes(t) ? t : state.sheet.week_start;
        if (location.hash === `#/uren/${anchor}`) render(); else location.hash = `#/uren/${anchor}`;
        return;
      }
      const mode = e.target.closest('[data-sheet-mode]');
      if (mode && mode.dataset.sheetMode !== effectiveMode()) {
        setSheetMode(mode.dataset.sheetMode);
        renderSheetBody(view);
      }
      if (e.target.closest('[data-add-row]')) openAddRow(view);
      const chip = e.target.closest('[data-day]');
      if (chip) {
        state.sheetDay = chip.dataset.day;
        renderSheetContent(view);
      }
      const quick = e.target.closest('[data-quick]');
      if (quick) {
        const card = quick.closest('.day-card');
        card.querySelector('.dv-hours').value = quick.dataset.quick === '0' ? '' : quick.dataset.quick;
        saveDayCard(view, card);
      }
      const grp = e.target.closest('[data-grp-toggle]');
      if (grp) toggleGroup(view, grp.dataset.grpToggle);
      const edit = e.target.closest('[data-list-edit]');
      if (edit) editListEntry(view, edit.closest('li').dataset.key);
      const del = e.target.closest('[data-list-delete]');
      if (del) deleteListEntry(view, del.closest('li').dataset.key);
    });
  }

  function renderSheetBody(view) {
    const body = view.querySelector('#sheet-body');
    body.innerHTML = `${filterHTML(state.sheet)}<div id="sheet-content"></div>`;
    for (const kind of ['projects', 'activities']) {
      view.querySelector(`[data-ms="${kind}"]`)?.classList.toggle('active', state.sheetFilter[kind].length > 0);
    }
    renderSheetContent(view);
  }

  function renderSheetContent(view) {
    const box = view.querySelector('#sheet-content');
    const mode = effectiveMode();
    box.innerHTML = mode === 'list' ? listHTML(state.sheet) : mode === 'day' ? dayHTML(state.sheet) : gridHTML(state.sheet);
    if (mode === 'day') box.querySelector('.day-chip[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    box.querySelectorAll('.le-desc-input, .dv-desc').forEach(autoGrow);
    refreshSheetChrome(view);
  }

  const LEGEND = `
    <span><i style="background:var(--draft)"></i>Concept</span>
    <span><i style="background:var(--submitted)"></i>Ingediend</span>
    <span><i style="background:var(--approved)"></i>Goedgekeurd</span>
    <span><i style="background:var(--rejected)"></i>Afgekeurd</span>
    <span><i style="background:var(--invoiced)"></i>Gefactureerd</span>`;

  const GROUP_KEY = 'coretic-uren:ingeklapt';
  function collapsedGroups() {
    if (!state.collapsed) {
      try { state.collapsed = JSON.parse(localStorage.getItem(GROUP_KEY) || '[]'); } catch { state.collapsed = []; }
    }
    return state.collapsed;
  }
  function toggleGroup(view, name) {
    const list = collapsedGroups();
    state.collapsed = list.includes(name) ? list.filter((x) => x !== name) : [...list, name];
    try { localStorage.setItem(GROUP_KEY, JSON.stringify(state.collapsed)); } catch { /* geen opslag */ }
    renderSheetContent(view);
  }

  function gridHTML(data) {
    const today = todayIso();
    const rows = visibleRows(data);
    const head = data.days.map((d, i) => {
      const cls = [dow(d) >= 5 ? 'weekend' : '', d === today ? 'today' : ''].join(' ').trim();
      return `<th class="${cls}" scope="col"><span>${DAYS[dow(d)]}</span><span class="dnum">${Number(d.slice(8))}</span></th>`;
    }).join('');

    // Groeperen per klant; ingeklapte groepen tonen alleen hun kop met totaal.
    const groups = [];
    for (const r of rows) {
      const g = r.project.client_name || 'Intern';
      if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, rows: [] });
      groups[groups.length - 1].rows.push(r);
    }
    const collapsed = collapsedGroups();
    const showGroups = groups.length > 1;
    const rowHTML = (r) => {
      const p = r.project;
      const rowLocked = !p.active || (r.activity && !r.activity.active);
      const cells = data.days.map((d, i) => {
        const e = data.map.get(cellKey(r.pid, r.aid, d));
        const locked = (e && !EDITABLE.includes(e.status)) || rowLocked;
        const label = rowLabel(r.pid, r.aid);
        return `
          <td class="cell${dow(d) >= 5 ? ' weekend' : ''}${e ? ` s-${e.status}` : ''}" data-date="${d}">
            <input class="hrs" inputmode="decimal" autocomplete="off" data-date="${d}"
              aria-label="${esc(label)}, ${DAYS_LONG[dow(d)]} ${fmtDate(d)}"
              value="${fmtInput(e && e.hours)}"${locked ? ' disabled' : ''}>
            <button type="button" class="note${e && e.description ? ' has' : ''}" data-date="${d}"
              aria-label="Omschrijving bij ${esc(label)}, ${DAYS_LONG[dow(d)]}"
              title="${esc((e && e.description) || 'Omschrijving toevoegen')}"></button>
            <span class="grip" aria-hidden="true" title="Sleep naar een andere dag (Ctrl of ⌥ om te kopiëren)"></span>
          </td>`;
      }).join('');
      return `
        <tr data-row="${r.key}">
          <th class="proj" scope="row">
            ${showGroups ? '' : `<span class="client">${esc(p.client_name || 'Intern')}</span>`}
            <span class="name" title="${esc(p.name)}">${esc(p.name)}</span>
            ${r.activity ? `<span class="act" title="${esc(r.activity.name)}">${esc(r.activity.name)}</span>` : ''}
            ${p.billable ? '' : '<span class="tag">Niet declarabel</span>'}
            ${budgetSlot(r.key, true)}
          </th>
          ${cells}
          <td class="rowtotal" data-rowtotal></td>
        </tr>`;
    };
    const body = groups.map((g) => {
      const closed = showGroups && collapsed.includes(g.name);
      const head = showGroups ? `
        <tr class="grp${closed ? ' closed' : ''}" data-grp="${esc(g.name)}">
          <th class="proj" scope="rowgroup">
            <button type="button" class="grp-toggle" data-grp-toggle="${esc(g.name)}" aria-expanded="${!closed}">${icon('chevron', 'grp-chev')}<span>${esc(g.name)}</span><span class="muted small">${g.rows.length}</span></button>
          </th>
          ${data.days.map((d) => `<td class="grp-day${dow(d) >= 5 ? ' weekend' : ''}" data-grp-day="${d}"></td>`).join('')}
          <td class="rowtotal" data-grp-total></td>
        </tr>` : '';
      return head + (closed ? '' : g.rows.map(rowHTML).join(''));
    }).join('') || `<tr><td class="empty-row" colspan="${data.days.length + 2}">${filterActive() ? 'Geen regels voor dit filter.' : 'Voeg een regel toe om uren te schrijven.'}</td></tr>`;

    const foot = data.days.map((d) => `<td class="coltotal${dow(d) >= 5 ? ' weekend' : ''}" data-coltotal="${d}"></td>`).join('');
    const canAdd = addableRows(data).length > 0;

    return `
      <div class="grid-wrap">
        <table class="grid${data.period === 'month' ? ' month' : ''}">
          <thead><tr><th class="proj" scope="col">Project</th>${head}<th class="rowtotal" scope="col">Totaal</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td class="proj muted">${filterActive() ? 'Per dag, gefilterd' : 'Per dag'}</td>${foot}<td class="rowtotal" data-weektotal></td></tr></tfoot>
        </table>
      </div>
      ${canAdd ? '<div class="add-row-bar"><button class="btn" type="button" data-add-row>Regel toevoegen</button></div>' : ''}
      <div class="legend">${LEGEND}
        <span>Tip: 7:30 wordt 7,5 uur. Enter springt naar de volgende regel. Sleep een vak aan ⠿ naar een andere dag; met Ctrl of ⌥ kopieer je.</span>
      </div>`;
  }

  function openAddRow(view) {
    const options = addableRows(state.sheet);
    if (!options.length) { toast('Alle projecten en activiteiten staan al in je urenstaat'); return; }
    const groups = new Map();
    for (const o of options) {
      if (!groups.has(o.pid)) groups.set(o.pid, []);
      groups.get(o.pid).push(o);
    }
    const opts = [...groups.values()].map((g) => {
      const p = g[0].project;
      const label = `${p.client_name || 'Intern'} / ${p.name}`;
      if (!g[0].aid) return opt(rowKey(p.id, 0), label, false);
      return `<optgroup label="${esc(label)}">${g.map((o) => opt(rowKey(o.pid, o.aid), o.activity.name, false)).join('')}</optgroup>`;
    }).join('');
    openDialog({
      title: 'Regel toevoegen',
      submit: 'Toevoegen',
      body: `<label class="field">Project en activiteit<select name="row">${opts}</select></label>
             <p class="muted small">De regel blijft staan zolang je er deze of vorige week uren op hebt.</p>`,
      onSubmit: (fd) => {
        const k = fd.get('row');
        if (!state.extraRows[state.sheet.week_start]) state.extraRows[state.sheet.week_start] = [];
        state.extraRows[state.sheet.week_start].push(k);
        renderSheetBody(view);
        const first = view.querySelector(`tr[data-row="${k}"] input.hrs:not(:disabled)`);
        if (first) first.focus();
      },
    });
  }

  /* ---------- Dagweergave (mobiel) ---------- */

  function selectedDay(data) {
    if (state.sheetDay && data.days.includes(state.sheetDay)) return state.sheetDay;
    const t = todayIso();
    return data.days.includes(t) ? t : data.days[0];
  }
  const dayTotal = (data, d) => [...data.map.values()].filter((e) => e.work_date === d).reduce((s, e) => s + e.hours, 0);

  function dayStripHTML(data) {
    const sel = selectedDay(data);
    const today = todayIso();
    return data.days.map((d) => {
      const tot = dayTotal(data, d);
      const statuses = [...data.map.values()].filter((e) => e.work_date === d).map((e) => e.status);
      const st = statuses.includes('rejected') ? 'rejected' : statuses.some((s) => s === 'draft') ? 'draft'
        : statuses.includes('submitted') ? 'submitted' : statuses.length ? statuses[0] : '';
      return `<button type="button" class="day-chip${dow(d) >= 5 ? ' weekend' : ''}${d === today ? ' today' : ''}${st ? ` s-${st}` : ''}" data-day="${d}" aria-pressed="${d === sel}">
        <span class="dc-dow">${DAYS[dow(d)]}</span><span class="dc-num">${Number(d.slice(8))}</span><span class="dc-hrs">${tot ? fh(tot) : '–'}</span></button>`;
    }).join('');
  }

  function dayHTML(data) {
    const d = selectedDay(data);
    const rows = visibleRows(data).slice().sort((x, y) => Number(data.map.has(cellKey(y.pid, y.aid, d))) - Number(data.map.has(cellKey(x.pid, x.aid, d))));
    const tot = dayTotal(data, d);
    const cards = rows.map((r) => {
      const p = r.project;
      const e = data.map.get(cellKey(r.pid, r.aid, d));
      const locked = (e && !EDITABLE.includes(e.status)) || !p.active || (r.activity && !r.activity.active);
      return `
        <section class="panel day-card${e ? ` has s-${e.status}` : ''}" data-row="${r.key}">
          <div class="dcard-head">
            <div class="dcard-title">
              <span class="client">${esc(p.client_name || 'Intern')}${p.billable ? '' : ' · niet declarabel'}</span>
              <span class="name">${esc(p.name)}</span>
              ${r.activity ? `<span class="act">${esc(r.activity.name)}</span>` : ''}
            </div>
            ${e && e.status !== 'draft' ? statusBadge(e.status) : ''}
          </div>
          ${budgetSlot(r.key, true)}
          ${e && e.status === 'rejected' && e.rejection_reason ? `<p class="le-reject">Afgekeurd: ${esc(e.rejection_reason)}</p>` : ''}
          ${locked ? `<p class="dcard-locked"><strong>${fh(e ? e.hours : 0)} uur</strong>${e && e.description ? ` · ${esc(e.description)}` : ''}</p>` : `
          <div class="dcard-input">
            <label class="dv-hours-wrap"><input class="dv-hours" data-field="hours" inputmode="decimal" autocomplete="off" placeholder="0"
              value="${fmtInput(e && e.hours)}" aria-label="Uren ${esc(rowLabel(r.pid, r.aid))}"><span>uur</span></label>
            <div class="quick" role="group" aria-label="Snel invullen">
              ${[2, 4, 8].map((h) => `<button type="button" class="btn quick-btn" data-quick="${h}">${h}</button>`).join('')}
              ${e ? '<button type="button" class="btn quick-btn ghost" data-quick="0" aria-label="Wissen">×</button>' : ''}
            </div>
          </div>
          <textarea class="dv-desc" data-field="description" rows="1" maxlength="1000" placeholder="Wat heb je gedaan?"
            aria-label="Omschrijving ${esc(rowLabel(r.pid, r.aid))}">${esc(e ? e.description : '')}</textarea>`}
        </section>`;
    }).join('');
    return `
      <div class="day-strip" role="tablist" aria-label="Dagen">${dayStripHTML(data)}</div>
      <div class="day-head"><h2>${DAYS_LONG[dow(d)][0].toUpperCase()}${DAYS_LONG[dow(d)].slice(1)} ${fmtDate(d)}</h2><span class="muted" data-day-total>${fh(tot)} uur</span></div>
      ${cards || `<div class="panel empty"><p>${filterActive() ? 'Geen regels voor dit filter.' : 'Geen projecten om uren op te schrijven.'}</p></div>`}`;
  }

  // Uren en omschrijving van één kaart opslaan (vervangt de waarde van die dag).
  async function saveDayCard(view, card) {
    const { pid, aid } = parseKey(card.dataset.row);
    const d = selectedDay(state.sheet);
    const key = cellKey(pid, aid, d);
    const existing = state.sheet.map.get(key);
    const hoursEl = card.querySelector('.dv-hours');
    const descEl = card.querySelector('.dv-desc');
    const hours = parseHours(hoursEl.value);
    const description = descEl.value.trim();
    if (Number.isNaN(hours) || hours < 0 || hours > 24) {
      hoursEl.classList.add('error');
      toast('Vul een aantal uren in tussen 0 en 24, bijvoorbeeld 7,5 of 7:30', true);
      return;
    }
    hoursEl.classList.remove('error');
    if (!hours && !existing) {
      if (description) toast('Vul eerst het aantal uren in');
      return;
    }
    if (existing && hours === existing.hours && description === existing.description) return;
    card.classList.add('saving');
    try {
      if (!hours) {
        await clearCell(pid, aid, d);
        toast('Uren verwijderd');
      } else {
        const res = await api('/timesheet/entry', {
          method: 'PUT', body: { project_id: pid, activity_id: aid || null, work_date: d, hours, description },
        });
        state.sheet.map.set(key, res);
      }
      const now = state.sheet.map.get(key);
      hoursEl.value = fmtInput(now && now.hours);
      card.classList.toggle('has', Boolean(now));
      card.className = card.className.replace(/\bs-\w+/g, '').trim();
      if (now) card.classList.add(`s-${now.status}`);
      view.querySelector('.day-strip').innerHTML = dayStripHTML(state.sheet);
      view.querySelector('[data-day-total]').textContent = `${fh(dayTotal(state.sheet, d))} uur`;
      refreshSheetChrome(view);
      card.classList.add('saved');
      setTimeout(() => card.classList.remove('saved'), 900);
    } catch (e) {
      toast(e.message, true);
    } finally {
      card.classList.remove('saving');
    }
  }

  /* ---------- Lijstweergave ---------- */

  const dayLabel = (d) => `${DAYS_LONG[dow(d)]} ${fmtDate(d)}`;

  function dayOptions(data, selected) {
    return data.days.map((d) => opt(d, dayLabel(d), d === selected)).join('');
  }
  function projectOptions(data, selected) {
    return data.projects.filter((p) => p.active || p.id === selected)
      .map((p) => opt(p.id, `${p.client_name || 'Intern'} / ${p.name}`, p.id === selected)).join('');
  }
  function activityOptions(p, selected) {
    const acts = p ? activeActivities(p) : [];
    if (!acts.length) return opt('', 'Geen activiteiten', true);
    return acts.map((a) => opt(a.id, a.name, a.id === selected)).join('');
  }
  function fillActivitySelect(form, selected) {
    const p = projectOf(Number(form.project.value));
    form.activity.innerHTML = activityOptions(p, selected);
    form.activity.disabled = !(p && activeActivities(p).length);
  }

  // Lijst: dezelfde regels als het raster (toegewezen projecten × activiteiten), elk als kaart met
  // de uren van deze week en een invulregel.
  function listHTML(data) {
    const today = todayIso();
    const draft = state.listDraft || {};
    const defDay = data.days.includes(draft.date) ? draft.date : (data.days.includes(today) ? today : data.days[0]);
    const rows = visibleRows(data);
    if (!rows.length) {
      return filterActive()
        ? '<div class="panel empty"><h2>Geen regels voor dit filter</h2><p>Kies een ander project of een andere activiteit, of wis het filter.</p></div>'
        : '<div class="panel empty"><h2>Geen projecten deze week</h2><p>Je bent niet aan een actief project toegewezen.</p></div>';
    }

    return rows.map((r) => {
      const p = r.project;
      const a = r.activity;
      const rowEditable = p.active && (!a || a.active);
      const entries = [...data.map.values()]
        .filter((e) => e.project_id === r.pid && (e.activity_id || 0) === r.aid)
        .sort((x, y) => x.work_date.localeCompare(y.work_date));
      const total = entries.reduce((s, e) => s + e.hours, 0);

      const items = entries.map((e) => {
        const editable = EDITABLE.includes(e.status) && rowEditable;
        return `
          <li class="list-entry s-${e.status}${editable ? ' editable' : ''}" data-key="${entryKey(e)}">
            <div class="le-main">
              <span class="le-date">${dayLabel(e.work_date)}</span>
              ${editable
                ? `<textarea class="le-desc-input" data-field="description" rows="1" maxlength="1000"
                     placeholder="Wat heb je gedaan?" aria-label="Omschrijving ${esc(rowLabel(e.project_id, e.activity_id))}, ${dayLabel(e.work_date)}">${esc(e.description)}</textarea>`
                : `<p class="le-desc">${e.description ? esc(e.description) : '<span class="muted">Geen omschrijving</span>'}</p>`}
              ${e.status === 'rejected' && e.rejection_reason ? `<p class="le-reject">Afgekeurd: ${esc(e.rejection_reason)}</p>` : ''}
            </div>
            <div class="le-hours">${editable
              ? `<input class="le-hours-input" data-field="hours" inputmode="decimal" autocomplete="off"
                   value="${fmtInput(e.hours)}" aria-label="Uren ${esc(rowLabel(e.project_id, e.activity_id))}, ${dayLabel(e.work_date)}">`
              : fh(e.hours)}<span> uur</span></div>
            <div class="le-status">${statusBadge(e.status)}<span class="le-saved" aria-live="polite"></span></div>
            <div class="le-actions">${editable ? `
              <button type="button" class="btn small" data-list-edit>Verplaatsen</button>
              <button type="button" class="btn small ghost danger" data-list-delete aria-label="Verwijderen">Verwijderen</button>` : ''}
            </div>
          </li>`;
      }).join('');

      const quick = rowEditable ? `
        <form class="list-quick" data-row="${r.key}" autocomplete="off">
          <select name="date" aria-label="Dag">${dayOptions(data, defDay)}</select>
          <input name="hours" inputmode="decimal" placeholder="Uren" aria-label="Uren" required>
          <input name="description" maxlength="1000" placeholder="Wat heb je gedaan?" aria-label="Omschrijving">
          <button class="btn primary" type="submit">Toevoegen</button>
        </form>` : '';

      return `
        <section class="panel list-card" data-card="${r.key}">
          <header>
            <div>
              <span class="client">${esc(p.client_name || 'Intern')}${p.billable ? '' : ', niet declarabel'}</span>
              <h3>${esc(p.name)}</h3>
              ${a ? `<span class="le-act">${esc(a.name)}</span>` : ''}
              ${budgetSlot(r.key)}
            </div>
            <span class="muted nowrap" data-cardtotal="${r.key}">${total ? `${fh(total)} uur` : ''}</span>
          </header>
          ${items ? `<ul class="list-entries">${items}</ul>` : ''}
          ${quick}
        </section>`;
    }).join('');
  }

  // Zet uren op een vak; staat er al iets, dan tellen we op en voegen we de omschrijvingen samen.
  async function addToCell(pid, aid, date, hours, description) {
    const key = cellKey(pid, aid, date);
    const existing = state.sheet.map.get(key);
    if (existing && !EDITABLE.includes(existing.status)) {
      throw new Error('Daar staan al ingediende of goedgekeurde uren');
    }
    const total = Math.round(((existing ? existing.hours : 0) + hours) * 100) / 100;
    if (total > 24) throw new Error('Samen wordt dat meer dan 24 uur');
    const desc = [...new Set([existing && existing.description, description].filter(Boolean))].join('; ');
    const res = await api('/timesheet/entry', {
      method: 'PUT', body: { project_id: pid, activity_id: aid || null, work_date: date, hours: total, description: desc },
    });
    state.sheet.map.set(key, res);
    return { res, existing };
  }

  async function clearCell(pid, aid, date) {
    await api('/timesheet/entry', {
      method: 'PUT', body: { project_id: pid, activity_id: aid || null, work_date: date, hours: 0, description: '' },
    });
    state.sheet.map.delete(cellKey(pid, aid, date));
  }

  async function addListEntry(view, form) {
    const rk = form.dataset.row;
    const { pid, aid } = parseKey(rk);
    const date = form.date.value;
    const hours = parseHours(form.hours.value);
    state.listDraft = { date };
    if (!hours || Number.isNaN(hours) || hours < 0 || hours > 24) {
      toast('Vul een aantal uren in tussen 0 en 24, bijvoorbeeld 7,5 of 7:30', true);
      form.hours.focus();
      return;
    }
    try {
      const { existing } = await addToCell(pid, aid, date, hours, form.description.value.trim());
      renderSheetBody(view);
      toast(existing ? `Opgeteld bij de ${fh(existing.hours)} uur die er al stond` : `${fh(hours)} uur toegevoegd`);
      const again = view.querySelector(`form.list-quick[data-row="${rk}"] input[name="hours"]`);
      if (again) again.focus();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  // Inline opslaan van uren en omschrijving in de lijst.
  async function saveListRow(view, li) {
    const key = li.dataset.key;
    const entry = state.sheet.map.get(key);
    if (!entry) return;
    const hoursEl = li.querySelector('[data-field="hours"]');
    const descEl = li.querySelector('[data-field="description"]');
    const hours = parseHours(hoursEl.value);
    const description = descEl.value.trim();
    if (Number.isNaN(hours) || hours < 0 || hours > 24) {
      hoursEl.classList.add('error');
      toast('Vul een aantal uren in tussen 0 en 24, bijvoorbeeld 7,5 of 7:30', true);
      return;
    }
    hoursEl.classList.remove('error');
    if (hours === entry.hours && description === entry.description) {
      hoursEl.value = fmtInput(entry.hours);
      return;
    }
    if (hours === 0) {
      hoursEl.value = fmtInput(entry.hours);
      await deleteListEntry(view, key);
      return;
    }
    li.classList.add('saving');
    try {
      const res = await api('/timesheet/entry', {
        method: 'PUT',
        body: { project_id: entry.project_id, activity_id: entry.activity_id || null, work_date: entry.work_date, hours, description },
      });
      state.sheet.map.set(key, res);
      hoursEl.value = fmtInput(res.hours);
      // Status kan veranderen (afgekeurd wordt weer concept): rij bijwerken zonder de focus te verliezen.
      li.className = li.className.replace(/\bs-\w+/g, '').trim();
      li.classList.add(`s-${res.status}`);
      const badge = li.querySelector('.le-status .badge');
      if (badge) badge.outerHTML = statusBadge(res.status);
      if (res.status !== 'rejected') { const r = li.querySelector('.le-reject'); if (r) r.remove(); }
      const rk = rowKey(entry.project_id, entry.activity_id);
      const totalEl = view.querySelector(`[data-cardtotal="${rk}"]`);
      if (totalEl) {
        const sum = [...state.sheet.map.values()]
          .filter((x) => x.project_id === entry.project_id && (x.activity_id || 0) === (entry.activity_id || 0))
          .reduce((s, x) => s + x.hours, 0);
        totalEl.textContent = sum ? `${fh(sum)} uur` : '';
      }
      refreshSheetChrome(view);
      const saved = li.querySelector('.le-saved');
      saved.textContent = 'Opgeslagen';
      clearTimeout(saved._t);
      saved._t = setTimeout(() => { saved.textContent = ''; }, 1800);
    } catch (e) {
      toast(e.message, true);
    } finally {
      li.classList.remove('saving');
    }
  }

  function editListEntry(view, key) {
    const entry = state.sheet.map.get(key);
    if (!entry) return;
    openDialog({
      title: 'Regel verplaatsen',
      submit: 'Verplaatsen',
      body: `
        <p class="muted small">${fh(entry.hours)} uur op ${esc(rowLabel(entry.project_id, entry.activity_id))}, ${dayLabel(entry.work_date)}</p>
        <div class="form-grid">
          <label class="field">Naar dag<select name="date">${dayOptions(state.sheet, entry.work_date)}</select></label>
          <label class="field">Naar project<select name="project">${projectOptions(state.sheet, entry.project_id)}</select></label>
          <label class="field">Activiteit<select name="activity"></select></label>
        </div>
        <p class="muted small">Staat daar al iets, dan worden de uren opgeteld.</p>`,
      onOpen: (form) => {
        fillActivitySelect(form, entry.activity_id);
        form.project.addEventListener('change', () => fillActivitySelect(form));
      },
      onSubmit: async (fd) => {
        const pid = Number(fd.get('project'));
        const aid = Number(fd.get('activity')) || 0;
        const date = fd.get('date');
        const p = projectOf(pid);
        if (!aid && p && activeActivities(p).length) throw new Error('Kies een activiteit');
        if (cellKey(pid, aid, date) === key) return;
        const { existing } = await addToCell(pid, aid, date, entry.hours, entry.description);
        await clearCell(entry.project_id, entry.activity_id, entry.work_date);
        if (existing) toast(`Opgeteld bij de ${fh(existing.hours)} uur die er al stond`);
        renderSheetBody(view);
      },
    });
  }

  async function deleteListEntry(view, key) {
    const entry = state.sheet.map.get(key);
    if (!entry) return;
    const ok = await confirmDialog('Regel verwijderen', `${fh(entry.hours)} uur op ${esc(rowLabel(entry.project_id, entry.activity_id))}, ${dayLabel(entry.work_date)} verwijderen?`, 'Verwijderen', true);
    if (!ok) return;
    try {
      await clearCell(entry.project_id, entry.activity_id, entry.work_date);
      renderSheetBody(view);
      toast('Regel verwijderd');
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ---------- Kop, totalen en raster-acties ---------- */

  function weekNavHTML(data) {
    const month = data.period === 'month';
    const entries = data.map ? [...data.map.values()] : [];
    const count = (st) => entries.filter((e) => st.includes(e.status)).length;
    const editable = count(EDITABLE);
    const submitted = count(['submitted']);
    let label = 'Nog leeg';
    if (editable) label = 'Nog niet ingediend';
    else if (submitted) label = 'Wacht op goedkeuring';
    else if (entries.length && entries.every((e) => e.status === 'invoiced')) label = 'Gefactureerd';
    else if (entries.length) label = 'Goedgekeurd';
    const total = entries.reduce((s, e) => s + e.hours, 0);
    const contract = month ? Math.round((data.weekly_hours / 5) * workdayCount(data.days) * 10) / 10 : data.weekly_hours;
    const today = todayIso();
    const prev = month ? shiftMonth(data.week_start, -1) : addDays(data.week_start, -7);
    const next = month ? shiftMonth(data.week_start, 1) : addDays(data.week_start, 7);
    const isCurrent = month ? today.slice(0, 7) === data.week_start.slice(0, 7) : data.week_start === weekStart(today);
    const [y, m] = data.week_start.split('-').map(Number);
    const title = month ? `${MONTHS_LONG[m - 1][0].toUpperCase()}${MONTHS_LONG[m - 1].slice(1)} ${y}` : `Week ${isoWeek(data.week_start)}`;
    const word = month ? 'maand' : 'week';
    const mode = effectiveMode();
    const pct = contract ? Math.min(100, (total / contract) * 100) : 0;
    const nFilter = state.sheetFilter.projects.length + state.sheetFilter.activities.length + (state.sheetFilter.onlyHours ? 1 : 0);
    const modeBtn = (k, lbl, cls) => `<button type="button" class="${cls}" data-sheet-mode="${k}" aria-pressed="${mode === k}">${lbl}</button>`;
    return `
      <div class="sheet-head">
        <div class="week-nav">
          <a class="btn icon-btn" href="#/uren/${prev}" aria-label="Vorige ${word}">‹</a>
          <div class="week-title"><h1>${title}</h1>${month ? '' : `<span class="range">${fmtRange(data.week_start, data.week_end)}</span>`}</div>
          <a class="btn icon-btn" href="#/uren/${next}" aria-label="Volgende ${word}">›</a>
          ${isCurrent ? '' : `<a class="btn ghost small today-btn" href="#/uren/${today}">Deze ${word}</a>`}
        </div>
        <div class="week-total" title="${esc(label)}">
          <strong>${fh(total)}</strong><span class="muted">/ ${fh(contract)} uur</span>
          <span class="week-progress" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></span>
          <span class="week-status muted small">${label}</span>
        </div>
        <div class="sheet-switches">
          <div class="seg" role="group" aria-label="Periode">
            <button type="button" data-sheet-period="week" aria-pressed="${!month}">Week</button>
            <button type="button" data-sheet-period="month" aria-pressed="${month}">Maand</button>
          </div>
          <div class="seg" role="group" aria-label="Weergave">
            ${modeBtn('grid', 'Raster', 'only-wide')}${modeBtn('day', 'Dag', 'only-narrow')}${modeBtn('list', 'Lijst', '')}
          </div>
          <button type="button" class="btn filter-toggle${nFilter ? ' active' : ''}" data-filter-toggle aria-expanded="${state.filterOpen ? 'true' : 'false'}">${icon('filter')}<span>Filter</span>${nFilter ? `<span class="badge count">${nFilter}</span>` : ''}</button>
        </div>
        <div class="sheet-actions">
          <span class="sheet-actions-info"><strong>${fh(total)}</strong> / ${fh(contract)} uur · ${label}</span>
          ${submitted && !editable ? '<button class="btn" type="button" data-sheet-action="recall">Terughalen</button>' : ''}
          <button class="btn primary" type="button" data-sheet-action="submit"${editable ? '' : ' disabled'}>${month ? 'Maand' : 'Week'} indienen</button>
        </div>
      </div>`;
  }

  function refreshSheetChrome(view) {
    const data = state.sheet;
    view.querySelector('#sheet-head').innerHTML = weekNavHTML(data);

    const rejected = [...data.map.values()].filter((e) => e.status === 'rejected');
    view.querySelector('#sheet-notices').innerHTML = rejected.length
      ? `<div class="notice error" style="margin-bottom:1rem">
           <strong>${rejected.length === 1 ? 'Eén regel is' : `${rejected.length} regels zijn`} afgekeurd.</strong>
           ${[...new Set(rejected.map((e) => e.rejection_reason))].map((r) => esc(r)).join(' ')}
           Pas de uren aan en dien de week opnieuw in.
         </div>`
      : '';

    for (const el of view.querySelectorAll('[data-budget]')) {
      const { pid, aid } = parseKey(el.dataset.budget);
      const infos = budgetInfos(pid, aid);
      el.hidden = !infos.length;
      el.innerHTML = el.dataset.compact !== undefined
        ? infos.map(budgetMini).join('')
        : infos.map((i) => `<div class="budget-row"><span class="budget-kind">${i.kind}</span>${budgetBar(i.used, i.budget, i.unit, i.kind)}</div>`).join('');
    }

    if (!view.querySelector('table.grid')) return;
    let week = 0;
    for (const tr of view.querySelectorAll('tbody tr[data-row]')) {
      const { pid, aid } = parseKey(tr.dataset.row);
      const sum = data.days.reduce((s, d) => s + ((data.map.get(cellKey(pid, aid, d)) || {}).hours || 0), 0);
      tr.querySelector('[data-rowtotal]').textContent = sum ? fh(sum) : '';
      week += sum;
    }
    // Ook regels in ingeklapte groepen tellen mee.
    const visible = visibleRows(data);
    week = visible.reduce((s, r) => s + data.days.reduce((t, d) => t + ((data.map.get(cellKey(r.pid, r.aid, d)) || {}).hours || 0), 0), 0);
    for (const tr of view.querySelectorAll('tbody tr.grp')) {
      const g = tr.dataset.grp;
      const gr = visible.filter((r) => (r.project.client_name || 'Intern') === g);
      let gt = 0;
      for (const td of tr.querySelectorAll('[data-grp-day]')) {
        const s = gr.reduce((t, r) => t + ((data.map.get(cellKey(r.pid, r.aid, td.dataset.grpDay)) || {}).hours || 0), 0);
        td.textContent = s ? fh(s) : '';
        gt += s;
      }
      tr.querySelector('[data-grp-total]').textContent = gt ? fh(gt) : '';
    }
    for (const d of data.days) {
      const sum = visible.reduce((s, { pid, aid }) => s + ((data.map.get(cellKey(pid, aid, d)) || {}).hours || 0), 0);
      const td = view.querySelector(`[data-coltotal="${d}"]`);
      td.textContent = sum ? fh(sum) : '';
      td.classList.toggle('over', sum > 12);
    }
    view.querySelector('[data-weektotal]').textContent = fh(week);
  }

  function paintCell(td, entry) {
    td.className = td.className.replace(/\bs-\w+/g, '').trim();
    if (entry) td.classList.add(`s-${entry.status}`);
    const note = td.querySelector('.note');
    note.classList.toggle('has', Boolean(entry && entry.description));
    note.title = (entry && entry.description) || 'Omschrijving toevoegen';
  }

  async function saveCell(view, input) {
    const rk = input.closest('tr').dataset.row;
    const { pid, aid } = parseKey(rk);
    const date = input.dataset.date;
    const key = cellKey(pid, aid, date);
    const existing = state.sheet.map.get(key);
    const hours = parseHours(input.value);
    if (Number.isNaN(hours) || hours < 0 || hours > 24) {
      input.classList.add('error');
      toast('Vul een aantal uren in tussen 0 en 24, bijvoorbeeld 7,5 of 7:30', true);
      return;
    }
    input.classList.remove('error');
    if ((existing ? existing.hours : 0) === hours) {
      input.value = fmtInput(hours);
      return;
    }
    input.classList.add('saving');
    try {
      const res = await api('/timesheet/entry', {
        method: 'PUT',
        body: { project_id: pid, activity_id: aid || null, work_date: date, hours, description: existing ? existing.description : '' },
      });
      if (res.deleted) state.sheet.map.delete(key);
      else state.sheet.map.set(key, res);
      input.value = fmtInput(res.deleted ? 0 : res.hours);
      paintCell(input.closest('td'), res.deleted ? null : res);
      refreshSheetChrome(view);
    } catch (e) {
      input.classList.add('error');
      toast(e.message, true);
    } finally {
      input.classList.remove('saving');
    }
  }

  /* Slepen: verplaatsen of (met Ctrl/Alt/⌘) kopiëren naar een ander vak */

  function cellAt(view, rk, date) {
    return view.querySelector(`tr[data-row="${rk}"] td[data-date="${date}"]`);
  }

  function updateCellUI(view, rk, date, entry) {
    const td = cellAt(view, rk, date);
    if (!td) return;
    td.querySelector('input.hrs').value = fmtInput(entry && entry.hours);
    paintCell(td, entry);
  }

  function startDrag(view, grip, ev) {
    const td = grip.closest('td.cell');
    if (td.querySelector('input.hrs').disabled) return;
    const rk = td.closest('tr').dataset.row;
    const { pid, aid } = parseKey(rk);
    const date = td.dataset.date;
    const entry = state.sheet.map.get(cellKey(pid, aid, date));
    if (!entry || !EDITABLE.includes(entry.status)) return;
    ev.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    grip.setPointerCapture(ev.pointerId);

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    document.body.appendChild(ghost);
    document.body.classList.add('dragging');
    td.classList.add('drag-source');
    let target = null;
    const isCopy = (e) => e.ctrlKey || e.altKey || e.metaKey;

    const move = (e) => {
      ghost.textContent = `${fh(entry.hours)} uur ${isCopy(e) ? 'kopiëren' : 'verplaatsen'}`;
      ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el && el.closest('td.cell');
      const ok = cell && view.contains(cell) && cell !== td && !cell.querySelector('input.hrs').disabled;
      if (target && target !== cell) target.classList.remove('drop-target');
      target = ok ? cell : null;
      if (target) target.classList.add('drop-target');
    };
    const cleanup = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', cleanup);
      document.removeEventListener('keydown', onKey);
      ghost.remove();
      document.body.classList.remove('dragging');
      td.classList.remove('drag-source');
      if (target) target.classList.remove('drop-target');
    };
    const finish = (e) => {
      const dropOn = target;
      cleanup();
      if (dropOn) dropEntry(view, rk, date, dropOn.closest('tr').dataset.row, dropOn.dataset.date, isCopy(e));
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { target = null; cleanup(); }
    };

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', cleanup);
    document.addEventListener('keydown', onKey);
    move(ev);
  }

  async function dropEntry(view, fromRk, fromDate, toRk, toDate, copy) {
    const from = parseKey(fromRk);
    const to = parseKey(toRk);
    const src = state.sheet.map.get(cellKey(from.pid, from.aid, fromDate));
    if (!src) return;
    try {
      const { res, existing } = await addToCell(to.pid, to.aid, toDate, src.hours, src.description);
      updateCellUI(view, toRk, toDate, res);
      if (!copy) {
        await clearCell(from.pid, from.aid, fromDate);
        updateCellUI(view, fromRk, fromDate, null);
      }
      refreshSheetChrome(view);
      toast(`${fh(src.hours)} uur ${copy ? 'gekopieerd' : 'verplaatst'} naar ${dayLabel(toDate)}${existing ? `, opgeteld bij ${fh(existing.hours)} uur` : ''}`);
    } catch (e) {
      toast(e.message, true);
      refreshSheetChrome(view);
    }
  }

  function openNote(view, rk, date) {
    const { pid, aid } = parseKey(rk);
    const key = cellKey(pid, aid, date);
    const entry = state.sheet.map.get(key);
    if (!entry) {
      toast('Vul eerst de uren in, dan kun je er een omschrijving bij zetten');
      const input = cellAt(view, rk, date);
      if (input && !input.querySelector('input').disabled) input.querySelector('input').focus();
      return;
    }
    const locked = !EDITABLE.includes(entry.status);
    openDialog({
      title: `${rowLabel(pid, aid)}, ${dayLabel(date)}`,
      submit: locked ? 'Sluiten' : 'Opslaan',
      body: `
        ${entry.rejection_reason ? `<div class="notice error">Afgekeurd: ${esc(entry.rejection_reason)}</div>` : ''}
        <p class="muted small">${fh(entry.hours)} uur, ${STATUS[entry.status].toLowerCase()}</p>
        <label class="field">Wat heb je gedaan?
          <textarea name="description" maxlength="1000"${locked ? ' disabled' : ''}>${esc(entry.description)}</textarea>
        </label>`,
      onSubmit: async (fd) => {
        if (locked) return;
        const res = await api('/timesheet/entry', {
          method: 'PUT',
          body: { project_id: pid, activity_id: aid || null, work_date: date, hours: entry.hours, description: fd.get('description') },
        });
        state.sheet.map.set(key, res);
        paintCell(cellAt(view, rk, date), res);
        refreshSheetChrome(view);
      },
    });
  }

  async function sheetAction(view, action) {
    const week = state.sheet.week_start;
    const month = state.sheet.period === 'month';
    const period = month ? { month: week.slice(0, 7) } : { week };
    try {
      if (action === 'submit') {
        const missing = [...state.sheet.map.values()].filter((e) => EDITABLE.includes(e.status) && !e.description).length;
        const extra = missing ? ` ${missing === 1 ? 'Eén regel heeft' : `${missing} regels hebben`} nog geen omschrijving.` : '';
        const label = month ? 'Maand indienen' : 'Week indienen';
        const ok = await confirmDialog(label, `Na indienen kun je de uren niet meer wijzigen, tenzij je ze terughaalt.${extra}`, label);
        if (!ok) return;
        const res = await api('/timesheet/submit', { method: 'POST', body: period });
        toast(`${res.submitted} ${res.submitted === 1 ? 'regel' : 'regels'} ingediend`);
      } else if (action === 'recall') {
        const res = await api('/timesheet/recall', { method: 'POST', body: period });
        toast(`${res.recalled} ${res.recalled === 1 ? 'regel' : 'regels'} teruggehaald`);
      }
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ================= Overzicht (beheerders) ================= */

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
  }

  async function viewDashboard(view) {
    const today = todayIso();
    const lastWeek = addDays(weekStart(today), -7);
    const prevMonth = monthBounds(-1);
    const curMonth = monthBounds(0);
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const [pending, candPrev, candCur, year, week] = await Promise.all([
      api('/approvals?status=submitted'),
      api(`/invoicing/candidates?from=${prevMonth.from}&to=${prevMonth.to}`),
      api(`/invoicing/candidates?from=${curMonth.from}&to=${curMonth.to}`),
      api(`/reports/summary?from=${yearStart}&to=${today}`),
      api(`/reports/summary?from=${lastWeek}&to=${addDays(lastWeek, 6)}`),
    ]);

    // Te beoordelen, per medewerker.
    const byUser = new Map();
    for (const r of pending) {
      const u = byUser.get(r.user_name) || { hours: 0, rows: 0 };
      u.hours += r.hours; u.rows += 1;
      byUser.set(r.user_name, u);
    }
    const pendingHours = pending.reduce((s, r) => s + r.hours, 0);

    // Te factureren: vorige maand eerst (dat is wat je nu factureert), deze maand ter info.
    const billPrev = candPrev.filter((c) => c.hours > 0);
    const prevAmount = billPrev.reduce((s, c) => s + c.amount, 0);
    const curAmount = candCur.reduce((s, c) => s + c.amount, 0);

    // Budgetten die bijna op zijn (minder dan 25% over) of overschreden.
    const budgets = [];
    for (const x of year.byActivity || []) {
      if (!x.active) continue;
      if (x.budget_hours) budgets.push({ label: `${x.client_name || 'Intern'} / ${x.project_name}`, sub: x.activity_name, used: x.hours_all_time, budget: x.budget_hours, unit: 'hours' });
      else if (x.budget_amount) budgets.push({ label: `${x.client_name || 'Intern'} / ${x.project_name}`, sub: x.activity_name, used: x.value_all_time, budget: x.budget_amount, unit: 'amount' });
    }
    for (const x of year.byProject || []) {
      if (x.active && x.budget_hours) budgets.push({ label: `${x.client_name || 'Intern'} / ${x.name}`, sub: 'Projectbudget', used: x.hours_all_time, budget: x.budget_hours, unit: 'hours' });
    }
    const tight = budgets.filter((b) => ['low', 'over'].includes(budgetLevel(b.used, b.budget)))
      .sort((x, y) => (x.budget - x.used) / x.budget - (y.budget - y.used) / y.budget);

    // Vorige week: wie heeft nog niet (alles) ingediend.
    const late = (week.byUser || []).filter((u) => u.draft_hours > 0 || u.hours === 0);

    const tile = (href, label, value, sub, lvl = '') => `
      <a class="panel tile${lvl ? ` tile-${lvl}` : ''}" href="${href}">
        <span class="tile-label">${label}</span><strong class="tile-value">${value}</strong><span class="tile-sub muted small">${sub}</span>
      </a>`;
    const monthName = (b) => MONTHS_LONG[Number(b.from.slice(5, 7)) - 1];

    view.innerHTML = `
      <div class="stack dash">
        <div class="row spread"><h1>${greeting()}${state.user.name ? `, ${esc(state.user.name.split(' ')[0])}` : ''}</h1>
          <a class="btn" href="#/uren">${icon('clock')} Uren schrijven</a></div>
        <div class="tiles">
          ${tile('#/goedkeuren', 'Te beoordelen', pending.length ? `${fh(pendingHours)} uur` : 'Niets', pending.length ? `${pending.length} regels van ${byUser.size} ${byUser.size === 1 ? 'medewerker' : 'medewerkers'}` : 'Alles is beoordeeld', pending.length ? 'warn' : 'ok')}
          ${tile('#/facturen', `Te factureren ${monthName(prevMonth)}`, eur0(prevAmount), billPrev.length ? `${billPrev.length} ${billPrev.length === 1 ? 'klant' : 'klanten'}, goedgekeurd` : 'Niets meer open', prevAmount ? 'accent' : 'ok')}
          ${tile('#/rapportage', 'Budgetten bijna op', String(tight.length), tight.length ? 'Minder dan 25% over' : 'Alle budgetten ruim', tight.length ? 'low' : 'ok')}
          ${tile('#/rapportage', 'Week ' + isoWeek(lastWeek) + ' niet ingediend', String(late.length), late.length ? late.map((u) => esc(u.name.split(' ')[0])).join(', ') : 'Iedereen is bij', late.length ? 'warn' : 'ok')}
        </div>

        <div class="dash-cols">
          <section class="panel">
            <div class="panel-pad row spread"><h2>Te beoordelen</h2>${pending.length ? '<a class="btn small" href="#/goedkeuren">Beoordelen</a>' : ''}</div>
            ${byUser.size ? `<ul class="dash-list">${[...byUser.entries()].map(([n, u]) => `
              <li><a href="#/goedkeuren"><span>${esc(n)}</span><span class="muted">${u.rows} regels</span><strong>${fh(u.hours)} uur</strong></a></li>`).join('')}</ul>`
              : '<div class="empty small"><p>Er wacht niets op goedkeuring.</p></div>'}
          </section>

          <section class="panel">
            <div class="panel-pad row spread"><h2>Factureren</h2><a class="btn small" href="#/facturen" data-inv-prev>${monthName(prevMonth)}</a></div>
            ${billPrev.length ? `<ul class="dash-list">${billPrev.map((c) => `
              <li><a href="#/facturen" data-inv-client="${c.id}"><span>${esc(c.name)}</span><span class="muted">${fh(c.hours)} uur${c.eb_relation_id ? '' : ' · nog koppelen'}</span><strong>${eur0(c.amount)}</strong></a></li>`).join('')}</ul>`
              : `<div class="empty small"><p>Alles van ${monthName(prevMonth)} is gefactureerd.</p></div>`}
            <p class="panel-pad muted small dash-foot">Deze maand tot nu toe goedgekeurd: <strong>${eur0(curAmount)}</strong></p>
          </section>

          <section class="panel">
            <div class="panel-pad row spread"><h2>Budgetten</h2><a class="btn small" href="#/rapportage">Rapportage</a></div>
            ${tight.length ? `<ul class="dash-list budgets">${tight.slice(0, 6).map((b) => `
              <li><div><span>${esc(b.label)}</span><span class="muted small">${esc(b.sub)}</span></div>${budgetBar(b.used, b.budget, b.unit)}</li>`).join('')}</ul>`
              : `<div class="empty small"><p>${budgets.length ? 'Alle budgetten hebben nog meer dan 25% over.' : 'Nog geen budgetten ingesteld. Dat doe je bij Beheer › Projecten › Activiteiten.'}</p></div>`}
          </section>

          <section class="panel">
            <div class="panel-pad"><h2>Week ${isoWeek(lastWeek)}</h2></div>
            <ul class="dash-list">${(week.byUser || []).map((u) => {
              const st = u.hours === 0 ? '<span class="badge rejected">Niets geschreven</span>'
                : u.draft_hours > 0 ? `<span class="badge submitted">${fh(u.draft_hours)} uur niet ingediend</span>`
                  : u.submitted_hours > 0 ? '<span class="badge">Te beoordelen</span>' : '<span class="badge approved">Ingediend</span>';
              return `<li><div class="dash-li"><span>${esc(u.name)}</span><span class="muted">${fh(u.hours)} / ${fh(u.weekly_hours)} uur</span>${st}</div></li>`;
            }).join('')}</ul>
          </section>
        </div>
      </div>`;

    view.querySelector('[data-inv-prev]').addEventListener('click', () => { state.invoicePeriod = prevMonth; });
    view.querySelectorAll('[data-inv-client]').forEach((l) => l.addEventListener('click', () => {
      state.invoicePeriod = prevMonth;
      state.openInvoiceClient = Number(l.dataset.invClient);
    }));
  }

  /* ================= Goedkeuren ================= */

  async function viewApprovals(view, params) {
    const status = params[0] === 'goedgekeurd' ? 'approved' : 'submitted';
    const rows = await api(`/approvals?status=${status}`);
    if (status === 'submitted') state.pendingCount = rows.length;

    const groups = new Map();
    for (const r of rows) {
      const key = `${r.user_id}|${weekStart(r.work_date)}`;
      if (!groups.has(key)) groups.set(key, { user: r.user_name, week: weekStart(r.work_date), rows: [] });
      groups.get(key).rows.push(r);
    }

    const tabs = `
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="${status === 'submitted'}" data-href="#/goedkeuren">Te beoordelen</button>
        <button role="tab" aria-selected="${status === 'approved'}" data-href="#/goedkeuren/goedgekeurd">Goedgekeurd, nog niet gefactureerd</button>
      </div>`;

    const body = groups.size ? [...groups.values()].map((g, gi) => {
      const total = g.rows.reduce((s, r) => s + r.hours, 0);
      const actions = status === 'submitted'
        ? `<button class="btn danger" data-act="reject" data-group="${gi}">Afkeuren</button>
           <button class="btn primary" data-act="approve" data-group="${gi}">Goedkeuren</button>`
        : `<button class="btn" data-act="reopen" data-group="${gi}">Terugzetten naar concept</button>`;
      return `
        <section class="panel approval-group" data-group="${gi}">
          <header>
            <div><span class="who">${esc(g.user)}</span>
              <span class="muted">week ${isoWeek(g.week)}, ${fmtRange(g.week, addDays(g.week, 6))}</span></div>
            <div class="row"><strong>${fh(total)} uur</strong>${actions}</div>
          </header>
          <div class="table-wrap"><table class="data">
            <thead><tr>
              <th><input type="checkbox" checked data-all aria-label="Alles selecteren"></th>
              <th>Datum</th><th>Klant / project</th><th class="num">Uren</th>
              ${status === 'approved' ? '<th class="num">Tarief</th>' : ''}<th>Omschrijving</th>
            </tr></thead>
            <tbody>${g.rows.map((r) => `
              <tr>
                <td><input type="checkbox" checked value="${r.id}" aria-label="Selecteer regel"></td>
                <td class="nowrap">${DAYS[dow(r.work_date)]} ${fmtDate(r.work_date)}</td>
                <td>${esc(r.client_name || 'Intern')} / ${esc(r.project_name)}${r.activity_name ? `<br><span class="muted small">${esc(r.activity_name)}</span>` : ''}${r.billable ? '' : ' <span class="muted small">(niet declarabel)</span>'}</td>
                <td class="num">${fh(r.hours)}</td>
                ${status === 'approved' ? `<td class="num">${eur(r.rate)}</td>` : ''}
                <td>${esc(r.description) || '<span class="muted">Geen omschrijving</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </section>`;
    }).join('') : `
      <div class="panel empty">
        <h2>${status === 'submitted' ? 'Niets te beoordelen' : 'Geen openstaande goedgekeurde uren'}</h2>
        <p>${status === 'submitted' ? 'Alle ingediende uren zijn verwerkt.' : 'Alles wat is goedgekeurd, is ook gefactureerd.'}</p>
      </div>`;

    view.innerHTML = `<div class="row spread" style="margin-bottom:1rem"><h1>Goedkeuren</h1></div>${tabs}${body}`;

    view.querySelectorAll('[data-href]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.href; }));
    view.addEventListener('change', (e) => {
      if (!e.target.matches('[data-all]')) return;
      e.target.closest('table').querySelectorAll('tbody input[type="checkbox"]').forEach((c) => { c.checked = e.target.checked; });
    });
    view.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const section = view.querySelector(`section[data-group="${btn.dataset.group}"]`);
      const ids = [...section.querySelectorAll('tbody input:checked')].map((c) => Number(c.value));
      if (!ids.length) { toast('Selecteer eerst een of meer regels', true); return; }
      try {
        if (btn.dataset.act === 'approve') {
          const res = await api('/approvals/approve', { method: 'POST', body: { ids } });
          toast(`${res.approved} ${res.approved === 1 ? 'regel' : 'regels'} goedgekeurd`);
          render();
        } else if (btn.dataset.act === 'reopen') {
          const res = await api('/approvals/reopen', { method: 'POST', body: { ids } });
          toast(`${res.reopened} ${res.reopened === 1 ? 'regel' : 'regels'} teruggezet`);
          render();
        } else {
          openDialog({
            title: `${ids.length} ${ids.length === 1 ? 'regel' : 'regels'} afkeuren`,
            submit: 'Afkeuren',
            danger: true,
            body: '<label class="field">Reden<span class="hint">De medewerker ziet deze tekst bij de afgekeurde uren.</span><textarea name="reason" required maxlength="500"></textarea></label>',
            onSubmit: async (fd) => {
              const res = await api('/approvals/reject', { method: 'POST', body: { ids, reason: fd.get('reason') } });
              toast(`${res.rejected} ${res.rejected === 1 ? 'regel' : 'regels'} afgekeurd`);
              render();
            },
          });
        }
      } catch (ex) {
        toast(ex.message, true);
      }
    });
  }

  /* ================= Facturen ================= */

  async function viewInvoicing(view, params = []) {
    const tab = params[0] === 'historie' ? 'historie' : 'open';
    state.invoicePeriod = state.invoicePeriod || monthBounds(-1);
    const { from, to } = state.invoicePeriod;
    const [candidates, history] = await Promise.all([
      api(`/invoicing/candidates?from=${from}&to=${to}`),
      api('/invoicing/history'),
    ]);

    const candRows = candidates.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td>${c.eb_relation_id ? esc(c.eb_relation_code || `#${c.eb_relation_id}`) : '<a href="#/beheer/klanten">Nog koppelen</a>'}</td>
        <td class="num">${fh(c.hours)}</td>
        <td class="num">${eur(c.amount)}</td>
        <td class="num">${c.open_hours ? `<span class="badge submitted">${fh(c.open_hours)} uur</span>` : ''}</td>
        <td class="right"><button class="btn small" data-preview="${c.id}"${c.hours ? '' : ' disabled'}>Bekijk factuur</button></td>
      </tr>`).join('');

    const histRows = history.map((i) => `
      <tr${i.reverted_at ? ' class="muted"' : ''}>
        <td><strong>${esc(i.eb_invoice_number || (i.eb_invoice_id ? `#${i.eb_invoice_id}` : '–'))}</strong>${/^https:\/\//i.test(i.pdf_url || '') ? ` <a href="${esc(i.pdf_url)}" target="_blank" rel="noopener noreferrer">PDF</a>` : ''}</td>
        <td>${esc(i.client_name)}</td>
        <td class="nowrap">${fmtRange(i.period_from, i.period_to)}</td>
        <td class="num">${fh(i.hours)}</td>
        <td class="num">${eur(i.total_excl)}</td>
        <td class="nowrap">${fmtDate(i.created_at.slice(0, 10), true)}</td>
        <td class="right nowrap">${i.reverted_at
          ? `<span class="badge" title="Teruggedraaid op ${fmtDate(i.reverted_at.slice(0, 10), true)}${i.reverted_by_name ? ` door ${esc(i.reverted_by_name)}` : ''}">Teruggedraaid</span>`
          : `<button class="btn small" data-revert="${i.id}">Terugdraaien</button>`}</td>
      </tr>`).join('');

    const pendingOpen = candidates.reduce((s, c) => s + (c.open_hours || 0), 0);
    const total = candidates.reduce((s, c) => s + c.amount, 0);
    const active = history.filter((i) => !i.reverted_at).length;
    const periodLabel = (() => {
      const m = monthBounds(-1); const c = monthBounds(0);
      if (from === m.from && to === m.to) return 'vorige maand';
      if (from === c.from && to === c.to) return 'deze maand';
      return fmtRange(from, to);
    })();
    view.innerHTML = `
      <div class="stack">
        <div class="row spread"><h1>Facturen</h1></div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${tab === 'open'}" data-href="#/facturen">Te factureren</button>
          <button role="tab" aria-selected="${tab === 'historie'}" data-href="#/facturen/historie">Gemaakte facturen <span class="muted">${active}</span></button>
        </div>
        ${tab === 'open' ? `
        <form class="period-bar" id="period">
          <div class="seg" role="group" aria-label="Periode">
            <button type="button" data-month="-1" aria-pressed="${periodLabel === 'vorige maand'}">Vorige maand</button>
            <button type="button" data-month="0" aria-pressed="${periodLabel === 'deze maand'}">Deze maand</button>
          </div>
          <details class="period-custom"${periodLabel.includes('–') ? ' open' : ''}><summary class="btn ghost small">Andere periode</summary>
            <div class="row">
              <label class="field">Van<input type="date" name="from" value="${from}" required></label>
              <label class="field">Tot en met<input type="date" name="to" value="${to}" required></label>
              <button class="btn primary" type="submit" style="align-self:end">Toon</button>
            </div>
          </details>
        </form>
        <section class="panel">
          <div class="panel-pad">
            <h2>Stap 1 · Kies een klant</h2>
            <p class="muted small">${candidates.length ? `${eur(total)} excl. btw aan goedgekeurde uren in ${periodLabel}.` : ''} Alleen goedgekeurde uren op declarabele projecten komen op de factuur.</p>
            ${pendingOpen ? `<div class="notice warn small">Er staan nog ${fh(pendingOpen)} uur in deze periode die niet zijn goedgekeurd. <a href="#/goedkeuren">Naar Goedkeuren</a></div>` : ''}
          </div>
          ${candidates.length ? `<ul class="client-pick">${candidates.map((c) => `
            <li>
              <button type="button" class="client-row" data-preview="${c.id}"${c.hours ? '' : ' disabled'}>
                <span class="cr-name">${esc(c.name)}<span class="muted small">${c.eb_relation_id ? esc(c.eb_relation_code || `#${c.eb_relation_id}`) : 'Nog niet gekoppeld aan e-Boekhouden'}</span></span>
                <span class="cr-hours">${fh(c.hours)} uur${c.open_hours ? `<span class="badge submitted">+${fh(c.open_hours)} open</span>` : ''}</span>
                <strong class="cr-amount">${eur(c.amount)}</strong>
                ${icon('chevron', 'chev')}
              </button>
            </li>`).join('')}</ul>`
          : `<div class="empty"><h2>Niets te factureren in ${periodLabel}</h2><p>${pendingOpen ? 'Keur eerst de openstaande uren goed.' : 'Kies een andere periode, of kijk bij Gemaakte facturen.'}</p></div>`}
        </section>` : `
        <section class="panel">
          ${history.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>Factuurnummer</th><th>Klant</th><th>Periode</th><th class="num">Uren</th><th class="num">Excl. btw</th><th>Gemaakt</th><th></th></tr></thead>
            <tbody>${histRows}</tbody></table></div>`
          : '<div class="empty"><h2>Nog geen facturen</h2><p>Facturen die je hier maakt, komen in deze lijst. <a href="#/facturen">Naar Te factureren</a></p></div>'}
        </section>`}
      </div>`;
    view.querySelectorAll('[data-href]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.href; }));
    if (tab === 'open' && state.openInvoiceClient) {
      const id = state.openInvoiceClient;
      state.openInvoiceClient = null;
      if (candidates.some((c) => c.id === id && c.hours)) showInvoicePreview(view, id);
    }

    const form = view.querySelector('#period');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      state.invoicePeriod = { from: form.from.value, to: form.to.value };
      render();
    });
    view.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
      state.invoicePeriod = monthBounds(Number(b.dataset.month));
      render();
    }));
    view.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => {
      showInvoicePreview(view, Number(b.dataset.preview));
    }));
    view.querySelectorAll('[data-revert]').forEach((b) => b.addEventListener('click', () => {
      const inv = history.find((x) => x.id === Number(b.dataset.revert));
      const nr = inv.eb_invoice_number || (inv.eb_invoice_id ? `#${inv.eb_invoice_id}` : '');
      openDialog({
        title: `Factuur ${nr} terugdraaien`.replace('  ', ' '),
        submit: 'Terugdraaien',
        danger: true,
        body: `
          <div class="notice warn"><strong>Eerst in e-Boekhouden:</strong> verwijder deze factuur (als hij nog een concept is) of maak er een creditfactuur voor. De app kan facturen in e-Boekhouden niet verwijderen.</div>
          <p>Daarna zet terugdraaien de ${fh(inv.hours)} uur van ${esc(inv.client_name)} (${fmtRange(inv.period_from, inv.period_to)}, ${eur(inv.total_excl)} excl. btw) terug naar goedgekeurd, zodat je ze opnieuw kunt factureren.</p>
          <label class="check"><input type="checkbox" name="confirm" required> Ik heb de factuur in e-Boekhouden verwijderd of gecrediteerd</label>`,
        onSubmit: async (fd) => {
          if (fd.get('confirm') !== 'on') throw new Error('Vink eerst aan dat de factuur in e-Boekhouden is verwijderd of gecrediteerd');
          const res = await api(`/invoicing/${inv.id}/revert`, { method: 'POST' });
          toast(`Factuur teruggedraaid: ${res.reverted} ${res.reverted === 1 ? 'regel' : 'regels'} (${fh(res.hours)} uur) weer te factureren`);
          render();
        },
      });
    }));
  }

  // projectIds: null = alle projecten van de klant met uren in de periode.
  // Zijpaneel (desktop) of volledig scherm (mobiel) voor de factuur.
  function invoiceDrawer() {
    let d = document.querySelector('.drawer-backdrop');
    if (d) return d.querySelector('.drawer-body');
    d = document.createElement('div');
    d.className = 'drawer-backdrop';
    d.innerHTML = `
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header class="drawer-head"><h2 id="drawer-title">Factuur</h2><button type="button" class="btn icon-btn ghost" data-drawer-close aria-label="Sluiten">${icon('close')}</button></header>
        <div class="drawer-body"></div>
      </aside>`;
    const close = () => { d.remove(); document.body.classList.remove('drawer-open'); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-drawer-close]')) close(); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', close, { once: true });
    document.body.appendChild(d);
    document.body.classList.add('drawer-open');
    requestAnimationFrame(() => d.classList.add('in'));
    return d.querySelector('.drawer-body');
  }
  const closeDrawer = () => document.querySelector('[data-drawer-close]')?.click();

  async function showInvoicePreview(view, clientId, projectIds = null) {
    const { from, to } = state.invoicePeriod;
    const box = invoiceDrawer();
    if (!box.innerHTML) box.innerHTML = '<p class="muted panel-pad">Factuur voorbereiden…</p>';
    try {
      const q = projectIds ? `&project_ids=${projectIds.join(',')}` : '';
      const p = await api(`/invoicing/preview?client_id=${clientId}&from=${from}&to=${to}${q}`);
      const selected = new Set(projectIds || p.projects.map((x) => x.id));
      const multiPo = p.references.length > 1;
      const many = p.projects.length > 1;
      const projectPicker = p.projects.length ? `
        <div class="stack">
          <h3 class="step"><span>2</span>${many ? 'Projecten en PO' : 'Project en PO'}</h3>
          <div class="table-wrap"><table class="data">
            <thead><tr><th></th><th>Project</th><th>PO / referentie</th><th class="num">Uren</th><th class="num">Bedrag</th><th></th></tr></thead>
            <tbody>${p.projects.map((x) => `
              <tr>
                <td>${many ? `<input type="checkbox" data-proj="${x.id}"${selected.has(x.id) ? ' checked' : ''} aria-label="${esc(x.name)}">` : ''}</td>
                <td>${esc(x.name)}</td>
                <td><div class="row" style="gap:0.4rem;flex-wrap:nowrap">
                  <input class="po-input${x.reference ? '' : ' missing'}" data-proj-ref="${x.id}" value="${esc(x.reference || '')}" maxlength="50"
                    placeholder="Nog geen PO" aria-label="PO / referentie van ${esc(x.name)}" title="Wordt opgeslagen bij het project">
                  ${!x.reference && poFromName(x.name) ? `<button type="button" class="btn small" data-proj-ref-use="${x.id}" data-value="${esc(poFromName(x.name))}">${esc(poFromName(x.name))} gebruiken</button>` : ''}
                </div></td>
                <td class="num">${fh(x.hours)}</td>
                <td class="num">${eur(x.amount)}</td>
                <td class="right">${many ? `<button type="button" class="btn small" data-proj-only="${x.id}">Alleen ${x.reference ? 'deze PO' : 'dit project'}</button>` : ''}</td>
              </tr>`).join('')}</tbody>
          </table></div>
          <p class="muted small">De PO / referentie wordt opgeslagen bij het project en komt als referentie op de factuur.${many ? ' Maak per PO een aparte factuur met "Alleen deze PO".' : ''}</p>
        </div>` : '';
      document.getElementById('drawer-title').textContent = `Factuur voor ${p.client.name}`;
      box.innerHTML = `
        <section>
          <div class="drawer-pad stack">
            <p class="muted">${fmtRange(from, to)} · ${fh(p.hours)} uur · <strong>${eur(p.total_excl)}</strong> excl. btw</p>
            ${p.client.eb_relation_id ? '' : '<div class="notice warn">Deze klant is nog niet gekoppeld aan een relatie in e-Boekhouden. Doe dat eerst onder <a href="#/beheer/klanten">Beheer › Klanten</a>.</div>'}
            ${projectPicker}
            ${multiPo ? `<div class="notice warn">Deze factuur bevat uren van ${p.references.length} verschillende PO's (${p.references.map(esc).join(', ')}). Klanten verwachten meestal één PO per factuur: vink hierboven de projecten per PO aan.</div>` : ''}
            <h3 class="step"><span>3</span>Regels controleren</h3>
            <p class="muted small">${LINE_MODES[p.line_mode]}, opmaak <code>${esc(p.line_format)}</code>. Aan te passen per klant onder Beheer › Klanten.</p>
          </div>
          ${p.lines.length ? `<div class="table-wrap"><table class="data lines">
            <thead><tr><th>Omschrijving</th><th class="num">Uren</th><th class="num">Tarief</th><th class="num">Bedrag</th></tr></thead>
            <tbody>${p.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${fh(l.hours)}</td><td class="num">${eur(l.rate)}</td><td class="num">${eur(l.amount)}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Totaal excl. btw</td><td class="num">${fh(p.hours)}</td><td></td><td class="num">${eur(p.total_excl)}</td></tr></tfoot>
          </table></div>` : '<div class="panel-pad"><p class="muted">Geen projecten geselecteerd.</p></div>'}
          <form class="drawer-pad stack" id="make-invoice">
            <h3 class="step"><span>4</span>Factuurgegevens en versturen</h3>
            <div class="form-grid">
              <label class="field">Factuurnummer<span class="hint">Volgende vrije nummer${p.invoice_number.source === 'e-Boekhouden' ? ' in e-Boekhouden' : ' (e-Boekhouden niet bereikbaar, gebaseerd op de app)'}</span><input name="invoice_number" maxlength="30" value="${esc(p.invoice_number.number)}"></label>
              <label class="field">Factuurdatum<input type="date" name="date" value="${todayIso()}" required></label>
              <label class="field">Referentie op deze factuur<span class="hint">${p.reference ? 'Uit de PO van het project; aanpassen geldt alleen voor deze factuur' : 'Leeg: het project heeft nog geen PO (vul die hierboven in)'}</span><input name="reference" maxlength="50" value="${esc(p.reference || '')}"></label>
            </div>
            <label class="field">Factuurtekst<input name="text" maxlength="2000" value="${esc(p.invoice_text || '')}"></label>
            <label class="check"><input type="checkbox" name="send_email"${p.email_default ? ' checked' : ''}> Factuur direct mailen naar de klant (naar het factuur-e-mailadres in e-Boekhouden${p.email_template ? ', met het gekozen e-mailsjabloon' : ''})</label>
            <label class="check"><input type="checkbox" name="print"${p.print_default ? ' checked' : ''}> Klaarzetten voor verzending per post</label>
            <div data-dry-out></div>
            <div class="drawer-foot">
              <button class="btn" type="button" data-dry${p.lines.length ? '' : ' disabled'}>Bekijk API-verzoek</button>
              <button class="btn primary" type="submit"${p.client.eb_relation_id && p.lines.length ? '' : ' disabled'}>Maak factuur · ${eur(p.total_excl)}</button>
            </div>
          </form>
        </section>`;

      const currentIds = () => [...box.querySelectorAll('[data-proj]:checked')].map((c) => Number(c.dataset.proj));
      box.querySelectorAll('[data-proj]').forEach((c) => c.addEventListener('change', () => {
        showInvoicePreview(view, clientId, currentIds());
      }));
      // PO direct bij het project opslaan en de factuur opnieuw opbouwen.
      box.querySelectorAll('[data-proj-ref]').forEach((inp) => {
        const save = async () => {
          const proj = p.projects.find((x) => x.id === Number(inp.dataset.projRef));
          const value = inp.value.trim();
          if (value === (proj.reference || '')) return;
          try {
            await api(`/admin/projects/${proj.id}`, { method: 'PATCH', body: { reference: value } });
            toast(value ? `PO ${value} opgeslagen bij ${proj.name}` : `PO verwijderd bij ${proj.name}`);
            showInvoicePreview(view, clientId, projectIds);
          } catch (e) { toast(e.message, true); }
        };
        inp.addEventListener('change', save);
        const use = box.querySelector(`[data-proj-ref-use="${inp.dataset.projRef}"]`);
        if (use) use.addEventListener('click', () => { inp.value = use.dataset.value; save(); });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      });
      box.querySelectorAll('[data-proj-only]').forEach((b) => b.addEventListener('click', () => {
        // Alle projecten met dezelfde PO, of alleen dit project als het geen PO heeft.
        const proj = p.projects.find((x) => x.id === Number(b.dataset.projOnly));
        const ids = proj.reference ? p.projects.filter((x) => x.reference === proj.reference).map((x) => x.id) : [proj.id];
        showInvoicePreview(view, clientId, ids);
      }));

      const form = box.querySelector('#make-invoice');
      const payload = () => ({
        client_id: clientId, from, to, date: form.date.value, reference: form.reference.value,
        invoice_number: form.invoice_number.value, text: form.text.value, print: form.print.checked,
        send_email: form.send_email.checked,
        project_ids: projectIds,
      });
      form.querySelector('[data-dry]').addEventListener('click', async () => {
        const out = form.querySelector('[data-dry-out]');
        try {
          const res = await api('/invoicing/create', { method: 'POST', body: { ...payload(), dry_run: true } });
          out.innerHTML = `<p class="muted small">Dit wordt naar e-Boekhouden gestuurd:</p><pre class="json">${esc(JSON.stringify(res.body, null, 2))}</pre>`;
        } catch (e) {
          out.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
        }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = await confirmDialog(
          'Factuur maken',
          `Je maakt factuur ${esc(form.invoice_number.value || '(nummer door e-Boekhouden)')} van ${eur(p.total_excl)} excl. btw voor ${esc(p.client.name)}${form.reference.value ? ` met referentie ${esc(form.reference.value)}` : ''} in e-Boekhouden${form.send_email.checked ? ' en e-Boekhouden mailt hem direct naar de klant' : ''}. De ${fh(p.hours)} uur worden daarna als gefactureerd gemarkeerd.`,
          'Maak factuur'
        );
        if (!ok) return;
        try {
          const res = await api('/invoicing/create', { method: 'POST', body: payload() });
          toast(`Factuur ${res.invoice.eb_invoice_number || ''} gemaakt in e-Boekhouden${res.emailed ? ' en gemaild naar de klant' : ''}`.replace('  ', ' '));
          closeDrawer();
          render();
        } catch (ex) {
          toast(ex.message, true);
        }
      });
    } catch (e) {
      box.innerHTML = `<div class="drawer-pad"><div class="notice error">${esc(e.message)}</div></div>`;
    }
  }

  /* ================= Rapportage ================= */

  const BUDGET_LEGEND = `<p class="budget-legend small"><span class="lvl-ok"><i></i>Ruim budget (50–100% over)</span>
    <span class="lvl-warn"><i></i>Let op (25–50% over)</span><span class="lvl-low"><i></i>Bijna op of overschreden (minder dan 25%)</span></p>`;

  async function viewReports(view) {
    state.reportPeriod = state.reportPeriod || monthBounds(0);
    const { from, to } = state.reportPeriod;
    const r = await api(`/reports/summary?from=${from}&to=${to}`);

    const users = r.byUser.map((u) => `
      <tr>
        <td>${esc(u.name)}</td>
        <td class="num">${fh(u.hours)}</td>
        <td class="num">${fh(u.billable_hours)}</td>
        <td class="num">${fh(u.available_hours)}</td>
        <td><div class="row" style="flex-wrap:nowrap">${bar(u.utilization)}<span class="nowrap">${pct(u.utilization)}</span></div></td>
        <td class="num">${u.draft_hours ? fh(u.draft_hours) : ''}</td>
        <td class="num">${u.submitted_hours ? fh(u.submitted_hours) : ''}</td>
      </tr>`).join('');

    const projects = r.byProject.map((p) => {
      const ratio = p.budget_hours ? p.hours_all_time / p.budget_hours : null;
      return `
        <tr>
          <td>${esc(p.client_name || 'Intern')} / ${esc(p.name)}${p.active ? '' : ' <span class="muted small">(afgesloten)</span>'}</td>
          <td class="num">${fh(p.hours)}</td>
          <td class="num">${fh(p.approved_hours)}</td>
          <td class="num">${p.billable ? eur(p.value) : '–'}</td>
          <td>${p.budget_hours ? budgetBar(p.hours_all_time, p.budget_hours)
            : p.activity_budget_hours ? `${budgetBar(p.activity_budget_used, p.activity_budget_hours)}<span class="muted small">Som van activiteitbudgetten</span>`
              : '<span class="muted">Geen budget</span>'}</td>
        </tr>`;
    }).join('');

    const totalValue = r.byProject.reduce((s, p) => s + (p.billable ? p.value : 0), 0);

    view.innerHTML = `
      <div class="stack">
        <div class="row spread"><h1>Rapportage</h1>
          <a class="btn" href="/api/reports/export.csv?from=${from}&to=${to}">Exporteer naar CSV</a></div>
        <form class="panel panel-pad row" id="rperiod">
          <label class="field">Van<input type="date" name="from" value="${from}" required></label>
          <label class="field">Tot en met<input type="date" name="to" value="${to}" required></label>
          <div class="row" style="align-self:end">
            <button class="btn" type="button" data-month="-1">Vorige maand</button>
            <button class="btn" type="button" data-month="0">Deze maand</button>
            <button class="btn" type="button" data-year>Dit jaar</button>
            <button class="btn primary" type="submit">Toon</button>
          </div>
        </form>
        <p class="muted">${r.workdays} werkdagen${to > todayIso() ? ' tot en met vandaag' : ''}. Goedgekeurde omzet in deze periode: <strong>${eur(totalValue)}</strong> excl. btw.</p>
        <section class="panel">
          <div class="panel-pad"><h2>Medewerkers</h2>
            <p class="muted small">Bezetting is declarabele uren gedeeld door contracturen, gerekend tot en met vandaag.</p></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Medewerker</th><th class="num">Geschreven</th><th class="num">Declarabel</th><th class="num">Beschikbaar</th><th>Bezetting</th><th class="num">Nog in te dienen</th><th class="num">Te beoordelen</th></tr></thead>
            <tbody>${users}</tbody></table></div>
        </section>
        ${r.byActivity && r.byActivity.length ? `<section class="panel">
          <div class="panel-pad"><h2>Budgetten per activiteit</h2>
            <p class="muted small">Verbruik telt alle uren sinds de start, van alle medewerkers. Het bedrag telt alleen goedgekeurde en gefactureerde uren.</p>
            ${BUDGET_LEGEND}</div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Klant / project / activiteit</th><th class="num">Uren in periode</th><th>Budget uren</th><th>Budget €</th></tr></thead>
            <tbody>${r.byActivity.map((x) => `
              <tr>
                <td>${esc(x.client_name || 'Intern')} / ${esc(x.project_name)}<br><span class="muted small">${esc(x.activity_name)}</span>${x.active ? '' : ' <span class="muted small">(afgesloten)</span>'}</td>
                <td class="num">${fh(x.hours)}</td>
                <td>${x.budget_hours ? budgetBar(x.hours_all_time, x.budget_hours) : '<span class="muted">–</span>'}</td>
                <td>${x.budget_amount ? budgetBar(x.value_all_time, x.budget_amount, 'amount') : '<span class="muted">–</span>'}</td>
              </tr>`).join('')}</tbody></table></div>
        </section>` : ''}
        <section class="panel">
          <div class="panel-pad"><h2>Projecten</h2>
            <p class="muted small">Het budget telt alle geschreven uren sinds de start van het project.</p>
            ${BUDGET_LEGEND}</div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Klant / project</th><th class="num">Uren</th><th class="num">Goedgekeurd</th><th class="num">Waarde</th><th>Budget</th></tr></thead>
            <tbody>${projects}</tbody></table></div>
        </section>
      </div>`;

    const form = view.querySelector('#rperiod');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      state.reportPeriod = { from: form.from.value, to: form.to.value };
      render();
    });
    view.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
      state.reportPeriod = monthBounds(Number(b.dataset.month));
      render();
    }));
    view.querySelector('[data-year]').addEventListener('click', () => {
      const y = new Date().getFullYear();
      state.reportPeriod = { from: `${y}-01-01`, to: `${y}-12-31` };
      render();
    });
  }

  /* ================= Beheer ================= */

  const ADMIN_TABS = { medewerkers: 'Medewerkers', klanten: 'Klanten', projecten: 'Projecten', activiteiten: 'Activiteiten', import: 'Uren importeren', koppeling: 'Koppeling e-Boekhouden' };

  async function viewAdmin(view, params) {
    const tab = ADMIN_TABS[params[0]] ? params[0] : 'medewerkers';
    view.innerHTML = `
      <h1 style="margin-bottom:1rem">Beheer</h1>
      <div class="tabs" role="tablist">${Object.entries(ADMIN_TABS).map(([k, label]) => `
        <button role="tab" aria-selected="${k === tab}" data-href="#/beheer/${k}">${label}</button>`).join('')}</div>
      <div id="tab"></div>`;
    view.querySelectorAll('[data-href]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.href; }));
    const el = view.querySelector('#tab');
    await ({ medewerkers: adminUsers, klanten: adminClients, projecten: adminProjects, activiteiten: adminActivities, import: adminHoursImport, koppeling: adminEb })[tab](el);
  }

  function userForm(u = {}) {
    return `
      <div class="form-grid">
        <label class="field">Naam<input name="name" value="${esc(u.name)}" required maxlength="120"></label>
        ${u.id ? '' : '<label class="field">E-mailadres<input name="email" type="email" required></label>'}
        <label class="field">Rol<select name="role">
          ${opt('employee', 'Medewerker', u.role !== 'admin')}${opt('admin', 'Beheerder', u.role === 'admin')}</select></label>
        <label class="field">Contracturen per week<input name="weekly_hours" inputmode="decimal" value="${fmtInput(u.weekly_hours ?? 40)}"></label>
      </div>
      <label class="field">${u.id ? 'Nieuw wachtwoord' : 'Wachtwoord'}
        <span class="hint">${u.id ? 'Leeg laten om niet te wijzigen. ' : ''}Minstens 10 tekens. Geef het persoonlijk door.</span>
        <input name="password" type="text" autocomplete="new-password"${u.id ? '' : ' required'} minlength="10"></label>
      ${u.id ? `<label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}> Actief (kan inloggen en uren schrijven)</label>` : ''}`;
  }

  async function adminUsers(el) {
    const users = await api('/admin/users');
    el.innerHTML = `
      <section class="panel">
        <div class="panel-pad row spread"><h2>Medewerkers</h2><button class="btn primary" data-new>Medewerker toevoegen</button></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Naam</th><th>E-mailadres</th><th>Rol</th><th class="num">Uren per week</th><th>2FA</th><th>Status</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
              <td>${u.role === 'admin' ? 'Beheerder' : 'Medewerker'}</td>
              <td class="num">${fh(u.weekly_hours)}</td>
              <td>${u.totp_enabled ? '<span class="badge approved">Aan</span>' : (u.role === 'admin' ? '<span class="badge submitted">Nog instellen</span>' : '<span class="muted">Uit</span>')}</td>
              <td>${u.active ? 'Actief' : '<span class="muted">Inactief</span>'}</td>
              <td class="right"><button class="btn small" data-edit="${u.id}">Wijzigen</button></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>`;
    el.querySelector('[data-new]').addEventListener('click', () => openDialog({
      title: 'Medewerker toevoegen',
      submit: 'Toevoegen',
      body: userForm(),
      onSubmit: async (fd) => {
        await api('/admin/users', {
          method: 'POST',
          body: {
            name: fd.get('name'), email: fd.get('email'), role: fd.get('role'),
            weekly_hours: parseHours(fd.get('weekly_hours')), password: fd.get('password'),
          },
        });
        toast('Medewerker toegevoegd. Koppel hem of haar nu aan projecten.');
        adminUsers(el);
      },
    }));
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const u = users.find((x) => x.id === Number(b.dataset.edit));
      openDialog({
        title: `${u.name} wijzigen`,
        body: userForm(u) + (u.totp_enabled ? `
          <div class="notice"><strong>Tweestapsverificatie staat aan.</strong> Telefoon kwijt en geen herstelcodes meer?
            <div style="margin-top:0.5rem"><button type="button" class="btn small danger" data-mfa-reset>2FA resetten</button></div></div>` : ''),
        onOpen: (form) => {
          const b = form.querySelector('[data-mfa-reset]');
          if (!b) return;
          b.addEventListener('click', async () => {
            if (!(await confirmDialog('2FA resetten', `De tweestapsverificatie van ${esc(u.name)} wordt uitgezet en alle sessies worden afgemeld.${u.role === 'admin' ? ' Bij de volgende keer inloggen moet het opnieuw worden ingesteld.' : ''}`, '2FA resetten', true))) return;
            try {
              await api(`/admin/users/${u.id}/mfa-reset`, { method: 'POST' });
              toast(`2FA van ${u.name} gereset`);
              form.closest('dialog').close();
              if (u.id === state.user.id) { state.user.mfa_setup_required = state.user.role === 'admin'; render(); } else adminUsers(el);
            } catch (ex) { toast(ex.message, true); }
          });
        },
        onSubmit: async (fd) => {
          const body = {
            name: fd.get('name'), role: fd.get('role'),
            weekly_hours: parseHours(fd.get('weekly_hours')), active: fd.get('active') === 'on',
          };
          if (fd.get('password')) body.password = fd.get('password');
          await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
          toast('Opgeslagen');
          adminUsers(el);
        },
      });
    }));
  }

  async function adminClients(el) {
    const clients = await api('/admin/clients');
    el.innerHTML = `
      <section class="panel">
        <div class="panel-pad row spread"><h2>Klanten</h2>
          <div class="row"><button class="btn" data-eb-import>Ophalen uit e-Boekhouden</button>
          <button class="btn primary" data-new>Klant toevoegen</button></div></div>
        ${clients.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Naam</th><th>Relatie in e-Boekhouden</th><th class="num">Projecten</th><th>Status</th><th></th></tr></thead>
          <tbody>${clients.map((c) => `
            <tr>
              <td>${esc(c.name)}</td>
              <td>${c.eb_relation_id ? `Code ${esc(c.eb_relation_code)}` : '<span class="muted">Niet gekoppeld</span>'}</td>
              <td class="num">${c.project_count}</td>
              <td>${c.active ? 'Actief' : '<span class="muted">Inactief</span>'}</td>
              <td class="right nowrap">
                ${c.eb_relation_id
                  ? `<button class="btn small" data-unlink="${c.id}">Ontkoppelen</button>`
                  : `<button class="btn small" data-link="${c.id}">Koppelen</button>`}
                <button class="btn small" data-edit="${c.id}">Wijzigen</button>
              </td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty"><p>Voeg je eerste klant toe en koppel hem aan een relatie in e-Boekhouden.</p></div>'}
      </section>`;

    el.querySelector('[data-eb-import]').addEventListener('click', () => openEbClientImport(el));

    el.querySelector('[data-new]').addEventListener('click', () => openDialog({
      title: 'Klant toevoegen',
      submit: 'Toevoegen',
      body: '<label class="field">Naam<input name="name" required maxlength="200"></label>',
      onSubmit: async (fd) => {
        await api('/admin/clients', { method: 'POST', body: { name: fd.get('name') } });
        adminClients(el);
      },
    }));

    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const c = clients.find((x) => x.id === Number(b.dataset.edit));
      const s = (await api('/admin/settings')).eb;
      const defaults = { mode: s.lineMode, format: s.lineFormat };
      openDialog({
        title: `${c.name} wijzigen`,
        wide: true,
        body: `<label class="field">Naam<input name="name" value="${esc(c.name)}" required maxlength="200"></label>
               <label class="check"><input type="checkbox" name="active"${c.active ? ' checked' : ''}> Actief</label>
               <h3>Factuurregels voor deze klant</h3>
               <p class="muted small">Laat leeg om de standaardinstelling te gebruiken (Beheer › Koppeling).</p>
               ${lineFormatFields({ mode: c.invoice_line_mode, format: c.invoice_line_format, allowDefault: true, defaults })}`,
        onOpen: (form) => bindLineFormatFields(form, defaults),
        onSubmit: async (fd) => {
          await api(`/admin/clients/${c.id}`, {
            method: 'PATCH',
            body: {
              name: fd.get('name'), active: fd.get('active') === 'on',
              invoice_line_mode: fd.get('lineMode') || null, invoice_line_format: fd.get('lineFormat') || null,
            },
          });
          adminClients(el);
        },
      });
    }));

    el.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
      const c = clients.find((x) => x.id === Number(b.dataset.unlink));
      if (!(await confirmDialog('Ontkoppelen', `${esc(c.name)} loskoppelen van relatie ${esc(c.eb_relation_code)}? Er wordt niets verwijderd in e-Boekhouden.`, 'Ontkoppelen'))) return;
      try {
        await api(`/admin/clients/${c.id}/unlink`, { method: 'POST' });
        adminClients(el);
      } catch (e) { toast(e.message, true); }
    }));

    el.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => {
      const c = clients.find((x) => x.id === Number(b.dataset.link));
      openDialog({
        title: `${c.name} koppelen aan e-Boekhouden`,
        submit: 'Koppelen',
        body: `
          <label class="field">Wat wil je doen?<select name="mode">
            ${opt('existing', 'Bestaande relatie koppelen', true)}${opt('new', 'Nieuwe relatie aanmaken in e-Boekhouden', false)}</select></label>
          <label class="field">Relatiecode<span class="hint">Zoals in e-Boekhouden onder Relaties</span><input name="code" required maxlength="15"></label>
          <div data-newfields hidden class="form-grid">
            <label class="field">E-mail voor facturen<input name="emailAddressInvoice" type="email"></label>
            <label class="field">Adres<input name="address"></label>
            <label class="field">Postcode<input name="postalCode"></label>
            <label class="field">Plaats<input name="city"></label>
            <label class="field">Btw-nummer<input name="vatNumber"></label>
            <label class="field">Betaaltermijn (dagen)<input name="termOfPayment" inputmode="numeric" value="30"></label>
          </div>`,
        onOpen: (form) => {
          form.mode.addEventListener('change', () => {
            const isNew = form.mode.value === 'new';
            form.querySelector('[data-newfields]').hidden = !isNew;
            form.querySelector('[type="submit"]').textContent = isNew ? 'Aanmaken en koppelen' : 'Koppelen';
          });
        },
        onSubmit: async (fd) => {
          if (fd.get('mode') === 'new') {
            const body = Object.fromEntries(['code', 'emailAddressInvoice', 'address', 'postalCode', 'city', 'vatNumber', 'termOfPayment']
              .map((k) => [k, fd.get(k)]));
            await api(`/admin/clients/${c.id}/create-relation`, { method: 'POST', body });
            toast('Relatie aangemaakt in e-Boekhouden en gekoppeld');
          } else {
            const res = await api(`/admin/clients/${c.id}/link`, { method: 'POST', body: { code: fd.get('code') } });
            toast(`Gekoppeld aan ${res.relation.name || res.relation.code}`);
          }
          adminClients(el);
        },
      });
    }));
  }

  function projectForm(p, clients) {
    return `
      <div class="form-grid">
        <label class="field">Klant<select name="client_id">
          ${opt('', 'Intern (geen klant)', !p.client_id)}
          ${clients.filter((c) => c.active || c.id === p.client_id).map((c) => opt(c.id, c.name, c.id === p.client_id)).join('')}
        </select></label>
        <label class="field">Projectnaam<input name="name" value="${esc(p.name)}" required maxlength="200"></label>
        <label class="field">Code<span class="hint">Optioneel, komt op de factuurregel</span><input name="code" value="${esc(p.code)}" maxlength="30"></label>
        <label class="field">PO / referentie<span class="hint">Wordt de referentie op de factuur${!p.reference && poFromName(p.name) ? `. Uit de naam: ${esc(poFromName(p.name))}` : ''}</span><input name="reference" value="${esc(p.reference || '')}" maxlength="50"${!p.reference && poFromName(p.name) ? ` placeholder="Bijv. ${esc(poFromName(p.name))}"` : ''}></label>
        <label class="field">Uurtarief (€)<span class="hint">Standaard; per medewerker aan te passen</span><input name="default_rate" inputmode="decimal" value="${fmtInput(p.default_rate)}"></label>
        <label class="field">Budget (uren)<span class="hint">Optioneel</span><input name="budget_hours" inputmode="decimal" value="${fmtInput(p.budget_hours)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="billable"${p.billable !== false ? ' checked' : ''}> Declarabel (uren komen op de factuur)</label>
      ${p.id ? `<label class="check"><input type="checkbox" name="active"${p.active ? ' checked' : ''}> Actief (medewerkers kunnen erop schrijven)</label>` : ''}`;
  }

  const numOrNull = (v) => {
    if (v === null || String(v).trim() === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : v;
  };

  async function adminProjects(el) {
    const [projects, clients] = await Promise.all([api('/admin/projects'), api('/admin/clients')]);
    el.innerHTML = `
      <section class="panel">
        <div class="panel-pad row spread"><h2>Projecten</h2>
          <div class="row"><button class="btn" data-import>Importeren uit e-Boekhouden</button>
          <button class="btn primary" data-new>Project toevoegen</button></div></div>
        ${projects.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Klant / project</th><th>Code</th><th class="num">Tarief</th><th class="num">Budget</th><th class="num">Geschreven</th><th class="num">Activiteiten</th><th class="num">Team</th><th>Status</th><th></th></tr></thead>
          <tbody>${projects.map((p) => `
            <tr>
              <td>${esc(p.client_name || 'Intern')} / ${esc(p.name)}${p.billable ? '' : ' <span class="muted small">(niet declarabel)</span>'}${p.reference ? `<br><span class="muted small">Referentie: ${esc(p.reference)}</span>` : ''}</td>
              <td>${esc(p.code || '')}</td>
              <td class="num">${!p.billable ? '–' : (p.default_rate ? eur(p.default_rate) : (p.activity_count ? '<span class="muted">Per activiteit</span>' : '<span class="badge submitted">Tarief ontbreekt</span>'))}</td>
              <td class="num">${p.budget_hours ? fh(p.budget_hours) : (p.activity_budget_hours ? `<span title="Som van de activiteitbudgetten">${fh(p.activity_budget_hours)}</span>` : '')}</td>
              <td class="num">${fh(p.hours_total)}</td>
              <td class="num">${p.activity_count || ''}</td>
              <td class="num">${p.member_count}</td>
              <td>${p.active ? 'Actief' : '<span class="muted">Afgesloten</span>'}</td>
              <td class="right nowrap">
                <button class="btn small" data-acts="${p.id}">Activiteiten</button>
                <button class="btn small" data-team="${p.id}">Team</button>
                <button class="btn small" data-edit="${p.id}">Wijzigen</button>
              </td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty"><p>Maak een project aan, bijvoorbeeld een detacheringsopdracht of "Intern / acquisitie".</p></div>'}
      </section>`;

    const collect = (fd) => ({
      client_id: fd.get('client_id') ? Number(fd.get('client_id')) : null,
      name: fd.get('name'),
      code: fd.get('code'),
      reference: fd.get('reference'),
      default_rate: numOrNull(fd.get('default_rate')) ?? 0,
      budget_hours: numOrNull(fd.get('budget_hours')),
      billable: fd.get('billable') === 'on',
    });

    el.querySelector('[data-import]').addEventListener('click', () => openProjectImport(el, projects, clients));

    el.querySelector('[data-new]').addEventListener('click', () => openDialog({
      title: 'Project toevoegen',
      submit: 'Toevoegen',
      body: projectForm({ billable: true }, clients),
      onSubmit: async (fd) => {
        const p = await api('/admin/projects', { method: 'POST', body: collect(fd) });
        toast('Project toegevoegd. Stel nu het team samen.');
        await adminProjects(el);
        openTeam(el, p);
      },
    }));

    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const p = projects.find((x) => x.id === Number(b.dataset.edit));
      openDialog({
        title: `${p.name} wijzigen`,
        body: projectForm(p, clients),
        onSubmit: async (fd) => {
          await api(`/admin/projects/${p.id}`, { method: 'PATCH', body: { ...collect(fd), active: fd.get('active') === 'on' } });
          adminProjects(el);
        },
      });
    }));

    el.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', () => {
      openTeam(el, projects.find((x) => x.id === Number(b.dataset.team)));
    }));
    el.querySelectorAll('[data-acts]').forEach((b) => b.addEventListener('click', () => {
      openProjectActivities(el, projects.find((x) => x.id === Number(b.dataset.acts)));
    }));
  }

  /* ---------- Importeren uit e-Boekhouden-exports ---------- */

  const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let sheetJsPromise = null;
  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!sheetJsPromise) {
      sheetJsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SHEETJS_URL;
        s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('Excel-lezer kon niet worden geladen')));
        s.onerror = () => { sheetJsPromise = null; reject(new Error('Excel-lezer kon niet worden geladen. Controleer je internetverbinding.')); };
        document.head.appendChild(s);
      });
    }
    return sheetJsPromise;
  }

  function poFromName(name) {
    const m = String(name || '').match(/\b(POR?)\s*:?\s*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/i);
    if (!m) return null;
    return m[1].toUpperCase() === 'POR' && !/\s|:/.test(m[0].slice(3, 4)) ? `${m[1].toUpperCase()}${m[2]}` : `${m[1].toUpperCase()} ${m[2]}`;
  }

  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(bv|nv|vof)$/, '');

  // Leest een export uit e-Boekhouden: bedrijfsgegevens bovenaan, daarna een kopregel met de gevraagde kolommen.
  // columns: { veld: 'Kolomnaam' }; de eerste kolom is verplicht per regel.
  async function readExport(file, columns, hint, { raw = false } = {}) {
    const XLSX = await loadSheetJs();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw, defval: '' });
    const wanted = Object.entries(columns);
    const required = wanted.slice(0, 2).map(([, label]) => normName(label));
    const hi = rows.findIndex((r) => required.every((col) => r.some((c) => normName(c) === col)));
    if (hi < 0) throw new Error(hint);
    const head = rows[hi];
    const idx = Object.fromEntries(wanted.map(([key, label]) => [key, head.findIndex((c) => normName(c) === normName(label))]));
    const firstKey = wanted[0][0];
    const firstText = rows.slice(0, hi).map((r) => r.find((c) => String(c).trim())).find(Boolean);
    const items = rows.slice(hi + 1)
      .map((r) => Object.fromEntries(wanted.map(([key]) => {
        const v = idx[key] >= 0 ? r[idx[key]] : '';
        return [key, raw && typeof v !== 'string' ? v : String(v ?? '').trim()];
      })))
      .filter((x) => x[firstKey]);
    if (!items.length) throw new Error('Het bestand bevat geen regels onder de kopregel');
    return { company: firstText ? String(firstText).trim() : '', items };
  }

  // Relaties uit e-Boekhouden; null als de koppeling (nog) niet werkt.
  async function loadEbRelations() {
    try { return await api('/admin/eb/relations'); } catch { return null; }
  }

  function openProjectImport(el, projects, clients) {
    let parsed = null;
    let relations = null;
    const clientByName = new Map(clients.map((c) => [normName(c.name), c]));
    const existing = new Set(projects.map((p) => `${p.client_id || 0}|${p.name.trim().toLowerCase()}`));

    const preview = (form) => {
      const box = form.querySelector('[data-preview]');
      if (!parsed) { box.innerHTML = ''; return; }
      const relByName = new Map((relations || []).filter((x) => !x.inactive).map((x) => [normName(x.name), x]));
      const internal = normName(form.internal_name.value);
      const newClients = new Set();
      const linkClients = new Set();
      const seen = new Set();
      let created = 0;
      const rows = parsed.items.map((it) => {
        const isInternal = !it.relation || (internal && normName(it.relation) === internal);
        const client = isInternal ? null : clientByName.get(normName(it.relation));
        const rel = isInternal ? null : relByName.get(normName(it.relation));
        if (!isInternal && !client) newClients.add(normName(it.relation));
        if (!isInternal && rel && (!client || !client.eb_relation_id)) linkClients.add(normName(it.relation));
        const key = `${client ? client.id : (isInternal ? 0 : `new:${normName(it.relation)}`)}|${it.project.toLowerCase()}`;
        const skip = existing.has(key) || seen.has(key);
        seen.add(key);
        if (!skip) created += 1;
        let klant;
        if (isInternal) klant = 'Intern, niet declarabel';
        else {
          const ebInfo = client && client.eb_relation_id ? ''
            : rel ? ` <span class="badge approved">koppelt aan ${esc(rel.code || rel.name)}</span>`
              : relations ? ' <span class="badge submitted">niet in e-Boekhouden gevonden</span>' : '';
          klant = `${esc(client ? client.name : it.relation)}${client ? '' : ' <span class="badge">nieuwe klant</span>'}${ebInfo}`;
        }
        return `<tr${skip ? ' class="muted"' : ''}><td>${esc(it.project)}</td><td>${klant}</td>
          <td>${skip ? 'Bestaat al, wordt overgeslagen' : 'Nieuw project'}</td></tr>`;
      }).join('');
      const parts = [
        `<strong>${created} ${created === 1 ? 'project wordt' : 'projecten worden'} aangemaakt</strong>`,
        parsed.items.length - created ? `${parsed.items.length - created} overgeslagen` : '',
        newClients.size ? `${newClients.size} ${newClients.size === 1 ? 'nieuwe klant' : 'nieuwe klanten'}` : '',
        linkClients.size ? `${linkClients.size} ${linkClients.size === 1 ? 'klant wordt' : 'klanten worden'} gekoppeld aan e-Boekhouden` : '',
      ].filter(Boolean);
      box.innerHTML = `
        <p>${parts.join(', ')}.</p>
        ${relations === null ? '<p class="muted small">e-Boekhouden is niet bereikbaar; nieuwe klanten koppel je later onder Klanten.</p>' : ''}
        <div class="table-wrap import-preview"><table class="data">
          <thead><tr><th>Project</th><th>Klant</th><th>Resultaat</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
    };

    openDialog({
      title: 'Projecten importeren',
      submit: 'Importeren',
      wide: true,
      body: `
        <p class="muted small">Exporteer in e-Boekhouden je projecten via Uren › Configuratie › Projecten en kies het bestand hier. Een eigen Excel- of CSV-bestand met de kolommen "Project" en "Relatie" werkt ook.</p>
        <label class="field">Bestand<input type="file" name="file" accept=".xlsx,.xls,.csv" required></label>
        <div class="form-grid">
          <label class="field">Eigen bedrijf<span class="hint">Projecten met deze relatie worden intern</span><input name="internal_name"></label>
          <label class="field">Uurtarief nieuwe projecten (€)<span class="hint">Alleen nodig voor projecten zonder activiteiten</span><input name="default_rate" inputmode="decimal" placeholder="0"></label>
        </div>
        <label class="check"><input type="checkbox" name="add_me" checked> Mij toevoegen aan het team van de nieuwe projecten</label>
        <div data-preview></div>`,
      onOpen: (form) => {
        loadEbRelations().then((r) => { relations = r; preview(form); });
        form.file.addEventListener('change', async () => {
          const box = form.querySelector('[data-preview]');
          parsed = null;
          if (!form.file.files[0]) { box.innerHTML = ''; return; }
          box.innerHTML = '<p class="muted">Bestand lezen…</p>';
          try {
            parsed = await readExport(form.file.files[0], { project: 'Project', relation: 'Relatie' },
              'Geen kolommen "Project" en "Relatie" gevonden. Gebruik de export uit e-Boekhouden (Uren › Configuratie › Projecten) of een bestand met die twee kolommen.');
            if (parsed.company && !form.internal_name.value) form.internal_name.value = parsed.company;
            preview(form);
          } catch (e) {
            box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
          }
        });
        form.internal_name.addEventListener('input', () => preview(form));
      },
      onSubmit: async (fd) => {
        if (!parsed) throw new Error('Kies eerst een bestand met projecten');
        const res = await api('/admin/projects/import', {
          method: 'POST',
          body: {
            rows: parsed.items,
            internal_name: fd.get('internal_name'),
            default_rate: numOrNull(fd.get('default_rate')) ?? 0,
            add_me: fd.get('add_me') === 'on',
          },
        });
        const unlinked = res.clients_created - res.clients_linked;
        toast(`${res.created} ${res.created === 1 ? 'project' : 'projecten'} geïmporteerd${res.skipped ? `, ${res.skipped} overgeslagen` : ''}`
          + `${res.clients_linked ? `. ${res.clients_linked} ${res.clients_linked === 1 ? 'klant' : 'klanten'} gekoppeld aan e-Boekhouden` : ''}`
          + `${unlinked > 0 ? `. Koppel ${unlinked === 1 ? 'de nieuwe klant' : `de ${unlinked} overige nieuwe klanten`} nog onder Klanten` : ''}.`);
        adminProjects(el);
      },
    });
  }

  /* ---------- Activiteiten ---------- */

  async function adminActivities(el) {
    const acts = await api('/admin/activities');
    el.innerHTML = `
      <section class="panel">
        <div class="panel-pad row spread"><h2>Activiteiten</h2>
          <div class="row"><button class="btn" data-import>Importeren uit e-Boekhouden</button>
          <button class="btn primary" data-new>Activiteit toevoegen</button></div></div>
        <div class="panel-pad" style="padding-top:0"><p class="muted small">Welke activiteiten bij een project horen, en eventueel een afwijkend tarief, stel je in bij het project onder Projecten › Activiteiten.</p></div>
        ${acts.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Naam</th><th>Omschrijving</th><th class="num">Standaardtarief</th><th class="num">Projecten</th><th>Status</th><th></th></tr></thead>
          <tbody>${acts.map((a) => `
            <tr>
              <td>${esc(a.name)}</td>
              <td class="muted">${esc(a.description || '')}</td>
              <td class="num">${a.default_rate === null ? '<span class="muted">Geen</span>' : eur(a.default_rate)}</td>
              <td class="num">${a.project_count}</td>
              <td>${a.active ? 'Actief' : '<span class="muted">Inactief</span>'}</td>
              <td class="right"><button class="btn small" data-edit="${a.id}">Wijzigen</button></td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty"><p>Nog geen activiteiten. Importeer ze uit e-Boekhouden of voeg ze zelf toe.</p></div>'}
      </section>`;

    const form = (a = {}) => `
      <div class="form-grid">
        <label class="field">Naam<input name="name" value="${esc(a.name)}" required maxlength="120"></label>
        <label class="field">Standaardtarief (€)<span class="hint">Leeg = tarief van medewerker of project</span><input name="default_rate" inputmode="decimal" value="${fmtInput(a.default_rate)}"></label>
      </div>
      <label class="field">Omschrijving<span class="hint">Optioneel</span><input name="description" value="${esc(a.description)}" maxlength="500"></label>
      ${a.id ? `<label class="check"><input type="checkbox" name="active"${a.active ? ' checked' : ''}> Actief</label>` : ''}`;
    const collect = (fd) => ({ name: fd.get('name'), description: fd.get('description'), default_rate: numOrNull(fd.get('default_rate')) });

    el.querySelector('[data-new]').addEventListener('click', () => openDialog({
      title: 'Activiteit toevoegen',
      submit: 'Toevoegen',
      body: form(),
      onSubmit: async (fd) => {
        await api('/admin/activities', { method: 'POST', body: collect(fd) });
        adminActivities(el);
      },
    }));
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const a = acts.find((x) => x.id === Number(b.dataset.edit));
      openActivityEdit(el, a, form, collect);
    }));
    el.querySelector('[data-import]').addEventListener('click', () => openActivityImport(el, acts));
  }

  // Activiteit wijzigen, met de budgetten per project waaraan de activiteit gekoppeld is.
  async function openActivityEdit(el, act, form, collect) {
    const projects = await api(`/admin/activities/${act.id}/projects`);
    const budgets = projects.length ? `
      <h3>Budget per project</h3>
      <p class="muted small">Het budget hoort bij deze activiteit op een specifiek project. Leeg laten = geen budget. Koppelen aan meer projecten doe je onder Projecten › Activiteiten.</p>
      <div class="table-wrap"><table class="data act-table">
        <thead><tr><th>Klant / project</th><th>Budget (uren)</th><th>Budget (€)</th><th>Verbruik</th></tr></thead>
        <tbody>${projects.map((p) => `
          <tr>
            <td>${esc(p.client_name || 'Intern')} / ${esc(p.project_name)}${p.active ? '' : ' <span class="muted small">(afgesloten)</span>'}</td>
            <td><input name="bh${p.project_id}" inputmode="decimal" value="${fmtInput(p.budget_hours)}" aria-label="Budget uren ${esc(p.project_name)}"></td>
            <td><input name="ba${p.project_id}" inputmode="decimal" value="${fmtInput(p.budget_amount)}" aria-label="Budget euro ${esc(p.project_name)}"></td>
            <td>${p.budget_hours ? budgetBar(p.used_hours, p.budget_hours)
              : p.budget_amount ? budgetBar(p.used_amount, p.budget_amount, 'amount')
                : `<span class="muted small">${fh(p.used_hours)} uur</span>`}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : '<p class="muted small">Deze activiteit is nog niet aan een project gekoppeld. Koppel hem onder Projecten › Activiteiten; daarna kun je hier per project een budget instellen.</p>';
    openDialog({
      title: `${act.name} wijzigen`,
      wide: true,
      body: form(act) + budgets,
      onSubmit: async (fd) => {
        await api(`/admin/activities/${act.id}`, { method: 'PATCH', body: { ...collect(fd), active: fd.get('active') === 'on' } });
        for (const p of projects) {
          const bh = numOrNull(fd.get(`bh${p.project_id}`));
          const ba = numOrNull(fd.get(`ba${p.project_id}`));
          if (bh !== p.budget_hours || ba !== p.budget_amount) {
            await api(`/admin/projects/${p.project_id}/activities/${act.id}`, {
              method: 'PUT', body: { rate: p.rate, budget_hours: bh, budget_amount: ba },
            });
          }
        }
        toast('Activiteit opgeslagen');
        adminActivities(el);
      },
    });
  }

  function openActivityImport(el, acts) {
    let parsed = null;
    const byName = new Map(acts.map((a) => [a.name.trim().toLowerCase(), a]));
    const rateOf = (v) => (String(v).trim() === '' ? null : numOrNull(v));

    const preview = (form) => {
      const box = form.querySelector('[data-preview]');
      if (!parsed) { box.innerHTML = ''; return; }
      const update = form.update_rates.checked;
      let created = 0;
      let updated = 0;
      const rows = parsed.items.map((it) => {
        const ex = byName.get(it.name.toLowerCase());
        const rate = rateOf(it.rate);
        let result = 'Nieuwe activiteit';
        if (!ex) created += 1;
        else if (update && rate !== ex.default_rate) { result = `Tarief wordt ${rate === null ? 'leeg' : eur(rate)} (was ${ex.default_rate === null ? 'leeg' : eur(ex.default_rate)})`; updated += 1; }
        else result = 'Bestaat al, wordt overgeslagen';
        return `<tr${ex && result.startsWith('Bestaat') ? ' class="muted"' : ''}><td>${esc(it.name)}</td>
          <td class="num">${rate === null ? '–' : eur(rate)}</td><td>${result}</td></tr>`;
      }).join('');
      box.innerHTML = `
        <p><strong>${created} ${created === 1 ? 'activiteit wordt' : 'activiteiten worden'} aangemaakt</strong>${updated ? `, ${updated} ${updated === 1 ? 'tarief' : 'tarieven'} bijgewerkt` : ''}.</p>
        <div class="table-wrap import-preview"><table class="data">
          <thead><tr><th>Activiteit</th><th class="num">Uurtarief</th><th>Resultaat</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
    };

    openDialog({
      title: 'Activiteiten importeren',
      submit: 'Importeren',
      wide: true,
      body: `
        <p class="muted small">Exporteer in e-Boekhouden je activiteiten via Uren › Configuratie › Activiteiten en kies het bestand hier. Een eigen bestand met de kolommen "Naam" en "Uurtarief" werkt ook.</p>
        <label class="field">Bestand<input type="file" name="file" accept=".xlsx,.xls,.csv" required></label>
        <label class="check"><input type="checkbox" name="update_rates" checked> Tarieven van bestaande activiteiten bijwerken</label>
        <div data-preview></div>`,
      onOpen: (form) => {
        form.file.addEventListener('change', async () => {
          const box = form.querySelector('[data-preview]');
          parsed = null;
          if (!form.file.files[0]) { box.innerHTML = ''; return; }
          box.innerHTML = '<p class="muted">Bestand lezen…</p>';
          try {
            parsed = await readExport(form.file.files[0], { name: 'Naam', rate: 'Uurtarief' },
              'Geen kolommen "Naam" en "Uurtarief" gevonden. Gebruik de export uit e-Boekhouden (Uren › Configuratie › Activiteiten).');
            preview(form);
          } catch (e) {
            box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
          }
        });
        form.update_rates.addEventListener('change', () => preview(form));
      },
      onSubmit: async (fd) => {
        if (!parsed) throw new Error('Kies eerst een bestand met activiteiten');
        const res = await api('/admin/activities/import', {
          method: 'POST',
          body: {
            rows: parsed.items.map((it) => ({ name: it.name, rate: rateOf(it.rate) })),
            update_rates: fd.get('update_rates') === 'on',
          },
        });
        toast(`${res.created} ${res.created === 1 ? 'activiteit' : 'activiteiten'} geïmporteerd${res.updated ? `, ${res.updated} tarieven bijgewerkt` : ''}. Koppel ze nu aan projecten onder Projecten › Activiteiten.`);
        adminActivities(el);
      },
    });
  }

  async function openProjectActivities(el, project) {
    const list = await api(`/admin/projects/${project.id}/activities`);
    const fallback = (a) => (a.default_rate !== null ? a.default_rate : project.default_rate);
    openDialog({
      title: `Activiteiten van ${project.name}`,
      wide: true,
      body: `
        <p class="muted small">Medewerkers kiezen bij dit project een van de aangevinkte activiteiten. Een afwijkend tarief geldt alleen voor dit project; leeg laten betekent het standaardtarief van de activiteit. Budgetten zijn optioneel, in uren en/of in euro's excl. btw.</p>
        ${list.length ? `<div class="table-wrap"><table class="data act-table">
          <thead><tr><th>Activiteit</th><th class="num">Standaard</th><th>Afwijkend tarief (€)</th><th>Budget (uren)</th><th>Budget (€)</th><th class="num">Verbruikt</th></tr></thead>
          <tbody>${list.map((a) => `
            <tr>
              <td><label class="check"><input type="checkbox" name="a${a.activity_id}"${a.linked ? ' checked' : ''}> ${esc(a.name)}${a.active ? '' : ' <span class="muted small">(inactief)</span>'}</label></td>
              <td class="num">${a.default_rate === null ? '–' : eur(a.default_rate)}</td>
              <td><input name="r${a.activity_id}" inputmode="decimal" value="${fmtInput(a.rate)}" placeholder="${String(fallback(a) ?? '').replace('.', ',')}" size="7" aria-label="Tarief ${esc(a.name)}"></td>
              <td><input name="bh${a.activity_id}" inputmode="decimal" value="${fmtInput(a.budget_hours)}" size="7" aria-label="Budget uren ${esc(a.name)}"></td>
              <td><input name="ba${a.activity_id}" inputmode="decimal" value="${fmtInput(a.budget_amount)}" size="9" aria-label="Budget euro ${esc(a.name)}"></td>
              <td class="num nowrap">${a.used_hours ? `${fh(a.used_hours)} uur${a.used_amount ? `<br><span class="muted small">${eur(a.used_amount)}</span>` : ''}` : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Er zijn nog geen activiteiten. Voeg er hieronder een toe of importeer ze onder Beheer › Activiteiten.</p>'}
        <div class="form-grid">
          <label class="field">Nieuwe activiteit<span class="hint">Optioneel, wordt meteen gekoppeld</span><input name="new_name" maxlength="120"></label>
          <label class="field">Tarief nieuwe activiteit (€)<input name="new_rate" inputmode="decimal"></label>
        </div>`,
      onSubmit: async (fd) => {
        for (const a of list) {
          const want = fd.get(`a${a.activity_id}`) === 'on';
          const rate = numOrNull(fd.get(`r${a.activity_id}`));
          const budgetHours = numOrNull(fd.get(`bh${a.activity_id}`));
          const budgetAmount = numOrNull(fd.get(`ba${a.activity_id}`));
          const changed = rate !== a.rate || budgetHours !== a.budget_hours || budgetAmount !== a.budget_amount;
          if (want && (!a.linked || changed)) {
            await api(`/admin/projects/${project.id}/activities/${a.activity_id}`, {
              method: 'PUT', body: { rate, budget_hours: budgetHours, budget_amount: budgetAmount },
            });
          } else if (!want && a.linked) {
            await api(`/admin/projects/${project.id}/activities/${a.activity_id}`, { method: 'DELETE' });
          }
        }
        const newName = String(fd.get('new_name') || '').trim();
        if (newName) {
          const created = await api('/admin/activities', { method: 'POST', body: { name: newName, default_rate: numOrNull(fd.get('new_rate')) } });
          await api(`/admin/projects/${project.id}/activities/${created.id}`, { method: 'PUT', body: { rate: null } });
        }
        toast('Activiteiten opgeslagen');
        adminProjects(el);
      },
    });
  }

  /* ---------- Uren importeren ---------- */

  // Excel-datum (serienummer), Date-object of tekst (dd-mm-jjjj / jjjj-mm-dd) naar jjjj-mm-dd.
  function parseDateCell(v) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  const parseHoursCell = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : parseHours(v));

  async function adminHoursImport(el) {
    const [users, projects, acts] = await Promise.all([api('/admin/users'), api('/admin/projects'), api('/admin/activities')]);
    const key = (s) => String(s || '').trim().toLowerCase();
    const projByName = new Map();
    for (const p of projects) if (!projByName.has(key(p.name))) projByName.set(key(p.name), p);
    const actByName = new Map(acts.map((x) => [key(x.name), x]));
    const prevMonthEnd = monthBounds(-1).to;
    let rows = null;
    let mapping = {};
    let fileName = '';

    el.innerHTML = `
      <section class="panel panel-pad stack" id="hours-import">
        <h2>Uren importeren</h2>
        <p class="muted small">Importeer eerder geschreven uren uit e-Boekhouden (export van de geregistreerde uren naar Excel). Importeer eerst de <a href="#/beheer/projecten">projecten</a> en <a href="#/beheer/activiteiten">activiteiten</a>, want de uren worden op naam aan projecten en activiteiten gekoppeld. Uren die al bestaan worden overgeslagen, dus je kunt hetzelfde bestand veilig opnieuw inlezen.</p>
        <label class="field">Bestand<input type="file" name="file" accept=".xlsx,.xls,.csv"></label>
        <div data-step></div>
      </section>`;
    const section = el.querySelector('#hours-import');
    const step = section.querySelector('[data-step]');

    function analyse() {
      const invoicedThrough = section.querySelector('[name="invoiced_through"]').value;
      const merged = new Map();
      const problems = [];
      for (const r of rows) {
        const reason = !r.date ? 'Ongeldige datum'
          : !(r.hours > 0) ? 'Geen uren (alleen kilometers)'
            : !r.project ? 'Project niet gevonden'
              : (r.activityName && !r.activity) ? 'Activiteit niet gevonden'
                : !mapping[r.userKey] ? 'Kies een medewerker' : '';
        if (reason) { problems.push({ ...r, reason }); continue; }
        const k = `${mapping[r.userKey]}|${r.project.id}|${r.activity ? r.activity.id : 0}|${r.date}`;
        const m = merged.get(k);
        if (m) {
          m.hours = Math.round((m.hours + r.hours) * 100) / 100;
          if (r.note && !m.notes.includes(r.note)) m.notes.push(r.note);
          m.mergedCount += 1;
        } else {
          merged.set(k, { ...r, userId: Number(mapping[r.userKey]), notes: r.note ? [r.note] : [], mergedCount: 1 });
        }
      }
      const items = [...merged.values()].sort((x, y) => x.date.localeCompare(y.date));
      for (const it of items) it.status = invoicedThrough && it.date <= invoicedThrough ? 'invoiced' : 'approved';
      return { items, problems, invoicedThrough };
    }

    function renderStep() {
      const userKeys = [...new Set(rows.map((r) => r.userKey))];
      const userOpts = (sel) => opt('', 'Kies…', !sel) + users.filter((u) => u.active).map((u) => opt(u.id, `${u.name} (${u.email})`, String(u.id) === String(sel))).join('');
      step.innerHTML = `
        <p class="muted small">Ingelezen: ${esc(fileName)}, ${rows.length} regels.</p>
        <h3>Medewerkers koppelen</h3>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>In de export</th><th>Medewerker in de app</th></tr></thead>
          <tbody>${userKeys.map((k) => `<tr><td>${esc(k || '(leeg)')}</td><td><select data-user-key="${esc(k)}">${userOpts(mapping[k])}</select></td></tr>`).join('')}</tbody>
        </table></div>
        <h3>Status</h3>
        <div class="form-grid">
          <label class="field">Al gefactureerd t/m<span class="hint">Uren t/m deze datum worden "gefactureerd" en komen niet meer op een factuur. Latere uren worden goedgekeurd en kun je hier factureren.</span>
            <input type="date" name="invoiced_through" value="${prevMonthEnd}"></label>
        </div>
        <label class="check"><input type="checkbox" name="add_to_team" checked> Medewerkers toevoegen aan het team van de projecten (en ontbrekende activiteiten aan het project koppelen)</label>
        <div data-preview></div>`;
      step.querySelectorAll('[data-user-key]').forEach((s) => s.addEventListener('change', () => {
        mapping[s.dataset.userKey] = s.value;
        renderPreview();
      }));
      step.querySelector('[name="invoiced_through"]').addEventListener('change', renderPreview);
      renderPreview();
    }

    function renderPreview() {
      const box = step.querySelector('[data-preview]');
      const { items, problems } = analyse();
      const total = items.reduce((s, x) => s + x.hours, 0);
      const inv = items.filter((x) => x.status === 'invoiced');
      const merges = items.filter((x) => x.mergedCount > 1).length;
      const userName = (id) => (users.find((u) => u.id === id) || {}).name || '';
      box.innerHTML = `
        <h3>Controleren</h3>
        <p><strong>${items.length} ${items.length === 1 ? 'regel' : 'regels'} (${fh(total)} uur) worden geïmporteerd</strong>:
          ${inv.length} als gefactureerd, ${items.length - inv.length} als goedgekeurd.${
          merges ? ` ${merges} ${merges === 1 ? 'keer zijn' : 'keer zijn'} meerdere regels op dezelfde dag en activiteit samengevoegd.` : ''}</p>
        ${problems.length ? `<div class="notice warn"><strong>${problems.length} ${problems.length === 1 ? 'regel wordt' : 'regels worden'} niet geïmporteerd.</strong>
          ${[...new Set(problems.map((x) => x.reason))].map((reason) => {
            const n = problems.filter((x) => x.reason === reason);
            const names = [...new Set(n.map((x) => (reason.startsWith('Project') ? x.projectName : reason.startsWith('Activiteit') ? x.activityName : '')).filter(Boolean))];
            return `<br>${esc(reason)}: ${n.length}${names.length ? ` (${names.slice(0, 5).map(esc).join(', ')}${names.length > 5 ? ', …' : ''})` : ''}`;
          }).join('')}
          ${problems.some((x) => x.reason.startsWith('Project') || x.reason.startsWith('Activiteit')) ? '<br>Importeer die eerst onder Projecten of Activiteiten en kies het bestand daarna opnieuw.' : ''}</div>` : ''}
        ${items.length ? `<div class="table-wrap import-preview"><table class="data">
          <thead><tr><th>Datum</th><th>Medewerker</th><th>Project / activiteit</th><th class="num">Uren</th><th>Opmerking</th><th>Status</th></tr></thead>
          <tbody>${items.map((x) => `<tr>
            <td class="nowrap">${fmtDate(x.date, true)}</td><td>${esc(userName(x.userId))}</td>
            <td>${esc(x.project.name)}${x.activity ? `<br><span class="muted small">${esc(x.activity.name)}</span>` : ''}</td>
            <td class="num">${fh(x.hours)}</td><td>${esc(x.notes.join('; '))}</td>
            <td>${statusBadge(x.status)}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
        <div class="row"><button class="btn primary" type="button" data-run${items.length ? '' : ' disabled'}>Importeer ${items.length} ${items.length === 1 ? 'regel' : 'regels'}</button></div>`;
      const run = box.querySelector('[data-run]');
      run.addEventListener('click', async () => {
        const ok = await confirmDialog('Uren importeren', `${items.length} regels (${fh(total)} uur) importeren? Uren die al bestaan worden overgeslagen.`, 'Importeren');
        if (!ok) return;
        run.disabled = true;
        try {
          const res = await api('/admin/hours/import', {
            method: 'POST',
            body: {
              rows: items.map((x) => ({
                user_id: x.userId, project_id: x.project.id, activity_id: x.activity ? x.activity.id : null,
                work_date: x.date, hours: x.hours, description: x.notes.join('; ').slice(0, 1000),
              })),
              invoiced_through: section.querySelector('[name="invoiced_through"]').value || null,
              add_to_team: section.querySelector('[name="add_to_team"]').checked,
            },
          });
          toast(`${res.inserted} ${res.inserted === 1 ? 'regel' : 'regels'} (${fh(res.hours)} uur) geïmporteerd${res.skipped ? `, ${res.skipped} bestonden al` : ''}`);
          section.querySelector('[name="file"]').value = ''; // zodat hetzelfde bestand opnieuw gekozen kan worden
          box.insertAdjacentHTML('afterbegin', `<div class="notice">Klaar: ${res.inserted} regels geïmporteerd${res.skipped ? `, ${res.skipped} overgeslagen omdat ze al bestonden` : ''}${res.linked_activities ? `, ${res.linked_activities} activiteiten aan projecten gekoppeld` : ''}${res.team_added ? `, ${res.team_added} keer een medewerker aan een projectteam toegevoegd` : ''}. Bekijk ze onder <a href="#/rapportage">Rapportage</a> of in de urenstaat.</div>`);
        } catch (e) {
          toast(e.message, true);
          run.disabled = false;
        }
      });
    }

    section.querySelector('[name="file"]').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) { step.innerHTML = ''; return; }
      fileName = file.name;
      step.innerHTML = '<p class="muted">Bestand lezen…</p>';
      try {
        const parsed = await readExport(file,
          { date: 'Datum', user: 'Medewerker', project: 'Project', activity: 'Activiteit', note: 'Opmerkingen', hours: 'Aantal uren' },
          'Geen kolommen "Datum" en "Medewerker" gevonden. Gebruik de export van de geregistreerde uren uit e-Boekhouden.',
          { raw: true });
        rows = parsed.items.map((it) => {
          const projectName = String(it.project ?? '').trim();
          const activityName = String(it.activity ?? '').trim();
          return {
            date: parseDateCell(it.date),
            userKey: String(it.user ?? '').trim(),
            projectName,
            activityName,
            project: projByName.get(key(projectName)) || null,
            activity: activityName ? actByName.get(key(activityName)) || null : null,
            note: String(it.note ?? '').trim(),
            hours: parseHoursCell(it.hours),
          };
        });
        // Medewerkers voorstellen: zelfde e-mailadres, anders als er maar één actieve gebruiker is die (of jij als beheerder).
        mapping = {};
        for (const k of new Set(rows.map((r) => r.userKey))) {
          const exact = users.find((u) => u.email.toLowerCase() === k.toLowerCase());
          const sameName = users.find((u) => normName(u.name).length > 2 && normName(k).includes(normName(u.name)));
          mapping[k] = String((exact || sameName || (users.filter((u) => u.active).length === 1 ? users[0] : state.user)).id);
        }
        renderStep();
      } catch (e) {
        step.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      }
      ev.target.value = ''; // zodat hetzelfde bestand opnieuw gekozen kan worden
    });
  }

  /* ---------- Klanten ophalen uit e-Boekhouden ---------- */

  async function openEbClientImport(el) {
    let relations;
    try {
      relations = await api('/admin/eb/relations');
    } catch (e) {
      toast(e.message, true);
      return;
    }
    const render = (form) => {
      const q = normName(form.q.value);
      const showInactive = form.inactive.checked;
      const rows = relations
        .filter((r) => (showInactive || !r.inactive) && (!q || normName(`${r.name} ${r.code}`).includes(q)))
        .map((r) => {
          const linked = Boolean(r.client_id);
          const status = linked ? `Al gekoppeld aan ${esc(r.client_name)}`
            : r.match_client_id ? 'Bestaande klant met deze naam wordt gekoppeld' : 'Wordt nieuwe klant';
          return `<tr${linked ? ' class="muted"' : ''}>
            <td><input type="checkbox" name="rel" value="${r.id}"${linked ? ' disabled' : ''}${form.dataset[`c${r.id}`] ? ' checked' : ''} aria-label="${esc(r.name)}"></td>
            <td>${esc(r.code)}</td><td>${esc(r.name)}${r.inactive ? ' <span class="muted small">(inactief)</span>' : ''}</td><td>${status}</td></tr>`;
        }).join('');
      form.querySelector('[data-list]').innerHTML = rows
        ? `<div class="table-wrap import-preview"><table class="data"><thead><tr><th></th><th>Code</th><th>Naam</th><th>Resultaat</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="muted">Geen relaties gevonden.</p>';
    };
    openDialog({
      title: 'Klanten ophalen uit e-Boekhouden',
      submit: 'Ophalen',
      wide: true,
      body: `
        <p class="muted small">Kies welke relaties je als klant wilt gebruiken. Ze worden direct gekoppeld, zodat je ze kunt factureren.</p>
        <div class="row">
          <label class="field grow">Zoeken<input name="q" placeholder="Naam of code" autocomplete="off"></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="inactive"> Ook inactieve relaties</label>
        </div>
        <div data-list></div>`,
      onOpen: (form) => {
        render(form);
        form.q.addEventListener('input', () => render(form));
        form.inactive.addEventListener('change', () => render(form));
        // Vinkjes onthouden tijdens zoeken
        form.addEventListener('change', (e) => {
          if (e.target.name === 'rel') {
            if (e.target.checked) form.dataset[`c${e.target.value}`] = '1';
            else delete form.dataset[`c${e.target.value}`];
          }
        });
      },
      onSubmit: async (fd, form) => {
        const ids = Object.keys(form.dataset).filter((k) => /^c\d+$/.test(k)).map((k) => Number(k.slice(1)));
        if (!ids.length) throw new Error('Selecteer een of meer relaties');
        const res = await api('/admin/clients/import-eb', { method: 'POST', body: { relation_ids: ids } });
        toast(`${res.created} ${res.created === 1 ? 'klant' : 'klanten'} toegevoegd${res.linked ? `, ${res.linked} bestaande gekoppeld` : ''}`);
        adminClients(el);
      },
    });
  }

  async function openTeam(el, project) {
    const members = await api(`/admin/projects/${project.id}/assignments`);
    openDialog({
      title: `Team van ${project.name}`,
      body: `
        <p class="muted small">Alleen teamleden zien dit project in hun urenstaat. Laat het tarief leeg om het projecttarief (${eur(project.default_rate)}) te gebruiken.</p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Medewerker</th><th>Tarief (€)</th></tr></thead>
          <tbody>${members.map((m) => `
            <tr>
              <td><label class="check"><input type="checkbox" name="u${m.user_id}"${m.assigned ? ' checked' : ''}> ${esc(m.name)}${m.active ? '' : ' <span class="muted small">(inactief)</span>'}</label></td>
              <td><input name="r${m.user_id}" inputmode="decimal" value="${fmtInput(m.rate)}" placeholder="${fmtInput(project.default_rate)}" aria-label="Tarief ${esc(m.name)}" size="8"></td>
            </tr>`).join('')}</tbody>
        </table></div>`,
      onSubmit: async (fd) => {
        for (const m of members) {
          const want = fd.get(`u${m.user_id}`) === 'on';
          const rate = numOrNull(fd.get(`r${m.user_id}`));
          if (want && (!m.assigned || rate !== m.rate)) {
            await api(`/admin/projects/${project.id}/assignments/${m.user_id}`, { method: 'PUT', body: { rate } });
          } else if (!want && m.assigned) {
            await api(`/admin/projects/${project.id}/assignments/${m.user_id}`, { method: 'DELETE' });
          }
        }
        toast('Team opgeslagen');
        adminProjects(el);
      },
    });
  }

  const VAT_LABELS = {
    HOOG_VERK_21: '21% btw (normaal tarief)',
    LAAG_VERK_9: '9% btw (laag tarief)',
    VERL_VERK: 'Btw verlegd (binnen Nederland)',
    BU_EU_VERK: 'Klant buiten de EU (0%)',
    BI_EU_VERK: 'Zakelijke klant binnen de EU, verlegd (0%)',
    GEEN: 'Geen btw',
  };

  async function adminEb(el) {
    const s = await api('/admin/settings');
    let options = null;
    let optionsError = null;
    if (s.eb_configured) {
      try { options = await api('/admin/eb/options'); } catch (e) { optionsError = e.message; }
    }
    const e = s.eb;

    const pick = (name, list, current, { filterCat, allowEmpty, emptyLabel } = {}) => {
      if (!options) {
        return `<input name="${name}" inputmode="numeric" value="${esc(current ?? '')}" placeholder="Interne id uit e-Boekhouden">`;
      }
      let items = list;
      if (filterCat) {
        const filtered = list.filter((x) => x.category === filterCat);
        if (filtered.length) items = filtered;
      }
      return `<select name="${name}">
        ${allowEmpty ? opt('', emptyLabel || 'Geen', !current) : (current ? '' : opt('', 'Kies…', true))}
        ${items.map((x) => opt(x.id, x.label, x.id === current)).join('')}
      </select>`;
    };

    el.innerHTML = `
      <div class="stack">
        ${s.eb_configured
          ? '<div class="notice">Het API-token staat ingesteld op de server.</div>'
          : '<div class="notice warn">Er is nog geen API-token ingesteld. Maak er een aan in e-Boekhouden (Beheer › API-tokens, kies "e-Boekhouden API") en zet het als <code>EB_API_TOKEN</code> in de omgevingsvariabelen op Render.</div>'}
        ${optionsError ? `<div class="notice error">Keuzelijsten ophalen lukte niet: ${esc(optionsError)}. Je kunt de ids ook handmatig invullen.</div>` : ''}
        <form class="stack" id="eb-form" data-guard>
          <nav class="jump" aria-label="Onderdelen">
            <a href="#eb-boek" data-jump>Boekhouding</a><a href="#eb-regels" data-jump>Factuurregels</a><a href="#eb-factuur" data-jump>Factuur</a><a href="#eb-mail" data-jump>E-mail</a>
          </nav>
          <fieldset class="panel panel-pad stack group" id="eb-boek">
          <div class="row spread"><legend><h2>Boekhouding</h2></legend>
            <button class="btn" type="button" data-test${s.eb_configured ? '' : ' disabled'}>Test verbinding</button></div>
          <p class="muted small">Waar facturen in e-Boekhouden terechtkomen.</p>
          <div class="form-grid">
            <label class="field">Factuursjabloon${pick('templateId', options && options.templates, e.templateId)}</label>
            <label class="field">Omzetrekening<span class="hint">Bijvoorbeeld 8000 Omzet</span>${pick('revenueLedgerId', options && options.ledgers, e.revenueLedgerId, { filterCat: 'VW' })}</label>
            <label class="field">Debiteurenrekening<span class="hint">Nodig om direct te verwerken</span>${pick('debtorLedgerId', options && options.ledgers, e.debtorLedgerId, { filterCat: 'DEB', allowEmpty: true })}</label>
            <label class="field">Eenheid op factuurregel${pick('unitId', options && options.units, e.unitId, { allowEmpty: true, emptyLabel: 'Geen eenheid' })}</label>
            <label class="field">Btw-code<span class="hint">Voor Nederlandse zakelijke klanten: 21%</span><select name="vatCode">${s.vat_codes.map((v) => opt(v, VAT_LABELS[v] || v, v === e.vatCode)).join('')}</select></label>
            <label class="field">Betaaltermijn (dagen)<input name="termOfPayment" inputmode="numeric" value="${esc(e.termOfPayment)}"></label>
          </div>
          <label class="check"><input type="checkbox" name="process"${e.process ? ' checked' : ''}> Factuur direct verwerken in de boekhouding (wordt een openstaande post)</label>
          </fieldset>

          <fieldset class="panel panel-pad stack group" id="eb-regels">
          <legend><h2>Factuurregels</h2></legend>
          <p class="muted small">Standaard voor alle klanten; per klant aan te passen onder Klanten. Dezelfde codes als in e-Boekhouden, plus [PROJECTCODE], [MEDEWERKER] en [REFERENTIE] (PO van het project).</p>
          ${lineFormatFields({ mode: e.lineMode, format: e.lineFormat })}
          </fieldset>

          <fieldset class="panel panel-pad stack group" id="eb-factuur">
          <legend><h2>Factuur</h2></legend>
          <div class="form-grid">
            <label class="field">Voorvoegsel factuurnummer<span class="hint">Bijvoorbeeld F voor F00035</span><input name="numberPrefix" value="${esc(e.numberPrefix ?? 'F')}" maxlength="10"></label>
            <label class="field">Aantal cijfers<span class="hint">5 geeft F00035</span><input name="numberDigits" inputmode="numeric" value="${esc(e.numberDigits ?? 5)}"></label>
          </div>
          <p class="muted small">Bij elke factuur stelt de app het volgende vrije nummer voor: het hoogste nummer met dit voorvoegsel in e-Boekhouden plus één. Voorbeeld: <strong data-number-example></strong></p>
          <label class="field">Factuurtekst<span class="hint">Komt op de factuur. Codes: [MAAND] (bijv. september 2026), [PERIODE], [KLANT], [REFERENTIE]</span>
            <input name="invoiceText" value="${esc(e.invoiceText ?? '')}" maxlength="500"></label>
          <label class="check"><input type="checkbox" name="printDefault"${e.printDefault ? ' checked' : ''}> Facturen standaard klaarzetten voor verzending per post</label>
          </fieldset>

          <fieldset class="panel panel-pad stack group" id="eb-mail">
          <legend><h2>E-mail</h2></legend>
          <label class="check"><input type="checkbox" name="emailDefault"${e.emailDefault ? ' checked' : ''}> Facturen standaard direct mailen naar de klant</label>
          <p class="muted small">e-Boekhouden mailt de factuur naar het factuur-e-mailadres van de relatie. Per factuur kun je dit nog aan- of uitzetten.</p>
          <label class="field">E-mailsjabloon<span class="hint">Uit e-Boekhouden. Kies je een sjabloon, dan komen onderwerp en tekst daaruit.</span>
            ${options && options.emailTemplates ? `<select name="emailTemplateId">${opt('', 'Geen sjabloon, eigen tekst hieronder', !e.emailTemplateId)}${options.emailTemplates.map((t) => opt(t.id, t.label, t.id === e.emailTemplateId)).join('')}</select>`
              : `<input name="emailTemplateId" inputmode="numeric" value="${esc(e.emailTemplateId ?? '')}" placeholder="Id van het e-mailsjabloon">`}</label>
          <div data-own-mail>
            <p class="muted small">Eigen tekst (alleen zonder sjabloon). Codes: [KLANT], [PERIODE], [MAAND], [REFERENTIE].</p>
            <label class="field">Onderwerp<input name="emailSubject" value="${esc(e.emailSubject)}" maxlength="200" required></label>
            <label class="field">Tekst<textarea name="emailBody" rows="6" maxlength="5000" required>${esc(e.emailBody)}</textarea></label>
          </div>
          </fieldset>
          <div class="save-bar"><span class="muted small" data-dirty-hint>Alle wijzigingen zijn opgeslagen</span><button class="btn primary" type="submit">Opslaan</button></div>
        </form>
      </div>`;

    const form = el.querySelector('#eb-form');
    bindLineFormatFields(form);
    const numberExample = () => {
      const digits = Math.max(1, Math.min(10, parseInt(form.numberDigits.value, 10) || 5));
      form.querySelector('[data-number-example]').textContent = `${form.numberPrefix.value}${'35'.padStart(digits, '0')}`;
    };
    form.numberPrefix.addEventListener('input', numberExample);
    form.numberDigits.addEventListener('input', numberExample);
    numberExample();
    const ownMail = () => { form.querySelector('[data-own-mail]').hidden = Boolean(form.emailTemplateId.value); };
    form.emailTemplateId.addEventListener('change', ownMail);
    form.emailTemplateId.addEventListener('input', ownMail);
    ownMail();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/admin/settings', {
          method: 'PUT',
          body: {
            templateId: fd.get('templateId'), revenueLedgerId: fd.get('revenueLedgerId'),
            debtorLedgerId: fd.get('debtorLedgerId'), unitId: fd.get('unitId'),
            vatCode: fd.get('vatCode'), termOfPayment: fd.get('termOfPayment'), process: fd.get('process') === 'on',
            lineMode: fd.get('lineMode'), lineFormat: fd.get('lineFormat'),
            emailDefault: fd.get('emailDefault') === 'on', emailSubject: fd.get('emailSubject'), emailBody: fd.get('emailBody'),
            emailTemplateId: fd.get('emailTemplateId'), invoiceText: fd.get('invoiceText'),
            numberPrefix: fd.get('numberPrefix'), numberDigits: fd.get('numberDigits'), printDefault: fd.get('printDefault') === 'on',
          },
        });
        delete form.dataset.dirty;
        form.querySelector('[data-dirty-hint]').textContent = 'Alle wijzigingen zijn opgeslagen';
        toast('Instellingen opgeslagen');
      } catch (ex) { toast(ex.message, true); }
    });
    form.addEventListener('input', () => { form.querySelector('[data-dirty-hint]').textContent = 'Niet-opgeslagen wijzigingen'; });
    form.querySelectorAll('[data-jump]').forEach((l) => l.addEventListener('click', (ev) => {
      ev.preventDefault();
      form.querySelector(l.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    const test = form.querySelector('[data-test]');
    test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        await api('/admin/eb/test', { method: 'POST' });
        toast('Verbinding met e-Boekhouden werkt');
      } catch (ex) { toast(ex.message, true); } finally { test.disabled = false; }
    });
  }

  /* ---------- Opmaak factuurregel ---------- */

  const LINE_CODES = ['DATUM', 'PROJECT', 'PROJECTCODE', 'ACTIVITEIT', 'OPMERKING', 'MEDEWERKER', 'REFERENTIE'];
  const LINE_MODES = { entry: 'Eén regel per uurregel', grouped: 'Samengevoegd per project, activiteit en medewerker' };

  // Zelfde regels als op de server, alleen voor het voorbeeld in beeld.
  function renderLineExample(format, mode) {
    const vars = {
      DATUM: mode === 'grouped' ? '01-09-2026 t/m 30-09-2026' : '01-09-2026',
      PROJECT: 'Discover & Enhance : PO 5473-1', PROJECTCODE: '',
      ACTIVITEIT: 'Neptune Software Architect',
      OPMERKING: mode === 'grouped' ? 'Workshop key-users; Datamodel uitgewerkt' : 'Workshop key-users',
      MEDEWERKER: state.user ? state.user.name : 'Medewerker',
      REFERENTIE: 'PO 5473-1',
    };
    let out = String(format || '').replace(/\[(DATUM|PROJECTCODE|PROJECT|ACTIVITEIT|OPMERKING|MEDEWERKER|REFERENTIE)\]/gi, (m, k) => vars[k.toUpperCase()] || '');
    out = out.replace(/\s*([|–,;/])\s*(?:[|–,;/]\s*)+/g, ' $1 ');
    return out.replace(/^[\s|–,;/:]+|[\s|–,;/:]+$/g, '').replace(/\s{2,}/g, ' ');
  }

  // Codeknoppen die de code op de cursorpositie invoegen, plus een live voorbeeld.
  function lineFormatFields({ mode, format, allowDefault = false, defaults = {} }) {
    return `
      <div class="form-grid">
        <label class="field">Factuurregels
          <select name="lineMode">
            ${allowDefault ? opt('', `Standaard (${LINE_MODES[defaults.mode] ? LINE_MODES[defaults.mode].toLowerCase() : ''})`, !mode) : ''}
            ${Object.entries(LINE_MODES).map(([k, v]) => opt(k, v, mode === k)).join('')}
          </select></label>
        <label class="field">Opmaak factuurregel
          <input name="lineFormat" value="${esc(format || '')}" maxlength="300"${allowDefault ? ` placeholder="${esc(defaults.format || '')} (standaard)"` : ' required'}></label>
      </div>
      <div class="row small"><span class="muted">Codes:</span>${LINE_CODES.map((c) => `<button type="button" class="btn small" data-code="${c}">[${c}]</button>`).join('')}</div>
      <p class="small"><span class="muted">Voorbeeld:</span> <span data-line-example></span></p>`;
  }

  function bindLineFormatFields(form, defaults = {}) {
    const update = () => {
      const mode = form.lineMode.value || defaults.mode || 'entry';
      const format = form.lineFormat.value || defaults.format || '';
      form.querySelector('[data-line-example]').textContent = renderLineExample(format, mode) || '(leeg)';
    };
    form.querySelectorAll('[data-code]').forEach((b) => b.addEventListener('click', () => {
      const input = form.lineFormat;
      const code = `[${b.dataset.code}]`;
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + code + input.value.slice(input.selectionEnd ?? pos);
      input.focus();
      input.setSelectionRange(pos + code.length, pos + code.length);
      update();
    }));
    form.lineMode.addEventListener('change', update);
    form.lineFormat.addEventListener('input', update);
    update();
  }

  /* ================= Account ================= */

  async function viewAccount(view) {
    view.innerHTML = `
      <div class="stack" style="max-width:480px">
        <h1>Account</h1>
        <p class="muted">${esc(state.user.name)}, ${esc(state.user.email)}</p>
        <form class="panel panel-pad stack" id="pw">
          <h2>Wachtwoord wijzigen</h2>
          <label class="field">Huidig wachtwoord<input type="password" name="current" autocomplete="current-password" required></label>
          <label class="field">Nieuw wachtwoord<span class="hint">Minstens 10 tekens</span><input type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <div><button class="btn primary" type="submit">Wachtwoord wijzigen</button></div>
        </form>
        <section class="panel panel-pad stack" id="mfa"><h2>Tweestapsverificatie</h2><p class="muted">Laden…</p></section>
      </div>`;
    renderMfaSection(view.querySelector('#mfa'));
    const form = view.querySelector('#pw');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/password', { method: 'POST', body: { current: form.current.value, next: form.next.value } });
        form.reset();
        toast('Wachtwoord gewijzigd. Andere apparaten zijn uitgelogd.');
      } catch (ex) { toast(ex.message, true); }
    });
  }

  async function renderMfaSection(box) {
    const st = await api('/auth/mfa/status');
    if (!st.totp_enabled) {
      box.innerHTML = `
        <h2>Tweestapsverificatie</h2>
        <div data-intro>
          <p>Staat <strong>uit</strong>. Met tweestapsverificatie heeft iemand met alleen je wachtwoord nog geen toegang: na het wachtwoord vraagt de app om een code uit je authenticator-app.</p>
          <div><button class="btn primary" type="button" data-start>Inschakelen</button></div>
        </div>
        <div data-mfa-box></div>`;
      box.querySelector('[data-start]').addEventListener('click', () => {
        box.querySelector('[data-intro]').hidden = true;
        mountMfaSetup(box.querySelector('[data-mfa-box]'), (user) => {
          state.user = { ...state.user, ...user };
          toast('Tweestapsverificatie staat aan');
          renderMfaSection(box);
        }).catch((ex) => toast(ex.message, true));
      });
      return;
    }
    box.innerHTML = `
      <h2>Tweestapsverificatie</h2>
      <p>Staat <strong>aan</strong>${st.required ? ' (verplicht voor beheerders)' : ''}. Je hebt nog <strong>${st.recovery_left}</strong> ${st.recovery_left === 1 ? 'herstelcode' : 'herstelcodes'}.</p>
      ${st.recovery_left < 3 ? '<div class="notice warn">Je hebt bijna geen herstelcodes meer. Maak nieuwe aan.</div>' : ''}
      <div class="row">
        <button class="btn" type="button" data-new-codes>Nieuwe herstelcodes</button>
        ${st.required ? '' : '<button class="btn danger" type="button" data-disable>Uitschakelen</button>'}
      </div>
      <div data-out></div>`;
    const askCode = (title, submit, danger, after) => openDialog({
      title, submit, danger,
      body: '<label class="field">Huidige code uit je authenticator-app<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="code-input" required></label>',
      onSubmit: async (fd) => after(fd.get('code')),
    });
    box.querySelector('[data-new-codes]').addEventListener('click', () => askCode('Nieuwe herstelcodes', 'Maak nieuwe codes', false, async (code) => {
      const res = await api('/auth/mfa/recovery-codes', { method: 'POST', body: { code } });
      const out = box.querySelector('[data-out]');
      out.innerHTML = `<p class="small">Je oude herstelcodes werken niet meer.</p>${recoveryCodesHTML(res.recovery_codes)}`;
      bindCopyCodes(out, res.recovery_codes);
    }));
    const dis = box.querySelector('[data-disable]');
    if (dis) {
      dis.addEventListener('click', () => askCode('Tweestapsverificatie uitschakelen', 'Uitschakelen', true, async (code) => {
        await api('/auth/mfa/disable', { method: 'POST', body: { code } });
        toast('Tweestapsverificatie staat uit');
        renderMfaSection(box);
      }));
    }
  }

  /* ================= Start ================= */

  (async () => {
    try {
      state.user = await api('/auth/me');
    } catch (e) {
      state.user = null;
      if (e.data && e.data.mfa_required) { renderMfaCode(); return; }
    }
    render();
  })();
})();
