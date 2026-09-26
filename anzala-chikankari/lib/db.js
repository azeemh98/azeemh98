// SQLite database: schema, default settings and seed data.
// Uses Node's built-in `node:sqlite` so there is no native dependency to compile.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'anzala.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  image TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  fabric TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK (price >= 0),
  compare_price INTEGER,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sizes TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, user_id)
);

CREATE TABLE IF NOT EXISTS wishlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('percent','flat')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_order INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  shipping INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  coupon_code TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod','upi')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','refunded')),
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed','confirmed','packed','shipped','delivered','cancelled')),
  tracking_no TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  image TEXT,
  size TEXT,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 60,
  price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_no TEXT NOT NULL UNIQUE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  date TEXT PRIMARY KEY,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, time);
`;

const DEFAULT_SETTINGS = {
  store_name: 'Anzala Chikankari',
  store_tagline: 'Handcrafted Luxury From The Heart Of Lucknow',
  store_email: 'hello@anzalachikankari.in',
  store_phone: '+91 90000 00000',
  store_address: 'Chowk, Lucknow, Uttar Pradesh 226003',
  whatsapp: '919000000000',
  upi_id: 'anzala@upi',
  shipping_fee: '99',
  free_shipping_min: '2999',
  booking_open: '11:00',
  booking_close: '19:00',
  booking_slot_minutes: '60',
  booking_slot_capacity: '2',
  booking_closed_weekdays: '0', // comma separated, 0 = Sunday
  booking_max_days_ahead: '60',
};

const IMG = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=80`;

const SEED_CATEGORIES = [
  { name: 'Kurtis', slug: 'kurtis', image: IMG('photo-1583391733956-6c78276477e2') },
  { name: 'Sarees', slug: 'sarees', image: IMG('photo-1610189012900-2e0a6c8b6e93') },
  { name: 'Suits & Sets', slug: 'suits', image: IMG('photo-1610030469983-98e550d6193c') },
  { name: 'Men Collection', slug: 'men', image: IMG('photo-1597983073493-88cd35cf93b0') },
  { name: 'Bridal Wear', slug: 'bridal', image: IMG('photo-1595777457583-95e059d581b8') },
];

const SEED_PRODUCTS = [
  ['Ivory Shadow Work Kurti', 'kurtis', 2499, 2999, 'Pure Georgette', 'S,M,L,XL,XXL', 18, 1, 'photo-1583391733956-6c78276477e2',
    'An ivory georgette kurti hand-embroidered with delicate bakhiya (shadow work) by artisans in Lucknow. Straight fit, three-quarter sleeves.'],
  ['Mint Mukaish Anarkali Kurti', 'kurtis', 3299, null, 'Cotton Mul', 'S,M,L,XL', 12, 1, 'photo-1617627143750-d86bc21e42bb',
    'Flared mint anarkali in breathable mul cotton with hand-done mukaish sparkle and phanda knots.'],
  ['Rose Pink Straight Kurti', 'kurtis', 1899, 2299, 'Cotton', 'S,M,L,XL,XXL', 30, 0, 'photo-1614252235316-8c857d38b5f4',
    'An everyday cotton kurti in rose pink with jaali and tepchi work along the yoke and hem.'],
  ['Royal Chikankari Saree', 'sarees', 5999, 6999, 'Pure Georgette', 'Free Size', 8, 1, 'photo-1610189012900-2e0a6c8b6e93',
    'Six yards of georgette with an all-over chikankari jaal and a heavily worked pallu. Comes with an unstitched blouse piece.'],
  ['Ivory Organza Saree', 'sarees', 7499, null, 'Organza', 'Free Size', 5, 0, 'photo-1583391733981-8498408ee48b',
    'Sheer organza saree with hand-embroidered floral butis and a scalloped border.'],
  ['Pastel Embroidery Suit', 'suits', 3499, 3999, 'Georgette', 'S,M,L,XL', 14, 1, 'photo-1610030469983-98e550d6193c',
    'Three-piece suit set: embroidered kurta, matching palazzo and a chiffon dupatta with chikankari border.'],
  ['Sky Blue Sharara Set', 'suits', 4599, null, 'Modal', 'S,M,L,XL', 9, 0, 'photo-1585487000160-6ebcfceb0d03',
    'Short kurta with a flared sharara, finished with gota and chikankari detailing. Ideal for festive days.'],
  ['White Chikan Kurta for Men', 'men', 2199, 2599, 'Cotton', 'S,M,L,XL,XXL', 22, 1, 'photo-1597983073493-88cd35cf93b0',
    'Classic white cotton kurta for men with fine chikan work on the placket and cuffs.'],
  ['Beige Mul Kurta Pyjama Set', 'men', 3199, null, 'Mul Cotton', 'M,L,XL,XXL', 3, 0, 'photo-1622122201714-77da0ca8e5d2',
    'Kurta pyjama set in beige mul with tone-on-tone embroidery. Soft enough for all-day wear.'],
  ['Bridal Lehenga with Zardozi & Chikan', 'bridal', 24999, 29999, 'Silk Georgette', 'Made to Measure', 2, 1, 'photo-1595777457583-95e059d581b8',
    'A statement bridal lehenga combining chikankari with zardozi and pearl work. Stitched to your measurements; book a fitting appointment after ordering.'],
];

