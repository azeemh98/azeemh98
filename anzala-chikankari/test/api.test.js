// Smoke tests for the storefront + admin API, run against a real Postgres database (set TEST_DATABASE_URL,
// or DATABASE_URL, to a disposable database — every table is dropped and recreated on each run).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgresql://postgres:localdevpass@127.0.0.1:5432/anzala_test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123';

const { db, pool, seed } = require('../lib/db');
const { loadUser, requireAdmin } = require('../lib/auth');
const { HttpError } = require('../lib/logic');
const storeRoutes = require('../routes/store');
const adminRoutes = require('../routes/admin');

let server; let base; let resetPool;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(loadUser(db));
  app.use('/api', storeRoutes(db));
  app.use('/api/admin', requireAdmin, adminRoutes(db));
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err); res.status(500).json({ error: 'server error' });
  });
  return app;
}

before(async () => {
  resetPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await resetPool.query(`
    drop table if exists messages, blocked_dates, settings, bookings, services, order_items, orders,
      coupons, wishlist, reviews, products, categories, sessions, users cascade;
  `);
  await seed();
  const app = buildApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await resetPool.end(); await pool.end(); });

// Minimal cookie-jar fetch wrapper so we can carry a session between calls per test.
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  };
}

test('public catalogue is browsable', async () => {
  const req = client();
  const cats = await req('GET', '/api/categories');
  assert.equal(cats.status, 200);
  assert.ok(cats.data.length > 0);

  const products = await req('GET', '/api/products');
  assert.equal(products.status, 200);
  assert.ok(products.data.length > 0);

  const one = await req('GET', `/api/products/${products.data[0].slug}`);
  assert.equal(one.status, 200);
  assert.equal(one.data.slug, products.data[0].slug);
});

test('cart quote computes shipping and rejects a bad coupon', async () => {
  const req = client();
  const products = (await req('GET', '/api/products')).data;
  const cheap = products.find((p) => p.price < 2999);
  const quote = await req('POST', '/api/cart/quote', { items: [{ product_id: cheap.id, qty: 1, size: cheap.sizes[0] || null }] });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.shipping > 0, true);

  const bad = await req('POST', '/api/cart/quote', { items: [{ product_id: cheap.id, qty: 1, size: cheap.sizes[0] || null }], coupon: 'NOPE' });
  assert.equal(bad.data.coupon, null);
  assert.ok(bad.data.coupon_error);
});

test('register, order placement, stock decrement and self-cancel', async () => {
  const req = client();
  const reg = await req('POST', '/api/auth/register', { name: 'Jane Doe', email: `jane${Date.now()}@test.com`, password: 'password123', phone: '9876543210' });
  assert.equal(reg.status, 201);

  const products = (await req('GET', '/api/products')).data;
  const target = products.find((p) => p.stock > 1);
  const size = target.sizes[0] || null;

  const order = await req('POST', '/api/orders', {
    name: 'Jane Doe', email: reg.data.email, phone: '9876543210', address: '221B Baker Street',
    city: 'Lucknow', state: 'UP', pincode: '226001', payment_method: 'cod',
    items: [{ product_id: target.id, qty: 1, size }],
  });
  assert.equal(order.status, 201);
  assert.ok(order.data.order_no.startsWith('AZ'));

  const after1 = await req('GET', `/api/products/${target.slug}`);
  assert.equal(after1.data.stock, target.stock - 1);

  const mine = await req('GET', '/api/orders');
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].order_no, order.data.order_no);

  const cancel = await req('POST', `/api/orders/${order.data.order_no}/cancel`);
  assert.equal(cancel.status, 200);

  const restocked = await req('GET', `/api/products/${target.slug}`);
  assert.equal(restocked.data.stock, target.stock); // cancellation returns stock
});

test('order rejects an out-of-stock quantity', async () => {
  const req = client();
  const products = (await req('GET', '/api/products')).data;
  const target = products[0];
  const res = await req('POST', '/api/orders', {
    name: 'Big Buyer', email: 'buyer@test.com', phone: '9876543210', address: '1 Somewhere Lane',
    city: 'Lucknow', state: 'UP', pincode: '226001', payment_method: 'cod',
    items: [{ product_id: target.id, qty: target.stock + 50, size: target.sizes[0] || null }],
  });
  assert.equal(res.status, 400); // invalid qty (max 10) or 409 out of stock depending on stock size
});

test('booking slots respect capacity and reject a double-booked slot', async () => {
  const req = client();
  const services = (await req('GET', '/api/services')).data;
  const service = services[0];
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

  const slots = await req('GET', `/api/bookings/slots?date=${date}&service_id=${service.id}`);
  assert.equal(slots.status, 200);
  assert.ok(slots.data.open);
  const openSlot = slots.data.slots.find((s) => s.available);
  assert.ok(openSlot, 'expected at least one open slot');

  const book = await req('POST', '/api/bookings', {
    service_id: service.id, name: 'A', email: 'a@test.com', phone: '9876543210', date, time: openSlot.time,
  });
  assert.equal(book.status, 201);

  // Fill remaining capacity then expect the next attempt to fail once the slot is full.
  const capacity = openSlot.remaining;
  for (let i = 1; i < capacity; i++) {
    const r = await req('POST', '/api/bookings', { service_id: service.id, name: 'B', email: 'b@test.com', phone: '9876543211', date, time: openSlot.time });
    assert.equal(r.status, 201);
  }
  const overbook = await req('POST', '/api/bookings', { service_id: service.id, name: 'C', email: 'c@test.com', phone: '9876543212', date, time: openSlot.time });
  assert.equal(overbook.status, 409);
});

test('admin routes require an admin session', async () => {
  const req = client();
  const anon = await req('GET', '/api/admin/dashboard');
  assert.equal(anon.status, 401);

  const badLogin = await req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong' });
  assert.equal(badLogin.status, 401);

  const login = await req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123' });
  assert.equal(login.status, 200);
  assert.equal(login.data.role, 'admin');

  const dash = await req('GET', '/api/admin/dashboard');
  assert.equal(dash.status, 200);
  assert.ok('kpis' in dash.data);
});

test('admin can manage products and coupons end-to-end', async () => {
  const req = client();
  await req('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123' });

  const created = await req('POST', '/api/admin/products', { name: 'Unit Test Kurti', price: 1500, stock: 10, sizes: 'S,M,L' });
  assert.equal(created.status, 201);
  assert.equal(created.data.price, 1500);

  const updated = await req('PUT', `/api/admin/products/${created.data.id}`, { name: 'Unit Test Kurti', price: 1700, stock: 8, sizes: 'S,M,L', featured: true });
  assert.equal(updated.data.price, 1700);
  assert.equal(updated.data.featured, true);

  const coupon = await req('POST', '/api/admin/coupons', { code: 'UNITTEST', type: 'flat', value: 100, min_order: 0 });
  assert.equal(coupon.status, 201);

  const del = await req('DELETE', `/api/admin/products/${created.data.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.archived, false); // never ordered, so hard-deleted
});

test('a non-admin customer is refused admin access', async () => {
  const req = client();
  await req('POST', '/api/auth/register', { name: 'Regular Shopper', email: `shopper${Date.now()}@test.com`, password: 'password123' });
  const res = await req('GET', '/api/admin/dashboard');
  assert.equal(res.status, 403);
});
