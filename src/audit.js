const { query } = require('./db');

// Legt een financieel relevante handeling vast in het logboek dat de accountant kan inzien.
// db: een transactie-client (zodat de regel alleen blijft staan als de handeling slaagt) of niets.
async function audit(db, userId, action, summary, details = null) {
  const run = db ? (sql, p) => db.query(sql, p) : query;
  await run(
    'INSERT INTO audit_log (user_id, action, summary, details) VALUES ($1, $2, $3, $4::jsonb)',
    [userId || null, action, String(summary).slice(0, 500), details ? JSON.stringify(details) : null]
  );
}

const fhNl = (n) => String(Math.round((Number(n) || 0) * 100) / 100).replace('.', ',');
const regels = (n) => `${n} ${n === 1 ? 'regel' : 'regels'}`;

module.exports = { audit, fhNl, regels };
