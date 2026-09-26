// Admin panel API: dashboard metrics, catalogue, orders, bookings and settings management.
// Every route here is mounted behind requireAdmin in server.js.
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('../lib/auth');
const { slugify, getSettings, DEFAULT_SETTINGS } = require('../lib/db');
const ah = require('../lib/asyncHandler');
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

  r.get('/dashboard', ah(async (_req, res) => {
    const since = v.addDays(v.nowLocal().date, -29);
    const today = v.nowLocal().date;

    const [revenue, ordersToday, pendingOrders, lowStock, bookingsUpcoming, customers, unreadMessages,
      salesByDay, topProducts, recentOrders, lowStockProducts] = await Promise.all([
      db.get(`SELECT COALESCE(SUM(total), 0)::int AS n FROM orders WHERE status != 'cancelled' AND created_at::date >= ?`, [since]),
      db.get(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at::date = ?`, [today]),
      db.get(`SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('placed','confirmed')`),
      db.get(`SELECT COUNT(*)::int AS n FROM products WHERE active = true AND stock <= 3`),
      db.get(`SELECT COUNT(*)::int AS n FROM bookings WHERE date >= ? AND status IN ('pending','confirmed')`, [today]),
      db.get(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer'`),
      db.get(`SELECT COUNT(*)::int AS n FROM messages WHERE is_read = false`),
      db.all(`SELECT created_at::date::text AS date, SUM(total)::int AS revenue, COUNT(*)::int AS orders
        FROM orders WHERE status != 'cancelled' AND created_at::date >= ? GROUP BY created_at::date ORDER BY date`, [since]),
      db.all(`SELECT oi.name, SUM(oi.qty)::int AS units, SUM(oi.qty * oi.price)::int AS revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled'
        GROUP BY oi.product_id, oi.name ORDER BY units DESC LIMIT 5`),
      db.all(`SELECT id, order_no, name, total, status, payment_status, created_at FROM orders ORDER BY id DESC LIMIT 8`),
      db.all(`SELECT id, name, stock FROM products WHERE active = true AND stock <= 3 ORDER BY stock ASC LIMIT 8`),
    ]);

    res.json({
      kpis: {
        revenue_30d: revenue.n, orders_today: ordersToday.n, pending_orders: pendingOrders.n, low_stock: lowStock.n,
        bookings_upcoming: bookingsUpcoming.n, customers: customers.n, unread_messages: unreadMessages.n,
      },
      sales_by_day: salesByDay, top_products: topProducts, recent_orders: recentOrders, low_stock_products: lowStockProducts,
    });
  }));

  // ---------- categories ----------

  r.get('/categories', ah(async (_req, res) => res.json(await db.all('SELECT * FROM categories ORDER BY sort_order, name'))));

  r.post('/categories', ah(async (req, res) => {
    const name = v.str(req.body.name, 'Category name', { max: 60 });
    const slug = slugify(req.body.slug || name);
    const { rows } = await db.run('INSERT INTO categories (name, slug, image, sort_order) VALUES (?, ?, ?, ?) RETURNING id',
      [name, slug, req.body.image || null, v.int(req.body.sort_order, 'Sort order', { optional: true }) || 0]);
    res.status(201).json(await db.get('SELECT * FROM categories WHERE id = ?', [rows[0].id]));
  }));

  r.put('/categories/:id', ah(async (req, res) => {
    const cat = await db.get('SELECT * FROM categories WHERE id = ?', [Number(req.params.id)]);
    if (!cat) throw new v.HttpError(404, 'Category not found.');
    const name = v.str(req.body.name, 'Category name', { max: 60 });
    await db.run('UPDATE categories SET name = ?, slug = ?, image = ?, sort_order = ? WHERE id = ?', [
      name, slugify(req.body.slug || name), req.body.image || null,
      v.int(req.body.sort_order, 'Sort order', { optional: true }) ?? cat.sort_order, cat.id,
    ]);
    res.json(await db.get('SELECT * FROM categories WHERE id = ?', [cat.id]));
  }));

  r.delete('/categories/:id', ah(async (req, res) => {
    const inUse = (await db.get('SELECT COUNT(*)::int AS n FROM products WHERE category_id = ?', [Number(req.params.id)])).n;
    if (inUse) throw new v.HttpError(409, `Cannot delete: ${inUse} product(s) still use this category.`);
    await db.run('DELETE FROM categories WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- products ----------

  r.get('/products', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.q) { where.push('(p.name ILIKE ? OR p.fabric ILIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    if (req.query.category_id) { where.push('p.category_id = ?'); params.push(Number(req.query.category_id)); }
    const sql = `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 500`;
    res.json((await db.all(sql, params)).map(v.parseProduct));
  }));

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
      featured: !!body.featured,
      active: body.active !== false,
    };
  }

  r.post('/products', ah(async (req, res) => {
    const p = productPayload(req.body, null);
    if (await db.get('SELECT 1 FROM products WHERE slug = ?', [p.slug])) p.slug = `${p.slug}-${Date.now().toString(36)}`;
    const { rows } = await db.run(`INSERT INTO products
      (name, slug, category_id, description, fabric, price, compare_price, stock, sizes, images, featured, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [p.name, p.slug, p.category_id, p.description, p.fabric, p.price, p.compare_price, p.stock, p.sizes, p.images, p.featured, p.active]);
    res.status(201).json(v.parseProduct(await db.get('SELECT * FROM products WHERE id = ?', [rows[0].id])));
  }));

  r.put('/products/:id', ah(async (req, res) => {
    const existing = v.parseProduct(await db.get('SELECT * FROM products WHERE id = ?', [Number(req.params.id)]));
    if (!existing) throw new v.HttpError(404, 'Product not found.');
    const p = productPayload(req.body, existing);
    await db.run(`UPDATE products SET name=?, slug=?, category_id=?, description=?, fabric=?,
      price=?, compare_price=?, stock=?, sizes=?, images=?, featured=?, active=? WHERE id=?`,
      [p.name, p.slug, p.category_id, p.description, p.fabric, p.price, p.compare_price, p.stock, p.sizes, p.images, p.featured, p.active, existing.id]);
    res.json(v.parseProduct(await db.get('SELECT * FROM products WHERE id = ?', [existing.id])));
  }));

  r.delete('/products/:id', ah(async (req, res) => {
    const used = (await db.get('SELECT COUNT(*)::int AS n FROM order_items WHERE product_id = ?', [Number(req.params.id)])).n;
    if (used) {
      await db.run('UPDATE products SET active = false WHERE id = ?', [Number(req.params.id)]); // keep order history intact
      return res.json({ ok: true, archived: true });
    }
    await db.run('DELETE FROM products WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true, archived: false });
  }));

  r.post('/uploads', upload.array('images', 6), (req, res) => {
    if (!req.files?.length) throw new v.HttpError(400, 'No valid image files were uploaded (jpg, png, webp, gif only, max 5MB each).');
    res.status(201).json({ urls: req.files.map((f) => `/uploads/${f.filename}`) });
  });

  // ---------- orders ----------

  r.get('/orders', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
    if (req.query.q) {
      where.push('(order_no ILIKE ? OR name ILIKE ? OR email ILIKE ? OR phone ILIKE ?)');
      const q = `%${req.query.q}%`; params.push(q, q, q, q);
    }
    const rows = await db.all(`SELECT o.*, (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 300`, params);
    res.json(rows);
  }));

  r.get('/orders/:id', ah(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [Number(req.params.id)]);
    if (!order) throw new v.HttpError(404, 'Order not found.');
    res.json({ ...order, items: await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]) });
  }));

  const NEXT_STATUS = { placed: ['confirmed', 'cancelled'], confirmed: ['packed', 'cancelled'], packed: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };

  r.put('/orders/:id/status', ah(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [Number(req.params.id)]);
    if (!order) throw new v.HttpError(404, 'Order not found.');
    const status = v.str(req.body.status, 'Status', { max: 20 });
    if (status === 'cancelled') {
      if (order.status === 'cancelled') throw new v.HttpError(400, 'Order is already cancelled.');
      await cancelOrder(db, order);
    } else {
      if (!NEXT_STATUS[order.status]?.includes(status)) {
        throw new v.HttpError(400, `Cannot move order from "${order.status}" to "${status}".`);
      }
      const tracking = req.body.tracking_no ? v.str(req.body.tracking_no, 'Tracking number', { max: 60 }) : order.tracking_no;
      const paymentStatus = status === 'delivered' && order.payment_method === 'cod' ? 'paid' : order.payment_status;
      await db.run('UPDATE orders SET status = ?, tracking_no = ?, payment_status = ? WHERE id = ?', [status, tracking, paymentStatus, order.id]);
    }
    res.json(await db.get('SELECT * FROM orders WHERE id = ?', [order.id]));
  }));

  r.put('/orders/:id/payment', ah(async (req, res) => {
    const status = v.str(req.body.payment_status, 'Payment status', { max: 20 });
    if (!['pending', 'paid', 'refunded'].includes(status)) throw new v.HttpError(400, 'Invalid payment status.');
    const info = await db.run('UPDATE orders SET payment_status = ? WHERE id = ?', [status, Number(req.params.id)]);
    if (!info.changes) throw new v.HttpError(404, 'Order not found.');
    res.json({ ok: true });
  }));

  // ---------- bookings ----------

  r.get('/bookings', ah(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.date) { where.push('b.date = ?'); params.push(req.query.date); }
    if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
    res.json(await db.all(`SELECT b.*, s.name AS service_name, s.duration_min FROM bookings b JOIN services s ON s.id = b.service_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.date DESC, b.time DESC LIMIT 300`, params));
  }));

  r.put('/bookings/:id/status', ah(async (req, res) => {
    const status = v.str(req.body.status, 'Status', { max: 20 });
    if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) throw new v.HttpError(400, 'Invalid status.');
    const info = await db.run('UPDATE bookings SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
    if (!info.changes) throw new v.HttpError(404, 'Booking not found.');
    res.json({ ok: true });
  }));

  r.get('/services', ah(async (_req, res) => res.json(await db.all('SELECT * FROM services ORDER BY id'))));

  r.post('/services', ah(async (req, res) => {
    const { rows } = await db.run('INSERT INTO services (name, description, duration_min, price, active) VALUES (?, ?, ?, ?, ?) RETURNING id', [
      v.str(req.body.name, 'Service name', { max: 100 }), v.str(req.body.description, 'Description', { max: 1000, optional: true }) || '',
      v.int(req.body.duration_min, 'Duration', { min: 10, max: 480 }), v.int(req.body.price, 'Price', { min: 0 }),
      req.body.active !== false,
    ]);
    res.status(201).json(await db.get('SELECT * FROM services WHERE id = ?', [rows[0].id]));
  }));

  r.put('/services/:id', ah(async (req, res) => {
    const info = await db.run('UPDATE services SET name=?, description=?, duration_min=?, price=?, active=? WHERE id=?', [
      v.str(req.body.name, 'Service name', { max: 100 }), v.str(req.body.description, 'Description', { max: 1000, optional: true }) || '',
      v.int(req.body.duration_min, 'Duration', { min: 10, max: 480 }), v.int(req.body.price, 'Price', { min: 0 }),
      req.body.active !== false, Number(req.params.id),
    ]);
    if (!info.changes) throw new v.HttpError(404, 'Service not found.');
    res.json(await db.get('SELECT * FROM services WHERE id = ?', [Number(req.params.id)]));
  }));

  r.get('/blocked-dates', ah(async (_req, res) => res.json(await db.all('SELECT * FROM blocked_dates ORDER BY date'))));
  r.post('/blocked-dates', ah(async (req, res) => {
    const date = v.str(req.body.date, 'Date', { max: 10 });
    await db.run('INSERT INTO blocked_dates (date, reason) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET reason = excluded.reason',
      [date, v.str(req.body.reason, 'Reason', { max: 200, optional: true }) || null]);
    res.status(201).json({ ok: true });
  }));
  r.delete('/blocked-dates/:date', ah(async (req, res) => {
    await db.run('DELETE FROM blocked_dates WHERE date = ?', [req.params.date]);
    res.json({ ok: true });
  }));

  // ---------- coupons ----------

  r.get('/coupons', ah(async (_req, res) => res.json(await db.all('SELECT * FROM coupons ORDER BY id DESC'))));
  r.post('/coupons', ah(async (req, res) => {
    const code = v.str(req.body.code, 'Code', { max: 30 }).toUpperCase();
    if (!['percent', 'flat'].includes(req.body.type)) throw new v.HttpError(400, 'Type must be percent or flat.');
    const { rows } = await db.run(`INSERT INTO coupons (code, type, value, min_order, max_uses, expires_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [code, req.body.type, v.int(req.body.value, 'Value', { min: 1 }),
      v.int(req.body.min_order, 'Minimum order', { min: 0, optional: true }) || 0,
      req.body.max_uses ? v.int(req.body.max_uses, 'Max uses', { min: 1 }) : null,
      req.body.expires_at || null, req.body.active !== false]);
    res.status(201).json(await db.get('SELECT * FROM coupons WHERE id = ?', [rows[0].id]));
  }));
  r.put('/coupons/:id', ah(async (req, res) => {
    const info = await db.run('UPDATE coupons SET active = ? WHERE id = ?', [!!req.body.active, Number(req.params.id)]);
    if (!info.changes) throw new v.HttpError(404, 'Coupon not found.');
    res.json(await db.get('SELECT * FROM coupons WHERE id = ?', [Number(req.params.id)]));
  }));
  r.delete('/coupons/:id', ah(async (req, res) => {
    await db.run('DELETE FROM coupons WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- customers & messages ----------

  r.get('/customers', ah(async (req, res) => {
    const search = req.query.q ? 'AND (u.name ILIKE ? OR u.email ILIKE ?)' : '';
    const params = req.query.q ? [`%${req.query.q}%`, `%${req.query.q}%`] : [];
    res.json(await db.all(`SELECT u.id, u.name, u.email, u.phone, u.created_at,
        (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = u.id) AS order_count,
        (SELECT COALESCE(SUM(total),0)::int FROM orders o WHERE o.user_id = u.id AND o.status != 'cancelled') AS lifetime_value
      FROM users u WHERE u.role = 'customer' ${search} ORDER BY u.id DESC LIMIT 300`, params));
  }));

  r.get('/messages', ah(async (req, res) => {
    res.json(await db.all(`SELECT * FROM messages ${req.query.unread ? 'WHERE is_read = false' : ''} ORDER BY id DESC LIMIT 300`));
  }));
  r.put('/messages/:id/read', ah(async (req, res) => {
    await db.run('UPDATE messages SET is_read = true WHERE id = ?', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- settings ----------

  r.get('/settings', ah(async (_req, res) => res.json(await getSettings(db))));
  r.put('/settings', ah(async (req, res) => {
    await db.tx(async (tdb) => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (req.body[key] !== undefined) {
          await tdb.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            [key, String(req.body[key])]);
        }
      }
    });
    res.json(await getSettings(db));
  }));

  // ---------- admin users (super-admin only manages via DB seed / here) ----------

  r.get('/admins', ah(async (_req, res) => res.json(await db.all("SELECT id, name, email, created_at FROM users WHERE role = 'admin'"))));
  r.post('/admins', ah(async (req, res) => {
    const name = v.str(req.body.name, 'Name', { max: 80 });
    const mail = v.email(req.body.email);
    if (await db.get('SELECT 1 FROM users WHERE email = ?', [mail])) throw new v.HttpError(409, 'Email already in use.');
    await db.run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [name, mail, hashPassword(v.password(req.body.password))]);
    res.status(201).json({ ok: true });
  }));

  return r;
};
