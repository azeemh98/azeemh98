// Anzala Chikankari — admin panel SPA. Hash-based routing, one file per section renderer.
const api = {
  async req(method, url, body, isForm) {
    const res = await fetch(`/api${url}`, {
      method,
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
      body: isForm ? body : (body ? JSON.stringify(body) : undefined),
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Request failed.'), { status: res.status });
    return data;
  },
  get(url) { return this.req('GET', url); },
  post(url, body, isForm) { return this.req('POST', url, body ?? {}, isForm); },
  put(url, body) { return this.req('PUT', url, body ?? {}); },
  del(url) { return this.req('DELETE', url); },
};

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const dt = (s) => new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function toast(msg, isError) {
  const el = document.getElementById('adminToast');
  el.textContent = msg; el.style.background = isError ? '#b23b3b' : '#111';
  el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

const ROUTES = [
  ['dashboard', 'Dashboard', '📊'],
  ['products', 'Products', '🧵'],
  ['categories', 'Categories', '🗂️'],
  ['orders', 'Orders', '📦'],
  ['bookings', 'Bookings', '📅'],
  ['services', 'Services', '🛎️'],
  ['coupons', 'Coupons', '🏷️'],
  ['customers', 'Customers', '👥'],
  ['messages', 'Messages', '✉️'],
  ['settings', 'Settings', '⚙️'],
];

let ME = null;

async function boot() {
  ME = await api.get('/auth/me').catch(() => null);
  if (!ME || ME.role !== 'admin') return showLogin();
  showApp();
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const user = await api.post('/auth/login', { email: f.get('email'), password: f.get('password') });
      if (user.role !== 'admin') throw new Error('This account does not have admin access.');
      ME = user; showApp();
    } catch (err) { document.getElementById('loginError').textContent = err.message; }
  }, { once: true });
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'flex';
  document.getElementById('adminName').textContent = ME.name;
  document.getElementById('sidebarNav').innerHTML = ROUTES.map(([key, label, icon]) => `<a href="#${key}" data-key="${key}">${icon} ${label}</a>`).join('');
  document.getElementById('logoutBtn').addEventListener('click', async () => { await api.post('/auth/logout'); window.location.reload(); });
  document.getElementById('menuToggle').style.display = 'inline-flex';
  document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const key = (window.location.hash || '#dashboard').slice(1);
  document.querySelectorAll('#sidebarNav a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
  document.getElementById('sidebar').classList.remove('open');
  const found = ROUTES.find((r) => r[0] === key) || ROUTES[0];
  document.getElementById('pageTitle').textContent = found[1];
  const renderer = { dashboard: renderDashboard, products: renderProducts, categories: renderCategories, orders: renderOrders,
    bookings: renderBookings, services: renderServices, coupons: renderCoupons, customers: renderCustomers,
    messages: renderMessages, settings: renderSettings }[found[0]];
  document.getElementById('content').innerHTML = '<p class="empty">Loading…</p>';
  renderer().catch((e) => { document.getElementById('content').innerHTML = `<p class="field-error">${esc(e.message)}</p>`; });
}

// ---------- dashboard ----------
async function renderDashboard() {
  const d = await api.get('/admin/dashboard');
  const k = d.kpis;
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><div class="label">Revenue (30 days)</div><div class="value">${money(k.revenue_30d)}</div></div>
      <div class="kpi-card"><div class="label">Orders Today</div><div class="value">${k.orders_today}</div></div>
      <div class="kpi-card ${k.pending_orders ? 'warn' : ''}"><div class="label">Pending Orders</div><div class="value">${k.pending_orders}</div></div>
      <div class="kpi-card ${k.low_stock ? 'warn' : ''}"><div class="label">Low Stock Items</div><div class="value">${k.low_stock}</div></div>
      <div class="kpi-card"><div class="label">Upcoming Bookings</div><div class="value">${k.bookings_upcoming}</div></div>
      <div class="kpi-card"><div class="label">Customers</div><div class="value">${k.customers}</div></div>
    </div>
    <div class="panel">
      <h3>Sales — Last 30 Days</h3>
      <svg id="salesChart" width="100%" height="180" viewBox="0 0 600 180" preserveAspectRatio="none"></svg>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;">
      <div class="panel">
        <h3>Recent Orders</h3>
        <div class="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${d.recent_orders.map((o) => `<tr><td><a href="#orders">${o.order_no}</a></td><td>${esc(o.name)}</td><td>${money(o.total)}</td><td><span class="pill pill-${o.status}">${o.status}</span></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No orders yet.</td></tr>'}</tbody></table></div>
      </div>
      <div class="panel">
        <h3>Top Products (30 days)</h3>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>Units</th><th>Revenue</th></tr></thead>
        <tbody>${d.top_products.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.units}</td><td>${money(p.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No sales yet.</td></tr>'}</tbody></table></div>
      </div>
    </div>
    <div class="panel">
      <h3>Low Stock Alert</h3>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th>Stock Left</th></tr></thead>
      <tbody>${d.low_stock_products.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.stock}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">All stocked up.</td></tr>'}</tbody></table></div>
    </div>`;
  drawSalesChart(d.sales_by_day);
}

function drawSalesChart(rows) {
  const svg = document.getElementById('salesChart');
  if (!rows.length) { svg.outerHTML = '<p class="empty">No sales in this period yet.</p>'; return; }
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  const w = 600, h = 180, pad = 10;
  const pts = rows.map((r, i) => {
    const x = pad + (i / Math.max(rows.length - 1, 1)) * (w - pad * 2);
    const y = h - pad - (r.revenue / max) * (h - pad * 2);
    return [x, y];
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${path} L${pts[pts.length - 1][0]},${h - pad} L${pts[0][0]},${h - pad} Z`;
  svg.innerHTML = `
    <path d="${area}" fill="#b08b3222"></path>
    <path d="${path}" fill="none" stroke="#b08b32" stroke-width="2.5"></path>
    ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#b08b32"><title>${rows[i].date}: ${money(rows[i].revenue)}</title></circle>`).join('')}`;
}

// ---------- categories ----------
async function renderCategories() {
  const cats = await api.get('/admin/categories');
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3 style="margin:0;">Categories</h3><button class="btn" id="addCatBtn">+ Add Category</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Slug</th><th>Products</th><th></th></tr></thead>
      <tbody>${cats.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.slug}</td><td>${c.product_count ?? ''}</td>
        <td><button class="btn btn-outline btn-sm" data-edit="${c.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-del="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No categories yet.</td></tr>'}</tbody></table></div>
    </div>`;
  document.getElementById('addCatBtn').addEventListener('click', () => categoryModal());
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => categoryModal(cats.find((c) => c.id == b.dataset.edit))));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this category?')) return;
    try { await api.del(`/admin/categories/${b.dataset.del}`); toast('Category deleted'); route(); } catch (e) { toast(e.message, true); }
  }));
}

