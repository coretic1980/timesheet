// Client voor de e-Boekhouden REST API (https://api.e-boekhouden.nl, OpenAPI v1).
// Het API-token (Beheer > API-tokens, type "e-Boekhouden API", niet SOAP) wordt
// omgewisseld voor een kortlevend sessietoken via POST /v1/session.

const BASE = (process.env.EB_API_BASE || 'https://api.e-boekhouden.nl').replace(/\/$/, '');
const SOURCE = (process.env.EB_SOURCE || 'Coretic').slice(0, 10);

class EbError extends Error {
  constructor(status, body) {
    let message = (body && (body.message || body.title)) || `e-Boekhouden gaf status ${status}`;
    if (body && body.errors && typeof body.errors === 'object') {
      const details = Object.entries(body.errors)
        .map(([field, msgs]) => `${field}: ${[].concat(msgs).join(', ')}`)
        .join('; ');
      if (details) message += ` (${details})`;
    }
    if (body && body.code) message = `${body.code}: ${message}`;
    super(message);
    this.status = status;
    this.code = body && body.code;
    this.body = body;
  }
}

let session = null; // { token, expires }
let authStyle = 'Bearer'; // valt terug op kaal token als de API dat verlangt

const configured = () => Boolean(process.env.EB_API_TOKEN);

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

async function startSession() {
  if (!configured()) throw new EbError(0, { message: 'EB_API_TOKEN is niet ingesteld op de server' });
  const res = await fetch(`${BASE}/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: process.env.EB_API_TOKEN, source: SOURCE }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new EbError(res.status, body);
  const token = body && (body.token || body.sessionToken || body.accessToken);
  if (!token) throw new EbError(res.status, { message: 'Geen sessietoken ontvangen van e-Boekhouden' });
  const ttl = Number(body.expiresIn) > 0 ? Number(body.expiresIn) * 1000 : 30 * 60 * 1000;
  session = { token, expires: Date.now() + ttl - 60 * 1000 };
  return session.token;
}

async function request(method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const send = async (style) => {
    if (!session || session.expires < Date.now()) await startSession();
    return fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: style === 'Bearer' ? `Bearer ${session.token}` : session.token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let res = await send(authStyle);
  if (res.status === 401) {
    // Sessie verlopen: nieuwe sessie, en zo nodig de andere header-vorm proberen.
    session = null;
    res = await send(authStyle);
    if (res.status === 401) {
      const alt = authStyle === 'Bearer' ? 'Raw' : 'Bearer';
      const retry = await send(alt);
      if (retry.status !== 401) authStyle = alt;
      res = retry;
    }
  }
  const data = await readJson(res);
  if (!res.ok) throw new EbError(res.status, data);
  return data;
}

async function listAll(path, query = {}) {
  const limit = 2000;
  const all = [];
  for (let offset = 0, page = 0; page < 25; page += 1, offset += limit) {
    const data = await request('GET', path, { query: { ...query, limit, offset } });
    const items = Array.isArray(data) ? data : (data && data.items) || [];
    all.push(...items);
    if (items.length < limit) break;
  }
  return all;
}

async function testConnection() {
  session = null;
  await startSession();
  await request('GET', '/v1/ledger', { query: { limit: 1 } });
  return true;
}

async function findRelationByCode(code) {
  const data = await request('GET', '/v1/relation', { query: { code, limit: 25 } });
  const items = (data && data.items) || [];
  const wanted = String(code).trim().toLowerCase();
  return items.find((r) => String(r.code || '').toLowerCase() === wanted) || null;
}

// Alle relaties, met naam. De lijst-endpoint geeft niet altijd de naam mee;
// in dat geval halen we de details per relatie op. Vijf minuten gecachet.
let relationCache = null;
async function relations({ fresh = false } = {}) {
  if (!fresh && relationCache && relationCache.at > Date.now() - 5 * 60 * 1000) return relationCache.items;
  const list = await listAll('/v1/relation');
  const missing = list.filter((r) => !r.name).slice(0, 500);
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(missing.slice(i, i + 5).map(async (r) => {
      try {
        const d = await request('GET', `/v1/relation/${r.id}`);
        if (d) Object.assign(r, { name: d.name, inactive: d.inactive, type: d.type || r.type });
      } catch { /* naam blijft leeg; we vallen terug op de code */ }
    }));
  }
  const items = list.map((r) => ({
    id: r.id,
    code: r.code || '',
    name: r.name || r.code || `Relatie ${r.id}`,
    type: r.type || '',
    inactive: Boolean(r.inactive),
  })).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  relationCache = { at: Date.now(), items };
  return items;
}

module.exports = {
  relations,
  EbError,
  configured,
  request,
  testConnection,
  ledgers: () => listAll('/v1/ledger'),
  invoiceTemplates: () => listAll('/v1/invoicetemplate'),
  units: () => listAll('/v1/unit'),
  emailTemplates: () => listAll('/v1/emailtemplate'),
  invoices: () => listAll('/v1/invoice'),
  findRelationByCode,
  getRelation: (id) => request('GET', `/v1/relation/${id}`),
  createRelation: (body) => request('POST', '/v1/relation', { body }),
  createInvoice: (body) => request('POST', '/v1/invoice', { body }),
  getInvoice: (id) => request('GET', `/v1/invoice/${id}`),
};
