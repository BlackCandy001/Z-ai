// ============================================================
// Z.AI Bridge 8.0 — Panel (SidePanel) UI logic
// Account Manager + Proxy Config — unified panel
// ============================================================

const el = {
  // Header
  serverDot: document.getElementById('serverDot'),
  serverText: document.getElementById('serverText'),
  countMinute: document.getElementById('countMinute'),
  countHour: document.getElementById('countHour'),
  limitMinute: document.getElementById('limitMinute'),
  limitHour: document.getElementById('limitHour'),
  // Accounts
  sessionList: document.getElementById('sessionList'),
  sessionCountLabel: document.getElementById('sessionCountLabel'),
  btnBackup: document.getElementById('btnBackup'),
  btnReset: document.getElementById('btnReset'),
  searchBox: document.getElementById('searchBox'),
  filterSelect: document.getElementById('filterSelect'),
  // Proxy
  proxyEnabled: document.getElementById('proxyEnabled'),
  proxyQuickPaste: document.getElementById('proxyQuickPaste'),
  proxyType: document.getElementById('proxyType'),
  proxyHost: document.getElementById('proxyHost'),
  proxyPort: document.getElementById('proxyPort'),
  proxyUser: document.getElementById('proxyUser'),
  proxyPass: document.getElementById('proxyPass'),
  btnProxySave: document.getElementById('btnProxySave'),
  btnProxyReset: document.getElementById('btnProxyReset'),
  // Settings
  btnSettings: document.getElementById('btnSettings'),
  settingsView: document.getElementById('settingsView'),
  themeLight: document.getElementById('themeLight'),
  themeDark: document.getElementById('themeDark'),
  btnExport: document.getElementById('btnExport'),
  importFile: document.getElementById('importFile'),
  importText: document.getElementById('importText'),
  btnImport: document.getElementById('btnImport'),
  importResult: document.getElementById('importResult'),
  cfgPerHour: document.getElementById('cfgPerHour'),
  cfgPerMinute: document.getElementById('cfgPerMinute'),
  cfgWarnPercent: document.getElementById('cfgWarnPercent'),
  btnSaveQuota: document.getElementById('btnSaveQuota'),
  quotaResult: document.getElementById('quotaResult')
};

// ============================================================
// Tab Navigation
// ============================================================
let currentTab = 'accounts';

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const tabBtn = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (tabBtn) tabBtn.classList.add('active');
  const view = document.getElementById('view' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (view) view.classList.add('active');
  // Hide settings when switching tabs
  el.settingsView.style.display = 'none';
}

// ============================================================
// Server Health Check
// ============================================================
function checkServerHealth() {
  fetch('http://127.0.0.1:8888/v1/health')
    .then(r => r.json())
    .then(d => {
      if (d && d.status === 'ok') {
        el.serverDot.classList.add('online');
        el.serverText.textContent = 'Online';
      } else {
        el.serverDot.classList.remove('online');
        el.serverText.textContent = 'Offline';
      }
    })
    .catch(() => {
      el.serverDot.classList.remove('online');
      el.serverText.textContent = 'Offline';
    });
}

// ============================================================
// Proxy Logic
// ============================================================
function parseRawProxy(raw) {
  raw = raw.trim();
  if (!raw) return null;
  let type = 'http', host = '', port = 80, username = '', password = '';
  if (raw.startsWith('socks5://')) { type = 'socks5'; raw = raw.substring(9); }
  else if (raw.startsWith('socks4://')) { type = 'socks5'; raw = raw.substring(9); }
  else if (raw.startsWith('https://')) { type = 'https'; raw = raw.substring(8); }
  else if (raw.startsWith('http://')) { type = 'http'; raw = raw.substring(7); }
  if (raw.includes('@')) {
    const parts = raw.split('@');
    const auth = parts[0].split(':');
    username = auth[0] || ''; password = auth[1] || '';
    raw = parts[1];
  }
  const pieces = raw.split(':');
  if (pieces.length >= 2) {
    host = pieces[0].trim();
    port = parseInt(pieces[1].trim(), 10) || 80;
    if (pieces.length >= 4) { username = pieces[2].trim(); password = pieces[3].trim(); }
  } else { host = raw; }
  return { enabled: true, type, host, port, username, password };
}