function categoryModal(existing) {
  openModal(`${existing ? 'Edit' : 'Add'} Category`, `
    <form id="catForm">
      <div class="field"><label>Name</label><input name="name" value="${esc(existing?.name || '')}" required></div>
      <div class="field"><label>Image URL</label><input name="image" value="${esc(existing?.image || '')}"></div>
      <div class="field"><label>Sort Order</label><input type="number" name="sort_order" value="${existing?.sort_order ?? 0}"></div>
      <p class="field-error" id="catError"></p>
      <button class="btn btn-gold" type="submit">${existing ? 'Save Changes' : 'Add Category'}</button>
    </form>`);
  document.getElementById('catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (existing) await api.put(`/admin/categories/${existing.id}`, f); else await api.post('/admin/categories', f);
      closeModal(); toast('Saved'); route();
    } catch (err) { document.getElementById('catError').textContent = err.message; }
  });
}

// ---------- products ----------
let productCache = { items: [], categories: [] };
async function renderProducts() {
  const [products, categories] = await Promise.all([api.get('/admin/products'), api.get('/admin/categories')]);
  productCache = { items: products, categories };
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <input id="prodSearch" placeholder="Search products…" style="max-width:240px;">
        <button class="btn" id="addProdBtn">+ Add Product</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead>
      <tbody id="prodRows"></tbody></table></div>
    </div>`;
  const renderRows = (list) => {
    document.getElementById('prodRows').innerHTML = list.map((p) => `
      <tr>
        <td><img src="${p.images[0] || ''}" style="width:42px;height:52px;object-fit:cover;border-radius:6px;"></td>
        <td>${esc(p.name)}${p.featured ? ' ⭐' : ''}</td>
        <td>${esc(p.category_name || '—')}</td>
        <td>${money(p.price)}${p.compare_price ? `<br><span style="text-decoration:line-through;color:#999;font-size:12px;">${money(p.compare_price)}</span>` : ''}</td>
        <td style="${p.stock <= 3 ? 'color:#b23b3b;font-weight:600;' : ''}">${p.stock}</td>
        <td>${p.active ? '<span class="pill pill-delivered">Active</span>' : '<span class="pill pill-cancelled">Hidden</span>'}</td>
        <td><button class="btn btn-outline btn-sm" data-edit="${p.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-del="${p.id}">Delete</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">No products found.</td></tr>';
    document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => productModal(list.find((p) => p.id == b.dataset.edit))));
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this product? If it has past orders it will be archived instead.')) return;
      try { const r = await api.del(`/admin/products/${b.dataset.del}`); toast(r.archived ? 'Product archived (has order history)' : 'Product deleted'); route(); }
      catch (e) { toast(e.message, true); }
    }));
  };
  renderRows(products);
  document.getElementById('addProdBtn').addEventListener('click', () => productModal());
  document.getElementById('prodSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    renderRows(products.filter((p) => p.name.toLowerCase().includes(q) || (p.fabric || '').toLowerCase().includes(q)));
  });
}

