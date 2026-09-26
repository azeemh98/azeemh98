// Public storefront + customer account API.
const express = require('express');
const {
  hashPassword, verifyPassword, createSession, setSessionCookie, requireUser, SESSION_COOKIE,
} = require('../lib/auth');
const { getSettings } = require('../lib/db');
const ah = require('../lib/asyncHandler');
const v = require('../lib/logic');

const PUBLIC_SETTINGS = [
  'store_name', 'store_tagline', 'store_email', 'store_phone', 'store_address', 'whatsapp', 'upi_id',
  'shipping_fee', 'free_shipping_min', 'booking_max_days_ahead',
];

module.exports = function storeRoutes(db) {
  const r = express.Router();

  // ---------- config & catalogue ----------

  r.get('/config', ah(async (_req, res) => {
    const s = await getSettings(db);
    res.json(Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, s[k]])));
  }));

  r.get('/categories', ah(async (_req, res) => {
    res.json(await db.all(`SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id AND p.active = true) AS product_count
      FROM categories c ORDER BY sort_order, name`));
  }));

  r.get('/products', ah(async (req, res) => {
    const where = ['p.active = true'];
    const params = [];
    if (req.query.category) { where.push('c.slug = ?'); params.push(String(req.query.category)); }
    if (req.query.featured) where.push('p.featured = true');
    if (req.query.q) {
      where.push('(p.name ILIKE ? OR p.description ILIKE ? OR p.fabric ILIKE ? OR c.name ILIKE ?)');
      const q = `%${String(req.query.q).slice(0, 60)}%`;
      params.push(q, q, q, q);
    }
    if (req.query.min) { where.push('p.price >= ?'); params.push(Number(req.query.min) || 0); }
    if (req.query.max) { where.push('p.price <= ?'); params.push(Number(req.query.max) || 1e9); }
    const sort = {
      price_asc: 'p.price ASC', price_desc: 'p.price DESC', newest: 'p.created_at DESC, p.id DESC', rating: 'rating DESC NULLS LAST',
    }[req.query.sort] || 'p.featured DESC, p.id DESC';
    const rows = await db.all(`SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE product_id = p.id) AS rating,
        (SELECT COUNT(*)::int FROM reviews WHERE product_id = p.id) AS review_count
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT 200`, params);
    res.json(rows.map(v.parseProduct));
  }));

  r.get('/products/:slug', ah(async (req, res) => {
    const product = v.parseProduct(await db.get(`SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.slug = ? AND p.active = true`, [req.params.slug]));
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    const reviews = await db.all(`SELECT r.id, r.rating, r.comment, r.created_at, u.name,
        EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
                WHERE o.user_id = r.user_id AND oi.product_id = r.product_id AND o.status = 'delivered') AS verified
      FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.product_id = ? ORDER BY r.created_at DESC`, [product.id]);
    const related = (await db.all(`SELECT * FROM products WHERE category_id IS NOT DISTINCT FROM ? AND id != ? AND active = true ORDER BY featured DESC LIMIT 4`,
      [product.category_id, product.id])).map(v.parseProduct);
    const rating = reviews.length ? Math.round((reviews.reduce((s, x) => s + x.rating, 0) / reviews.length) * 10) / 10 : null;
    res.json({ ...product, rating, reviews, related });
  }));

  r.post('/products/:id/reviews', requireUser, ah(async (req, res) => {
    const product = await db.get('SELECT id FROM products WHERE id = ?', [Number(req.params.id)]);
    if (!product) throw new v.HttpError(404, 'Product not found.');
    const rating = v.int(req.body.rating, 'Rating', { min: 1, max: 5 });
    const comment = v.str(req.body.comment, 'Review', { max: 1000, optional: true }) || '';
    await db.run(`INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
      ON CONFLICT (product_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = now()`,
      [product.id, req.user.id, rating, comment]);
    res.status(201).json({ ok: true });
  }));

  // ---------- auth & account ----------

  r.post('/auth/register', ah(async (req, res) => {
    const name = v.str(req.body.name, 'Name', { max: 80 });
    const mail = v.email(req.body.email);
    const tel = req.body.phone ? v.phone(req.body.phone) : null;
    const pass = v.password(req.body.password);
    if (await db.get('SELECT 1 FROM users WHERE email = ?', [mail])) {
      throw new v.HttpError(409, 'An account with this email already exists. Please log in.');
    }
    const { rows } = await db.run('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?) RETURNING id',
      [name, mail, tel, hashPassword(pass)]);
    const userId = rows[0].id;
    setSessionCookie(res, await createSession(db, userId));
    res.status(201).json({ id: userId, name, email: mail, phone: tel, role: 'customer' });
  }));

  r.post('/auth/login', ah(async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [String(req.body.email || '').trim().toLowerCase()]);
    if (!user || !verifyPassword(req.body.password || '', user.password_hash)) {
      throw new v.HttpError(401, 'Incorrect email or password.');
    }
    setSessionCookie(res, await createSession(db, user.id));
    res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role });
  }));

  r.post('/auth/logout', ah(async (req, res) => {
    if (req.sessionToken) await db.run('DELETE FROM sessions WHERE token = ?', [req.sessionToken]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  r.get('/auth/me', (req, res) => res.json(req.user || null));

  r.put('/account', requireUser, ah(async (req, res) => {
    const name = v.str(req.body.name, 'Name', { max: 80 });
    const tel = req.body.phone ? v.phone(req.body.phone) : null;
    await db.run('UPDATE users SET name = ?, phone = ? WHERE id = ?', [name, tel, req.user.id]);
    res.json({ ...req.user, name, phone: tel });
  }));

  r.put('/account/password', requireUser, ah(async (req, res) => {
    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(req.body.current_password || '', user.password_hash)) {
      throw new v.HttpError(400, 'Current password is incorrect.');
    }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(v.password(req.body.new_password)), req.user.id]);
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [req.user.id, req.sessionToken]);
    res.json({ ok: true });
  }));

  // ---------- wishlist ----------

  r.get('/wishlist', requireUser, ah(async (req, res) => {
    res.json((await db.all(`SELECT p.* FROM wishlist w JOIN products p ON p.id = w.product_id
      WHERE w.user_id = ? AND p.active = true`, [req.user.id])).map(v.parseProduct));
  }));
  r.post('/wishlist/:productId', requireUser, ah(async (req, res) => {
    const product = await db.get('SELECT id FROM products WHERE id = ?', [Number(req.params.productId)]);
    if (!product) throw new v.HttpError(404, 'Product not found.');
    await db.run('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?) ON CONFLICT (user_id, product_id) DO NOTHING',
      [req.user.id, product.id]);
    res.status(201).json({ ok: true });
  }));
  r.delete('/wishlist/:productId', requireUser, ah(async (req, res) => {
    await db.run('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?', [req.user.id, Number(req.params.productId)]);
    res.json({ ok: true });
  }));

  // ---------- cart & orders ----------

  r.post('/cart/quote', ah(async (req, res) => {
    res.json(await v.quote(db, req.body.items || [], req.body.coupon));
  }));

  r.post('/orders', ah(async (req, res) => {
    const b = req.body;
    const customer = {
      name: v.str(b.name, 'Name', { max: 80 }),
      email: v.email(b.email),
      phone: v.phone(b.phone),
      address: v.str(b.address, 'Address', { min: 5, max: 300 }),
      city: v.str(b.city, 'City', { max: 60 }),
      state: v.str(b.state, 'State', { max: 60 }),
      pincode: v.pincode(b.pincode),
      notes: v.str(b.notes, 'Notes', { max: 500, optional: true }),
    };
    const method = ['cod', 'upi'].includes(b.payment_method) ? b.payment_method : null;
    if (!method) throw new v.HttpError(400, 'Please choose a payment method.');

    const order = await db.tx(async (tdb) => {
      const q = await v.quote(tdb, b.items || [], b.coupon);
      if (!q.lines.length) throw new v.HttpError(400, 'Your bag is empty.');
      if (q.errors.length) throw Object.assign(new v.HttpError(409, q.errors[0]), { details: q.errors });
      if (b.coupon && !q.coupon) throw new v.HttpError(409, q.coupon_error || 'Coupon could not be applied.');
      if (b.expected_total != null && Number(b.expected_total) !== q.total) {
        throw new v.HttpError(409, 'Prices in your bag have changed. Please review your order and try again.');
      }

      const orderNo = v.reference('AZ');
      const { rows } = await tdb.run(`INSERT INTO orders
        (order_no, user_id, name, email, phone, address, city, state, pincode, subtotal, discount, shipping, total,
         coupon_code, payment_method, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
        orderNo, req.user ? req.user.id : null, customer.name, customer.email, customer.phone, customer.address,
        customer.city, customer.state, customer.pincode, q.subtotal, q.discount, q.shipping, q.total,
        q.coupon ? q.coupon.code : null, method, customer.notes,
      ]);
      const orderId = rows[0].id;
      for (const l of q.lines) {
        await tdb.run(`INSERT INTO order_items (order_id, product_id, name, image, size, price, qty)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [orderId, l.product_id, l.name, l.image, l.size, l.price, l.qty]);
        const stockUpdate = await tdb.run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [l.qty, l.product_id, l.qty]);
        if (stockUpdate.changes !== 1) throw new v.HttpError(409, `${l.name} just sold out.`);
      }
      if (q.coupon) await tdb.run('UPDATE coupons SET used = used + 1 WHERE code = ?', [q.coupon.code]);
      return { order_no: orderNo, total: q.total, payment_method: method };
    });
    res.status(201).json(order);
  }));

  async function orderWithItems(order) {
    return { ...order, items: await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]) };
  }

  r.get('/orders', requireUser, ah(async (req, res) => {
    const orders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(await Promise.all(orders.map(orderWithItems)));
  }));

  // Order tracking: the signed-in owner, or anyone who knows the order number + email used.
  r.get('/orders/:orderNo', ah(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE order_no = ?', [String(req.params.orderNo).toUpperCase()]);
    const owns = order && req.user && (order.user_id === req.user.id || req.user.role === 'admin');
    const emailMatch = order && req.query.email && String(req.query.email).trim().toLowerCase() === order.email;
    if (!order || !(owns || emailMatch)) throw new v.HttpError(404, 'No order found with those details.');
    res.json(await orderWithItems(order));
  }));

  r.post('/orders/:orderNo/cancel', requireUser, ah(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE order_no = ? AND user_id = ?', [req.params.orderNo, req.user.id]);
    if (!order) throw new v.HttpError(404, 'Order not found.');
    if (!['placed', 'confirmed'].includes(order.status)) {
      throw new v.HttpError(400, 'This order has already been packed or shipped and can no longer be cancelled online. Please contact us.');
    }
    await cancelOrder(db, order);
    res.json({ ok: true });
  }));

  // ---------- booking engine ----------

  r.get('/services', ah(async (_req, res) => {
    res.json(await db.all('SELECT * FROM services WHERE active = true ORDER BY id'));
  }));

  r.get('/bookings/slots', ah(async (req, res) => {
    res.json(await v.availableSlots(db, String(req.query.date || ''), req.query.service_id));
  }));

  r.post('/bookings', ah(async (req, res) => {
    const b = req.body;
    const data = {
      name: v.str(b.name, 'Name', { max: 80 }),
      email: v.email(b.email),
      phone: v.phone(b.phone),
      notes: v.str(b.notes, 'Notes', { max: 500, optional: true }),
      date: String(b.date || ''),
      time: String(b.time || ''),
    };
    const booking = await db.tx(async (tdb) => {
      const { slots, open, reason } = await v.availableSlots(tdb, data.date, b.service_id);
      if (!open) throw new v.HttpError(409, reason);
      const slot = slots.find((s) => s.time === data.time);
      if (!slot || !slot.available) throw new v.HttpError(409, 'Sorry, that slot was just taken. Please pick another time.');
      const bookingNo = v.reference('BK');
      await tdb.run(`INSERT INTO bookings (booking_no, service_id, user_id, name, email, phone, date, time, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [bookingNo, Number(b.service_id), req.user ? req.user.id : null,
        data.name, data.email, data.phone, data.date, data.time, data.notes]);
      return tdb.get(`SELECT b.*, s.name AS service_name, s.duration_min, s.price AS service_price FROM bookings b
        JOIN services s ON s.id = b.service_id WHERE booking_no = ?`, [bookingNo]);
    });
    res.status(201).json(booking);
  }));

  r.get('/bookings', requireUser, ah(async (req, res) => {
    res.json(await db.all(`SELECT b.*, s.name AS service_name, s.duration_min FROM bookings b
      JOIN services s ON s.id = b.service_id WHERE b.user_id = ? ORDER BY b.date DESC, b.time DESC`, [req.user.id]));
  }));

  r.post('/bookings/:bookingNo/cancel', requireUser, ah(async (req, res) => {
    const info = await db.run(`UPDATE bookings SET status = 'cancelled'
      WHERE booking_no = ? AND user_id = ? AND status IN ('pending','confirmed')`, [req.params.bookingNo, req.user.id]);
    if (!info.changes) throw new v.HttpError(404, 'Booking not found or already closed.');
    res.json({ ok: true });
  }));

  // ---------- contact ----------

  r.post('/contact', ah(async (req, res) => {
    await db.run('INSERT INTO messages (name, email, phone, message) VALUES (?, ?, ?, ?)', [
      v.str(req.body.name, 'Name', { max: 80 }), v.email(req.body.email),
      req.body.phone ? v.phone(req.body.phone) : null, v.str(req.body.message, 'Message', { max: 2000 }),
    ]);
    res.status(201).json({ ok: true });
  }));

  return r;
};

// Cancels an order and puts its items back into stock. Used by customers and admins.
// `dbLike` may be the pool-backed db or an already-open transaction's db.
async function cancelOrder(dbLike, order) {
  const run = async (tdb) => {
    const items = await tdb.all('SELECT product_id, qty FROM order_items WHERE order_id = ?', [order.id]);
    for (const it of items) if (it.product_id) await tdb.run('UPDATE products SET stock = stock + ? WHERE id = ?', [it.qty, it.product_id]);
    await tdb.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
  };
  return dbLike.tx ? dbLike.tx(run) : run(dbLike);
}

module.exports.cancelOrder = cancelOrder;
