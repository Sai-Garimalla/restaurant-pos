// Shared API utility & auth helpers for all pages
const API = '/api';

// ── XSS defence: escape user-supplied strings before inserting into innerHTML ──
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Styled confirmation modal (replaces native confirm()) ──
function confirmModal(message, onConfirm, { confirmLabel = 'Confirm', confirmClass = 'btn-danger', cancelLabel = 'Cancel' } = {}) {
  // Remove any existing confirm modal
  document.getElementById('_confirm-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_confirm-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface,#fff);border-radius:16px;padding:28px 24px;max-width:340px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.25);text-align:center;';

  const msg = document.createElement('p');
  msg.style.cssText = 'margin:0 0 20px;font-size:15px;font-weight:600;color:var(--text,#3E2000);line-height:1.5;';
  msg.textContent = message;

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = cancelLabel;
  cancelBtn.onclick = () => overlay.remove();

  const confirmBtn = document.createElement('button');
  confirmBtn.className = `btn ${confirmClass}`;
  confirmBtn.textContent = confirmLabel;
  confirmBtn.onclick = () => { overlay.remove(); onConfirm(); };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  box.appendChild(msg);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function getToken() { return localStorage.getItem('pos_token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('pos_user')); } catch { return null; } }

function logout() {
  localStorage.removeItem('pos_token');
  localStorage.removeItem('pos_user');
  window.location.href = '/index.html';
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) };
  const res = await fetch(API + path, { ...options, headers });
  if (res.status === 401 || res.status === 403) { logout(); return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function authGuard(allowedRoles) {
  const token = getToken();
  if (!token) { window.location.href = '/index.html'; return false; }
  const user = getUser();
  const currentPage = window.location.pathname;
  if (allowedRoles) {
    if (!user || !allowedRoles.includes(user.role)) {
      if (user && user.role === 'delivery_boy') window.location.href = '/delivery-dashboard.html';
      else if (user && user.role === 'kitchen') window.location.href = '/kitchen.html';
      else window.location.href = '/index.html';
      return false;
    }
  } else {
    // Default guard: redirect restricted roles to their portal
    if (user && user.role === 'delivery_boy' && currentPage !== '/delivery.html') {
      window.location.href = '/delivery-dashboard.html'; return false;
    }
    if (user && user.role === 'kitchen' && currentPage !== '/kitchen.html') {
      window.location.href = '/kitchen.html'; return false;
    }
  }
  return true;
}

// Toast notifications
function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️' };
  toast.innerHTML = `<span>${icons[type] || '💬'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; toast.style.transition = '.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

// ── Restaurant name cache (fetched once from /api/settings/public) ──
let _cachedRestaurantName = null;
async function getRestaurantName() {
  if (_cachedRestaurantName) return _cachedRestaurantName;
  try {
    const d = await fetch('/api/settings/public').then(r => r.json());
    _cachedRestaurantName = (d && d.restaurant_name) ? d.restaurant_name : 'Restaurant POS';
  } catch {
    _cachedRestaurantName = 'Restaurant POS';
  }
  return _cachedRestaurantName;
}

// Sidebar setup
async function initSidebar(activePage) {
  const user = getUser();
  const isAdmin = user && user.role === 'admin';
  const isDeliveryBoy = user && user.role === 'delivery_boy';
  const isKitchen = user && user.role === 'kitchen';

  const restaurantName = await getRestaurantName();
  const rn = escapeHtml(restaurantName);

  let sidebarHTML;

  if (isDeliveryBoy) {
    sidebarHTML = `
  <div class="sidebar-logo" style="text-align:center;position:relative">
    <button class="sidebar-close-btn" id="sidebar-close-btn" aria-label="Close Menu">&times;</button>
    <img src="/assets/logo.png" alt="Logo" style="width:80px;height:80px;object-fit:contain;border-radius:8px;margin-bottom:8px">
    <h1>${rn}</h1><p>Delivery Portal</p>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-label">Delivery</div>
    <a href="/delivery-dashboard.html" class="nav-link ${activePage==='delivery-dashboard'?'active':''}"><span class="nav-icon">📊</span> My Dashboard</a>
    <a href="/delivery.html" class="nav-link ${activePage==='delivery'?'active':''}"><span class="nav-icon">🛵</span> My Orders</a>
  </nav>
  <div class="sidebar-footer">
    <div class="user-info"><div class="user-avatar">${user.full_name[0].toUpperCase()}</div><div><div class="user-name">${escapeHtml(user.full_name)}</div><div class="user-role">🛵 Delivery Boy</div></div></div>
    <button class="btn-logout" onclick="logout()">🚪 Logout</button>
  </div>`;
  } else if (isKitchen) {
    sidebarHTML = `
  <div class="sidebar-logo" style="text-align:center;position:relative">
    <button class="sidebar-close-btn" id="sidebar-close-btn" aria-label="Close Menu">&times;</button>
    <img src="/assets/logo.png" alt="Logo" style="width:80px;height:80px;object-fit:contain;border-radius:8px;margin-bottom:8px">
    <h1>${rn}</h1><p>Kitchen Station</p>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-label">Kitchen</div>
    <a href="/kitchen.html" class="nav-link ${activePage==='kitchen'?'active':''}"><span class="nav-icon">🍳</span> KOT / Packing</a>
  </nav>
  <div class="sidebar-footer">
    <div class="user-info"><div class="user-avatar">${user.full_name[0].toUpperCase()}</div><div><div class="user-name">${escapeHtml(user.full_name)}</div><div class="user-role">🍳 Kitchen</div></div></div>
    <button class="btn-logout" onclick="logout()">🚪 Logout</button>
  </div>`;
  } else {
    const isAdminOrStaff = isAdmin || (user && user.role === 'staff');
    sidebarHTML = `
  <div class="sidebar-logo" style="text-align:center;position:relative">
    <button class="sidebar-close-btn" id="sidebar-close-btn" aria-label="Close Menu">&times;</button>
    <img src="/assets/logo.png" alt="Logo" style="width:80px;height:80px;object-fit:contain;border-radius:8px;margin-bottom:8px">
    <h1>${rn}</h1><p>POS &amp; Billing System</p>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-label">Main</div>
    <a href="/dashboard.html" class="nav-link ${activePage==='dashboard'?'active':''}"><span class="nav-icon">📊</span> Dashboard</a>
    <a href="/item-sales.html" class="nav-link ${activePage==='item-sales'?'active':''}"><span class="nav-icon">📈</span> Item Sales</a>
    <a href="/billing.html" class="nav-link ${activePage==='billing'?'active':''}"><span class="nav-icon">🧾</span> New Bill</a>
    <a href="/recent-bills.html" class="nav-link ${activePage==='bills'?'active':''}"><span class="nav-icon">📋</span> Recent Bills</a>
    <a href="/customer-search.html" class="nav-link ${activePage==='customer-search'?'active':''}"><span class="nav-icon">🔍</span> Customer Search</a>
    <div class="nav-label">Management</div>
    <a href="/menu.html" class="nav-link ${activePage==='menu'?'active':''}"><span class="nav-icon">🍽️</span> Menu</a>
    ${isAdminOrStaff ? `<a href="/users.html" class="nav-link ${activePage==='users'?'active':''}"><span class="nav-icon">👥</span> Staff Users</a>` : ''}
    ${isAdmin ? `<a href="/settings.html" class="nav-link ${activePage==='settings'?'active':''}"><span class="nav-icon">⚙️</span> Settings</a>` : ''}
  </nav>
  <div class="sidebar-footer">
    <div class="user-info"><div class="user-avatar">${user ? user.full_name[0].toUpperCase() : 'A'}</div><div><div class="user-name">${user ? escapeHtml(user.full_name) : 'Admin'}</div><div class="user-role">${user ? (user.role==='admin'?'🔑 Admin':'👨‍🍳 Staff') : ''}</div></div></div>
    <button class="btn-logout" onclick="logout()">🚪 Logout</button>
  </div>`;
  }

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.innerHTML = sidebarHTML;

  // ── Mobile: inject header, overlay, bottom-nav ──
  if (!document.getElementById('mobile-header')) {
    const mh = document.createElement('div');
    mh.id = 'mobile-header';
    mh.className = 'mobile-header';
    mh.innerHTML = `
      <button class="hamburger" id="hamburger-btn" aria-label="Open Menu">
        <div class="hb-bar"></div>
        <div class="hb-bar"></div>
        <div class="hb-bar"></div>
      </button>
      <div class="m-logo">🔥 <span>${rn}</span></div>
      <div style="width:44px"></div>`;
    document.body.prepend(mh);
  }
  if (!document.getElementById('sidebar-overlay')) {
    const ov = document.createElement('div');
    ov.id = 'sidebar-overlay';
    ov.className = 'sidebar-overlay';
    document.body.appendChild(ov);
  }
  if (!document.getElementById('bottom-nav')) {
    const bn = document.createElement('div');
    bn.id = 'bottom-nav'; bn.className = 'bottom-nav';
    if (isDeliveryBoy) {
      bn.innerHTML = `<nav><a href="/delivery.html" class="bn-item ${activePage==='delivery'?'active':''}"><span class="bn-icon">🛵</span>Deliveries</a></nav>`;
    } else if (isKitchen) {
      bn.innerHTML = `<nav><a href="/kitchen.html" class="bn-item ${activePage==='kitchen'?'active':''}"><span class="bn-icon">🍳</span>KOT</a></nav>`;
    } else {
      bn.innerHTML = `<nav>
        <a href="/dashboard.html" class="bn-item ${activePage==='dashboard'?'active':''}"><span class="bn-icon">📊</span>Dash</a>
        <a href="/billing.html"   class="bn-item ${activePage==='billing'?'active':''}"><span class="bn-icon">🧾</span>Bill</a>
        <a href="/recent-bills.html" class="bn-item ${activePage==='bills'?'active':''}"><span class="bn-icon">📋</span>Bills</a>
        <a href="/customer-search.html" class="bn-item ${activePage==='customer-search'?'active':''}"><span class="bn-icon">🔍</span>Search</a>
        <a href="/menu.html"      class="bn-item ${activePage==='menu'?'active':''}"><span class="bn-icon">🍽️</span>Food</a>
      </nav>`;
    }
    document.body.appendChild(bn);
  }

  // Hamburger open/close
  function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('open');
    document.body.style.overflow = 'hidden'; // prevent background scroll
  }
  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }
  document.getElementById('hamburger-btn').addEventListener('click', openSidebar);
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
  // Close button inside sidebar
  const sbCloseBtn = document.querySelector('.sidebar-close-btn');
  if (sbCloseBtn) sbCloseBtn.addEventListener('click', closeSidebar);
  // Close on nav link tap (mobile)
  document.querySelectorAll('#sidebar .nav-link').forEach(l => l.addEventListener('click', closeSidebar));

  // Add drag handle to all modals (for mobile bottom-sheet feel)
  document.querySelectorAll('.modal').forEach(m => {
    if (!m.querySelector('.modal-drag-handle')) {
      const dh = document.createElement('div');
      dh.className = 'modal-drag-handle';
      m.prepend(dh);
    }
  });
}

function formatCurrency(val) {
  return '₹' + parseFloat(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
