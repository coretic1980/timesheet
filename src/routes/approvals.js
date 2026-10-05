const express = require('express');
const { query } = require('../db');
const { ah, HttpError, idList, str, isoDate, addDays, todayIso } = require('../util');

const r = express.Router();

r.get('/', ah(async (req, res) => {
  const status = ['submitted', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'submitted';
  const params = [status];
  let period = '';
  if (status !== 'submitted') {
    const to = req.query.to ? isoDate(req.query.to) : todayIso();
    const from = req.query.from ? isoDate(req.query.from) : addDays(to, -62);
    params.push(from, to);
    period = 'AND e.work_date BETWEEN $2 AND $3';
  }
  const { rows } = await query(
    `SELECT e.id, e.work_date, e.hours, e.description, e.status, e.rejection_reason, e.rate,
            u.id AS user_id, u.name AS user_name,
            p.id AS project_id, p.name AS project_name, p.billable, c.name AS client_name
       FROM time_entries e
       JOIN users u ON u.id = e.user_id
       JOIN projects p ON p.id = e.project_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE e.status = $1 ${period}
      ORDER BY u.name, e.work_date, c.name NULLS LAST, p.name`,
    params
  );
  res.json(rows);
}));

// Bij goedkeuring wordt het tarief vastgelegd: medewerkertarief op het project, anders projecttarief.
r.post('/approve', ah(async (req, res) => {
  const ids = idList(req.body.ids);
  const { rowCount } = await query(
    `UPDATE time_entries e
        SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now(),
            rate = COALESCE(
              (SELECT a.rate FROM assignments a WHERE a.project_id = e.project_id AND a.user_id = e.user_id),
              (SELECT p.default_rate FROM projects p WHERE p.id = e.project_id))
      WHERE e.id = ANY($1) AND e.status = 'submitted'`,
    [ids, req.user.id]
  );
  res.json({ approved: rowCount });
}));

r.post('/reject', ah(async (req, res) => {
  const ids = idList(req.body.ids);
  const reason = str(req.body.reason, { name: 'Reden', max: 500 });
  const { rowCount } = await query(
    `UPDATE time_entries SET status = 'rejected', rejection_reason = $2, updated_at = now()
      WHERE id = ANY($1) AND status = 'submitted'`,
    [ids, reason]
  );
  res.json({ rejected: rowCount });
}));

// Goedgekeurde (nog niet gefactureerde) uren terugzetten naar concept.
r.post('/reopen', ah(async (req, res) => {
  const ids = idList(req.body.ids);
  const { rowCount } = await query(
    `UPDATE time_entries
        SET status = 'draft', approved_by = NULL, approved_at = NULL, rate = NULL, updated_at = now()
      WHERE id = ANY($1) AND status IN ('approved', 'rejected') AND invoice_id IS NULL`,
    [ids]
  );
  if (!rowCount) throw new HttpError(400, 'Geen regels heropend; gefactureerde uren kunnen niet terug');
  res.json({ reopened: rowCount });
}));

module.exports = r;
