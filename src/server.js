const path = require('path');
const express = require('express');
const { migrate, seedAdmin, pool } = require('./db');
const { loadUser, requireAuth, requireAdmin, csrfGuard, cleanupSessions } = require('./auth');
const { HttpError } = require('./util');
const { EbError } = require('./eboekhouden');

const app = express();
app.set('trust proxy', 1); // Render zet een proxy voor de app
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
      + "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', express.json({ limit: '1mb' }), csrfGuard, loadUser);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/timesheet', requireAuth, require('./routes/timesheet'));
app.use('/api/approvals', requireAdmin, require('./routes/approvals'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));
app.use('/api/invoicing', requireAdmin, require('./routes/invoicing'));
app.use('/api/reports', requireAdmin, require('./routes/reports'));
app.use('/api', (req, res, next) => next(new HttpError(404, 'Onbekend endpoint')));

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof EbError) {
    console.warn('e-Boekhouden:', err.status, err.message, err.body ? JSON.stringify(err.body) : '');
    return res.status(502).json({ error: `e-Boekhouden: ${err.message}`, details: err.body || null });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ongeldige JSON' });
  console.error(err);
  res.status(500).json({ error: 'Er ging iets mis op de server' });
});

(async () => {
  await migrate();
  await seedAdmin();
  setInterval(() => cleanupSessions().catch((e) => console.error(e)), 6 * 60 * 60 * 1000).unref();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Coretic uren draait op poort ${port}`));
})().catch((err) => {
  console.error('Opstarten mislukt:', err);
  process.exit(1);
});
