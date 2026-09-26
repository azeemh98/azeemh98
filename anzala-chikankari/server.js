// Anzala Chikankari — e-commerce store, booking engine and admin panel.
// A single Express app serving the JSON API and the static storefront/admin frontends.
const express = require('express');
const path = require('node:path');
const { open, seed } = require('./lib/db');
const cookieParser = require('cookie-parser');
const { loadUser, requireAdmin } = require('./lib/auth');
const { HttpError } = require('./lib/logic');
const storeRoutes = require('./routes/store');
const adminRoutes = require('./routes/admin');

const PORT = process.env.PORT || 3000;
const db = open();
seed(db);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(loadUser(db));

// Basic request rate limiting for the write-heavy public endpoints (login, orders, bookings, contact).
const hits = new Map();
function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const bucket = hits.get(key) || [];
    const recent = bucket.filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (recent.length > max) return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    next();
  };
}
setInterval(() => { // periodic cleanup so the map doesn't grow forever
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, bucket] of hits) if (!bucket.some((t) => t > cutoff)) hits.delete(key);
}, 5 * 60_000).unref();

app.use('/api', rateLimit({ windowMs: 60_000, max: 60 }));
app.use('/api/auth/login', rateLimit({ windowMs: 60_000, max: 10 }));
app.use('/api/orders', rateLimit({ windowMs: 60_000, max: 15 }));
app.use('/api/bookings', rateLimit({ windowMs: 60_000, max: 15 }));

app.use('/api', storeRoutes(db));
app.use('/api/admin', requireAdmin, adminRoutes(db));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/admin*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Centralised error handler: HttpError carries its own status, everything else is a 500.
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Anzala Chikankari running on http://localhost:${PORT}`);
});

module.exports = app;
