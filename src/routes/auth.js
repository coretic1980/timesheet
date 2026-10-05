const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { ah, HttpError, str } = require('../util');
const {
  createSession, destroySession, requireAuth, loginLimiter, recordLoginFailure, clearLoginFailures,
  upgradeSession, mfaRequired,
} = require('../auth');
const mfa = require('../mfa');

const r = express.Router();

// Dummy-hash zodat een onbekend e-mailadres net zo lang duurt als een fout wachtwoord.
const DUMMY_HASH = bcrypt.hashSync('niet-bestaand-account', 12);
const MAX_MFA_ATTEMPTS = 5;

async function publicUser(id) {
  const { rows } = await query('SELECT id, email, name, role, weekly_hours, totp_enabled FROM users WHERE id = $1', [id]);
  const u = rows[0];
  u.mfa_setup_required = mfaRequired(u) && !u.totp_enabled;
  u.mfa_required_for_role = mfaRequired(u);
  return u;
}

/* ---------- Stap 1: wachtwoord ---------- */

r.post('/login', loginLimiter, ah(async (req, res) => {
  const email = str(req.body.email, { name: 'E-mail', max: 200 }).toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await query('SELECT id, password_hash, totp_enabled FROM users WHERE email = $1 AND active', [email]);
  const ok = await bcrypt.compare(password, rows[0] ? rows[0].password_hash : DUMMY_HASH);
  if (!rows[0] || !ok) {
    recordLoginFailure(req.ip);
    throw new HttpError(401, 'E-mailadres of wachtwoord klopt niet');
  }
  if (rows[0].totp_enabled) {
    // Nog geen toegang: eerst de code uit de authenticator-app.
    await createSession(res, rows[0].id, { pendingMfa: true });
    return res.json({ mfa_required: true });
  }
  clearLoginFailures(req.ip);
  await createSession(res, rows[0].id);
  res.json(await publicUser(rows[0].id));
}));

/* ---------- Stap 2: code uit de app of herstelcode ---------- */

r.post('/mfa/verify', loginLimiter, ah(async (req, res) => {
  const pending = req.pendingUser;
  if (!pending) throw new HttpError(401, 'Log opnieuw in');
  const { rows } = await query('SELECT totp_secret, totp_last_step, recovery_codes FROM users WHERE id = $1', [pending.id]);
  const u = rows[0];
  const code = String(req.body.code || '').trim();
  let ok = false;
  let usedRecovery = false;

  if (/^\d{6}$/.test(code.replace(/\s/g, '')) && u.totp_secret) {
    const step = mfa.verifyTotp(mfa.decrypt(u.totp_secret), code, u.totp_last_step === null ? null : Number(u.totp_last_step));
    if (step !== null) {
      ok = true;
      await query('UPDATE users SET totp_last_step = $1 WHERE id = $2', [step, pending.id]);
    }
  } else if (code) {
    const h = mfa.hashCode(code);
    if ((u.recovery_codes || []).includes(h)) {
      ok = true;
      usedRecovery = true;
      await query('UPDATE users SET recovery_codes = array_remove(recovery_codes, $1) WHERE id = $2', [h, pending.id]);
    }
  }

  if (!ok) {
    recordLoginFailure(req.ip);
    const attempts = pending.mfa_attempts + 1;
    if (attempts >= MAX_MFA_ATTEMPTS) {
      await query('DELETE FROM sessions WHERE token = $1', [pending.session_hash]);
      throw new HttpError(401, 'Te veel onjuiste codes. Log opnieuw in.');
    }
    await query('UPDATE sessions SET mfa_attempts = $1 WHERE token = $2', [attempts, pending.session_hash]);
    throw new HttpError(400, 'De code klopt niet. Controleer of de tijd op je telefoon goed staat.');
  }

  clearLoginFailures(req.ip);
  await upgradeSession(pending.session_hash);
  const user = await publicUser(pending.id);
  if (usedRecovery) {
    const left = (await query('SELECT coalesce(array_length(recovery_codes, 1), 0) AS n FROM users WHERE id = $1', [pending.id])).rows[0].n;
    user.recovery_codes_left = left;
  }
  res.json(user);
}));

r.post('/logout', ah(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

r.get('/me', (req, res) => {
  if (req.user) return res.json(req.user);
  if (req.pendingUser) return res.status(401).json({ error: 'Vul de code uit je authenticator-app in', mfa_required: true });
  return res.status(401).json({ error: 'Niet ingelogd' });
});

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

/* ---------- Instellen en beheren ---------- */

// Nieuwe geheime sleutel klaarzetten (nog niet actief tot de eerste code klopt).
r.post('/mfa/setup', requireAuth, ah(async (req, res) => {
  const secret = mfa.newSecret();
  await query('UPDATE users SET totp_pending_secret = $1 WHERE id = $2', [mfa.encrypt(secret), req.user.id]);
  res.json({ secret, otpauth: mfa.otpauthUrl(secret, req.user.email) });
}));

r.post('/mfa/enable', requireAuth, ah(async (req, res) => {
  const { rows } = await query('SELECT totp_pending_secret FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0].totp_pending_secret) throw new HttpError(400, 'Start het instellen opnieuw');
  const secret = mfa.decrypt(rows[0].totp_pending_secret);
  const step = mfa.verifyTotp(secret, req.body.code);
  if (step === null) throw new HttpError(400, 'De code klopt niet. Controleer of de tijd op je telefoon goed staat en probeer de volgende code.');
  const codes = mfa.newRecoveryCodes();
  await query(
    `UPDATE users SET totp_enabled = TRUE, totp_secret = $1, totp_pending_secret = NULL, totp_last_step = $2,
            recovery_codes = $3 WHERE id = $4`,
    [mfa.encrypt(secret), step, codes.map(mfa.hashCode), req.user.id]
  );
  // Andere sessies van deze gebruiker afmelden; de huidige blijft geldig.
  await query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user.id, req.sessionHash]);
  res.json({ recovery_codes: codes, user: await publicUser(req.user.id) });
}));

async function checkCurrentCode(userId, code) {
  const { rows } = await query('SELECT totp_secret, totp_last_step FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  const step = u.totp_secret
    ? mfa.verifyTotp(mfa.decrypt(u.totp_secret), code, u.totp_last_step === null ? null : Number(u.totp_last_step))
    : null;
  if (step === null) throw new HttpError(400, 'De code klopt niet');
  await query('UPDATE users SET totp_last_step = $1 WHERE id = $2', [step, userId]);
}

r.post('/mfa/recovery-codes', requireAuth, ah(async (req, res) => {
  await checkCurrentCode(req.user.id, req.body.code);
  const codes = mfa.newRecoveryCodes();
  await query('UPDATE users SET recovery_codes = $1 WHERE id = $2', [codes.map(mfa.hashCode), req.user.id]);
  res.json({ recovery_codes: codes });
}));

r.post('/mfa/disable', requireAuth, ah(async (req, res) => {
  if (mfaRequired(req.user)) throw new HttpError(400, 'Voor beheerders is tweestapsverificatie verplicht');
  await checkCurrentCode(req.user.id, req.body.code);
  await query(
    `UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL,
            recovery_codes = NULL WHERE id = $1`,
    [req.user.id]
  );
  res.json(await publicUser(req.user.id));
}));

r.get('/mfa/status', requireAuth, ah(async (req, res) => {
  const { rows } = await query(
    'SELECT totp_enabled, coalesce(array_length(recovery_codes, 1), 0) AS recovery_left FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json({ ...rows[0], required: mfaRequired(req.user) });
}));

module.exports = r;
