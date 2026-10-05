const express = require('express');
const { query } = require('../db');
const { ah, HttpError, isoDate, workdaysBetween, todayIso, round2 } = require('../util');

const r = express.Router();

function period(q) {
  const from = isoDate(q.from, 'begindatum');
  const to = isoDate(q.to, 'einddatum');
  if (from > to) throw new HttpError(400, 'Begindatum ligt na de einddatum');
  return { from, to };
}

r.get('/summary', ah(async (req, res) => {
  const { from, to } = period(req.query);

  const byUser = (await query(
    `SELECT u.id, u.name, u.weekly_hours,
            coalesce(sum(e.hours), 0) AS hours,
            coalesce(sum(e.hours) FILTER (WHERE p.billable), 0) AS billable_hours,
            coalesce(sum(e.hours) FILTER (WHERE e.status IN ('draft', 'rejected')), 0) AS draft_hours,
            coalesce(sum(e.hours) FILTER (WHERE e.status = 'submitted'), 0) AS submitted_hours
       FROM users u
       LEFT JOIN time_entries e ON e.user_id = u.id AND e.work_date BETWEEN $1 AND $2
       LEFT JOIN projects p ON p.id = e.project_id
      WHERE u.active
      GROUP BY u.id
      ORDER BY u.name`,
    [from, to]
  )).rows;

  // Beschikbaarheid alleen tot en met vandaag, anders lijkt een lopende maand onderbezet.
  const until = to < todayIso() ? to : todayIso();
  const workdays = from <= until ? workdaysBetween(from, until) : 0;
  for (const u of byUser) {
    u.available_hours = round2((u.weekly_hours / 5) * workdays);
    u.utilization = u.available_hours > 0 ? round2(u.billable_hours / u.available_hours) : null;
  }

  const byProject = (await query(
    `SELECT p.id, p.name, p.code, p.billable, p.active, p.budget_hours, c.name AS client_name,
            coalesce(sum(e.hours) FILTER (WHERE e.work_date BETWEEN $1 AND $2), 0) AS hours,
            coalesce(sum(e.hours) FILTER (WHERE e.work_date BETWEEN $1 AND $2
                                            AND e.status IN ('approved', 'invoiced')), 0) AS approved_hours,
            coalesce(sum(e.hours * e.rate) FILTER (WHERE e.work_date BETWEEN $1 AND $2
                                            AND e.status IN ('approved', 'invoiced')), 0) AS value,
            coalesce(sum(e.hours), 0) AS hours_all_time
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN time_entries e ON e.project_id = p.id
      GROUP BY p.id, c.name
     HAVING p.active OR coalesce(sum(e.hours) FILTER (WHERE e.work_date BETWEEN $1 AND $2), 0) > 0
      ORDER BY c.name NULLS LAST, p.name`,
    [from, to]
  )).rows.map((p) => ({ ...p, value: round2(p.value) }));

  const byActivity = (await query(
    `SELECT p.id AS project_id, p.name AS project_name, p.active, c.name AS client_name,
            a.id AS activity_id, a.name AS activity_name, pa.budget_hours, pa.budget_amount,
            coalesce(sum(e.hours) FILTER (WHERE e.work_date BETWEEN $1 AND $2), 0) AS hours,
            coalesce(sum(e.hours), 0) AS hours_all_time,
            coalesce(sum(e.hours * e.rate) FILTER (WHERE e.status IN ('approved', 'invoiced')), 0) AS value_all_time
       FROM project_activities pa
       JOIN projects p ON p.id = pa.project_id
       JOIN activities a ON a.id = pa.activity_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN time_entries e ON e.project_id = pa.project_id AND e.activity_id = pa.activity_id
      WHERE pa.budget_hours IS NOT NULL OR pa.budget_amount IS NOT NULL
      GROUP BY p.id, c.name, a.id, pa.budget_hours, pa.budget_amount
      ORDER BY c.name NULLS LAST, p.name, a.name`,
    [from, to]
  )).rows.map((x) => ({ ...x, value_all_time: round2(x.value_all_time) }));

  res.json({ from, to, workdays, byUser, byProject, byActivity });
}));

const STATUS_NL = {
  draft: 'Concept', submitted: 'Ingediend', approved: 'Goedgekeurd', rejected: 'Afgekeurd', invoiced: 'Gefactureerd',
};

r.get('/export.csv', ah(async (req, res) => {
  const { from, to } = period(req.query);
  const { rows } = await query(
    `SELECT e.work_date, u.name AS user_name, c.name AS client_name, p.code, p.name AS project_name,
            ac.name AS activity_name, e.hours, e.rate, e.status, e.description, i.eb_invoice_number
       FROM time_entries e
       JOIN users u ON u.id = e.user_id
       JOIN projects p ON p.id = e.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN activities ac ON ac.id = e.activity_id
       LEFT JOIN invoices i ON i.id = e.invoice_id
      WHERE e.work_date BETWEEN $1 AND $2
      ORDER BY e.work_date, u.name, p.name`,
    [from, to]
  );
  // Puntkomma en decimale komma, zodat Nederlandse Excel het direct goed opent.
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Datum', 'Medewerker', 'Klant', 'Projectcode', 'Project', 'Activiteit', 'Uren', 'Tarief', 'Status', 'Omschrijving', 'Factuur'];
  const lines = rows.map((x) => [
    x.work_date, x.user_name, x.client_name || 'Intern', x.code, x.project_name, x.activity_name, x.hours, x.rate,
    STATUS_NL[x.status], x.description, x.eb_invoice_number,
  ].map(cell).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="uren_${from}_${to}.csv"`);
  res.send(`\uFEFF${header.join(';')}\r\n${lines.join('\r\n')}\r\n`);
}));

module.exports = r;
