const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { ah, HttpError, str } = require('../util');
const {
  createSession, destroySession, requireAuth, loginLimiter, recordLoginFailure, clearLoginFailures,
} = require('../auth');

const r = express.Router();

// Dummy-hash zodat een onbekend e-mailadres net zo lang duurt als een fout wachtwoord.
const DUMMY_HASH = bcrypt.hashSync('niet-bestaand-account', 12);

r.post('/login', loginLimiter, ah(async (req, res) => {
  const email = str(req.body.email, { name: 'E-mail', max: 200 }).toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await query('SELECT id, password_hash FROM users WHERE email = $1 AND active', [email]);
  const ok = await bcrypt.compare(password, rows[0] ? rows[0].password_hash : DUMMY_HASH);
  if (!rows[0] || !ok) {
    recordLoginFailure(req.ip);
    throw new HttpError(401, 'E-mailadres of wachtwoord klopt niet');
  }
  clearLoginFailures(req.ip);
  await createSession(res, rows[0].id);
  const me = await query('SELECT id, email, name, role, weekly_hours FROM users WHERE id = $1', [rows[0].id]);
  res.json(me.rows[0]);
}));

r.post('/logout', ah(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

r.get('/me', requireAuth, (req, res) => res.json(req.user));

r.post('/password', requireAuth, ah(async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  if (next.length < 10) throw new HttpError(400, 'Nieuw wachtwoord moet minstens 10 tekens zijn');
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, 'Huidig wachtwoord klopt niet');
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 12), req.user.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
  await createSession(res, req.user.id);
  res.json({ ok: true });
}));

module.exports = r;
