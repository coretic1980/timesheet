const express = require('express');
const { query } = require('../db');
const { hoursAccess, assertHoursAllowed, allowedWork, scopeFor, gateMessage } = require('../onboarding');
const {
  ah, HttpError, isoDate, addDays, todayIso, weekRange, num, str, intParam,
} = require('../util');

const r = express.Router();

const ENTRY_COLS = 'id, project_id, activity_id, work_date, hours, description, internal_note, status, rejection_reason';

// Periode uit query/body: { month: 'jjjj-mm' } voor een maand, anders { week: datum } voor een week.
function periodRange(src) {
  if (src.month !== undefined && src.month !== null && src.month !== '') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(src.month))) throw new HttpError(400, 'Ongeldige maand');
    const start = `${src.month}-01`;
    const [y, m] = src.month.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { period: 'month', start, end };
  }
  const { start, end } = weekRange(src.week || todayIso());
  return { period: 'week', start, end };
}

function daysBetween(start, end) {
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

r.get('/', ah(async (req, res) => {
  const { period, start, end } = periodRange(req.query);
  const uid = req.user.id;

  const projects = (await query(
    `SELECT p.id, p.name, p.code, p.billable, p.active, p.budget_hours, p.client_id, c.name AS client_name,
            EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id AND a.user_id = $1) AS assigned
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
      WHERE (p.active AND EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id AND a.user_id = $1))
         OR p.id IN (SELECT project_id FROM time_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3)
      ORDER BY c.name NULLS LAST, p.name`,
    [uid, start, end]
  )).rows;

  const entries = (await query(
    `SELECT ${ENTRY_COLS} FROM time_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3`,
    [uid, start, end]
  )).rows;

  // Activiteiten per project; ook activiteiten die niet meer gekoppeld zijn maar deze week wel gebruikt.
  const ids = projects.map((p) => p.id);
  const linked = ids.length ? (await query(
    `SELECT pa.project_id, a.id, a.name, a.active, pa.budget_hours, pa.budget_amount,
            (SELECT coalesce(sum(e.hours * e.rate), 0) FROM time_entries e
              WHERE e.project_id = pa.project_id AND e.activity_id = a.id AND e.status IN ('approved', 'invoiced')) AS used_amount
       FROM project_activities pa JOIN activities a ON a.id = pa.activity_id
      WHERE pa.project_id = ANY($1)
      ORDER BY a.name`,
    [ids]
  )).rows : [];
  const usedIds = [...new Set(entries.filter((e) => e.activity_id).map((e) => e.activity_id))];
  const used = usedIds.length
    ? (await query('SELECT id, name FROM activities WHERE id = ANY($1)', [usedIds])).rows : [];
  for (const p of projects) {
    p.activities = linked.filter((a) => a.project_id === p.id)
      .map(({ id, name, active, budget_hours: budgetHours, budget_amount: budgetAmount, used_amount: usedAmount }) => ({
        id, name, active, budget_hours: budgetHours, budget_amount: budgetAmount, used_amount: usedAmount,
      }));
    for (const e of entries.filter((x) => x.project_id === p.id && x.activity_id)) {
      if (!p.activities.some((a) => a.id === e.activity_id)) {
        const a = used.find((x) => x.id === e.activity_id);
        if (a) p.activities.push({ id: a.id, name: a.name, active: false });
      }
    }
  }

  // Verbruik (alle medewerkers, alle tijd) voor de budgetweergave per regel.
  const usage = ids.length ? (await query(
    `SELECT project_id, COALESCE(activity_id, 0) AS activity_id, sum(hours) AS used
       FROM time_entries WHERE project_id = ANY($1) GROUP BY 1, 2`,
    [ids]
  )).rows : [];
  for (const p of projects) {
    const rows = usage.filter((u) => u.project_id === p.id);
    p.used_hours = rows.reduce((s, u) => s + u.used, 0);
    for (const a of p.activities) a.used_hours = (rows.find((u) => u.activity_id === a.id) || {}).used || 0;
  }

  // Ingehuurde zzp'ers zien alleen de projecten en activiteiten uit hun vrijgegeven opdracht
  // (plus wat er in deze periode al geschreven is).
  const access = await hoursAccess(uid);
  const scope = scopeFor(access, start, end);
  if (scope) {
    const usedProjects = new Set(entries.map((e) => e.project_id));
    for (let i = projects.length - 1; i >= 0; i -= 1) {
      const p = projects[i];
      const allowed = scope.get(p.id);
      if (!allowed && !usedProjects.has(p.id)) { projects.splice(i, 1); continue; }
      if (allowed && allowed !== 'all') {
        const usedActs = new Set(entries.filter((e) => e.project_id === p.id).map((e) => e.activity_id));
        p.activities = p.activities.filter((a) => allowed.has(a.id) || usedActs.has(a.id));
      }
    }
  }

  // Regels van vorige week, zodat dezelfde project/activiteit-combinaties terugkomen.
  const recent = (await query(
    `SELECT DISTINCT project_id, activity_id FROM time_entries
      WHERE user_id = $1 AND work_date BETWEEN $2 AND $3`,
    [uid, addDays(start, -7), addDays(start, -1)]
  )).rows;

  res.json({
    period,
    week_start: start,
    week_end: end,
    days: daysBetween(start, end),
    projects,
    entries,
    recent,
    weekly_hours: req.user.weekly_hours,
    // Ingehuurde zzp'ers: in welke periodes mag er geschreven worden (vrijgegeven inhuurdossiers).
    onboarding: access,
  });
}));

r.put('/entry', ah(async (req, res) => {
  const uid = req.user.id;
  const projectId = intParam(req.body.project_id, 'project');
  const activityId = req.body.activity_id ? intParam(req.body.activity_id, 'activiteit') : null;
  const workDate = isoDate(req.body.work_date);
  const hours = num(req.body.hours === '' || req.body.hours == null ? 0 : req.body.hours, {
    min: 0, max: 24, name: 'aantal uren',
  });
  const description = str(req.body.description, { name: 'Omschrijving', max: 1000, required: false });
  // Interne notitie: alleen wijzigen als die is meegestuurd (anders blijft de bestaande staan).
  const noteGiven = req.body.internal_note !== undefined;
  const note = noteGiven ? (str(req.body.internal_note, { name: 'Interne notitie', max: 1000, required: false }) || null) : null;

  const assigned = await query(
    `SELECT 1 FROM projects p JOIN assignments a ON a.project_id = p.id AND a.user_id = $2
      WHERE p.id = $1 AND p.active`,
    [projectId, uid]
  );
  if (!assigned.rowCount) throw new HttpError(403, 'Je bent niet (meer) aan dit project gekoppeld');

  const existing = (await query(
    `SELECT id, status FROM time_entries
      WHERE user_id = $1 AND project_id = $2 AND COALESCE(activity_id, 0) = $3 AND work_date = $4`,
    [uid, projectId, activityId || 0, workDate]
  )).rows[0];
  if (existing && !['draft', 'rejected'].includes(existing.status)) {
    throw new HttpError(409, 'Deze uren zijn al ingediend of goedgekeurd en kunnen niet meer worden gewijzigd');
  }

  if (hours === 0) {
    if (existing) await query('DELETE FROM time_entries WHERE id = $1', [existing.id]);
    return res.json({ deleted: true });
  }

  // zzp'ers schrijven alleen uren binnen een vrijgegeven opdracht.
  await assertHoursAllowed(uid, workDate, projectId, activityId);

  if (!existing) {
    const linked = (await query(
      `SELECT pa.activity_id, a.active FROM project_activities pa JOIN activities a ON a.id = pa.activity_id
        WHERE pa.project_id = $1`,
      [projectId]
    )).rows;
    if (activityId) {
      const l = linked.find((x) => x.activity_id === activityId);
      if (!l || !l.active) throw new HttpError(400, 'Deze activiteit hoort niet (meer) bij dit project');
    } else if (linked.some((x) => x.active)) {
      throw new HttpError(400, 'Kies een activiteit voor dit project');
    }
  }

  const dayTotal = (await query(
    `SELECT coalesce(sum(hours), 0) AS total FROM time_entries
      WHERE user_id = $1 AND work_date = $2 AND NOT (project_id = $3 AND COALESCE(activity_id, 0) = $4)`,
    [uid, workDate, projectId, activityId || 0]
  )).rows[0].total;
  if (dayTotal + hours > 24) throw new HttpError(400, 'Meer dan 24 uur op één dag kan niet');

  const { rows } = await query(
    `INSERT INTO time_entries (user_id, project_id, activity_id, work_date, hours, description, internal_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text)
     ON CONFLICT (user_id, project_id, (COALESCE(activity_id, 0)), work_date) DO UPDATE
        SET hours = EXCLUDED.hours, description = EXCLUDED.description,
            internal_note = CASE WHEN $8::boolean THEN EXCLUDED.internal_note ELSE time_entries.internal_note END,
            status = 'draft', rejection_reason = NULL, updated_at = now()
      WHERE time_entries.status IN ('draft', 'rejected')
     RETURNING ${ENTRY_COLS}`,
    [uid, projectId, activityId, workDate, hours, description, note, noteGiven]
  );
  if (!rows[0]) throw new HttpError(409, 'Deze uren zijn intussen ingediend en kunnen niet meer worden gewijzigd');
  res.json(rows[0]);
}));

r.post('/submit', ah(async (req, res) => {
  const { start, end, period } = periodRange(req.body);
  const access = await hoursAccess(req.user.id);
  if (access.required) {
    const open = (await query(
      `SELECT work_date, project_id, activity_id FROM time_entries
        WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 AND status IN ('draft', 'rejected') ORDER BY work_date`,
      [req.user.id, start, end]
    )).rows;
    const bad = open.find((e) => !allowedWork(access, e.work_date, e.project_id, e.activity_id));
    if (bad) {
      const err = new HttpError(403, `${gateMessage(access, bad.work_date)} Verwijder die uren (${bad.work_date}) voordat je indient.`);
      err.code = 'ONBOARDING_REQUIRED';
      throw err;
    }
  }
  // "Wat heb je gedaan?" is verplicht op declarabele projecten: die tekst komt op de factuur.
  const missing = (await query(
    `SELECT e.work_date, p.name AS project_name FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE e.user_id = $1 AND e.work_date BETWEEN $2 AND $3 AND e.status IN ('draft', 'rejected')
        AND p.billable AND btrim(e.description) = ''
      ORDER BY e.work_date, p.name`,
    [req.user.id, start, end]
  )).rows;
  if (missing.length) {
    const first = missing[0];
    const err = new HttpError(400, `${missing.length === 1 ? 'Eén regel heeft' : `${missing.length} regels hebben`} nog geen omschrijving `
      + `(bijvoorbeeld ${first.project_name} op ${first.work_date.split('-').reverse().join('-')}). Vul bij elke regel in wat je hebt gedaan; dat komt op de factuur.`);
    err.code = 'DESCRIPTION_REQUIRED';
    throw err;
  }
  const { rowCount } = await query(
    `UPDATE time_entries SET status = 'submitted', rejection_reason = NULL, updated_at = now()
      WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 AND status IN ('draft', 'rejected')`,
    [req.user.id, start, end]
  );
  if (!rowCount) throw new HttpError(400, `Er zijn deze ${period === 'month' ? 'maand' : 'week'} geen uren om in te dienen`);
  res.json({ submitted: rowCount });
}));

r.post('/recall', ah(async (req, res) => {
  const { start, end, period } = periodRange(req.body);
  const { rowCount } = await query(
    `UPDATE time_entries SET status = 'draft', updated_at = now()
      WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 AND status = 'submitted'`,
    [req.user.id, start, end]
  );
  if (!rowCount) throw new HttpError(400, `Er zijn deze ${period === 'month' ? 'maand' : 'week'} geen ingediende uren om terug te halen`);
  res.json({ recalled: rowCount });
}));

module.exports = r;
