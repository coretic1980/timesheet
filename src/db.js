const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// DATE als 'YYYY-MM-DD' (geen tijdzone-verschuivingen), NUMERIC en BIGINT als getal.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => parseInt(v, 10));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is niet ingesteld.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Versleuteld én certificaat gecontroleerd (Neon heeft geldige certificaten).
  // Alleen voor lokaal testen: DATABASE_SSL=false (geen TLS) of DATABASE_SSL=no-verify.
  ssl: process.env.DATABASE_SSL === 'false' ? false
    : { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' },
  max: Number(process.env.DATABASE_POOL_MAX || 5),
});

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* negeren */ }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function seedAdmin() {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('Er zijn nog geen gebruikers. Zet ADMIN_EMAIL en ADMIN_PASSWORD om de eerste beheerder aan te maken.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
    [email, process.env.ADMIN_NAME || 'Beheerder', hash]
  );
  console.log(`Eerste beheerder aangemaakt: ${email}`);
}

const EB_DEFAULTS = {
  templateId: null,
  revenueLedgerId: null,
  debtorLedgerId: null,
  unitId: null,
  vatCode: 'HOOG_VERK_21',
  termOfPayment: 30,
  process: true,
  lineMode: 'entry',                                   // 'entry' = één regel per uurregel, 'grouped' = samengevoegd
  lineFormat: '[DATUM] | [ACTIVITEIT] | [OPMERKING]',
  emailDefault: false,
  emailTemplateId: null,                               // e-mailsjabloon uit e-Boekhouden (leeg = eigen tekst)
  invoiceText: 'Factuur periode [MAAND]',
  numberPrefix: 'F',
  numberDigits: 5,
  printDefault: false,
  emailSubject: 'Factuur [KLANT] [PERIODE]',
  emailBody: 'Beste relatie,\n\nHierbij ontvangt u de factuur voor de uren over [PERIODE].\n\nMet vriendelijke groet,\nDVN Technology BV',
};

async function getEbSettings() {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'eb'`);
  return { ...EB_DEFAULTS, ...(rows[0] ? rows[0].value : {}) };
}

async function setEbSettings(value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ('eb', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)]
  );
}

module.exports = { pool, query, tx, migrate, seedAdmin, getEbSettings, setEbSettings };
