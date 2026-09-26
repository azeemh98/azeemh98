// Shared storefront logic: API client, cart (persisted in localStorage), auth state, header/footer chrome.
const api = {
  async req(method, url, body) {
    const res = await fetch(`/api${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Something went wrong.'), { status: res.status, details: data?.details });
    return data;
  },
  get(url) { return this.req('GET', url); },
  post(url, body) { return this.req('POST', url, body || {}); },
  put(url, body) { return this.req('PUT', url, body || {}); },
  del(url) { return this.req('DELETE', url); },
};

function toast(message, isError) {
  const el = document.getElementById('toast');
  if (!el) return alert(message);
  el.textContent = message;
  el.style.background = isError ? '#b23b3b' : '#111';
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
// Escapes text before it's interpolated into an HTML template — product names, review text and
// anything else that ultimately comes from a customer or admin input field must go through this.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ---------- cart (client-side; server always re-prices via /cart/quote before checkout) ----------
const Cart = {
  KEY: 'anzala_cart',
  read() { try { return JSON.parse(localStorage.getItem(this.KEY)) || []; } catch { return []; } },
  write(items) { localStorage.setItem(this.KEY, JSON.stringify(items)); document.dispatchEvent(new Event('cart:change')); },
  add(productId, size, qty = 1) {
    const items = this.read();
    const line = items.find((i) => i.product_id === productId && i.size === size);
    if (line) line.qty = Math.min(10, line.qty + qty); else items.push({ product_id: productId, size, qty });
    this.write(items);
  },
  setQty(productId, size, qty) {
    const items = this.read().map((i) => (i.product_id === productId && i.size === size ? { ...i, qty } : i)).filter((i) => i.qty > 0);
    this.write(items);
  },
  remove(productId, size) { this.write(this.read().filter((i) => !(i.product_id === productId && i.size === size))); },
  clear() { this.write([]); },
  count() { return this.read().reduce((s, i) => s + i.qty, 0); },
};

// ---------- wishlist (server-backed when logged in, local fallback otherwise) ----------
const Wishlist = {
  KEY: 'anzala_wishlist',
  readLocal() { try { return JSON.parse(localStorage.getItem(this.KEY)) || []; } catch { return []; } },
  writeLocal(ids) { localStorage.setItem(this.KEY, JSON.stringify(ids)); },
  async list() {
    if (Auth.user) return (await api.get('/wishlist')).map((p) => p.id);
    return this.readLocal();
  },
  async toggle(productId) {
    if (Auth.user) {
      const mine = await this.list();
      if (mine.includes(productId)) await api.del(`/wishlist/${productId}`); else await api.post(`/wishlist/${productId}`);
    } else {
      const ids = this.readLocal();
      this.writeLocal(ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId]);
    }
  },
};

// ---------- auth ----------
const Auth = {
  user: null,
  async refresh() { this.user = await api.get('/auth/me').catch(() => null); document.dispatchEvent(new Event('auth:change')); return this.user; },
  async login(email, password) { const u = await api.post('/auth/login', { email, password }); await this.refresh(); return u; },
  async register(payload) { const u = await api.post('/auth/register', payload); await this.refresh(); return u; },
  async logout() { await api.post('/auth/logout'); await this.refresh(); },
};

// ---------- shared chrome (header/footer) ----------
const CHROME = {
  header: (active) => `
    <header class="site">
      <a href="/" class="logo">Anzala</a>
      <button class="menu-toggle" id="menuToggle" aria-label="Menu">☰</button>
      <nav class="main-nav" id="mainNav">
        <a href="/" class="${active === 'home' ? 'active' : ''}">Home</a>
        <a href="/shop.html" class="${active === 'shop' ? 'active' : ''}">Shop</a>
        <a href="/shop.html?category=bridal" class="${active === 'bridal' ? 'active' : ''}">Bridal</a>
        <a href="/booking.html" class="${active === 'booking' ? 'active' : ''}">Book Appointment</a>
        <a href="/about.html" class="${active === 'about' ? 'active' : ''}">About</a>
        <a href="/contact.html" class="${active === 'contact' ? 'active' : ''}">Contact</a>
      </nav>
      <div class="header-actions">
        <div class="search-box"><span>🔍</span><input id="quickSearch" placeholder="Search sarees, kurtis…" /></div>
        <button class="icon-btn" id="accountBtn" title="Account">👤</button>
        <a class="icon-btn" href="/account.html?tab=orders" title="Track Order">📦</a>
        <button class="icon-btn" id="cartBtn" title="Bag">🛍️<span class="badge" id="cartCount">0</span></button>
      </div>
    </header>`,
  footer: (settings) => `
    <footer class="site">
      <div class="container">
        <div class="footer-grid">
          <div>
            <h4>Anzala Chikankari</h4>
            <p style="font-size:13px;line-height:1.7;max-width:280px;">${settings?.store_tagline || ''}<br><br>
              ${settings?.store_address || ''}</p>
          </div>
          <div><h4>Shop</h4>
            <a href="/shop.html?category=kurtis">Kurtis</a><a href="/shop.html?category=sarees">Sarees</a>
            <a href="/shop.html?category=men">Men</a><a href="/shop.html?category=bridal">Bridal</a>
          </div>
          <div><h4>Support</h4>
            <a href="/account.html?tab=orders">Track Order</a><a href="/booking.html">Book Appointment</a>
            <a href="/contact.html">Contact Us</a><a href="/about.html">About Us</a>
          </div>
          <div><h4>Get in touch</h4>
            <a href="mailto:${settings?.store_email || ''}">${settings?.store_email || ''}</a>
            <a href="tel:${settings?.store_phone || ''}">${settings?.store_phone || ''}</a>
            <a href="https://wa.me/${settings?.whatsapp || ''}" target="_blank" rel="noopener">Chat on WhatsApp</a>
          </div>
        </div>
        <div class="footer-bottom">© ${new Date().getFullYear()} Anzala Chikankari — Authentic Handmade Lucknowi Heritage Fashion.</div>
      </div>
    </footer>
    <a class="whatsapp-fab" href="https://wa.me/${settings?.whatsapp || ''}" target="_blank" rel="noopener" title="Chat on WhatsApp">💬</a>
    <div id="toast"></div>`,
};

let SETTINGS = null;
async function mountChrome(active) {
  document.getElementById('headerMount').innerHTML = CHROME.header(active);
  SETTINGS = await api.get('/config').catch(() => ({}));
  document.getElementById('footerMount').innerHTML = CHROME.footer(SETTINGS);
  wireChromeEvents();
  updateCartBadge();
  await Auth.refresh();
  buildCartPanel();
}

function updateCartBadge() {
  const badge = document.getElementById('cartCount');
  if (badge) badge.textContent = Cart.count();
}
document.addEventListener('cart:change', updateCartBadge);

function wireChromeEvents() {
  document.getElementById('menuToggle')?.addEventListener('click', () => document.getElementById('mainNav').classList.toggle('open'));
  document.getElementById('cartBtn')?.addEventListener('click', openCart);
  document.getElementById('accountBtn')?.addEventListener('click', () => {
    if (Auth.user) window.location.href = '/account.html'; else openAuthModal();
  });
  const search = document.getElementById('quickSearch');
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && search.value.trim()) window.location.href = `/shop.html?q=${encodeURIComponent(search.value.trim())}`;
  });
}

// ---------- cart drawer (built once into the page) ----------
function buildCartPanel() {
  if (document.getElementById('cartPanel')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="overlay" id="cartOverlay"></div>
    <div class="cart-panel" id="cartPanel">
      <div class="cart-head"><h2>Your Bag</h2><button class="modal-close" id="closeCart">✕</button></div>
      <div class="cart-items" id="cartItems"></div>
      <div class="cart-footer" id="cartFooter"></div>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById('closeCart').addEventListener('click', closeCart);
  document.getElementById('cartOverlay').addEventListener('click', closeCart);
  document.addEventListener('cart:change', renderCart);
}

function openCart() { document.getElementById('cartPanel').classList.add('active'); document.getElementById('cartOverlay').classList.add('active'); renderCart(); }
function closeCart() { document.getElementById('cartPanel').classList.remove('active'); document.getElementById('cartOverlay').classList.remove('active'); }

let lastQuote = null;
async function renderCart() {
  const itemsEl = document.getElementById('cartItems');
  const footerEl = document.getElementById('cartFooter');
  if (!itemsEl) return;
  const items = Cart.read();
  if (!items.length) {
    itemsEl.innerHTML = `<div class="empty-state"><p>Your bag is empty.</p><a class="btn btn-dark" href="/shop.html">Start Shopping</a></div>`;
    footerEl.innerHTML = '';
    return;
  }
  itemsEl.innerHTML = '<p style="text-align:center;color:#999;padding:20px 0;">Loading…</p>';
  let quote;
  try { quote = await api.post('/cart/quote', { items, coupon: sessionStorage.getItem('anzala_coupon') || undefined }); }
  catch { itemsEl.innerHTML = '<p class="msg-error">Could not load your bag. Please try again.</p>'; return; }
  lastQuote = quote;

  itemsEl.innerHTML = quote.lines.map((l) => `
    <div class="cart-item">
      <img src="${l.image || ''}" alt="">
      <div class="cart-item-body">
        <h4>${l.name}</h4>
        <div class="cart-item-meta">${l.size ? `Size: ${l.size} · ` : ''}${money(l.price)}${l.out_of_stock ? ' · <span style="color:#b23b3b">low stock</span>' : ''}</div>
        <div class="cart-item-controls">
          <div class="qty-control">
            <button data-act="dec" data-pid="${l.product_id}" data-size="${l.size || ''}">−</button>
            <span>${l.qty}</span>
            <button data-act="inc" data-pid="${l.product_id}" data-size="${l.size || ''}">+</button>
          </div>
          <button class="remove-link" data-act="rm" data-pid="${l.product_id}" data-size="${l.size || ''}">Remove</button>
        </div>
      </div>
    </div>`).join('');

  itemsEl.querySelectorAll('button[data-act]').forEach((btn) => btn.addEventListener('click', () => {
    const pid = Number(btn.dataset.pid);
    const size = btn.dataset.size || null;
    const line = items.find((i) => i.product_id === pid && i.size === size);
    if (btn.dataset.act === 'inc') Cart.setQty(pid, size, (line?.qty || 0) + 1);
    if (btn.dataset.act === 'dec') Cart.setQty(pid, size, (line?.qty || 0) - 1);
    if (btn.dataset.act === 'rm') Cart.remove(pid, size);
  }));

  const errors = quote.errors.length ? `<p class="msg-error">${quote.errors.join(' ')}</p>` : '';
  footerEl.innerHTML = `
    ${errors}
    <div class="coupon-row">
      <input id="couponInput" placeholder="Coupon code" value="${quote.coupon ? quote.coupon.code : (sessionStorage.getItem('anzala_coupon') || '')}">
      <button class="btn btn-outline btn-sm" id="applyCoupon">Apply</button>
    </div>
    ${quote.coupon_error ? `<p class="msg-error">${quote.coupon_error}</p>` : ''}
    ${quote.coupon ? `<p class="msg-success">"${quote.coupon.code}" applied.</p>` : ''}
    <div class="summary-row"><span>Subtotal</span><span>${money(quote.subtotal)}</span></div>
    ${quote.discount ? `<div class="summary-row"><span>Discount</span><span>−${money(quote.discount)}</span></div>` : ''}
    <div class="summary-row"><span>Shipping</span><span>${quote.shipping ? money(quote.shipping) : 'FREE'}</span></div>
    <div class="summary-row total"><span>Total</span><span>${money(quote.total)}</span></div>
    <a class="btn btn-primary btn-block" style="margin-top:16px" href="/checkout.html">Checkout</a>`;

  document.getElementById('applyCoupon')?.addEventListener('click', () => {
    const code = document.getElementById('couponInput').value.trim();
    if (code) sessionStorage.setItem('anzala_coupon', code); else sessionStorage.removeItem('anzala_coupon');
    renderCart();
  });
}

// ---------- auth modal ----------
function openAuthModal() {
  let modal = document.getElementById('authModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'authModal';
    modal.innerHTML = `
      <div class="modal-box">
        <button class="modal-close" id="authClose">✕</button>
        <div class="modal-tabs">
          <button data-tab="login" class="active">Log In</button>
          <button data-tab="register">Create Account</button>
        </div>
        <form id="loginForm">
          <div class="form-row"><label>Email</label><input type="email" name="email" required></div>
          <div class="form-row"><label>Password</label><input type="password" name="password" required></div>
          <p class="field-error" id="loginError"></p>
          <button class="btn btn-dark btn-block" type="submit">Log In</button>
        </form>
        <form id="registerForm" style="display:none">
          <div class="form-row"><label>Full Name</label><input name="name" required></div>
          <div class="form-row"><label>Email</label><input type="email" name="email" required></div>
          <div class="form-row"><label>Phone</label><input name="phone" placeholder="10-digit mobile"></div>
          <div class="form-row"><label>Password</label><input type="password" name="password" minlength="8" required></div>
          <p class="field-error" id="registerError"></p>
          <button class="btn btn-dark btn-block" type="submit">Create Account</button>
        </form>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeAuthModal(); });
    document.getElementById('authClose').addEventListener('click', closeAuthModal);
    modal.querySelectorAll('.modal-tabs button').forEach((tab) => tab.addEventListener('click', () => {
      modal.querySelectorAll('.modal-tabs button').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('loginForm').style.display = tab.dataset.tab === 'login' ? 'block' : 'none';
      document.getElementById('registerForm').style.display = tab.dataset.tab === 'register' ? 'block' : 'none';
    }));
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await Auth.login(f.get('email'), f.get('password')); closeAuthModal(); toast('Welcome back!'); }
      catch (err) { document.getElementById('loginError').textContent = err.message; }
    });
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await Auth.register({ name: f.get('name'), email: f.get('email'), phone: f.get('phone'), password: f.get('password') });
        closeAuthModal(); toast('Account created!');
      } catch (err) { document.getElementById('registerError').textContent = err.message; }
    });
  }
  modal.classList.add('active');
}
function closeAuthModal() { document.getElementById('authModal')?.classList.remove('active'); }

