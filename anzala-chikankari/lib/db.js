// Postgres (Supabase) database layer: connection pool, a thin query helper that keeps the rest of the
// codebase reading like plain "?"-placeholder SQL, transactions, settings and seed data.
const { Pool } = require('pg');
const { hashPassword } = require('./auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10,
});
pool.on('error', (err) => console.error('[db] idle client error', err)); // a dropped idle connection must not crash the process

// Converts the app's SQLite-style "?" placeholders into Postgres's "$1,$2,..." so every call site can stay
// written as plain, readable SQL instead of juggling two placeholder conventions.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wraps either the pool or a single checked-out client behind the same small async API, so route code and
// business logic never need to know whether they're running inside a transaction.
// `isTx` marks a client-backed wrapper already inside a transaction, so a nested `.tx()` call (e.g. shared
// helpers like cancelOrder that may run standalone or from within a larger transaction) reuses the same
// client/connection instead of opening a second one and deadlocking against its own uncommitted locks.
function wrap(queryable, isTx = false) {
  const self = {
    async get(sql, params = []) { const r = await queryable.query(toPg(sql), params); return r.rows[0]; },
    async all(sql, params = []) { const r = await queryable.query(toPg(sql), params); return r.rows; },
    async run(sql, params = []) { const r = await queryable.query(toPg(sql), params); return { changes: r.rowCount, rows: r.rows }; },
    async tx(fn) {
      if (isTx) return fn(self); // already inside a transaction — just reuse it
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client, true));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return self;
}

const db = wrap(pool);

const SCHEMA = `
create extension if not exists citext;

create table if not exists users (
  id integer generated always as identity primary key,
  name text not null,
  email citext not null unique,
  phone text,
  password_hash text not null,
  role text not null default 'customer' check (role in ('customer','admin')),
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists categories (
  id integer generated always as identity primary key,
  name text not null,
  slug text not null unique,
  image text,
  sort_order integer not null default 0
);

create table if not exists products (
  id integer generated always as identity primary key,
  name text not null,
  slug text not null unique,
  category_id integer references categories(id) on delete set null,
  description text not null default '',
  fabric text not null default '',
  price integer not null check (price >= 0),
  compare_price integer,
  stock integer not null default 0 check (stock >= 0),
  sizes text not null default '',
  images jsonb not null default '[]'::jsonb,
  featured boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists reviews (
  id integer generated always as identity primary key,
  product_id integer not null references products(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text not null default '',
  created_at timestamptz not null default now(),
  unique (product_id, user_id)
);

create table if not exists wishlist (
  user_id integer not null references users(id) on delete cascade,
  product_id integer not null references products(id) on delete cascade,
  primary key (user_id, product_id)
);

create table if not exists coupons (
  id integer generated always as identity primary key,
  code citext not null unique,
  type text not null check (type in ('percent','flat')),
  value integer not null check (value > 0),
  min_order integer not null default 0,
  max_uses integer,
  used integer not null default 0,
  expires_at date,
  active boolean not null default true
);

create table if not exists orders (
  id integer generated always as identity primary key,
  order_no text not null unique,
  user_id integer references users(id) on delete set null,
  name text not null,
  email text not null,
  phone text not null,
  address text not null,
  city text not null,
  state text not null,
  pincode text not null,
  subtotal integer not null,
  discount integer not null default 0,
  shipping integer not null default 0,
  total integer not null,
  coupon_code text,
  payment_method text not null check (payment_method in ('cod','upi')),
  payment_status text not null default 'pending' check (payment_status in ('pending','paid','refunded')),
  status text not null default 'placed'
    check (status in ('placed','confirmed','packed','shipped','delivered','cancelled')),
  tracking_no text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists order_items (
  id integer generated always as identity primary key,
  order_id integer not null references orders(id) on delete cascade,
  product_id integer references products(id) on delete set null,
  name text not null,
  image text,
  size text,
  price integer not null,
  qty integer not null check (qty > 0)
);

create table if not exists services (
  id integer generated always as identity primary key,
  name text not null,
  description text not null default '',
  duration_min integer not null default 60,
  price integer not null default 0,
  active boolean not null default true
);

create table if not exists bookings (
  id integer generated always as identity primary key,
  booking_no text not null unique,
  service_id integer not null references services(id),
  user_id integer references users(id) on delete set null,
  name text not null,
  email text not null,
  phone text not null,
  date date not null,
  time text not null,
  notes text,
  status text not null default 'pending'
    check (status in ('pending','confirmed','completed','cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists blocked_dates (
  date date primary key,
  reason text
);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists messages (
  id integer generated always as identity primary key,
  name text not null,
  email text not null,
  phone text,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_products_category on products(category_id);
create index if not exists idx_orders_user on orders(user_id);
create index if not exists idx_orders_created on orders(created_at);
create index if not exists idx_bookings_date on bookings(date, time);
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

async function migrate() {
  await pool.query(SCHEMA);
  const stmt = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING';
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await db.run(stmt, [k, v]);
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function getSettings(dbLike = db) {
  const rows = await dbLike.all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function seed() {
  await migrate();
  const hasAdmin = (await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'")).n > 0;
  if (!hasAdmin) {
    const email = process.env.ADMIN_EMAIL || 'admin@anzalachikankari.in';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe@123';
    await db.run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
      ['Store Admin', email, hashPassword(password)]);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`[seed] Admin created: ${email} / ${password}  <-- change this password after first login`);
    }
  }

  const hasProducts = (await db.get('SELECT COUNT(*)::int AS n FROM products')).n > 0;
  if (hasProducts) return;

  await db.tx(async (tdb) => {
    for (let i = 0; i < SEED_CATEGORIES.length; i++) {
      const c = SEED_CATEGORIES[i];
      await tdb.run('INSERT INTO categories (name, slug, image, sort_order) VALUES (?, ?, ?, ?)', [c.name, c.slug, c.image, i]);
    }
    const catRows = await tdb.all('SELECT id, slug FROM categories');
    const catId = Object.fromEntries(catRows.map((r) => [r.slug, r.id]));

    for (const [name, cat, price, compare, fabric, sizes, stock, featured, img, desc] of SEED_PRODUCTS) {
      await tdb.run(`INSERT INTO products
        (name, slug, category_id, description, fabric, price, compare_price, stock, sizes, images, featured)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, slugify(name), catId[cat], desc, fabric, price, compare, stock, sizes, JSON.stringify([IMG(img)]), !!featured]);
    }

    for (const s of SEED_SERVICES) {
      await tdb.run('INSERT INTO services (name, description, duration_min, price) VALUES (?, ?, ?, ?)', s);
    }

    await tdb.run("INSERT INTO coupons (code, type, value, min_order) VALUES ('WELCOME10', 'percent', 10, 1999)");
    await tdb.run("INSERT INTO coupons (code, type, value, min_order) VALUES ('FLAT500', 'flat', 500, 4999)");
  });
  console.log('[seed] Sample categories, products, services and coupons added.');
}

module.exports = { pool, db, migrate, seed, slugify, getSettings, DEFAULT_SETTINGS };

if (require.main === module && process.argv.includes('--reset')) {
  (async () => {
    await pool.query(`
      drop table if exists messages, blocked_dates, settings, bookings, services, order_items, orders,
        coupons, wishlist, reviews, products, categories, sessions, users cascade;
    `);
    await seed();
    console.log('[seed] Database reset and reseeded.');
    await pool.end();
  })().catch((err) => { console.error(err); process.exit(1); });
}