function loadProxyUI() {
  chrome.storage.local.get('proxyConfig', result => {
    if (result && result.proxyConfig) {
      const c = result.proxyConfig;
      el.proxyEnabled.checked = !!c.enabled;
      el.proxyType.value = c.type || 'http';
      el.proxyHost.value = c.host || '';
      el.proxyPort.value = c.port || '';
      el.proxyUser.value = c.username || '';
      el.proxyPass.value = c.password || '';
    }
  });
}

function saveProxyConfig(config) {
  chrome.storage.local.set({ proxyConfig: config }, () => {
    showToast('✅ Proxy đã áp dụng!');
    fetch('http://127.0.0.1:8888/api/proxy/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer zen-local-key' },
      body: JSON.stringify(config)
    }).then(r => r.json()).then(d => {
      if (d.success) console.log('[Panel] Proxy synced with server.');
    }).catch(() => console.log('[Panel] Server offline, proxy saved locally.'));
  });
}

function bindProxyEvents() {
  el.proxyQuickPaste.addEventListener('input', () => {
    const parsed = parseRawProxy(el.proxyQuickPaste.value);
    if (parsed) {
      el.proxyEnabled.checked = true;
      el.proxyType.value = parsed.type;
      el.proxyHost.value = parsed.host;
      el.proxyPort.value = parsed.port;
      el.proxyUser.value = parsed.username;
      el.proxyPass.value = parsed.password;
      saveProxyConfig(parsed);
      el.proxyQuickPaste.value = '';
    } else if (el.proxyQuickPaste.value.trim()) {
      showToast('⚠ Định dạng proxy không hợp lệ', 'warn');
    }
  });

  el.btnProxySave.addEventListener('click', () => {
    const config = {
      enabled: el.proxyEnabled.checked,
      type: el.proxyType.value,
      host: el.proxyHost.value.trim(),
      port: parseInt(el.proxyPort.value, 10) || 80,
      username: el.proxyUser.value.trim(),
      password: el.proxyPass.value.trim()
    };
    if (config.enabled && !config.host) {
      showToast('⚠ Vui lòng nhập Host Address', 'warn');
      return;
    }
    saveProxyConfig(config);
  });

  el.btnProxyReset.addEventListener('click', () => {
    el.proxyEnabled.checked = false;
    el.proxyType.value = 'http';
    el.proxyHost.value = '';
    el.proxyPort.value = '';
    el.proxyUser.value = '';
    el.proxyPass.value = '';
    el.proxyQuickPaste.value = '';
    saveProxyConfig({ enabled: false, type: 'http', host: '', port: 80, username: '', password: '' });
  });
}

let lastState = null;

// ============ View & Theme ============
function showView(view) {
  if (view === 'settings') {
    // Overlay settings on top of current tab
    el.settingsView.style.display = 'block';
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  } else {
    el.settingsView.style.display = 'none';
    switchTab(currentTab);
  }
}

async function loadTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  setTheme(theme || 'light');
}

async function setTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark');
    el.themeDark.classList.add('active');
    el.themeLight.classList.remove('active');
  } else {
    document.body.classList.remove('dark');
    el.themeLight.classList.add('active');
    el.themeDark.classList.remove('active');
  }
  await chrome.storage.local.set({ theme });
}

// ============ API helpers ============
function send(action, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action, ...payload }, resolve);
  });
}

// ============ Render ============
function applyCounterClass(valueEl, count, limit, warnPercent) {
  valueEl.classList.remove('warn', 'danger');
  const ratio = count / limit;
  if (ratio >= 1) valueEl.classList.add('danger');
  else if (ratio >= warnPercent / 100) valueEl.classList.add('warn');
}