function starRow(rating) {
  const full = Math.round(rating || 0);
  return `<span class="stars">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`;
}

function qs(name) { return new URLSearchParams(window.location.search).get(name); }

// ---------- product card (shared by home / shop / related-products) ----------
// Note: data attributes carry the product info instead of inline onclick handlers,
// since embedding JSON (double quotes) inside a double-quoted HTML attribute breaks parsing.
function productCard(p) {
  return `
  <a class="product-card" href="/product.html?slug=${encodeURIComponent(p.slug)}">
    <div class="product-media">
      <img src="${esc(p.images[0] || '')}" alt="${esc(p.name)}" loading="lazy">
      ${p.compare_price ? `<span class="badge-sale">-${Math.round(100 - (p.price / p.compare_price) * 100)}%</span>` : ''}
      ${p.stock <= 3 && p.stock > 0 ? `<span class="badge-stock">Only ${p.stock} left</span>` : ''}
      ${p.stock === 0 ? `<span class="badge-stock">Sold out</span>` : ''}
      <button class="wish-btn" data-wish="${p.id}">♡</button>
    </div>
    <div class="product-info">
      <h3>${esc(p.name)}</h3>
      <p class="product-fabric">${esc(p.fabric || '')}</p>
      ${p.rating ? `<div class="rating-row">${starRow(p.rating)} ${p.rating} (${p.review_count || 0})</div>` : ''}
      <div class="price-row"><span class="price">${money(p.price)}</span>${p.compare_price ? `<span class="price-compare">${money(p.compare_price)}</span>` : ''}</div>
      <button class="add-btn" ${p.stock === 0 ? 'disabled' : ''} data-quickadd="${p.id}" data-slug="${esc(p.slug)}" data-has-sizes="${p.sizes.length ? '1' : ''}">${p.stock === 0 ? 'Sold Out' : (p.sizes.length ? 'Select Options' : 'Add To Bag')}</button>
    </div>
  </a>`;
}

function quickAdd(id, slug, hasSizes) {
  if (hasSizes) { window.location.href = `/product.html?slug=${slug}#size`; return; }
  Cart.add(id, null, 1);
  toast('Added to your bag');
}

async function wireProductCards() {
  document.querySelectorAll('[data-quickadd]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      quickAdd(Number(btn.dataset.quickadd), btn.dataset.slug, btn.dataset.hasSizes === '1');
    });
  });
  const wished = await Wishlist.list().catch(() => []);
  document.querySelectorAll('[data-wish]').forEach((btn) => {
    const id = Number(btn.dataset.wish);
    if (wished.includes(id)) { btn.classList.add('active'); btn.textContent = '♥'; }
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      await Wishlist.toggle(id);
      btn.classList.toggle('active');
      btn.textContent = btn.classList.contains('active') ? '♥' : '♡';
      toast(btn.classList.contains('active') ? 'Added to wishlist' : 'Removed from wishlist');
    });
  });
}
