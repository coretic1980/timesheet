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

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3::int))`,
    [hashToken(token), userId, MAX_AGE_DAYS]
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

async function loadUser(req, res, next) {
  try {
    req.user = null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const { rows } = await query(
        `SELECT u.id, u.email, u.name, u.role, u.weekly_hours
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = $1 AND s.expires_at > now() AND u.active`,
        [hashToken(token)]
      );
      req.user = rows[0] || null;
    }
    next();
  } catch (err) {
    next(err);
  }
}

const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Niet ingelogd')));

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
  loginLimiter, recordLoginFailure, clearLoginFailures, cleanupSessions,
};