function renderCounts(counts, quotaConfig) {
  const cfg = quotaConfig || { perHour: 60, perMinute: 10, warnPercent: 80 };
  el.countMinute.textContent = counts.perMinute;
  el.countHour.textContent = counts.perHour;
  el.limitMinute.textContent = cfg.perMinute;
  el.limitHour.textContent = cfg.perHour;
  applyCounterClass(el.countMinute, counts.perMinute, cfg.perMinute, cfg.warnPercent);
  applyCounterClass(el.countHour, counts.perHour, cfg.perHour, cfg.warnPercent);
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(sec) {
  if (sec <= 0) return 'đã hết hạn';
  if (sec < 60) return Math.floor(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  return Math.floor(sec / 86400) + 'd';
}

function getSessionStatus(s, wafStatus, tokenInfo) {
  const waf = wafStatus?.[s.id];
  const ti = tokenInfo?.[s.id];
  const result = { waf: null, token: null };
  if (waf?.blocked) result.waf = waf;
  if (ti) {
    if (ti.expired) result.token = 'expired';
    else if (ti.expSoon) result.token = 'warn';
    else result.token = 'ok';
  }
  return result;
}

function filterSession(s, status, query, filter) {
  const q = query.trim().toLowerCase();
  if (q && !(s.name?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q))) return false;
  switch (filter) {
    case 'active': return s.id === lastState?.state?.activeSessionId;
    case 'token-ok': return status.token === 'ok';
    case 'token-warn': return status.token === 'warn';
    case 'token-expired': return status.token === 'expired';
    case 'waf': return !!status.waf;
    default: return true;
  }
}

function renderSessions(sessions, activeSessionId, perSessionCounts, quotaConfig, wafStatus, tokenInfo) {
  if (!sessions || sessions.length === 0) {
    el.sessionList.innerHTML = '<div class="empty">Chưa có session nào.<br>Đăng nhập Z.AI rồi bấm "Lưu session hiện tại".</div>';
    el.sessionCountLabel.textContent = 'Tài khoản đã lưu (0)';
    return;
  }

  const query = el.searchBox.value;
  const filter = el.filterSelect.value;
  const filtered = sessions.filter(s => {
    const status = getSessionStatus(s, wafStatus, tokenInfo);
    return filterSession(s, status, query, filter);
  });

  el.sessionCountLabel.textContent = 'Tài khoản đã lưu (' + filtered.length + '/' + sessions.length + ')';

  if (filtered.length === 0) {
    el.sessionList.innerHTML = '<div class="empty">Không tìm thấy tài khoản phù hợp.</div>';
    return;
  }

  const cfg = quotaConfig || { perHour: 60, perMinute: 10, warnPercent: 80 };
  el.sessionList.innerHTML = '';
  for (const s of filtered) {
    const isActive = s.id === activeSessionId;
    const item = document.createElement('div');
    item.className = 'session-item' + (isActive ? ' active' : '');

    const cnt = perSessionCounts?.[s.id] || { perMinute: 0, perHour: 0 };
    const hourRatio = cnt.perHour / cfg.perHour;
    let reqColor = '#667eea';
    if (hourRatio >= 1) reqColor = '#ef5350';
    else if (hourRatio >= cfg.warnPercent / 100) reqColor = '#ff9800';

    const status = getSessionStatus(s, wafStatus, tokenInfo);
    let statusHtml = '';
    if (status.waf) {
      statusHtml += '<div class="session-status status-waf">🚫 WAF blocked (' + status.waf.code + ') · còn ' + status.waf.remaining + 's</div>';
    }
    if (status.token === 'expired') {
      statusHtml += '<div class="session-status status-expired">⏰ Token đã hết hạn — cần login lại</div>';
    } else if (status.token === 'warn') {
      const ti = tokenInfo[s.id];
      statusHtml += '<div class="session-status status-exp-warn">⏰ Token hết hạn sau ' + fmtDuration(ti.remaining) + '</div>';
    }

    let innerHtml = '<div class="session-top">';
    innerHtml += '<div class="session-info">';
    innerHtml += '<div class="session-name">' + escapeHtml(s.name) + '</div>';
    if (s.email) {
      innerHtml += '<div class="session-email">✉ ' + escapeHtml(s.email) + '</div>';
    }
    innerHtml += '<div class="session-meta">';
    innerHtml += (isActive ? '🟢 Đang active · ' : '') + 'Tạo: ' + fmtTime(s.createdAt);
    if (s.lastUsed) {
      innerHtml += ' · Dùng: ' + fmtTime(s.lastUsed);
    }
    innerHtml += '</div>';
    innerHtml += '<div class="session-req">';
    innerHtml += '<span>req/giờ: <b style="color:' + reqColor + '">' + cnt.perHour + '</b>/' + cfg.perHour + '</span>';
    innerHtml += '<span>req/phút: <b>' + cnt.perMinute + '</b>/' + cfg.perMinute + '</span>';
    innerHtml += '</div>';
    innerHtml += statusHtml;
    innerHtml += '<div class="session-actions-r">';
    innerHtml += '<button class="btn-ghost btn-tiny" data-act="resetUser" data-id="' + s.id + '" data-uid="' + s.userId + '">↻ Reset</button>';
    innerHtml += '</div>';
    innerHtml += '</div>'; // session-info

    innerHtml += '<div class="session-actions">';
    innerHtml += '<button class="btn-primary btn-sm" data-act="restore" data-id="' + s.id + '">Mở</button>';
    innerHtml += '<button class="btn-ghost btn-sm" data-act="rename" data-id="' + s.id + '">✎</button>';
    innerHtml += '<button class="btn-danger btn-sm" data-act="delete" data-id="' + s.id + '">✕</button>';
    innerHtml += '</div>'; // session-actions
    innerHtml += '</div>'; // session-top

    item.innerHTML = innerHtml;
    el.sessionList.appendChild(item);
  }
}

function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function refresh() {
  const res = await send('getState');
  if (!res || !res.success) {
    el.sessionList.innerHTML = '<div class="empty">Lỗi kết nối background.</div>';
    return;
  }
  lastState = res;
  renderCounts(res.counts, res.state.quotaConfig);
  renderSessions(res.state.sessions, res.state.activeSessionId, res.perSessionCounts, res.state.quotaConfig, res.wafStatus, res.tokenInfo);
}

// ============ Event handlers ============
el.btnBackup.addEventListener('click', async () => {
  const name = prompt('Tên cho session này:', 'Account ' + new Date().toLocaleString('vi-VN'));
  if (name === null) return;
  el.btnBackup.disabled = true;
  el.btnBackup.textContent = 'Đang lưu...';
  const res = await send('backupSession', { name: name || undefined });
  el.btnBackup.disabled = false;
  el.btnBackup.textContent = '💾 Lưu session hiện tại';
  if (res && res.success) {
    await refresh();
  } else {
    alert('Lỗi khi lưu: ' + (res?.error || 'không rõ'));
  }
});

el.btnReset.addEventListener('click', async () => {
  await send('resetCounters');
  await refresh();
});

el.searchBox.addEventListener('input', () => refresh());
el.filterSelect.addEventListener('change', () => refresh());

el.sessionList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === 'restore') {
    btn.disabled = true;
    btn.textContent = '...';
    const res = await send('restoreSession', { sessionId: id });
    if (res && res.success) {
      await refresh();
      const warns = [];
      if (res.expSoon) warns.push('token sắp hết hạn (<1h)');
      if (res.cookieFailures > 0) warns.push(res.cookieFailures + ' cookie đặt thất bại');
      if (warns.length) showToast('Đã mở session · ⚠ ' + warns.join(', '), 'warn');
      else showToast('Đã mở session thành công');
    } else {
      showToast('Lỗi restore: ' + (res?.error || 'không rõ'), 'danger');
      btn.disabled = false;
      btn.textContent = 'Mở';
    }
  } else if (act === 'resetUser') {
    const uid = btn.dataset.uid;
    if (uid) {
      await send('resetCounterForUser', { userId: uid });
      await refresh();
    }
  } else if (act === 'rename') {
    const res = await send('getState');
    const s = res?.state?.sessions?.find(x => x.id === id);
    const newName = prompt('Tên mới:', s ? s.name : '');
    if (newName === null) return;
    await send('renameSession', { sessionId: id, name: newName });
    await refresh();
  } else if (act === 'delete') {
    if (confirm('Xóa session này?')) {
      await send('deleteSession', { sessionId: id });
      await refresh();
    }
  }
});

