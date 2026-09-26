# Anzala Chikankari

A full e-commerce site for a Lucknowi chikankari fashion brand: storefront, shopping
cart & checkout, a booking engine for in-store/bridal appointments, customer accounts,
and an admin panel with a dashboard, catalogue, order and booking management.

Single Node.js process, zero external services required to run locally — it uses
Node's built-in `node:sqlite` for storage, so there's nothing to install or provision.

## Features

**Storefront**
- Home, category browsing, search & filters (price, category, sort)
- Product detail pages with image gallery, sizes, stock, ratings & verified reviews
- Cart drawer with live server-side pricing, coupons and free-shipping threshold
- Checkout with address form, COD / UPI payment, and stock-safe order placement
- Customer accounts: order history + cancellation, appointment history, wishlist, profile
- Guest order tracking by order number + email
- Booking engine: pick a service, see a live calendar with real slot availability
  (respects opening hours, slot length, per-slot capacity, blocked dates, lead time)
- Contact form, WhatsApp button, responsive layout

**Admin panel** (`/admin`)
- Dashboard: revenue (30d), orders today, pending orders, low stock, upcoming
  bookings, a sales chart and top-products table
- Products: create/edit/delete (soft-archives if it has order history), image
  upload, sizes, pricing, stock, featured flag
- Categories, Coupons (percent/flat, min order, usage caps, expiry)
- Orders: search/filter, status workflow (placed → confirmed → packed → shipped →
  delivered, or cancelled with automatic restock), payment status, tracking number
- Bookings: confirm/complete/cancel, block out dates
- Services (what can be booked), Customers (lifetime value), Contact messages
- Store settings: shipping fee/threshold, contact details, booking hours & capacity
- Multiple admin users

## Getting started

```bash
npm install
npm run seed   # creates the DB, an admin user and sample products/services
npm start      # http://localhost:3000  (storefront)  /admin (admin panel)
```

The seed step prints the generated admin login if `ADMIN_EMAIL`/`ADMIN_PASSWORD`
aren't set in the environment — **change that password after your first login**.

For development with auto-restart: `npm run dev`.

## Configuration

Copy `.env.example` to `.env` to override defaults (port, DB file location, initial
admin credentials, timezone). All store-facing settings (shipping fee, contact info,
booking hours, UPI ID, etc.) are edited from **Admin → Settings** at runtime — no
redeploy needed.

## Architecture

```
server.js           Express app: static files, API mounting, error handling, rate limits
lib/db.js            Schema (SQLite), settings, seed data
lib/auth.js          Password hashing, cookie sessions, requireUser/requireAdmin
lib/logic.js         Validation, cart pricing, booking slot availability — the business rules
routes/store.js      Public + customer API (catalogue, cart, orders, bookings, account)
routes/admin.js       Admin-only API (dashboard, CRUD, order/booking workflow, settings)
public/              Storefront (static HTML/CSS/vanilla JS, no build step)
public/admin/         Admin panel (single-page app, hash-routed, vanilla JS)
test/                 API test suite (node:test) against an in-memory DB
```

All pricing (cart totals, coupons, shipping) and booking slot availability are
computed **server-side only** — the client never sends a price, so it can't be
tampered with from the browser.

## Running tests

```bash
npm test
```

## Notes on going to production

- Put this behind HTTPS (a reverse proxy like Caddy/Nginx, or your host's TLS) —
  session cookies are marked `secure` automatically when `NODE_ENV=production`.
- Back up `data/anzala.db` regularly (or point `DB_FILE` at a persistent volume).
- Wire up real payment gateway + SMS/email notifications when you're ready — the
  order/booking hooks (`routes/store.js`) are the natural place to add them.
