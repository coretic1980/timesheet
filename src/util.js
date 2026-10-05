class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Laat async route-handlers fouten doorgeven aan de error-middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value, name = 'datum') {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new HttpError(400, `Ongeldige ${name}`);
  }
  return value;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  // Datum in Nederlandse tijd, ook als de server in UTC draait.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

function weekRange(iso) {
  const day = isoDate(iso, 'week');
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // maandag = 0
  const start = addDays(day, -dow);
  return { start, end: addDays(start, 6) };
}

function workdaysBetween(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

function num(value, { min = -Infinity, max = Infinity, name = 'waarde', allowNull = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new HttpError(400, `${name} ontbreekt`);
  }
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Ongeldige ${name}`);
  return Math.round(n * 100) / 100;
}

function str(value, { name = 'veld', max = 500, required = true } = {}) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (required && !v) throw new HttpError(400, `${name} is verplicht`);
  if (v.length > max) throw new HttpError(400, `${name} is te lang (max. ${max} tekens)`);
  return v;
}

function intParam(value, name = 'id') {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Ongeldige ${name}`);
  return n;
}

function idList(value) {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'Geen regels geselecteerd');
  return value.map((v) => intParam(v));
}

function fmtDateNl(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Namen vergelijken zonder hoofdletters, leestekens en rechtsvorm: "Aiden Netherlands B.V." = "aiden netherlands bv".
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(bv|nv|vof)$/, '');

module.exports = {
  HttpError, ah, isoDate, addDays, todayIso, weekRange, workdaysBetween,
  num, str, intParam, idList, fmtDateNl, round2, normName,
};