// ============ Realtime updates ============
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'stateUpdated') {
    refresh();
  }
});

// ============ Settings handlers ============
el.themeLight.addEventListener('click', () => setTheme('light'));
el.themeDark.addEventListener('click', () => setTheme('dark'));

async function loadQuotaIntoUI() {
  const res = await send('getState');
  const cfg = res?.state?.quotaConfig || { perHour: 60, perMinute: 10, warnPercent: 80 };
  el.cfgPerHour.value = cfg.perHour;
  el.cfgPerMinute.value = cfg.perMinute;
  el.cfgWarnPercent.value = cfg.warnPercent;
}

el.btnSaveQuota.addEventListener('click', async () => {
  const config = {
    perHour: parseInt(el.cfgPerHour.value, 10) || 60,
    perMinute: parseInt(el.cfgPerMinute.value, 10) || 10,
    warnPercent: parseInt(el.cfgWarnPercent.value, 10) || 80
  };
  const res = await send('updateQuota', { config });
  if (res?.success) {
    el.quotaResult.textContent = '✅ Đã lưu giới hạn mới.';
    await refresh();
  } else {
    el.quotaResult.textContent = '❌ Lỗi: ' + (res?.error || 'không rõ');
  }
});

el.btnSettings.addEventListener('click', async () => {
  const isVisible = el.settingsView.style.display === 'block';
  if (!isVisible) await loadQuotaIntoUI();
  showView(isVisible ? 'tab' : 'settings');
});

