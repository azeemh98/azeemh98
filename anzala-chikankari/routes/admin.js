// Admin panel API: dashboard metrics, catalogue, orders, bookings and settings management.
// Every route here is mounted behind requireAdmin in server.js.
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('../lib/auth');
const { transaction, slugify, getSettings, DEFAULT_SETTINGS } = require('../lib/db');
const v = require('../lib/logic');
const { cancelOrder } = require('./store');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'uploads'),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => cb(null, ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(file.originalname).toLowerCase())),
});

module.exports = function adminRoutes(db) {
  const r = express.Router();

  // ---------- dashboard ----------

  r.get('/dashboard', (req, res) => {
    const since = v.addDays(v.nowLocal().date, -29);
    const revenue = db.prepare(`SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status != 'cancelled' AND date(created_at) >= ?`).get(since).n;
    const ordersToday = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE date(created_at) = ?`).get(v.nowLocal().date).n;
    const pendingOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('placed','confirmed')`).get().n;
    const lowStock = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND stock <= 3`).get().n;
    const bookingsUpcoming = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE date >= ? AND status IN ('pending','confirmed')`).get(v.nowLocal().date).n;
    const customers = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer'`).get().n;
    const unreadMessages = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_read = 0`).get().n;

    const salesByDay = db.prepare(`SELECT date(created_at) AS date, SUM(total) AS revenue, COUNT(*) AS orders
      FROM orders WHERE status != 'cancelled' AND date(created_at) >= ? GROUP BY date(created_at) ORDER BY date`).all(since);

    const topProducts = db.prepare(`SELECT oi.name, SUM(oi.qty) AS units, SUM(oi.qty * oi.price) AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled'
      GROUP BY oi.product_id, oi.name ORDER BY units DESC LIMIT 5`).all();

    const recentOrders = db.prepare(`SELECT id, order_no, name, total, status, payment_status, created_at
      FROM orders ORDER BY id DESC LIMIT 8`).all();

    const lowStockProducts = db.prepare(`SELECT id, name, stock FROM products WHERE active = 1 AND stock <= 3 ORDER BY stock ASC LIMIT 8`).all();

    res.json({
      kpis: { revenue_30d: revenue, orders_today: ordersToday, pending_orders: pendingOrders, low_stock: lowStock, bookings_upcoming: bookingsUpcoming, customers, unread_messages: unreadMessages },
      sales_by_day: salesByDay, top_products: topProducts, recent_orders: recentOrders, low_stock_products: lowStockProducts,
    });
  });

  // ---------- categories ----------

  r.get('/categories', (_req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all()));

  r.post('/categories', (req, res) => {
    const name = v.str(req.body.name, 'Category name', { max: 60 });
    const slug = slugify(req.body.slug || name);
    const { lastInsertRowid } = db.prepare('INSERT INTO categories (name, slug, image, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, slug, req.body.image || null, v.int(req.body.sort_order, 'Sort order', { optional: true }) || 0);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(lastInsertRowid)));
  });

  r.put('/categories/:id', (req, res) => {
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
    if (!cat) throw new v.HttpError(404, 'Category not found.');
    const name = v.str(req.body.name, 'Category name', { max: 60 });
    db.prepare('UPDATE categories SET name = ?, slug = ?, image = ?, sort_order = ? WHERE id = ?').run(
      name, slugify(req.body.slug || name), req.body.image || null,
      v.int(req.body.sort_order, 'Sort order', { optional: true }) ?? cat.sort_order, cat.id,
    );
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(cat.id));
  });

  r.delete('/categories/:id', (req, res) => {
    const inUse = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(Number(req.params.id)).n;
    if (inUse) throw new v.HttpError(409, `Cannot delete: ${inUse} product(s) still use this category.`);
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- products ----------

  r.get('/products', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.q) { where.push('(p.name LIKE ? OR p.fabric LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    if (req.query.category_id) { where.push('p.category_id = ?'); params.push(Number(req.query.category_id)); }
    const sql = `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 500`;
    res.json(db.prepare(sql).all(...params).map(v.parseProduct));
  });

  function productPayload(body, existing) {
    const name = v.str(body.name, 'Name', { max: 150 });
    const images = Array.isArray(body.images) ? body.images.filter((x) => typeof x === 'string').slice(0, 8) : (existing ? existing.images : []);
    return {
      name,
      slug: slugify(body.slug || name),
      category_id: body.category_id ? v.int(body.category_id, 'Category') : null,
      description: v.str(body.description, 'Description', { max: 4000, optional: true }) || '',
      fabric: v.str(body.fabric, 'Fabric', { max: 60, optional: true }) || '',
      price: v.int(body.price, 'Price', { min: 0, max: 10_000_000 }),
      compare_price: body.compare_price ? v.int(body.compare_price, 'Compare-at price', { min: 0 }) : null,
      stock: v.int(body.stock, 'Stock', { min: 0, max: 100_000 }),
      sizes: Array.isArray(body.sizes) ? body.sizes.join(',') : v.str(body.sizes, 'Sizes', { max: 100, optional: true }) || '',
      images: JSON.stringify(images),
      featured: body.featured ? 1 : 0,
      active: body.active === false ? 0 : 1,
    };
  }

  r.post('/products', (req, res) => {
    const p = productPayload(req.body, null);
    if (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(p.slug)) p.slug = `${p.slug}-${Date.now().toString(36)}`;
    const { lastInsertRowid } = db.prepare(`INSERT INTO products
      (name, slug, category_id, description, fabric, price, compare_price, stock, sizes, images, featured, active)
      VALUES (@name, @slug, @category_id, @description, @fabric, @price, @compare_price, @stock, @sizes, @images, @featured, @active)`).run(p);
    res.status(201).json(v.parseProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(lastInsertRowid))));
  });

  r.put('/products/:id', (req, res) => {
    const existing = v.parseProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id)));
    if (!existing) throw new v.HttpError(404, 'Product not found.');
    const p = productPayload(req.body, existing);
    db.prepare(`UPDATE products SET name=@name, slug=@slug, category_id=@category_id, description=@description, fabric=@fabric,
      price=@price, compare_price=@compare_price, stock=@stock, sizes=@sizes, images=@images, featured=@featured, active=@active
      WHERE id=@id`).run({ ...p, id: existing.id });
    res.json(v.parseProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id)));
  });

  r.delete('/products/:id', (req, res) => {
    const used = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?').get(Number(req.params.id)).n;
    if (used) {
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(Number(req.params.id)); // keep order history intact
      return res.json({ ok: true, archived: true });
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true, archived: false });
  });

  r.post('/uploads', upload.array('images', 6), (req, res) => {
    if (!req.files?.length) throw new v.HttpError(400, 'No valid image files were uploaded (jpg, png, webp, gif only, max 5MB each).');
    res.status(201).json({ urls: req.files.map((f) => `/uploads/${f.filename}`) });
  });

  // ---------- orders ----------

  r.get('/orders', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
    if (req.query.q) {
      where.push('(order_no LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ?)');
      const q = `%${req.query.q}%`; params.push(q, q, q, q);
    }
    const rows = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 300`).all(...params);
    res.json(rows);
  });

  r.get('/orders/:id', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) throw new v.HttpError(404, 'Order not found.');
    res.json({ ...order, items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id) });
  });

  const NEXT_STATUS = { placed: ['confirmed', 'cancelled'], confirmed: ['packed', 'cancelled'], packed: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };

  r.put('/orders/:id/status', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) throw new v.HttpError(404, 'Order not found.');
    const status = v.str(req.body.status, 'Status', { max: 20 });
    if (status === 'cancelled') {
      if (order.status === 'cancelled') throw new v.HttpError(400, 'Order is already cancelled.');
      cancelOrder(db, order);
    } else {
      if (!NEXT_STATUS[order.status]?.includes(status)) {
        throw new v.HttpError(400, `Cannot move order from "${order.status}" to "${status}".`);
      }
      const tracking = req.body.tracking_no ? v.str(req.body.tracking_no, 'Tracking number', { max: 60 }) : order.tracking_no;
      const paymentStatus = status === 'delivered' && order.payment_method === 'cod' ? 'paid' : order.payment_status;
      db.prepare('UPDATE orders SET status = ?, tracking_no = ?, payment_status = ? WHERE id = ?').run(status, tracking, paymentStatus, order.id);
    }
    res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
  });

  r.put('/orders/:id/payment', (req, res) => {
    const status = v.str(req.body.payment_status, 'Payment status', { max: 20 });
    if (!['pending', 'paid', 'refunded'].includes(status)) throw new v.HttpError(400, 'Invalid payment status.');
    const info = db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (!info.changes) throw new v.HttpError(404, 'Order not found.');
    res.json({ ok: true });
  });

  // ---------- bookings ----------

  r.get('/bookings', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.date) { where.push('b.date = ?'); params.push(req.query.date); }
    if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
    res.json(db.prepare(`SELECT b.*, s.name AS service_name, s.duration_min FROM bookings b JOIN services s ON s.id = b.service_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.date DESC, b.time DESC LIMIT 300`).all(...params));
  });

  r.put('/bookings/:id/status', (req, res) => {
    const status = v.str(req.body.status, 'Status', { max: 20 });
    if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) throw new v.HttpError(400, 'Invalid status.');
    const info = db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (!info.changes) throw new v.HttpError(404, 'Booking not found.');
    res.json({ ok: true });
  });

  r.get('/services', (_req, res) => res.json(db.prepare('SELECT * FROM services ORDER BY id').all()));

  r.post('/services', (req, res) => {
    const { lastInsertRowid } = db.prepare('INSERT INTO services (name, description, duration_min, price, active) VALUES (?, ?, ?, ?, ?)').run(
      v.str(req.body.name, 'Service name', { max: 100 }), v.str(req.body.description, 'Description', { max: 1000, optional: true }) || '',
      v.int(req.body.duration_min, 'Duration', { min: 10, max: 480 }), v.int(req.body.price, 'Price', { min: 0 }),
      req.body.active === false ? 0 : 1,
    );
    res.status(201).json(db.prepare('SELECT * FROM services WHERE id = ?').get(Number(lastInsertRowid)));
  });

  r.put('/services/:id', (req, res) => {
    const info = db.prepare('UPDATE services SET name=?, description=?, duration_min=?, price=?, active=? WHERE id=?').run(
      v.str(req.body.name, 'Service name', { max: 100 }), v.str(req.body.description, 'Description', { max: 1000, optional: true }) || '',
      v.int(req.body.duration_min, 'Duration', { min: 10, max: 480 }), v.int(req.body.price, 'Price', { min: 0 }),
      req.body.active === false ? 0 : 1, Number(req.params.id),
    );
    if (!info.changes) throw new v.HttpError(404, 'Service not found.');
    res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(Number(req.params.id)));
  });

  r.get('/blocked-dates', (_req, res) => res.json(db.prepare('SELECT * FROM blocked_dates ORDER BY date').all()));
  r.post('/blocked-dates', (req, res) => {
    const date = v.str(req.body.date, 'Date', { max: 10 });
    db.prepare('INSERT INTO blocked_dates (date, reason) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET reason = excluded.reason')
      .run(date, v.str(req.body.reason, 'Reason', { max: 200, optional: true }) || null);
    res.status(201).json({ ok: true });
  });
  r.delete('/blocked-dates/:date', (req, res) => {
    db.prepare('DELETE FROM blocked_dates WHERE date = ?').run(req.params.date);
    res.json({ ok: true });
  });

  // ---------- coupons ----------

  r.get('/coupons', (_req, res) => res.json(db.prepare('SELECT * FROM coupons ORDER BY id DESC').all()));
  r.post('/coupons', (req, res) => {
    const code = v.str(req.body.code, 'Code', { max: 30 }).toUpperCase();
    if (!['percent', 'flat'].includes(req.body.type)) throw new v.HttpError(400, 'Type must be percent or flat.');
    const { lastInsertRowid } = db.prepare(`INSERT INTO coupons (code, type, value, min_order, max_uses, expires_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(code, req.body.type, v.int(req.body.value, 'Value', { min: 1 }),
      v.int(req.body.min_order, 'Minimum order', { min: 0, optional: true }) || 0,
      req.body.max_uses ? v.int(req.body.max_uses, 'Max uses', { min: 1 }) : null,
      req.body.expires_at || null, req.body.active === false ? 0 : 1);
    res.status(201).json(db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(lastInsertRowid)));
  });
  r.put('/coupons/:id', (req, res) => {
    const info = db.prepare('UPDATE coupons SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, Number(req.params.id));
    if (!info.changes) throw new v.HttpError(404, 'Coupon not found.');
    res.json(db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(req.params.id)));
  });
  r.delete('/coupons/:id', (req, res) => {
    db.prepare('DELETE FROM coupons WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- customers & messages ----------

  r.get('/customers', (req, res) => {
    const search = req.query.q ? "AND (u.name LIKE ? OR u.email LIKE ?)" : '';
    const params = req.query.q ? [`%${req.query.q}%`, `%${req.query.q}%`] : [];
    res.json(db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.created_at,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
        (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.user_id = u.id AND o.status != 'cancelled') AS lifetime_value
      FROM users u WHERE u.role = 'customer' ${search} ORDER BY u.id DESC LIMIT 300`).all(...params));
  });

  r.get('/messages', (req, res) => {
    res.json(db.prepare(`SELECT * FROM messages ${req.query.unread ? 'WHERE is_read = 0' : ''} ORDER BY id DESC LIMIT 300`).all());
  });
  r.put('/messages/:id/read', (req, res) => {
    db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- settings ----------

  r.get('/settings', (_req, res) => res.json(getSettings(db)));
  r.put('/settings', (req, res) => {
    transaction(db, () => {
      const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (req.body[key] !== undefined) stmt.run(key, String(req.body[key]));
      }
    });
    res.json(getSettings(db));
  });

  // ---------- admin users (super-admin only manages via DB seed / here) ----------

  r.get('/admins', (_req, res) => res.json(db.prepare("SELECT id, name, email, created_at FROM users WHERE role = 'admin'").all()));
  r.post('/admins', (req, res) => {
    const name = v.str(req.body.name, 'Name', { max: 80 });
    const mail = v.email(req.body.email);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new v.HttpError(409, 'Email already in use.');
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(name, mail, hashPassword(v.password(req.body.password)));
    res.status(201).json({ ok: true });
  });

  return r;
};