function productModal(existing) {
  const cats = productCache.categories;
  let images = existing ? [...existing.images] : [];
  openModal(`${existing ? 'Edit' : 'Add'} Product`, `
    <form id="prodForm">
      <div class="field"><label>Name</label><input name="name" value="${esc(existing?.name || '')}" required></div>
      <div class="field-row">
        <div class="field"><label>Category</label><select name="category_id">
          <option value="">— None —</option>
          ${cats.map((c) => `<option value="${c.id}" ${existing?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Fabric</label><input name="fabric" value="${esc(existing?.fabric || '')}"></div>
      </div>
      <div class="field"><label>Description</label><textarea name="description" rows="3">${esc(existing?.description || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Price (₹)</label><input type="number" name="price" min="0" value="${existing?.price ?? ''}" required></div>
        <div class="field"><label>Compare-at Price (₹, optional)</label><input type="number" name="compare_price" min="0" value="${existing?.compare_price ?? ''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Stock</label><input type="number" name="stock" min="0" value="${existing?.stock ?? 0}" required></div>
        <div class="field"><label>Sizes (comma separated)</label><input name="sizes" value="${esc((existing?.sizes || []).join(','))}" placeholder="S,M,L,XL"></div>
      </div>
      <div class="field">
        <label>Images</label>
        <input type="file" id="imgFile" multiple accept="image/*">
        <div class="img-thumbs" id="imgThumbs"></div>
      </div>
      <div class="field checkbox-row"><input type="checkbox" name="featured" ${existing?.featured ? 'checked' : ''}> <label style="margin:0;">Featured on homepage</label></div>
      <div class="field checkbox-row"><input type="checkbox" name="active" ${existing?.active !== false ? 'checked' : ''}> <label style="margin:0;">Active (visible in store)</label></div>
      <p class="field-error" id="prodError"></p>
      <button class="btn btn-gold" type="submit">${existing ? 'Save Changes' : 'Add Product'}</button>
    </form>`);

  const renderThumbs = () => {
    document.getElementById('imgThumbs').innerHTML = images.map((url, i) => `
      <div class="thumb"><img src="${url}"><button type="button" class="rm" data-i="${i}">✕</button></div>`).join('');
    document.querySelectorAll('.img-thumbs .rm').forEach((b) => b.addEventListener('click', () => { images.splice(Number(b.dataset.i), 1); renderThumbs(); }));
  };
  renderThumbs();

  document.getElementById('imgFile').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('images', f));
    try { const { urls } = await api.post('/admin/uploads', fd, true); images.push(...urls); renderThumbs(); }
    catch (err) { toast(err.message, true); }
  });

  document.getElementById('prodForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      name: fd.get('name'), category_id: fd.get('category_id') || null, fabric: fd.get('fabric'),
      description: fd.get('description'), price: fd.get('price'), compare_price: fd.get('compare_price') || null,
      stock: fd.get('stock'), sizes: fd.get('sizes'), images, featured: fd.get('featured') === 'on', active: fd.get('active') === 'on',
    };
    try {
      if (existing) await api.put(`/admin/products/${existing.id}`, payload); else await api.post('/admin/products', payload);
      closeModal(); toast('Saved'); route();
    } catch (err) { document.getElementById('prodError').textContent = err.message; }
  });
}

// ---------- orders ----------
const ORDER_NEXT = { placed: ['confirmed', 'cancelled'], confirmed: ['packed', 'cancelled'], packed: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
async function renderOrders() {
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <input id="orderSearch" placeholder="Search order #, name, phone…" style="max-width:260px;">
        <select id="orderStatusFilter">
          <option value="">All statuses</option>
          ${Object.keys(ORDER_NEXT).map((s) => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th></th></tr></thead>
      <tbody id="orderRows"></tbody></table></div>
    </div>`;
  const load = async () => {
    const params = new URLSearchParams();
    if (document.getElementById('orderSearch').value) params.set('q', document.getElementById('orderSearch').value);
    if (document.getElementById('orderStatusFilter').value) params.set('status', document.getElementById('orderStatusFilter').value);
    const orders = await api.get(`/admin/orders?${params}`);
    document.getElementById('orderRows').innerHTML = orders.map((o) => `
      <tr>
        <td>${o.order_no}<br><span style="color:#999;font-size:11px;">${dt(o.created_at)}</span></td>
        <td>${esc(o.name)}<br><span style="color:#999;font-size:11px;">${esc(o.phone)}</span></td>
        <td>${o.item_count ?? ''}</td>
        <td>${money(o.total)}</td>
        <td><span class="pill pill-${o.payment_status}">${o.payment_status}</span><br><span style="font-size:11px;color:#999;">${o.payment_method.toUpperCase()}</span></td>
        <td><span class="pill pill-${o.status}">${o.status}</span></td>
        <td><button class="btn btn-outline btn-sm" data-view="${o.id}">Manage</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">No orders found.</td></tr>';
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => orderModal(Number(b.dataset.view))));
  };
  document.getElementById('orderSearch').addEventListener('input', debounce(load, 300));
  document.getElementById('orderStatusFilter').addEventListener('change', load);
  load();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function orderModal(id) {
  const o = await api.get(`/admin/orders/${id}`);
  const nextOptions = ORDER_NEXT[o.status] || [];
  openModal(`Order ${o.order_no}`, `
    <p><strong>${esc(o.name)}</strong> · ${esc(o.email)} · ${esc(o.phone)}</p>
    <p style="font-size:13px;color:#666;">${esc(o.address)}, ${esc(o.city)}, ${esc(o.state)} - ${esc(o.pincode)}</p>
    <div class="table-wrap" style="margin:14px 0;"><table><thead><tr><th>Item</th><th>Size</th><th>Qty</th><th>Price</th></tr></thead>
    <tbody>${o.items.map((it) => `<tr><td>${esc(it.name)}</td><td>${it.size || '—'}</td><td>${it.qty}</td><td>${money(it.price)}</td></tr>`).join('')}</tbody></table></div>
    <p>Subtotal: ${money(o.subtotal)} ${o.discount ? `· Discount: −${money(o.discount)}` : ''} · Shipping: ${o.shipping ? money(o.shipping) : 'Free'}</p>
    <p style="font-size:17px;font-weight:700;">Total: ${money(o.total)}</p>
    ${o.notes ? `<p style="font-size:13px;color:#666;">Notes: ${esc(o.notes)}</p>` : ''}

    <div class="field-row" style="margin-top:16px;">
      <div class="field">
        <label>Order Status</label>
        <select id="statusSelect">
          <option value="${o.status}">${o.status} (current)</option>
          ${nextOptions.map((s) => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Payment Status</label>
        <select id="paymentSelect">
          ${['pending', 'paid', 'refunded'].map((s) => `<option value="${s}" ${o.payment_status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Tracking Number (optional)</label><input id="trackingInput" value="${esc(o.tracking_no || '')}"></div>
    <p class="field-error" id="orderModalError"></p>
    <button class="btn btn-gold" id="saveOrderBtn">Update Order</button>`);

  document.getElementById('saveOrderBtn').addEventListener('click', async () => {
    const status = document.getElementById('statusSelect').value;
    const payment_status = document.getElementById('paymentSelect').value;
    const tracking_no = document.getElementById('trackingInput').value;
    try {
      if (status !== o.status) await api.put(`/admin/orders/${o.id}/status`, { status, tracking_no });
      if (payment_status !== o.payment_status) await api.put(`/admin/orders/${o.id}/payment`, { payment_status });
      closeModal(); toast('Order updated'); route();
    } catch (e) { document.getElementById('orderModalError').textContent = e.message; }
  });
}

// ---------- bookings ----------
async function renderBookings() {
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <input type="date" id="bookingDateFilter">
        <select id="bookingStatusFilter"><option value="">All statuses</option>
          <option value="pending">Pending</option><option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>
        <button class="btn btn-outline" id="blockDateBtn">Block a Date</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Booking</th><th>Service</th><th>Customer</th><th>Date & Time</th><th>Status</th><th></th></tr></thead>
      <tbody id="bookingRows"></tbody></table></div>
    </div>`;
  const load = async () => {
    const params = new URLSearchParams();
    if (document.getElementById('bookingDateFilter').value) params.set('date', document.getElementById('bookingDateFilter').value);
    if (document.getElementById('bookingStatusFilter').value) params.set('status', document.getElementById('bookingStatusFilter').value);
    const rows = await api.get(`/admin/bookings?${params}`);
    document.getElementById('bookingRows').innerHTML = rows.map((b) => `
      <tr>
        <td>${b.booking_no}</td><td>${esc(b.service_name)}</td>
        <td>${esc(b.name)}<br><span style="color:#999;font-size:11px;">${esc(b.phone)}</span></td>
        <td>${b.date} · ${b.time}</td>
        <td><span class="pill pill-${b.status}">${b.status}</span></td>
        <td>
          ${b.status === 'pending' ? `<button class="btn btn-outline btn-sm" data-status="confirmed" data-id="${b.id}">Confirm</button>` : ''}
          ${['pending','confirmed'].includes(b.status) ? `<button class="btn btn-outline btn-sm" data-status="completed" data-id="${b.id}">Complete</button>
          <button class="btn btn-danger btn-sm" data-status="cancelled" data-id="${b.id}">Cancel</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No bookings found.</td></tr>';
    document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.put(`/admin/bookings/${b.dataset.id}/status`, { status: b.dataset.status }); toast('Booking updated'); load(); }
      catch (e) { toast(e.message, true); }
    }));
  };
  document.getElementById('bookingDateFilter').addEventListener('change', load);
  document.getElementById('bookingStatusFilter').addEventListener('change', load);
  document.getElementById('blockDateBtn').addEventListener('click', () => openModal('Block a Date', `
    <form id="blockForm">
      <div class="field"><label>Date</label><input type="date" name="date" required></div>
      <div class="field"><label>Reason (optional)</label><input name="reason" placeholder="e.g. Boutique closed for stocktaking"></div>
      <button class="btn btn-gold" type="submit">Block Date</button>
    </form>`, () => {
    document.getElementById('blockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await api.post('/admin/blocked-dates', f); closeModal(); toast('Date blocked');
    });
  }));
  load();
}

// ---------- services ----------
async function renderServices() {
  const services = await api.get('/admin/services');
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3 style="margin:0;">Booking Services</h3><button class="btn" id="addSvcBtn">+ Add Service</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Duration</th><th>Price</th><th>Status</th><th></th></tr></thead>
      <tbody>${services.map((s) => `<tr><td>${esc(s.name)}<br><span style="color:#999;font-size:12px;">${esc(s.description)}</span></td>
        <td>${s.duration_min} min</td><td>${s.price ? money(s.price) : 'Free'}</td>
        <td>${s.active ? '<span class="pill pill-delivered">Active</span>' : '<span class="pill pill-cancelled">Hidden</span>'}</td>
        <td><button class="btn btn-outline btn-sm" data-edit="${s.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No services yet.</td></tr>'}</tbody></table></div>
    </div>`;
  const openSvc = (existing) => openModal(`${existing ? 'Edit' : 'Add'} Service`, `
    <form id="svcForm">
      <div class="field"><label>Name</label><input name="name" value="${esc(existing?.name || '')}" required></div>
      <div class="field"><label>Description</label><textarea name="description" rows="2">${esc(existing?.description || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Duration (minutes)</label><input type="number" name="duration_min" min="10" max="480" value="${existing?.duration_min ?? 60}" required></div>
        <div class="field"><label>Price (₹, 0 = free)</label><input type="number" name="price" min="0" value="${existing?.price ?? 0}" required></div>
      </div>
      <div class="field checkbox-row"><input type="checkbox" name="active" ${existing?.active !== false ? 'checked' : ''}> <label style="margin:0;">Active</label></div>
      <p class="field-error" id="svcError"></p>
      <button class="btn btn-gold" type="submit">${existing ? 'Save Changes' : 'Add Service'}</button>
    </form>`);
  document.getElementById('addSvcBtn').addEventListener('click', () => { openSvc(); wireSvcForm(null); });
  document.querySelectorAll('[data-edit]').forEach((b) => { const s = services.find((x) => x.id == b.dataset.edit); b.addEventListener('click', () => { openSvc(s); wireSvcForm(s); }); });

  function wireSvcForm(existing) {
    document.getElementById('svcForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      f.active = f.active === 'on';
      try {
        if (existing) await api.put(`/admin/services/${existing.id}`, f); else await api.post('/admin/services', f);
        closeModal(); toast('Saved'); route();
      } catch (err) { document.getElementById('svcError').textContent = err.message; }
    });
  }
}

// ---------- coupons ----------
async function renderCoupons() {
  const coupons = await api.get('/admin/coupons');
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3 style="margin:0;">Coupons</h3><button class="btn" id="addCouponBtn">+ Add Coupon</button></div>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Min Order</th><th>Used</th><th>Status</th><th></th></tr></thead>
      <tbody>${coupons.map((c) => `<tr><td><strong>${c.code}</strong></td>
        <td>${c.type === 'percent' ? `${c.value}%` : money(c.value)}</td><td>${money(c.min_order)}</td>
        <td>${c.used}${c.max_uses ? ` / ${c.max_uses}` : ''}</td>
        <td>${c.active ? '<span class="pill pill-delivered">Active</span>' : '<span class="pill pill-cancelled">Off</span>'}</td>
        <td><button class="btn btn-outline btn-sm" data-toggle="${c.id}" data-active="${c.active}">${c.active ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-danger btn-sm" data-del="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No coupons yet.</td></tr>'}</tbody></table></div>
    </div>`;
  document.getElementById('addCouponBtn').addEventListener('click', () => openModal('Add Coupon', `
    <form id="couponForm">
      <div class="field"><label>Code</label><input name="code" required></div>
      <div class="field-row">
        <div class="field"><label>Type</label><select name="type"><option value="percent">Percent off</option><option value="flat">Flat amount off</option></select></div>
        <div class="field"><label>Value</label><input type="number" name="value" min="1" required></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Minimum Order (₹)</label><input type="number" name="min_order" min="0" value="0"></div>
        <div class="field"><label>Max Uses (optional)</label><input type="number" name="max_uses" min="1"></div>
      </div>
      <div class="field"><label>Expires On (optional)</label><input type="date" name="expires_at"></div>
      <p class="field-error" id="couponError"></p>
      <button class="btn btn-gold" type="submit">Add Coupon</button>
    </form>`, () => {
    document.getElementById('couponForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api.post('/admin/coupons', f); closeModal(); toast('Coupon added'); route(); }
      catch (err) { document.getElementById('couponError').textContent = err.message; }
    });
  }));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    await api.put(`/admin/coupons/${b.dataset.toggle}`, { active: b.dataset.active !== 'true' });
    route();
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this coupon?')) return;
    await api.del(`/admin/coupons/${b.dataset.del}`); toast('Deleted'); route();
  }));
}

// ---------- customers ----------
async function renderCustomers() {
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><input id="custSearch" placeholder="Search customers…" style="max-width:260px;"></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Orders</th><th>Lifetime Value</th><th>Joined</th></tr></thead>
      <tbody id="custRows"></tbody></table></div>
    </div>`;
  const load = async () => {
    const q = document.getElementById('custSearch').value;
    const rows = await api.get(`/admin/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    document.getElementById('custRows').innerHTML = rows.map((c) => `
      <tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone || '—')}</td>
      <td>${c.order_count}</td><td>${money(c.lifetime_value)}</td><td>${dt(c.created_at)}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No customers found.</td></tr>';
  };
  document.getElementById('custSearch').addEventListener('input', debounce(load, 300));
  load();
}

// ---------- messages ----------
async function renderMessages() {
  const messages = await api.get('/admin/messages');
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h3>Contact Messages</h3>
      <div class="table-wrap"><table><thead><tr><th>From</th><th>Message</th><th>Received</th><th></th></tr></thead>
      <tbody>${messages.map((m) => `<tr style="${m.is_read ? '' : 'font-weight:600;background:#fdf9f0;'}">
        <td>${esc(m.name)}<br><span style="font-weight:400;color:#999;font-size:12px;">${esc(m.email)} ${m.phone ? `· ${esc(m.phone)}` : ''}</span></td>
        <td style="max-width:320px;">${esc(m.message)}</td><td>${dt(m.created_at)}</td>
        <td>${m.is_read ? '' : `<button class="btn btn-outline btn-sm" data-read="${m.id}">Mark Read</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No messages yet.</td></tr>'}</tbody></table></div>
    </div>`;
  document.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', async () => { await api.put(`/admin/messages/${b.dataset.read}/read`); route(); }));
}

// ---------- settings ----------
async function renderSettings() {
  const s = await api.get('/admin/settings');
  document.getElementById('content').innerHTML = `
    <div class="panel">
      <h3>Store Settings</h3>
      <form id="settingsForm">
        <div class="field-row">
          <div class="field"><label>Store Name</label><input name="store_name" value="${esc(s.store_name)}"></div>
          <div class="field"><label>Tagline</label><input name="store_tagline" value="${esc(s.store_tagline)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Support Email</label><input name="store_email" value="${esc(s.store_email)}"></div>
          <div class="field"><label>Support Phone</label><input name="store_phone" value="${esc(s.store_phone)}"></div>
        </div>
        <div class="field"><label>Store Address</label><textarea name="store_address" rows="2">${esc(s.store_address)}</textarea></div>
        <div class="field-row">
          <div class="field"><label>WhatsApp Number (with country code, no +)</label><input name="whatsapp" value="${esc(s.whatsapp)}"></div>
          <div class="field"><label>UPI ID</label><input name="upi_id" value="${esc(s.upi_id)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Shipping Fee (₹)</label><input type="number" name="shipping_fee" value="${s.shipping_fee}"></div>
          <div class="field"><label>Free Shipping Above (₹)</label><input type="number" name="free_shipping_min" value="${s.free_shipping_min}"></div>
        </div>
        <h3 style="margin-top:26px;">Booking Engine</h3>
        <div class="field-row">
          <div class="field"><label>Opens At</label><input type="time" name="booking_open" value="${s.booking_open}"></div>
          <div class="field"><label>Closes At</label><input type="time" name="booking_close" value="${s.booking_close}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Slot Length (minutes)</label><input type="number" name="booking_slot_minutes" value="${s.booking_slot_minutes}"></div>
          <div class="field"><label>Capacity per Slot</label><input type="number" name="booking_slot_capacity" value="${s.booking_slot_capacity}"></div>
        </div>
        <div class="field"><label>Book Up To (days ahead)</label><input type="number" name="booking_max_days_ahead" value="${s.booking_max_days_ahead}"></div>
        <button class="btn btn-gold" type="submit">Save Settings</button>
      </form>
    </div>
    <div class="panel">
      <h3>Admin Users</h3>
      <div id="adminList" class="table-wrap"></div>
      <button class="btn btn-outline" style="margin-top:12px;" id="addAdminBtn">+ Add Admin User</button>
    </div>`;
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api.put('/admin/settings', Object.fromEntries(new FormData(e.target)));
    toast('Settings saved');
  });
  const admins = await api.get('/admin/admins');
  document.getElementById('adminList').innerHTML = `<table><thead><tr><th>Name</th><th>Email</th></tr></thead>
    <tbody>${admins.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.email)}</td></tr>`).join('')}</tbody></table>`;
  document.getElementById('addAdminBtn').addEventListener('click', () => openModal('Add Admin User', `
    <form id="adminForm">
      <div class="field"><label>Name</label><input name="name" required></div>
      <div class="field"><label>Email</label><input type="email" name="email" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" minlength="8" required></div>
      <p class="field-error" id="adminError"></p>
      <button class="btn btn-gold" type="submit">Add Admin</button>
    </form>`, () => {
    document.getElementById('adminForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post('/admin/admins', Object.fromEntries(new FormData(e.target))); closeModal(); toast('Admin added'); route(); }
      catch (err) { document.getElementById('adminError').textContent = err.message; }
    });
  }));
}

// ---------- modal helper ----------
function openModal(title, bodyHtml, after) {
  let bg = document.getElementById('modalBg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'modalBg'; bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal" id="modalInner"></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
  }
  document.getElementById('modalInner').innerHTML = `<button class="modal-close" onclick="closeModal()">✕</button><h3>${title}</h3>${bodyHtml}`;
  bg.classList.add('active');
  if (after) after();
}
function closeModal() { document.getElementById('modalBg')?.classList.remove('active'); }

boot();