el.btnExport.addEventListener('click', async () => {
  const res = await send('exportSessions');
  if (res?.success) {
    const blob = new Blob([JSON.stringify({ exportedAt: res.exportedAt, sessions: res.sessions }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zai-accounts-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đã xuất file backup');
  } else {
    showToast('Lỗi xuất file', 'danger');
  }
});

el.btnImport.addEventListener('click', async () => {
  el.importResult.textContent = 'Đang xử lý...';
  let jsonStr = el.importText.value.trim();
  
  if (el.importFile.files.length > 0) {
    jsonStr = await el.importFile.files[0].text();
  }

  if (!jsonStr) {
    el.importResult.textContent = '⚠ Chưa có dữ liệu đầu vào.';
    return;
  }

  try {
    const data = JSON.parse(jsonStr);
    const sessions = Array.isArray(data) ? data : data.sessions;
    if (!Array.isArray(sessions)) throw new Error('JSON không hợp lệ (thiếu mảng sessions)');

    const res = await send('importSessions', { sessions });
    if (res?.success) {
      el.importResult.textContent = '✅ Thành công: ' + res.added + ' mới, ' + res.overwritten + ' ghi đè.';
      el.importText.value = "";
      el.importFile.value = "";
      await refresh();
    } else {
      throw new Error(res?.error || 'Lỗi không rõ');
    }
  } catch (e) {
    el.importResult.textContent = '❌ ' + e.message;
  }
});

// ============ Init ============
loadTheme();
refresh();
// Proxy
loadProxyUI();
bindProxyEvents();
// Server health
checkServerHealth();
setInterval(checkServerHealth, 5000);
// Tự refresh mỗi 5s để giữ counter realtime kể cả khi không có message push
setInterval(refresh, 5000);
// Expose switchTab globally (called from HTML onclick)
window.switchTab = switchTab;