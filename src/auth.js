const crypto = require('crypto');
const { query } = require('./db');
const { HttpError } = require('./util');

const COOKIE = 'sid';
const MAX_AGE_DAYS = 30;

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* ongeldige cookie negeren */ }
  }
  return out;
}

// pendingMfa: sessie na het wachtwoord, nog zonder 2FA-code. Tien minuten geldig en geeft geen toegang.
async function createSession(res, userId, { pendingMfa = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token, user_id, expires_at, pending_mfa)
     VALUES ($1, $2, now() + ($3::int * interval '1 minute'), $4)`,
    [hashToken(token), userId, pendingMfa ? 10 : MAX_AGE_DAYS * 24 * 60, pendingMfa]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE_DAYS * 86400000,
    path: '/',
  });
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token = $1', [hashToken(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

// Beheerders moeten tweestapsverificatie gebruiken (uit te zetten met MFA_REQUIRED_FOR_ADMINS=false).
const mfaRequired = (u) => u.role === 'admin' && process.env.MFA_REQUIRED_FOR_ADMINS !== 'false';

async function loadUser(req, res, next) {
  try {
    req.user = null;
    req.pendingUser = null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const { rows } = await query(
        `SELECT u.id, u.email, u.name, u.role, u.weekly_hours, u.totp_enabled, s.pending_mfa, s.mfa_attempts, s.token AS session_hash
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = $1 AND s.expires_at > now() AND u.active`,
        [hashToken(token)]
      );
      const row = rows[0];
      if (row && row.pending_mfa) req.pendingUser = row;
      else if (row) {
        const { pending_mfa: _p, mfa_attempts: _a, session_hash: sessionHash, ...user } = row;
        req.sessionHash = sessionHash;
        user.mfa_setup_required = mfaRequired(user) && !user.totp_enabled;
        req.user = user;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Niet ingelogd')));

// Blokkeert alles behalve de auth-routes zolang een beheerder 2FA nog niet heeft ingesteld.
function enforceMfaSetup(req, res, next) {
  if (req.user && req.user.mfa_setup_required) {
    const err = new HttpError(403, 'Stel eerst tweestapsverificatie in');
    err.code = 'MFA_SETUP_REQUIRED';
    return next(err);
  }
  next();
}

// Sessie na het 2FA-codescherm omzetten naar een volwaardige sessie.
async function upgradeSession(sessionHash) {
  await query(
    `UPDATE sessions SET pending_mfa = FALSE, mfa_attempts = 0,
            expires_at = now() + ($2::int * interval '1 day') WHERE token = $1`,
    [sessionHash, MAX_AGE_DAYS]
  );
}

const requireAdmin = (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Niet ingelogd'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Alleen voor beheerders'));
  next();
};

// Mutaties moeten een custom header meesturen. Andere sites kunnen die niet
// zetten zonder CORS-preflight, en die staan we niet toe.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'fetch') return next(new HttpError(403, 'Ongeldig verzoek'));
  next();
}

// Eenvoudige rem op inlogpogingen per IP.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;

function loginLimiter(req, res, next) {
  const a = attempts.get(req.ip);
  if (a && a.reset > Date.now() && a.count >= 10) {
    return next(new HttpError(429, 'Te veel inlogpogingen. Probeer het over een kwartier opnieuw.'));
  }
  next();
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) attempts.set(ip, { count: 1, reset: now + WINDOW });
  else a.count += 1;
}

const clearLoginFailures = (ip) => attempts.delete(ip);

async function cleanupSessions() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
}

module.exports = {
  createSession, destroySession, loadUser, requireAuth, requireAdmin, csrfGuard,
  enforceMfaSetup, upgradeSession, mfaRequired,
  loginLimiter, recordLoginFailure, clearLoginFailures, cleanupSessions,
};
