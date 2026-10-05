const express = require('express');
const { query } = require('../db');
const {
  ah, HttpError, isoDate, addDays, todayIso, weekRange, num, str, intParam,
} = require('../util');

const r = express.Router();

const ENTRY_COLS = 'id, project_id, work_date, hours, description, status, rejection_reason';

r.get('/', ah(async (req, res) => {
  const { start, end } = weekRange(req.query.week || todayIso());
  const uid = req.user.id;

  const projects = await query(
    `SELECT p.id, p.name, p.code, p.billable, p.active, c.name AS client_name
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
      WHERE (p.active AND EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id AND a.user_id = $1))
         OR p.id IN (SELECT project_id FROM time_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3)
      ORDER BY c.name NULLS LAST, p.name`,
    [uid, start, end]
  );
  const entries = await query(
    `SELECT ${ENTRY_COLS} FROM time_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3`,
    [uid, start, end]
  );

  res.json({
    week_start: start,
    week_end: end,
    days: Array.from({ length: 7 }, (_, i) => addDays(start, i)),
    projects: projects.rows,
    entries: entries.rows,
    weekly_hours: req.user.weekly_hours,
  });
}));

r.put('/entry', ah(async (req, res) => {
  const uid = req.user.id;
  const projectId = intParam(req.body.project_id, 'project');
  const workDate = isoDate(req.body.work_date);
  const hours = num(req.body.hours === '' || req.body.hours == null ? 0 : req.body.hours, {
    min: 0, max: 24, name: 'aantal uren',
  });
  const description = str(req.body.description, { name: 'Omschrijving', max: 1000, required: false });

  const assigned = await query(
    `SELECT 1 FROM projects p JOIN assignments a ON a.project_id = p.id AND a.user_id = $2
      WHERE p.id = $1 AND p.active`,
    [projectId, uid]
  );
  if (!assigned.rowCount) throw new HttpError(403, 'Je bent niet (meer) aan dit project gekoppeld');

  const existing = (await query(
    'SELECT id, status FROM time_entries WHERE user_id = $1 AND project_id = $2 AND work_date = $3',
    [uid, projectId, workDate]
  )).rows[0];
  if (existing && !['draft', 'rejected'].includes(existing.status)) {
    throw new HttpError(409, 'Deze uren zijn al ingediend of goedgekeurd en kunnen niet meer worden gewijzigd');
  }

  if (hours === 0) {
    if (existing) await query('DELETE FROM time_entries WHERE id = $1', [existing.id]);
    return res.json({ deleted: true, project_id: projectId, work_date: workDate });
  }

  const dayTotal = (await query(
    `SELECT coalesce(sum(hours), 0) AS total FROM time_entries
      WHERE user_id = $1 AND work_date = $2 AND project_id <> $3`,
    [uid, workDate, projectId]
  )).rows[0].total;
  if (dayTotal + hours > 24) throw new HttpError(400, 'Meer dan 24 uur op één dag kan niet');

  const { rows } = await query(
    `INSERT INTO time_entries (user_id, project_id, work_date, hours, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, project_id, work_date) DO UPDATE
        SET hours = EXCLUDED.hours, description = EXCLUDED.description,
            status = 'draft', rejection_reason = NULL, updated_at = now()
      WHERE time_entries.status IN ('draft', 'rejected')
     RETURNING ${ENTRY_COLS}`,
    [uid, projectId, workDate, hours, description]
  );
  if (!rows[0]) throw new HttpError(409, 'Deze uren zijn intussen ingediend en kunnen niet meer worden gewijzigd');
  res.json(rows[0]);
}));

r.post('/submit', ah(async (req, res) => {
  const { start, end } = weekRange(req.body.week);
  const { rowCount } = await query(
    `UPDATE time_entries SET status = 'submitted', rejection_reason = NULL, updated_at = now()
      WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 AND status IN ('draft', 'rejected')`,
    [req.user.id, start, end]
  );
  if (!rowCount) throw new HttpError(400, 'Er zijn deze week geen uren om in te dienen');
  res.json({ submitted: rowCount });
}));

r.post('/recall', ah(async (req, res) => {
  const { start, end } = weekRange(req.body.week);
  const { rowCount } = await query(
    `UPDATE time_entries SET status = 'draft', updated_at = now()
      WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 AND status = 'submitted'`,
    [req.user.id, start, end]
  );
  if (!rowCount) throw new HttpError(400, 'Er zijn deze week geen ingediende uren om terug te halen');
  res.json({ recalled: rowCount });
}));

module.exports = r;
