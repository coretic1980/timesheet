// Regels voor het inhuren van zzp'ers (Wet DBA): intakevragen, documenten, risico-indicatie,
// opdrachtovereenkomst en de voorwaarden om uren te mogen schrijven.
// Eén bestand voor server (require) en browser (window.OnboardingRules), zodat beide dezelfde regels gebruiken.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OnboardingRules = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /* ---------- hulpfuncties ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const isIso = (s) => typeof s === 'string' && ISO.test(s);
  const D = (s) => new Date(`${s}T12:00:00Z`);
  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  const addMonths = (s, m) => { const d = D(s); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
  const daysUntil = (s, from = todayIso()) => Math.round((D(s) - D(from)) / 864e5);
  const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  const fmtLong = (s) => { if (!isIso(s)) return ''; const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
  const MON = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const fmtShort = (s) => { if (!isIso(s)) return '–'; const [y, m, d] = s.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}`; };
  const money = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '';
    const [i, f] = v.toFixed(2).split('.');
    return `€ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------- intakevragen ---------- */
  // dom: G = gezag, I = inbedding, O = ondernemerschap, null = telt niet mee in de score.
  // Elke optie: [tekst voor Coretic, score, tekst voor de zzp'er (optioneel)].
  const Q = {
    profiel: [
      { id: 'rechtsvorm', dom: null, t: 'Hoe is de onderneming ingericht?', tz: 'Hoe is je onderneming ingericht?', o: [['Eenmanszaak of vof', 0], ['Eigen BV', 0]] },
      { id: 'kor', dom: null, t: "Past de zzp'er de kleineondernemersregeling (KOR) toe?", tz: 'Pas je de kleineondernemersregeling (KOR) toe?', why: 'Dan staat er geen btw op de factuur en geeft Coretic de betalingen door aan de Belastingdienst (UBD).', o: [['Nee, factureert met btw', 0, 'Nee, ik reken btw'], ['Ja', 0]] },
    ],
    opdracht: [
      { id: 'doorlenen', dom: null, t: "Werkt de zzp'er via Coretic op locatie of in het team van een eindklant?", tz: 'Werk je via Coretic op locatie of in het team van een eindklant?', why: 'Bepaalt of de Wtta (uitlenen van arbeidskrachten) geldt.', o: [['Nee, levert aan Coretic', 0, 'Nee, ik lever aan Coretic'], ['Ja, onder leiding van de eindklant', 2], ['Ja, maar levert een afgebakend resultaat op', 1, 'Ja, maar ik lever een afgebakend resultaat op']] },
    ],
    gezag: [
      { id: 'hoe', dom: 'G', t: 'Wie bepaalt hoe het werk wordt uitgevoerd?', tz: 'Wie bepaalt hoe je het werk uitvoert?', why: 'Werkinhoudelijke aanwijzingen wijzen op gezag.', o: [["De zzp'er, op basis van vakkennis", 0, 'Ik, op basis van mijn vakkennis'], ['Samen, binnen afgesproken kaders', 1], ['Coretic of de klant geeft dagelijks instructies', 2]] },
      { id: 'tijden', dom: 'G', t: 'Wie bepaalt werktijden en werkplek?', tz: 'Wie bepaalt je werktijden en werkplek?', o: [["De zzp'er zelf", 0, 'Ik zelf'], ['Afgestemd op de klant', 1], ['Opdrachtgever legt ze vast', 2]] },
      { id: 'vervanging', dom: 'G', t: "Mag de zzp'er zich laten vervangen?", tz: 'Mag je je laten vervangen door iemand anders?', why: 'Een vrije vervangingsmogelijkheid weegt zwaar voor zelfstandigheid.', o: [['Ja, door iemand met dezelfde kwalificaties', 0], ['Alleen met toestemming', 1], ['Nee', 2]] },
      { id: 'verantw', dom: 'G', t: 'Hoe wordt het werk verantwoord?', tz: 'Hoe verantwoord je je werk?', o: [['Op het opgeleverde resultaat', 0], ['Voortgangsoverleg per sprint of mijlpaal', 1], ['Functionerings- of beoordelingsgesprekken', 2]] },
    ],
    inbed: [
      { id: 'zelfde', dom: 'I', t: 'Doen werknemers van de klant of Coretic hetzelfde werk?', why: 'Werk dat ook in loondienst gebeurt, wijst op inbedding.', o: [['Nee, het is specialistisch', 0], ['Deels', 1], ['Ja, een vaste functie', 2, 'Ja, ik vul een vaste functie in']] },
      { id: 'duur', dom: 'I', t: 'Hoe lang loopt de opdracht inclusief verwachte verlenging?', o: [['Korter dan 6 maanden', 0], ['6 tot 12 maanden', 1], ['Langer dan een jaar', 2]] },
      { id: 'herken', dom: 'I', t: "Treedt de zzp'er naar buiten op als medewerker van de klant of Coretic?", tz: 'Treed je naar buiten op als medewerker van de klant of Coretic?', why: 'Denk aan e-mailadres, visitekaartjes, kleding of personeelsfeesten.', o: [['Nee, onder eigen naam', 0, 'Nee, onder mijn eigen naam'], ['Alleen een technisch account', 1], ['Ja', 2]] },
      { id: 'structureel', dom: 'I', t: 'Is het werk tijdelijk of structureel voor de organisatie?', o: [['Tijdelijk project of piek', 0], ['Onduidelijk', 1], ['Structureel', 2]] },
    ],
    ond: [
      { id: 'aantal', dom: 'O', t: "Voor hoeveel opdrachtgevers werkte de zzp'er de afgelopen 12 maanden?", tz: 'Voor hoeveel opdrachtgevers werkte je de afgelopen 12 maanden?', why: 'De voorgestelde Zelfstandigenwet vraagt minimaal 3 opdrachtgevers.', o: [['3 of meer', 0], ['2', 1], ['1 of geen', 2]] },
      { id: 'aandeel', dom: 'O', t: 'Welk deel van de omzet komt naar verwachting via Coretic?', tz: 'Welk deel van je omzet komt naar verwachting via Coretic?', o: [['Minder dan 50%', 0], ['50 tot 70%', 1], ['Meer dan 70%', 2]] },
      { id: 'acq', dom: 'O', t: "Werft de zzp'er zelf actief opdrachten?", tz: 'Werf je zelf actief opdrachten?', o: [['Ja, via netwerk, website en offertes', 0], ['Soms', 1], ['Nee', 2]] },
      { id: 'bav', dom: 'O', t: 'Is er een beroeps- of bedrijfsaansprakelijkheidsverzekering?', tz: 'Heb je een beroeps- of bedrijfsaansprakelijkheidsverzekering?', o: [['Ja', 0], ['Aangevraagd', 1], ['Nee', 2]] },
      { id: 'aov', dom: 'O', t: 'Is er een verzekering of buffer voor arbeidsongeschiktheid?', tz: 'Heb je een verzekering of buffer voor arbeidsongeschiktheid?', o: [['Ja', 0], ['Nee', 1]] },
      { id: 'rekening', dom: 'O', t: 'Is er een aparte zakelijke rekening op naam van de onderneming?', tz: 'Heb je een aparte zakelijke rekening op naam van je onderneming?', o: [['Ja', 0], ['Nee', 1]] },
      { id: 'middelen', dom: 'O', t: 'Werkt de zzp’er met eigen laptop, licenties en opleidingen op eigen kosten?', tz: 'Werk je met eigen laptop, licenties en opleidingen op eigen kosten?', o: [['Ja', 0], ['Deels', 1], ['Nee, de opdrachtgever levert alles', 2]] },
      { id: 'risico', dom: 'O', t: "Herstelt de zzp'er fouten op eigen kosten?", tz: 'Herstel je fouten op eigen kosten?', why: 'Financieel risico dragen is een kenmerk van ondernemerschap.', o: [['Ja', 0], ['In overleg', 1], ['Nee', 2]] },
      { id: 'prijs', dom: 'O', t: 'Wie bepaalt het tarief?', tz: 'Wie bepaalt je tarief?', o: [["De zzp'er, via een eigen offerte", 0, 'Ik, via mijn eigen offerte'], ['Onderhandeld', 0], ['De opdrachtgever', 2]] },
    ],
  };
  const GROUPS = { profiel: 'Onderneming', opdracht: 'Opdracht', gezag: 'Gezag', inbed: 'Inbedding', ond: 'Ondernemerschap' };
  const ALLQ = Object.values(Q).flat();
  const SCORED = ALLQ.filter((q) => q.dom);
  const DNAME = { G: 'Gezag', I: 'Inbedding', O: 'Ondernemerschap' };
  const LBL = { ok: 'laag risico', warn: 'aandacht', bad: 'hoog risico' };
  const VTXT = {
    ok: ['Laag risico', 'De antwoorden passen bij een zelfstandige. Bewaar het dossier en herhaal de praktijkcheck elk half jaar.'],
    warn: ['Aandacht nodig', 'Er zijn signalen van gezag, inbedding of afhankelijkheid. Pas de opdracht of overeenkomst aan voordat het werk start.'],
    bad: ['Hoog risico', 'Zo ingericht lijkt de relatie op een dienstbetrekking. Kies loondienst of een andere opzet, of los de rode punten eerst op.'],
  };

  /* ---------- dossier ---------- */
  const STATUS = { intake: 'Intake', contract: 'Contract', actief: 'Vrijgegeven', afgerond: 'Afgerond', afgewezen: 'Niet doorgegaan' };
  const SECTIONS = {
    zzp: { naam: '', bedrijf: '', kvk: '', kvkDatum: '', btw: '', web: '', email: '', tel: '', adres: '' },
    opdracht: { resultaat: '', klant: '', start: '', eind: '', uren: '', tarief: '' },
    intake: { answers: {}, akkoord: false, plaats: '', datum: '', notes: '', bron: '' },
    contract: { og: '', prijsvorm: 'uur', vast: '', betaal: '', opzeg: '', vervanging: true, relatie: false, avg: false, zelffacturering: true, aansprak: 'opdracht', getekend: '' },
  };
  function emptyDossier() {
    return { zzp: { ...SECTIONS.zzp }, opdracht: { ...SECTIONS.opdracht }, intake: { ...SECTIONS.intake, answers: {} }, contract: { ...SECTIONS.contract }, docs: {}, checks: [] };
  }
  // Alleen bekende onderdelen, met standaardwaarden aangevuld.
  function normalize(data) {
    const src = data && typeof data === 'object' ? data : {};
    const out = emptyDossier();
    for (const k of Object.keys(SECTIONS)) {
      const s = src[k] && typeof src[k] === 'object' ? src[k] : {};
      for (const f of Object.keys(SECTIONS[k])) if (s[f] !== undefined) out[k][f] = s[f];
    }
    const a = src.intake && src.intake.answers && typeof src.intake.answers === 'object' ? src.intake.answers : {};
    for (const q of ALLQ) if (Number.isInteger(a[q.id]) && a[q.id] >= 0 && a[q.id] < q.o.length) out.intake.answers[q.id] = a[q.id];
    if (src.docs && typeof src.docs === 'object') {
      for (const x of DOCS) {
        const r = src.docs[x.k];
        if (r && typeof r === 'object') out.docs[x.k] = { s: ['', 'gemeld', 'ok', 'nvt'].includes(r.s) ? r.s : '', d: isIso(r.d) ? r.d : '', exp: isIso(r.exp) ? r.exp : '' };
      }
    }
    out.checks = Array.isArray(src.checks) ? src.checks.filter((c) => c && isIso(c.datum)).slice(-50) : [];
    return out;
  }

  /* ---------- documenten ---------- */
  // who: zzp = de zzp'er levert aan (ook via de intakelink), coretic, beide, klant, acc = accountant van de zzp'er.
  const WHO = { zzp: "Zzp'er", coretic: 'Coretic', beide: 'Beide', klant: 'Eindklant', acc: "Accountant zzp'er" };
  const selfBilling = (d) => d.contract && d.contract.zelffacturering !== false;
  const DOCS = [
    { k: 'intake', f: 'start', req: 1, who: 'zzp', t: 'Ingevulde intake met verklaring', why: 'Legt werkwijze en ondernemerschap vast.', auto: (d) => !!d.intake.akkoord },
    { k: 'kvk', f: 'start', req: 1, who: 'zzp', t: 'KvK-uittreksel, maximaal 3 maanden oud', why: 'Bewijs van inschrijving als ondernemer.' },
    { k: 'btw', f: 'start', req: 1, who: 'zzp', t: 'Btw-id of bevestiging KOR', why: 'Bepaalt de btw op de factuur en of Coretic een UBD-opgaaf doet.' },
    { k: 'bav', f: 'start', req: 1, exp: 1, who: 'zzp', t: 'Polis beroeps- of bedrijfsaansprakelijkheid', why: 'Ondernemersrisico. Vraag elk jaar een nieuw polisblad.' },
    { k: 'offerte', f: 'start', req: 1, who: 'zzp', t: "Offerte van de zzp'er", why: "Laat zien dat de zzp'er zelf de prijs bepaalt." },
    { k: 'klanten', f: 'start', req: 1, who: 'zzp', t: 'Overzicht opdrachtgevers afgelopen 12 maanden', why: 'Ondernemerschap. Onder de Zelfstandigenwet straks minimaal 3.' },
    { k: 'rekening', f: 'start', req: 1, who: 'zzp', t: 'Zakelijke rekening op naam van de onderneming', why: 'Bijvoorbeeld een bankafschrift met tenaamstelling. Betaal nooit naar een privérekening.' },
    { k: 'aov', f: 'start', req: 0, who: 'zzp', t: 'Bewijs AOV, pensioen of buffer', why: 'De Zelfstandigenwet vraagt een minimumbedrag aan voorzieningen.' },
    { k: 'webmodule', f: 'start', req: 1, who: 'coretic', t: 'Uitslag Webmodule Beoordeling arbeidsrelatie', why: 'Extra onderbouwing richting de Belastingdienst. Bewaar de pdf.' },
    { k: 'overeenkomst', f: 'start', req: 1, who: 'beide', t: 'Getekende opdrachtovereenkomst', why: 'Kern van het dossier. Wordt afgevinkt met de tekendatum bij Overeenkomst.', auto: (d) => isIso(d.contract.getekend) },
    { k: 'zelffacturering', f: 'start', req: 1, who: 'beide', t: 'Getekend akkoord zelffacturering', why: 'Coretic maakt de facturen namens de zzp\'er. Dat mag alleen met een vooraf schriftelijk vastgelegde afspraak.', cond: selfBilling },
    { k: 'klantakkoord', f: 'start', req: 1, who: 'klant', t: 'Akkoord eindklant op inzet onderaannemer', why: 'Veel klantcontracten verbieden onderaanneming zonder toestemming.', cond: (d) => !!d.opdracht.klant },
    { k: 'backtoback', f: 'start', req: 1, who: 'coretic', t: 'Opdracht van de eindklant met hetzelfde resultaat', why: 'Voorkomt dat het lijkt op terbeschikkingstelling (Wtta).', cond: (d) => !!d.opdracht.klant },
    { k: 'screening', f: 'start', req: 0, who: 'zzp', t: 'Screening of VOG, als de eindklant dat eist', why: 'Toegangseis van de klant.', cond: (d) => !!d.opdracht.klant },
    { k: 'verwerker', f: 'start', req: 1, who: 'beide', t: 'Verwerkersovereenkomst', why: "Verplicht als de zzp'er persoonsgegevens verwerkt (art. 28 AVG).", cond: (d) => !!d.contract.avg },
    { k: 'derden', f: 'start', req: 0, who: 'acc', t: 'Derdenverklaring van de accountant', why: 'Optioneel. Voorbereiding op de Zelfstandigenwet.' },
    { k: 'ubd', f: 'tijdens', req: 1, who: 'zzp', t: 'Gegevens voor de UBD-opgaaf: BSN, geboortedatum, adres', why: 'Alleen bij KOR of een factuur zonder btw. Opgaaf vóór 31 januari.', cond: (d) => d.intake.answers.kor === 1 && d.intake.answers.rechtsvorm !== 1 },
    { k: 'facturen', f: 'tijdens', req: 1, who: 'zzp', t: 'Facturen met btw-id, KvK en eigen bedrijfsnaam', why: 'De zzp\'er factureert zelf, per resultaat of periode.', cond: (d) => !selfBilling(d) },
    { k: 'meerwerk', f: 'tijdens', req: 0, who: 'beide', t: 'Schriftelijke afspraken over meerwerk en wijzigingen', why: 'Leg elke wijziging van het resultaat vast.' },
    { k: 'oplevering', f: 'einde', req: 1, who: 'coretic', t: 'Opleverbewijs of acceptatie van het resultaat', why: 'Bewijst dat er een resultaat is geleverd.' },
    { k: 'ip', f: 'einde', req: 0, who: 'zzp', t: 'Overdracht intellectueel eigendom', why: 'Nodig als de klant de rechten op het resultaat moet krijgen.' },
    { k: 'toegang', f: 'einde', req: 1, who: 'coretic', t: 'Toegang ingetrokken en materialen terug', why: 'Accounts, badges en laptops van de klant.' },
    { k: 'evaluatie', f: 'einde', req: 0, who: 'coretic', t: 'Korte evaluatie', why: 'Input voor een volgende opdracht.' },
  ];
  const DOC_KEYS = DOCS.map((x) => x.k);
  const FASE = { start: 'Vóór de start', tijdens: 'Tijdens de opdracht', einde: 'Bij het einde' };
  const DSTAT = { '': 'Open', gemeld: "Aangeleverd, nog controleren", ok: 'Ontvangen en gecontroleerd', nvt: 'Niet van toepassing' };
  const applies = (x, d) => !x.cond || x.cond(d);
  const docState = (x, d) => ((x.auto && x.auto(d)) ? 'ok' : ((d.docs[x.k] && d.docs[x.k].s) || ''));
  const docDone = (x, d) => ['ok', 'nvt'].includes(docState(x, d));
  function docCount(d, fase) {
    const list = DOCS.filter((x) => x.req && applies(x, d) && (!fase || x.f === fase));
    const open = list.filter((x) => !docDone(x, d));
    return { done: list.length - open.length, total: list.length, open };
  }
  // Documenten die de zzp'er zelf via de intakelink kan aanleveren.
  const uploadableByZzp = (d) => DOCS.filter((x) => x.who === 'zzp' && !x.auto && applies(x, d) && x.k !== 'ubd');

  /* ---------- praktijkcheck ---------- */
  const PC = [
    { id: 'res', t: "Werkt de zzp'er nog aan het afgesproken resultaat, zonder losse taken erbij?", o: ['Ja', 'Nee'], s: [0, 2] },
    { id: 'instr', t: "Krijgt de zzp'er aanwijzingen over hoe het werk moet, van Coretic of de klant?", o: ['Nee', 'Soms', 'Ja'], s: [0, 1, 2] },
    { id: 'tijd', t: "Bepaalt de zzp'er zelf werktijden en werkplek?", o: ['Ja', 'Deels', 'Nee'], s: [0, 1, 2] },
    { id: 'andere', t: "Heeft de zzp'er nog andere opdrachtgevers?", o: ['Ja', 'Nee'], s: [0, 1] },
    { id: 'verleng', t: 'Is de opdracht verlengd zonder nieuw resultaat?', o: ['Nee', 'Ja'], s: [0, 2] },
    { id: 'inbed', t: "Doet de zzp'er mee als teamlid: Coretic- of klantmail, kleding, verplicht teamoverleg?", o: ['Nee', 'Ja'], s: [0, 2] },
    { id: 'fact', t: 'Kloppen de uren en facturen met de overeenkomst?', o: ['Ja', 'Nee'], s: [0, 1] },
  ];
  const lastCheck = (d) => (d.checks || []).map((c) => c.datum).filter(isIso).sort().pop() || null;
  const nextCheck = (d) => { const b = lastCheck(d) || (isIso(d.opdracht.start) ? d.opdracht.start : null); return b ? addMonths(b, 6) : null; };

  /* ---------- risico-indicatie ---------- */
  function assess(d) {
    const A = d.intake.answers || {};
    const o = d.opdracht;
    const z = d.zzp;
    const dom = { G: [0, 0, 0], I: [0, 0, 0], O: [0, 0, 0] };
    for (const q of SCORED) {
      const v = A[q.id];
      if (v == null) continue;
      dom[q.dom][0] += q.o[v][1];
      dom[q.dom][1] += Math.max(...q.o.map((x) => x[1]));
      dom[q.dom][2] += 1;
    }
    const lvl = (x) => (x[2] === 0 ? null : x[0] / x[1] < 0.25 ? 'ok' : x[0] / x[1] < 0.5 ? 'warn' : 'bad');
    const L = { G: lvl(dom.G), I: lvl(dom.I), O: lvl(dom.O) };
    const flags = [];
    const tarief = parseFloat(String(o.tarief).replace(',', '.'));
    if (Number.isFinite(tarief) && tarief > 0 && tarief < 38) flags.push(['bad', 'Tarief onder €38 per uur', "Volgens het wetsvoorstel rechtsvermoeden mag de zzp'er dan uitgaan van een arbeidsovereenkomst en moet Coretic het tegendeel bewijzen."]);
    if (A.doorlenen === 1) flags.push(['bad', 'Doorlenen onder leiding van de eindklant', 'Dit is terbeschikkingstelling van arbeid. Vanaf 1 januari 2027 heeft Coretic daarvoor een toelating of ontheffing van de NAU nodig (Wtta).']);
    if (A.doorlenen === 2) flags.push(['warn', 'Werk bij een eindklant', 'Leg hetzelfde resultaat vast in de opdracht van de eindklant en in deze overeenkomst.']);
    if (A.zelfde === 2) flags.push(['bad', 'Werk dat ook werknemers doen', 'Het sterkste signaal voor inbedding. Beschrijf een afgebakend, specialistisch resultaat of kies loondienst.']);
    if (isIso(o.start) && isIso(o.eind) && (D(o.eind) - D(o.start)) / 864e5 > 365 && A.duur !== 2) flags.push(['warn', 'Looptijd langer dan een jaar', 'Dat past niet bij het antwoord over de looptijd. Knip op in afgebakende resultaten.']);
    if (isIso(z.kvkDatum) && (D(todayIso()) - D(z.kvkDatum)) / 864e5 < 365) flags.push(['warn', 'Korter dan een jaar ingeschreven bij de KvK', 'Vraag naar acquisitie, investeringen en andere opdrachtgevers.']);
    if (A.vervanging === 2) flags.push(['warn', 'Geen vervanging mogelijk', 'Neem vrije vervanging op in de overeenkomst als dat in de praktijk kan.']);
    if (A.aantal > 0) flags.push(['info', 'Minder dan 3 opdrachtgevers', 'Onder de voorgestelde Zelfstandigenwet is dat straks een voorwaarde voor zekerheid vooraf.']);
    if (A.kor === 1 && A.rechtsvorm !== 1) flags.push(['info', "Zzp'er past de KOR toe", 'Coretic geeft de betalingen vóór 31 januari door aan de Belastingdienst (UBD). Vraag BSN en geboortedatum op.']);
    if (A.rechtsvorm === 1) flags.push(['info', 'Werkt via een eigen BV', 'Coretic contracteert met de BV. Er is geen UBD-opgaaf nodig.']);
    const answered = dom.G[2] + dom.I[2] + dom.O[2];
    let verdict = null;
    if (answered >= SCORED.length * 0.6) {
      const pts = ['G', 'I', 'O'].map((k) => (L[k] === 'bad' ? 2 : L[k] === 'warn' ? 1 : 0)).reduce((a, b) => a + b, 0);
      const hard = flags.some((f) => f[0] === 'bad');
      verdict = (pts >= 4 || (hard && pts >= 2)) ? 'bad' : (pts >= 2 || hard) ? 'warn' : 'ok';
    }
    return { dom, L, flags, verdict, answered, complete: answered === SCORED.length };
  }

  /* ---------- actiepunten ---------- */
  function actions(d, status) {
    const A = [];
    const o = d.opdracht;
    const ans = d.intake.answers;
    if (status === 'afgewezen') return A;
    if (status === 'afgerond') {
      const e = docCount(d, 'einde');
      if (e.open.length) A.push(['warn', `${plural(e.open.length, 'afrondingsdocument', 'afrondingsdocumenten')} open`, e.open.map((x) => x.t).join(', ')]);
      return A;
    }
    const active = status === 'actief';
    const r = assess(d);
    if (r.verdict === 'bad') A.push(['bad', 'Hoog risico op schijnzelfstandigheid', 'Pas de opdracht aan of kies een andere constructie.']);
    if (+o.tarief > 0 && +o.tarief < 38) A.push(['bad', 'Tarief onder €38', 'Rechtsvermoeden van werknemerschap. Onderbouw of verhoog het tarief.']);
    if (ans.doorlenen === 1) A.push(['bad', 'Doorlenen onder leiding van de klant', 'Vanaf 1 januari 2027 is een Wtta-toelating nodig.']);
    const s = docCount(d, 'start');
    if (s.open.length) A.push([active ? 'bad' : 'warn', `${plural(s.open.length, 'startdocument', 'startdocumenten')} open`, s.open.slice(0, 3).map((x) => x.t).join(', ') + (s.open.length > 3 ? ' en meer' : '')]);
    const kd = d.docs.kvk && d.docs.kvk.d;
    if (isIso(kd) && isIso(o.start) && (D(o.start) - D(kd)) / 864e5 > 92) A.push(['warn', 'KvK-uittreksel te oud', 'Het uittreksel is bij de start ouder dan 3 maanden. Vraag een nieuwe op.']);
    const be = d.docs.bav && d.docs.bav.exp;
    if (isIso(be)) {
      const n = daysUntil(be);
      if (n < 0) A.push(['bad', 'Aansprakelijkheidspolis verlopen', 'Vraag het nieuwe polisblad op.']);
      else if (n <= 30) A.push(['warn', `Polis verloopt over ${plural(n, 'dag', 'dagen')}`, 'Vraag het nieuwe polisblad op.']);
    }
    if (active) {
      const nx = nextCheck(d);
      if (nx) {
        const n = daysUntil(nx);
        if (n < 0) A.push(['bad', 'Praktijkcheck verlopen', `Was gepland op ${fmtShort(nx)}.`]);
        else if (n <= 14) A.push(['warn', 'Praktijkcheck binnenkort', `Gepland op ${fmtShort(nx)}.`]);
      }
      if (isIso(o.eind)) {
        const n = daysUntil(o.eind);
        if (n < 0) A.push(['warn', 'Einddatum verstreken', "De zzp'er kan geen uren meer schrijven. Rond af of leg een nieuwe opdracht met een eigen resultaat vast."]);
        else if (n <= 30) A.push(['warn', `Eindigt over ${plural(n, 'dag', 'dagen')}`, 'Verlengen alleen met een nieuwe opdracht en een nieuw resultaat.']);
      }
      if (ans.kor === 1 && ans.rechtsvorm !== 1) { const y = Number(todayIso().slice(0, 4)); A.push(['warn', 'UBD-opgaaf nodig', `Geef de betalingen van ${y} vóór 31 januari ${y + 1} door aan de Belastingdienst.`]); }
    }
    return A;
  }

  // Voorwaarden om de zzp'er vrij te geven voor urenregistratie.
  // hard: altijd nodig. soft: alleen met een vastgelegde motivering.
  function releaseProblems(d, ctx = {}) {
    const hard = [];
    const soft = [];
    if (!ctx.userId) hard.push("Koppel het dossier aan een gebruiker, zodat de zzp'er kan inloggen.");
    else if (!ctx.isContractor) hard.push("Zet de gekoppelde gebruiker op 'Ingehuurde zzp'er' (knop Zzp-gegevens overnemen).");
    if (ctx.userId && ctx.isContractor && selfBilling(d) && !ctx.agreementDate) hard.push('Vul de datum van het akkoord zelffacturering in (bij Documenten, dan Zzp-gegevens overnemen).');
    const r = assess(d);
    if (!r.complete) hard.push('Niet alle vragen over gezag, inbedding en ondernemerschap zijn beantwoord.');
    if (!d.intake.akkoord) hard.push("De zzp'er heeft de verklaring bij de intake nog niet bevestigd.");
    if (!isIso(d.contract.getekend)) hard.push('De overeenkomst is nog niet getekend.');
    if (!isIso(d.opdracht.start) || !isIso(d.opdracht.eind)) hard.push('Vul de start- en einddatum van de opdracht in. Uren schrijven kan alleen binnen die periode.');
    else if (d.opdracht.eind < d.opdracht.start) hard.push('De einddatum ligt vóór de startdatum.');
    const s = docCount(d, 'start');
    for (const x of s.open) hard.push(`Document open: ${x.t}`);
    if (r.verdict === 'bad') soft.push('De risico-indicatie is hoog.');
    if (+d.opdracht.tarief > 0 && +d.opdracht.tarief < 38) soft.push('Het tarief ligt onder €38 per uur.');
    if (d.intake.answers.doorlenen === 1) soft.push('De zzp\'er werkt onder leiding van de eindklant (Wtta).');
    return { hard, soft };
  }

  /* ---------- opdrachtovereenkomst ---------- */
  const OG = { dvn: 'DVN Technology B.V., handelend onder de naam Coretic', cor: 'Coretic B.V.' };
  const OG_SHORT = { dvn: 'DVN Technology B.V.', cor: 'Coretic B.V.' };
  // S: instellingen van de opdrachtgever (og, dvnKvk, corKvk, ogAdres, ogPlaats, ogRep, betaal, opzeg).
  function contractData(d, S, id) {
    const c = d.contract;
    const o = d.opdracht;
    const z = d.zzp;
    const og = OG[c.og] ? c.og : (OG[S.og] ? S.og : 'dvn');
    return {
      og, ogKvk: og === 'cor' ? S.corKvk : S.dvnKvk, ogPlaats: S.ogPlaats, ogAdres: S.ogAdres, ogRep: S.ogRep,
      onNaam: z.naam, onBedrijf: z.bedrijf, onKvk: z.kvk, onBtw: z.btw, onAdres: z.adres,
      resultaat: o.resultaat, klant: o.klant, start: o.start, eind: o.eind, uren: o.uren,
      prijsvorm: c.prijsvorm === 'vast' ? 'vast' : 'uur', bedrag: c.prijsvorm === 'vast' ? c.vast : o.tarief,
      betaal: c.betaal || S.betaal || '30', opzeg: c.opzeg || S.opzeg || '30',
      vervanging: c.vervanging !== false, relatie: !!c.relatie, avg: !!c.avg, zelffacturering: selfBilling(d), aansprak: c.aansprak || 'opdracht',
      kenmerk: `CO-${isIso(o.start) ? o.start.slice(0, 4) : todayIso().slice(0, 4)}-${String(id || 0).padStart(4, '0')}`, getekend: c.getekend,
    };
  }
  function contractHtml(s) {
    const v = (x, ph) => (x ? esc(x) : `<mark>${ph}</mark>`);
    const klant = s.klant;
    const lines = s.resultaat ? String(s.resultaat).split(/\n+/).map((x) => x.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean) : [];
    const res = lines.length ? `<ol type="a">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>` : '<p><mark>omschrijving van het resultaat</mark></p>';
    const prijs = s.prijsvorm === 'vast'
      ? `een vaste prijs van ${v(money(s.bedrag), 'bedrag')} exclusief btw voor het volledige Resultaat. Opdrachtnemer draagt het risico als de werkzaamheden meer tijd kosten dan ingeschat`
      : `een tarief van ${v(money(s.bedrag), 'uurtarief')} per uur exclusief btw, zoals door Opdrachtnemer voorgesteld in zijn offerte${s.uren ? `. De inschatting van ${esc(s.uren)} uur is indicatief en geeft geen recht op een minimum aantal uren` : ''}`;
    const cap = { opdracht: 'het totale bedrag dat voor de Opdracht is of wordt gefactureerd', verzekerd: 'het bedrag dat de beroeps- of bedrijfsaansprakelijkheidsverzekering van Opdrachtnemer in het betreffende geval uitkeert', jaar: 'het bedrag dat Opdrachtnemer in de twaalf maanden voorafgaand aan de schade heeft gefactureerd' }[s.aansprak] || 'het totale bedrag dat voor de Opdracht is of wordt gefactureerd';
    let n = 0;
    const art = (t, body) => `<h3>Artikel ${++n}. ${t}</h3>${body}`;
    let h = `<h1>Overeenkomst van opdracht</h1><p class="psub">Kenmerk ${esc(s.kenmerk)}</p>
    <p><b>De ondergetekenden</b></p>
    <p>1. ${OG[s.og]}, gevestigd te ${v(s.ogPlaats, 'plaats')}${s.ogAdres ? `, ${esc(s.ogAdres)}` : ''}, ingeschreven bij de Kamer van Koophandel onder nummer ${v(s.ogKvk, 'KvK opdrachtgever')}, rechtsgeldig vertegenwoordigd door ${v(s.ogRep, 'vertegenwoordiger')}, hierna: <b>Opdrachtgever</b>;</p>
    <p>2. ${v(s.onBedrijf, 'bedrijfsnaam opdrachtnemer')}, ${s.onAdres ? esc(s.onAdres) : '<mark>adres</mark>'}, ingeschreven bij de Kamer van Koophandel onder nummer ${v(s.onKvk, 'KvK opdrachtnemer')}, btw-identificatienummer ${v(s.onBtw, 'btw-id')}, rechtsgeldig vertegenwoordigd door ${v(s.onNaam, 'naam')}, hierna: <b>Opdrachtnemer</b>;</p>
    <p><b>Overwegende dat</b></p>
    <p>Opdrachtnemer een zelfstandige onderneming drijft, voor eigen rekening en risico werkt en zijn diensten aan meerdere opdrachtgevers aanbiedt; Opdrachtgever een afgebakend resultaat wil laten realiseren waarvoor Opdrachtnemer de specialistische kennis heeft; partijen uitdrukkelijk geen arbeidsovereenkomst willen sluiten en ook in de praktijk niet zo zullen werken;</p>
    <p><b>komen het volgende overeen.</b></p>`;
    h += art('De opdracht', `<p>1. Opdrachtgever geeft Opdrachtnemer opdracht tot het realiseren van het volgende resultaat (het <b>Resultaat</b>):</p>${res}<p>2. Opdrachtnemer aanvaardt de opdracht. Deze overeenkomst is een overeenkomst van opdracht als bedoeld in artikel 7:400 en volgende van het Burgerlijk Wetboek.</p>`);
    h += art('Zelfstandige uitvoering', `<p>1. Opdrachtnemer bepaalt zelf de wijze waarop hij het Resultaat realiseert, en wanneer en waar hij de werkzaamheden uitvoert. Hij doet dat naar eigen inzicht en vakmanschap.</p><p>2. Opdrachtgever geeft uitsluitend aanwijzingen die het Resultaat zelf betreffen. Opdrachtgever houdt geen toezicht op de manier van werken en voert met Opdrachtnemer geen functionerings- of beoordelingsgesprekken.</p><p>3. Partijen stemmen de voortgang af op mijlpalen. Afstemming over planning en toegang tot systemen of locaties dient alleen om het Resultaat te kunnen opleveren.</p><p>4. Opdrachtnemer treedt naar buiten op onder zijn eigen naam en is niet opgenomen in de organisatie of het personeelsbestand van Opdrachtgever${klant ? ' of de Eindklant' : ''}.</p>`);
    if (klant) h += art('Werk voor een eindklant', `<p>1. Het Resultaat wordt gerealiseerd ten behoeve van ${esc(klant)} (de <b>Eindklant</b>), een opdrachtgever van Opdrachtgever.</p><p>2. Opdrachtgever stelt Opdrachtnemer niet ter beschikking aan de Eindklant. De Eindklant geeft Opdrachtnemer geen leiding en geen toezicht. Opdrachtnemer blijft tegenover Opdrachtgever verantwoordelijk voor het Resultaat.</p><p>3. Voor zover Opdrachtnemer op locatie bij de Eindklant werkt, houdt hij zich aan de daar geldende veiligheids-, screenings- en toegangsregels.</p>`);
    h += art('Vervanging en inschakelen van derden', s.vervanging
      ? '<p>1. Opdrachtnemer mag de werkzaamheden geheel of gedeeltelijk laten uitvoeren door een vervanger of hulppersoon met vergelijkbare kwalificaties, na melding aan Opdrachtgever.</p><p>2. Opdrachtgever kan een vervanger alleen weigeren als deze aantoonbaar niet over de vereiste kwalificaties of een vereiste screening beschikt.</p><p>3. Opdrachtnemer betaalt de vervanger zelf en blijft volledig verantwoordelijk voor het Resultaat.</p>'
      : '<p>1. Opdrachtnemer mag hulppersonen of een vervanger inschakelen na voorafgaande schriftelijke toestemming van Opdrachtgever. Opdrachtgever weigert die toestemming niet op onredelijke gronden.</p><p>2. Opdrachtnemer betaalt hulppersonen en vervangers zelf en blijft volledig verantwoordelijk voor het Resultaat.</p>');
    h += art('Duur en beëindiging', `<p>1. De overeenkomst gaat in op ${v(fmtLong(s.start), 'startdatum')} en eindigt van rechtswege op ${v(fmtLong(s.eind), 'einddatum')}, of eerder als het Resultaat is opgeleverd en aanvaard.</p><p>2. Verlenging is alleen mogelijk met een nieuwe schriftelijke opdracht met een eigen resultaat.</p><p>3. Beide partijen kunnen de overeenkomst tussentijds schriftelijk opzeggen met een termijn van ${v(s.opzeg, 'aantal')} dagen. Het tot dan toe gerealiseerde werk wordt naar rato vergoed.</p><p>4. Elke partij kan de overeenkomst met directe ingang ontbinden als de andere partij failliet gaat, surseance van betaling krijgt of na een schriftelijke ingebrekestelling met een redelijke termijn tekort blijft schieten.</p>`);
    const fact = s.zelffacturering
      ? `<p>2. Opdrachtnemer registreert de bestede tijd per deelresultaat in het registratiesysteem van Opdrachtgever. Deze registratie dient uitsluitend als specificatie voor de facturatie en houdt geen toezicht op de werkwijze in.</p><p>3. Partijen komen overeen dat Opdrachtgever de facturen namens Opdrachtnemer opmaakt en uitreikt (factuur uitgereikt door afnemer). Opdrachtnemer controleert elke factuur en geeft binnen 14 dagen akkoord of maakt bezwaar. Opdrachtnemer blijft zelf verantwoordelijk voor de aangifte en afdracht van btw. Opdrachtgever betaalt binnen ${v(s.betaal, 'aantal')} dagen na uitreiking op een zakelijke rekening op naam van Opdrachtnemer.</p>`
      : `<p>2. Opdrachtnemer factureert ${s.prijsvorm === 'vast' ? 'na oplevering van het Resultaat, of per afgesproken mijlpaal' : 'maandelijks achteraf, met een specificatie van de bestede tijd per deelresultaat'}. Opdrachtgever betaalt binnen ${v(s.betaal, 'aantal')} dagen na ontvangst van een correcte factuur op een zakelijke rekening op naam van Opdrachtnemer.</p>`;
    h += art('Vergoeding en facturatie', `<p>1. Opdrachtnemer ontvangt ${prijs}.</p>${fact}<p>${s.zelffacturering ? 4 : 3}. Er is geen vergoeding verschuldigd bij ziekte, vakantie of andere afwezigheid van Opdrachtnemer. Opdrachtnemer bouwt geen vakantiegeld of andere werknemersaanspraken op.</p><p>${s.zelffacturering ? 5 : 4}. Meerwerk wordt alleen vergoed als partijen het vooraf schriftelijk hebben afgesproken.</p>`);
    h += art('Eigen middelen en kosten', `<p>Opdrachtnemer gebruikt eigen apparatuur, software en licenties, tenzij toegang tot systemen van Opdrachtgever${klant ? ' of de Eindklant' : ''} technisch of om beveiligingsredenen nodig is. Opleiding, reiskosten en overige bedrijfskosten zijn voor rekening van Opdrachtnemer, tenzij schriftelijk anders afgesproken.</p>`);
    h += art('Kwaliteit, aansprakelijkheid en verzekering', `<p>1. Opdrachtnemer herstelt gebreken in het Resultaat op eigen kosten, als Opdrachtgever die binnen 30 dagen na oplevering meldt.</p><p>2. Opdrachtnemer is aansprakelijk voor schade die het gevolg is van een tekortkoming in de uitvoering. De aansprakelijkheid is beperkt tot ${cap}, behalve bij opzet of bewuste roekeloosheid.</p><p>3. Opdrachtnemer heeft een beroeps- of bedrijfsaansprakelijkheidsverzekering en toont de polis op verzoek aan.</p>`);
    h += art('Geheimhouding', `<p>Opdrachtnemer houdt alle vertrouwelijke informatie van Opdrachtgever${klant ? ' en de Eindklant' : ''} geheim, ook na het einde van deze overeenkomst, en gebruikt die alleen voor de uitvoering van de opdracht. Deze plicht geldt ook voor vervangers en hulppersonen die Opdrachtnemer inschakelt.</p>`);
    h += art('Intellectueel eigendom', '<p>1. De rechten op het Resultaat gaan over op Opdrachtgever zodra de bijbehorende facturen zijn betaald. Opdrachtnemer werkt mee aan een eventueel benodigde akte van overdracht.</p><p>2. Algemene kennis, methoden, tools en standaardcomponenten die Opdrachtnemer al had of los van de opdracht ontwikkelt, blijven van Opdrachtnemer. Opdrachtgever krijgt daarop een eeuwigdurend, niet-exclusief gebruiksrecht voor zover dat nodig is om het Resultaat te gebruiken.</p>');
    if (s.avg) h += art('Persoonsgegevens', '<p>Voor zover Opdrachtnemer bij de uitvoering persoonsgegevens verwerkt, sluiten partijen vóór aanvang een verwerkersovereenkomst als bedoeld in artikel 28 AVG.</p>');
    h += art('Andere opdrachtgevers', `<p>1. Opdrachtnemer is vrij om tijdens deze overeenkomst opdrachten voor anderen uit te voeren, ook voor concurrenten van Opdrachtgever, mits dat de geheimhouding niet raakt.</p>${s.relatie && klant ? '<p>2. Opdrachtnemer verricht tot twaalf maanden na het einde van deze overeenkomst geen werkzaamheden rechtstreeks voor de Eindklant, tenzij via Opdrachtgever of met diens schriftelijke toestemming. Dit relatiebeding beperkt Opdrachtnemer niet in het werken voor andere partijen.</p>' : ''}`);
    h += art('Fiscale positie en praktijk', '<p>1. Partijen beogen uitdrukkelijk geen arbeidsovereenkomst. Opdrachtnemer voldoet zelf de verschuldigde belastingen en premies en draagt zelf zorg voor zijn verzekeringen en inkomensvoorzieningen.</p><p>2. Partijen voeren de opdracht feitelijk uit zoals in deze overeenkomst beschreven. Bij verlenging, en anders ten minste elke zes maanden, controleren zij gezamenlijk of de praktijk nog overeenkomt met deze overeenkomst en de intake die Opdrachtnemer heeft ingevuld.</p><p>3. Opdrachtnemer meldt Opdrachtgever direct als zijn situatie wezenlijk verandert, zoals beëindiging van de KvK-inschrijving of van de aansprakelijkheidsverzekering.</p>');
    h += art('Slotbepalingen', '<p>1. Afwijkingen van deze overeenkomst gelden alleen als ze schriftelijk zijn vastgelegd. Algemene voorwaarden van partijen zijn niet van toepassing, tenzij schriftelijk anders afgesproken.</p><p>2. Op deze overeenkomst is Nederlands recht van toepassing. Geschillen worden voorgelegd aan de bevoegde rechter van de rechtbank Zeeland-West-Brabant.</p>');
    h += `<p style="margin-top:22px">Aldus overeengekomen en in tweevoud ondertekend te ${v(s.ogPlaats, 'plaats')} op ${isIso(s.getekend) ? esc(fmtLong(s.getekend)) : '<mark>datum</mark>'}.</p>
    <div class="sig"><div><b>Opdrachtgever</b><br>${OG_SHORT[s.og]}<br>${v(s.ogRep, 'vertegenwoordiger')}</div><div><b>Opdrachtnemer</b><br>${v(s.onBedrijf, 'bedrijfsnaam')}<br>${v(s.onNaam, 'naam')}</div></div>`;
    return h;
  }
  function contractChecks(d, S, id) {
    const s = contractData(d, S, id);
    const c = [];
    const days = (isIso(s.start) && isIso(s.eind)) ? (D(s.eind) - D(s.start)) / 864e5 : null;
    if (s.prijsvorm === 'uur' && s.bedrag && +s.bedrag < 38) c.push(['bad', 'Tarief onder €38', 'Dan geldt volgens het wetsvoorstel het rechtsvermoeden van werknemerschap.']);
    if (days !== null && days < 0) c.push(['bad', 'Einddatum ligt vóór de startdatum', 'Controleer de data bij Intake.']);
    if (days !== null && days > 365) c.push(['warn', 'Looptijd langer dan een jaar', 'Lange opdrachten wijzen op inbedding. Knip op in afgebakende resultaten.']);
    if (s.resultaat && /\b(medewerker|functie|ondersteun\w*|meewerk\w*|capaciteit|inzet als|rol als)\b/i.test(s.resultaat)) c.push(['warn', 'Resultaat leest als een functie', 'Beschrijf wat er wordt opgeleverd, zoals een app, analyse of migratie.']);
    if (!s.vervanging) c.push(['warn', 'Geen vrije vervanging', 'Toegestaan, maar vrije vervanging weegt zwaar voor zelfstandigheid.']);
    if (s.klant) c.push(['info', 'Werk voor een eindklant', 'Vraag akkoord voor onderaanneming en leg hetzelfde resultaat vast in de klantopdracht (zie Documenten).']);
    if (s.relatie && !s.klant) c.push(['info', 'Relatiebeding zonder eindklant', 'Het beding komt alleen in de tekst als er een eindklant is ingevuld.']);
    if (s.og === 'dvn') c.push(['info', 'Opdrachtgever is de holding', 'Kies Coretic B.V. zodra de werkmaatschappij is ingeschreven.']);
    const missing = [['onNaam', 'naam'], ['onBedrijf', 'bedrijfsnaam'], ['onKvk', 'KvK opdrachtnemer'], ['onAdres', 'adres opdrachtnemer'], ['ogKvk', 'KvK opdrachtgever'], ['resultaat', 'resultaat'], ['start', 'startdatum'], ['eind', 'einddatum'], ['bedrag', 'bedrag']].filter(([k]) => !s[k]).map((x) => x[1]);
    if (missing.length) c.push(['warn', missing.length === 1 ? '1 gegeven ontbreekt' : `${missing.length} gegevens ontbreken`, `${missing.join(', ')}. Geel gemarkeerd in de tekst.`]);
    if (!c.some((x) => x[0] === 'bad' || x[0] === 'warn')) c.push(['ok', 'Klaar om te tekenen', 'Laat beide partijen tekenen en vul daarna de tekendatum in.']);
    return c;
  }

  return {
    esc, isIso, todayIso, addMonths, daysUntil, fmtLong, fmtShort, money, plural,
    Q, GROUPS, ALLQ, SCORED, DNAME, LBL, VTXT, STATUS, SECTIONS, emptyDossier, normalize,
    WHO, DOCS, DOC_KEYS, FASE, DSTAT, applies, docState, docDone, docCount, uploadableByZzp, selfBilling,
    PC, lastCheck, nextCheck, assess, actions, releaseProblems,
    OG, OG_SHORT, contractData, contractHtml, contractChecks,
  };
}));