const SEED_SERVICES = [
  ['Custom Stitching & Measurement', 'Get measured by our master tailor for made-to-measure kurtis, suits and blouses.', 45, 0],
  ['Bridal Consultation', 'One-on-one session with our designer to plan your bridal or trousseau chikankari ensemble.', 90, 500],
  ['Store Visit / Private Viewing', 'Reserve a slot at our Chowk boutique to browse the full collection with a stylist.', 60, 0],
  ['Video Call Shopping', 'Shop live over a WhatsApp video call with a stylist from anywhere in the world.', 30, 0],
];

function open(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function seed(db) {
  const hasProducts = db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0;
  const hasAdmin = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n > 0;

  if (!hasAdmin) {
    const email = process.env.ADMIN_EMAIL || 'admin@anzalachikankari.in';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe@123';
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run('Store Admin', email, hashPassword(password));
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`[seed] Admin created: ${email} / ${password}  <-- change this password after first login`);
    }
  }

  if (hasProducts) return;
  transaction(db, () => {
    const insCat = db.prepare('INSERT INTO categories (name, slug, image, sort_order) VALUES (?, ?, ?, ?)');
    SEED_CATEGORIES.forEach((c, i) => insCat.run(c.name, c.slug, c.image, i));
    const catId = Object.fromEntries(db.prepare('SELECT id, slug FROM categories').all().map((r) => [r.slug, r.id]));

    const insProd = db.prepare(`INSERT INTO products
      (name, slug, category_id, description, fabric, price, compare_price, stock, sizes, images, featured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [name, cat, price, compare, fabric, sizes, stock, featured, img, desc] of SEED_PRODUCTS) {
      insProd.run(name, slugify(name), catId[cat], desc, fabric, price, compare, stock, sizes,
        JSON.stringify([IMG(img)]), featured);
    }

    const insSvc = db.prepare('INSERT INTO services (name, description, duration_min, price) VALUES (?, ?, ?, ?)');
    for (const s of SEED_SERVICES) insSvc.run(...s);

    db.prepare("INSERT INTO coupons (code, type, value, min_order) VALUES ('WELCOME10', 'percent', 10, 1999)").run();
    db.prepare("INSERT INTO coupons (code, type, value, min_order) VALUES ('FLAT500', 'flat', 500, 4999)").run();
  });
  console.log('[seed] Sample categories, products, services and coupons added.');
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

module.exports = { open, seed, transaction, slugify, getSettings, DEFAULT_SETTINGS, DB_FILE };

if (require.main === module && process.argv.includes('--reset')) {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
  const db = open();
  seed(db);
  db.close();
  console.log(`[seed] Fresh database written to ${DB_FILE}`);
}
