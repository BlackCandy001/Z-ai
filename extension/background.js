// ============================================================
// Z.AI Bridge 8.0 — Background Service Worker
// MERGED: reverse Z ai 7.0 (WS + Proxy) + Z ai Account (Multi-Account + WAF + Counter)
//
// Sections:
//   [PROXY]    WS Client + Proxy Manager (từ 7.0)
//   [ACCOUNT]  Account Manager + Session Backup/Restore (từ Account)
//   [MONITOR]  Request Counter + WAF Detector (từ Account)
//   [UI]       Context Menu + Badge (từ Account, mở rộng)
//   [WAF-BRIDGE] Unified WAF state (inject.js → content.js → background) [NEW 8.0]
//   [BADGE]    Smart badge: proxy status + request count + WAF [NEW 8.0]
//   [INIT]     Thứ tự init thống nhất (pattern từ Account)
// ============================================================

// ===== CONSTANTS =====
const ZAI_URL = 'https://chat.z.ai/';
const CHAT_API_PATTERNS = [
  '/api/v2/chat/completions',
  '/api/agent/v2/chat/completions'
];
const DEFAULT_QUOTA = { perHour: 60, perMinute: 10, warnPercent: 80 };
const STORAGE_KEY = 'zaiAccountManager';
const LOG_KEY = 'zaiRequestLog';
const WAF_KEY = 'zaiWafState';
const WAF_COOLDOWN_MS = 300000; // 5 phút — đồng bộ với rate-limiter.ts và content.js

// ===== STATE =====
let ws = null;
let pendingReconnectTimer = null;
let reconnectAttempts = 0;
let proxyChangeInProgress = false;
let lastAppliedConfigHash = '';

let requestLog = [];
let wafState = {};
let quotaConfig = DEFAULT_QUOTA;
let initialized = false;

// ===== [AUTO-ROTATE] State (Phase 3.3) =====
const MAX_ROTATE_ATTEMPTS = 3;
const ROTATE_COOLDOWN_MS = 10000;
let rotateAttempts = 0;
let lastRotateTime = 0;
let isRotating = false;

// ===== [PROXY] Helper: config hash =====
function configHash(config) {
  if (!config) return '';
  return JSON.stringify({
    e: config.enabled,
    h: config.host,
    p: config.port,
    t: config.type,
    u: config.username,
    w: config.password,
    fa: config.forwarderActive,
    fp: config.forwarderPort
  });
}

// ===== [PROXY] WS Reconnect scheduler =====
function scheduleReconnect(delayMs) {
  if (pendingReconnectTimer) {
    clearTimeout(pendingReconnectTimer);
    pendingReconnectTimer = null;
  }
  pendingReconnectTimer = setTimeout(() => {
    pendingReconnectTimer = null;
    connectWS();
  }, delayMs);
}

// ===== [PROXY] WebSocket Client =====
function connectWS() {
  if (pendingReconnectTimer) {
    clearTimeout(pendingReconnectTimer);
    pendingReconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }

  console.log('[Bridge] Connecting to WebSocket Server...');
  ws = new WebSocket('ws://127.0.0.1:8899?client=background');

  ws.onopen = () => {
    console.log('[Bridge] WebSocket Connected successfully.');
    reconnectAttempts = 0;
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'request_proxy_config' }));
        sendAccountInfo();
        sendQuotaSync();
      }
    }, 1000);
    updateBadge();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[Bridge] Message received:', data.action);
      if (data.action === 'apply_proxy') {
        const config = data.config;
        const serverHash = configHash(config);
        if (serverHash === lastAppliedConfigHash) {
          console.log('[Bridge] Received apply_proxy but config is unchanged. Skipping.');
          return;
        }
        applyProxy(config);
      }
    } catch (e) {
      console.error('[Bridge] Error parsing message:', e);
    }
  };

  ws.onclose = () => {
    console.log('[Bridge] WebSocket disconnected.');
    ws = null;
    updateBadge();

    if (proxyChangeInProgress) {
      console.log('[Bridge] Disconnect expected due to proxy update. Reconnecting after settle...');
      scheduleReconnect(6000);
      return;
    }

    const MAX_PHASE1_ATTEMPTS = 50;
    const MAX_TOTAL_ATTEMPTS = 60;

    if (reconnectAttempts < MAX_PHASE1_ATTEMPTS) {
      const baseDelay = Math.min(3000 * Math.pow(1.5, reconnectAttempts), 30000);
      const delay = baseDelay + Math.floor(Math.random() * baseDelay * 0.25);
      reconnectAttempts++;
      console.log(`[Bridge] WS reconnect (Phase 1) ${reconnectAttempts}/${MAX_PHASE1_ATTEMPTS} in ${Math.round(delay)}ms`);
      scheduleReconnect(delay);
    } else if (reconnectAttempts < MAX_TOTAL_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`[Bridge] ⚠️ Phase 2 reconnect ${reconnectAttempts}/${MAX_TOTAL_ATTEMPTS} in 10 min`);
      scheduleReconnect(10 * 60 * 1000);
    } else {
      console.error(`[Bridge] ⛔ Max reconnect attempts reached. Stopping.`);
    }
  };

  ws.onerror = (err) => {
    console.warn('[Bridge] WebSocket error (server offline):', err);
  };
}

// ===== [PROXY] Apply proxy via PAC script =====
function applyProxy(config) {
  if (!config || !config.enabled) {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
      console.log('[Proxy] Proxy cleared.');
      lastAppliedConfigHash = configHash(config);
      chrome.storage.local.set({ proxyConfig: config });
      updateBadge();
    });
    return;
  }

  proxyChangeInProgress = true;

  const useForwarder = config.type === 'socks5' && config.forwarderActive && config.forwarderPort;
  const pacScript = useForwarder
    ? `function FindProxyForURL(url, host) {
        if (host === "127.0.0.1" || host === "localhost") return "DIRECT";
        return "PROXY 127.0.0.1:${config.forwarderPort}";
       }`
    : `function FindProxyForURL(url, host) {
        if (host === "127.0.0.1" || host === "localhost") return "DIRECT";
        return "${config.type.toUpperCase() === 'SOCKS5' ? 'SOCKS5' : 'PROXY'} ${config.host}:${config.port}";
       }`;

  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {
      console.log('[Proxy] Proxy applied:', config);
      lastAppliedConfigHash = configHash(config);
      chrome.storage.local.set({ proxyConfig: config });
      setTimeout(() => {
        proxyChangeInProgress = false;
        updateBadge();
      }, 5000);
    }
  );
}

// ===== [ACCOUNT] JWT decode =====
function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) {
    return null;
  }
}

async function getCurrentUserId() {
  try {
    const cookie = await chrome.cookies.get({ url: ZAI_URL, name: 'token' });
    if (!cookie) return 'unknown';
    const payload = decodeJwtPayload(cookie.value);
    return payload?.id || payload?.user_id || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ===== [ACCOUNT] Storage helpers =====
async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { sessions: [], activeSessionId: null, quotaConfig: DEFAULT_QUOTA };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function loadConfig() {
  const state = await getState();
  quotaConfig = state.quotaConfig || DEFAULT_QUOTA;
}

async function loadLog() {
  const result = await chrome.storage.local.get(LOG_KEY);
  requestLog = result[LOG_KEY] || [];
}

async function saveLog() {
  await chrome.storage.local.set({ [LOG_KEY]: requestLog });
}

async function loadWaf() {
  const result = await chrome.storage.local.get(WAF_KEY);
  wafState = result[WAF_KEY] || {};
}

async function saveWaf() {
  await chrome.storage.local.set({ [WAF_KEY]: wafState });
}

// ===== [MONITOR] Request Counter (webRequest) =====
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (!CHAT_API_PATTERNS.some(p => details.url.includes(p))) return;
    const userId = await getCurrentUserId();
    requestLog.push({ ts: Date.now(), userId });
    pruneRequests();
    await saveLog();
    updateBadge();
    broadcastUpdate();
    sendQuotaSync(); // [NEW 8.0] Sync quota with server after each request
  },
  { urls: ['*://chat.z.ai/*', '*://*.z.ai/*'] }
);

// ===== [MONITOR] WAF detection (webRequest — browser level backup) =====
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (!CHAT_API_PATTERNS.some(p => details.url.includes(p))) return;
    if ([403, 429, 503].includes(details.statusCode)) {
      const userId = await getCurrentUserId();
      console.log(`[WAF-Detector] 🚨 HTTP ${details.statusCode} on chat API for userId=${userId}`);
      handleWafBlock(userId, details.statusCode);
    }
  },
  { urls: ['*://chat.z.ai/*', '*://*.z.ai/*'] }
);

function isWafBlocked(userId) {
  const w = wafState[userId];
  if (!w) return false;
  if (Date.now() >= w.until) {
    delete wafState[userId];
    saveWaf();
    return false;
  }
  return true;
}

function pruneRequests() {
  const oneHourAgo = Date.now() - 3600000;
  requestLog = requestLog.filter(t => t.ts > oneHourAgo);
}

function getRequestCounts(userId) {
  pruneRequests();
  const oneMinuteAgo = Date.now() - 60000;
  const recentMinute = requestLog.filter(t => t.ts > oneMinuteAgo);
  if (userId) {
    return {
      perMinute: recentMinute.filter(t => t.userId === userId).length,
      perHour: requestLog.filter(t => t.userId === userId).length
    };
  }
  return { perMinute: recentMinute.length, perHour: requestLog.length };
}

function getAllSessionCounts(sessions) {
  const map = {};
  for (const s of sessions) map[s.id] = getRequestCounts(s.userId);
  return map;
}

function getWafStatusForSessions(sessions) {
  const map = {};
  for (const s of sessions) {
    if (s.userId && isWafBlocked(s.userId)) {
      const w = wafState[s.userId];
      map[s.id] = { blocked: true, until: w.until, remaining: Math.ceil((w.until - Date.now()) / 1000), code: w.code };
    }
  }
  return map;
}

function getTokenInfoForSessions(sessions) {
  const map = {};
  const nowSec = Date.now() / 1000;
  for (const s of sessions) {
    if (s.tokenExp) {
      map[s.id] = {
        exp: s.tokenExp,
        remaining: Math.max(0, s.tokenExp - nowSec),
        expired: nowSec > s.tokenExp,
        expSoon: (s.tokenExp - nowSec) < 3600 && !((s.tokenExp - nowSec) < 0)
      };
    }
  }
  return map;
}

// ===== [BADGE] Smart badge: request count + proxy + WAF [NEW 8.0] =====
function updateBadge() {
  const { perHour } = getRequestCounts(null);
  const ratio = perHour / quotaConfig.perHour;

  // Badge text: request count
  chrome.action.setBadgeText({ text: perHour > 0 ? String(perHour).slice(0, 4) : '' });

  // Badge color: xanh < 80%, cam ≥80%, đỏ ≥100% hoặc WAF
  const hasWaf = Object.values(wafState).some(w => Date.now() < w.until);
  let color = '#4caf50';
  if (ratio >= quotaConfig.warnPercent / 100) color = '#ff9800';
  if (ratio >= 1 || hasWaf) color = '#f44336';
  chrome.action.setBadgeBackgroundColor({ color });

  // Tooltip (title)
  const wsStatus = (ws && ws.readyState === WebSocket.OPEN) ? 'ON' : 'OFF';
  chrome.action.setTitle({ title: `Z.AI Bridge 8.0 | Server: ${wsStatus} | Requests: ${perHour}/${quotaConfig.perHour}` });
}

function broadcastUpdate() {
  chrome.runtime.sendMessage({ action: 'stateUpdated' }).catch(() => {});
}

// ===== [NEW 8.0] Send real-time quota data to server via WS =====
async function sendQuotaSync() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const userId = await getCurrentUserId();
  const counts = getRequestCounts(userId);
  const blocked = isWafBlocked(userId);
  ws.send(JSON.stringify({
    type: 'quota_sync',
    userId,
    perMinute: counts.perMinute,
    perHour: counts.perHour,
    wafBlocked: blocked,
  }));
}

// ===== [Phase 3.3] Send full account info to server via WS =====
async function sendAccountInfo() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const state = await getState();
  const activeSession = state.sessions.find(s => s.id === state.activeSessionId);
  const availableAccounts = state.sessions.map(s => ({
    id: s.id,
    userId: s.userId || 'unknown',
    email: s.email || '',
    name: s.name || '',
    tokenExp: s.tokenExp || 0,
    isWafBlocked: isWafBlocked(s.userId),
    hasProxy: !!(s.proxyConfig && s.proxyConfig.enabled),
  }));

  ws.send(JSON.stringify({
    type: 'account_info',
    activeUserId: activeSession?.userId || await getCurrentUserId(),
    activeSessionId: state.activeSessionId,
    availableAccounts,
  }));
}

// ===== [Phase 3.3] Auto-Rotate Account on WAF block (Appendix C algorithm) =====
async function handleWafBlock(blockedUserId, statusCode) {
  if (!blockedUserId || blockedUserId === 'unknown') {
    blockedUserId = await getCurrentUserId();
  }
  wafState[blockedUserId] = {
    blocked: true,
    until: Date.now() + WAF_COOLDOWN_MS,
    code: statusCode || 403
  };
  await saveWaf();
  updateBadge();
  broadcastUpdate();
  sendQuotaSync();
  sendAccountInfo();

  const now = Date.now();
  if (now - lastRotateTime > 60000) {
    rotateAttempts = 0; // reset attempts after 1 min
  }

  if (rotateAttempts >= MAX_ROTATE_ATTEMPTS) {
    console.warn(`[Auto-Rotate] ⚠️ Max rotate attempts (${MAX_ROTATE_ATTEMPTS}) reached. Stopping auto-rotate.`);
    return;
  }

  if (isRotating) {
    console.log('[Auto-Rotate] ⏳ Rotation already in progress, skipping duplicate trigger.');
    return;
  }

  const state = await getState();
  const nowSec = Date.now() / 1000;
  // Find healthy candidate sessions (not blocked, not expired, not current)
  const candidates = state.sessions.filter(s => {
    if (!s || s.id === state.activeSessionId) return false;
    if (s.userId && isWafBlocked(s.userId)) return false;
    if (s.tokenExp && s.tokenExp < nowSec) return false;
    return true;
  });

  if (candidates.length === 0) {
    console.warn('[Auto-Rotate] ⚠️ No healthy candidate accounts available to auto-rotate.');
    return;
  }

  // Sort candidates by lowest perHour usage, then least recently used
  candidates.sort((a, b) => {
    const countA = getRequestCounts(a.userId).perHour;
    const countB = getRequestCounts(b.userId).perHour;
    if (countA !== countB) return countA - countB;
    return (a.lastUsed || 0) - (b.lastUsed || 0);
  });

  const targetSession = candidates[0];
  isRotating = true;
  rotateAttempts++;
  lastRotateTime = Date.now();

  console.log(`[Auto-Rotate] 🔄 WAF block on "${blockedUserId}". Auto-switching to account "${targetSession.name}" (${targetSession.userId}) — Attempt ${rotateAttempts}/${MAX_ROTATE_ATTEMPTS}`);

  try {
    await restoreSession(targetSession.id);
    console.log(`[Auto-Rotate] ✅ Successfully auto-rotated to account "${targetSession.name}".`);
  } catch (err) {
    console.error(`[Auto-Rotate] ❌ Failed to auto-rotate to "${targetSession.name}":`, err);
  } finally {
    isRotating = false;
    sendAccountInfo();
    sendQuotaSync();
  }
}

// ===== [ACCOUNT] Tab Helper =====
async function getOrCreateZaiTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chat.z.ai/*' });
  if (tabs.length > 0) return tabs[0];
  const tab = await chrome.tabs.create({ url: ZAI_URL, active: false });
  await new Promise(resolve => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

// ===== [ACCOUNT] Check if tab busy/streaming =====
async function isTabBusy(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (document.readyState !== 'complete') return true;
        const sel = document.querySelector('[class*="loading"], [class*="generating"], [class*="streaming"], [class*="stop"]');
        if (sel && sel.offsetParent !== null) return true;
        return false;
      }
    });
    return result.result === true;
  } catch {
    return false;
  }
}

// ===== [ACCOUNT] Session Backup =====
async function backupSession(name) {
  const tab = await getOrCreateZaiTab();
  const cookies = await chrome.cookies.getAll({ domain: 'z.ai' });
  const tokenCookie = cookies.find(c => c.name === 'token');
  let email = '', userId = '', tokenExp = 0;
  if (tokenCookie) {
    const payload = decodeJwtPayload(tokenCookie.value);
    email = payload?.email || '';
    userId = payload?.id || payload?.user_id || '';
    tokenExp = payload?.exp || 0;
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        ls[key] = localStorage.getItem(key);
      }
      const ss = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        ss[key] = sessionStorage.getItem(key);
      }
      return { ls, ss };
    }
  });

  const data = result.result || { ls: {}, ss: {} };
  const proxyRes = await chrome.storage.local.get('proxyConfig');
  const session = {
    id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name || (email || `Account ${Date.now()}`),
    email,
    userId,
    tokenExp,
    proxyConfig: proxyRes?.proxyConfig || null,
    cookies,
    localStorage: data.ls || {},
    sessionStorage: data.ss || {},
    createdAt: Date.now(),
    lastUsed: Date.now()
  };

  const state = await getState();
  state.sessions.push(session);
  state.activeSessionId = session.id;
  await saveState(state);
  sendAccountInfo();
  return session;
}

function cookieUrl(c) {
  const proto = c.secure ? 'https' : 'http';
  const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  return `${proto}://${domain}${c.path}`;
}

// ===== [ACCOUNT] Session Restore =====
async function restoreSession(sessionId) {
  const state = await getState();
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  // A3: JWT exp check
  if (session.tokenExp && Date.now() / 1000 > session.tokenExp) {
    throw new Error('Token đã hết hạn. Vui lòng đăng nhập lại tài khoản này trên Z.AI rồi lưu lại session mới.');
  }
  const expSoon = session.tokenExp && (session.tokenExp - Date.now() / 1000) < 3600;

  const tab = await getOrCreateZaiTab();

  // A4: Guard restore when busy
  const busy = await isTabBusy(tab.id);
  if (busy) throw new Error('Tab Z.AI đang xử lý (streaming/loading). Vui lòng đợi hoàn tất rồi thử lại.');

  // Clear existing cookies
  const existing = await chrome.cookies.getAll({ domain: 'z.ai' });
  for (const c of existing) {
    await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
  }

  // Set cookies from snapshot
  let cookieFailures = 0;
  for (const c of session.cookies) {
    try {
      await chrome.cookies.set({
        url: cookieUrl(c),
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate
      });
    } catch (e) {
      cookieFailures++;
      console.warn('[Restore] Cookie set failed:', c.name, e.message);
    }
  }

  // Write localStorage + sessionStorage
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (ls, ss) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(ls)) localStorage.setItem(key, value);
      sessionStorage.clear();
      for (const [key, value] of Object.entries(ss)) sessionStorage.setItem(key, value);
    },
    args: [session.localStorage || {}, session.sessionStorage || {}]
  });

  // [Phase 3.4] Apply per-account proxy if configured on session
  if (session.proxyConfig) {
    console.log(`[Restore] Applying per-account proxy for "${session.name}"...`, session.proxyConfig);
    applyProxy(session.proxyConfig);
  }

  // Reload tab to apply session
  await chrome.tabs.reload(tab.id);

  session.lastUsed = Date.now();
  state.activeSessionId = sessionId;
  await saveState(state);

  updateBadge();
  sendAccountInfo();
  sendQuotaSync();
  return { session, expSoon, cookieFailures };
}

async function deleteSession(sessionId) {
  const state = await getState();
  state.sessions = state.sessions.filter(s => s.id !== sessionId);
  if (state.activeSessionId === sessionId) state.activeSessionId = null;
  await saveState(state);
  sendAccountInfo();
}

async function renameSession(sessionId, name) {
  const state = await getState();
  const session = state.sessions.find(s => s.id === sessionId);
  if (session) {
    session.name = name;
    await saveState(state);
    sendAccountInfo();
  }
}

async function resetCounterForUser(userId) {
  requestLog = requestLog.filter(t => t.userId !== userId);
  await saveLog();
  updateBadge();
}

// ===== [UI] Context Menu =====
const MENU_PARENT_ID = 'zai-switch-parent';
const MENU_OPEN_PANEL = 'zai-open-panel';

async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();
  const state = await getState();

  chrome.contextMenus.create({
    id: MENU_PARENT_ID,
    title: 'Z.AI: Chuyển tài khoản',
    contexts: ['page', 'frame'],
    documentUrlPatterns: ['https://chat.z.ai/*']
  });

  if (state.sessions.length === 0) {
    chrome.contextMenus.create({
      id: 'zai-no-acc',
      parentId: MENU_PARENT_ID,
      title: '(Chưa có acc nào)',
      contexts: ['page', 'frame']
    });
  } else {
    for (const s of state.sessions) {
      const isActive = s.id === state.activeSessionId;
      chrome.contextMenus.create({
        id: 'zai-acc-' + s.id,
        parentId: MENU_PARENT_ID,
        title: (isActive ? '🟢 ' : '⚪ ') + (s.name || s.email || s.id),
        contexts: ['page', 'frame']
      });
    }
  }

  chrome.contextMenus.create({ id: 'zai-sep', parentId: MENU_PARENT_ID, type: 'separator', contexts: ['page', 'frame'] });
  chrome.contextMenus.create({ id: MENU_OPEN_PANEL, parentId: MENU_PARENT_ID, title: '📊 Xem trạng thái', contexts: ['page', 'frame'] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_OPEN_PANEL) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    return;
  }
  if (info.menuItemId.startsWith('zai-acc-')) {
    const sessionId = info.menuItemId.slice(8);
    try {
      await restoreSession(sessionId);
    } catch (e) {
      console.error('[Context Menu] Restore failed:', e);
    }
  }
});

function rebuildContextMenuSafe() {
  rebuildContextMenu().catch(e => console.error('[Context Menu] Rebuild failed:', e));
}

// ===== [WAF-BRIDGE] Unified WAF: content.js → background [NEW 8.0] =====
// content.js sẽ gửi chrome.runtime.sendMessage({ action: 'waf_block_from_content', status })
// background nhận và cập nhật wafState chung với webRequest handler

// ===== [ACCOUNT] Message Handler (popup + panel + content.js) =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        // --- State query ---
        case 'getState': {
          const state = await getState();
          const activeSession = state.sessions.find(s => s.id === state.activeSessionId);
          const counts = getRequestCounts(activeSession?.userId);
          const perSessionCounts = getAllSessionCounts(state.sessions);
          const wafStatus = getWafStatusForSessions(state.sessions);
          const tokenInfo = getTokenInfoForSessions(state.sessions);
          const wsConnected = !!(ws && ws.readyState === WebSocket.OPEN);
          sendResponse({ success: true, state, counts, perSessionCounts, wafStatus, tokenInfo, wsConnected });
          break;
        }
        // --- Session management ---
        case 'backupSession':
          sendResponse({ success: true, session: await backupSession(msg.name) });
          break;
        case 'restoreSession': {
          const result = await restoreSession(msg.sessionId);
          sendResponse({ success: true, session: result.session, expSoon: result.expSoon, cookieFailures: result.cookieFailures });
          break;
        }
        case 'deleteSession':
          await deleteSession(msg.sessionId);
          sendResponse({ success: true });
          break;
        case 'renameSession':
          await renameSession(msg.sessionId, msg.name);
          sendResponse({ success: true });
          break;
        // --- Request counters ---
        case 'resetCounters':
          requestLog = [];
          await saveLog();
          updateBadge();
          sendResponse({ success: true });
          break;
        case 'resetCounterForUser':
          await resetCounterForUser(msg.userId);
          sendResponse({ success: true });
          break;
        // --- Quota config ---
        case 'updateQuota': {
          const state = await getState();
          state.quotaConfig = { ...quotaConfig, ...msg.config };
          await saveState(state);
          quotaConfig = state.quotaConfig;
          updateBadge();
          sendResponse({ success: true });
          break;
        }
        // --- Export/Import ---
        case 'exportSessions': {
          const state = await getState();
          sendResponse({ success: true, sessions: state.sessions, exportedAt: Date.now() });
          break;
        }
        case 'importSessions': {
          const state = await getState();
          const incoming = Array.isArray(msg.sessions) ? msg.sessions : [];
          let added = 0, overwritten = 0;
          for (const inc of incoming) {
            if (!inc || (!inc.userId && !inc.email)) continue;
            const idx = state.sessions.findIndex(s =>
              (inc.userId && s.userId === inc.userId) || (inc.email && s.email === inc.email)
            );
            if (idx >= 0) {
              state.sessions[idx] = { ...state.sessions[idx], ...inc, lastUsed: Date.now() };
              overwritten++;
            } else {
              state.sessions.push({ ...inc, id: inc.id || ('sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)), createdAt: inc.createdAt || Date.now(), lastUsed: Date.now() });
              added++;
            }
          }
          await saveState(state);
          sendResponse({ success: true, added, overwritten });
          break;
        }
        // --- [NEW 8.0] WAF bridge: forward from content.js ---
        case 'waf_block_from_content': {
          const userId = await getCurrentUserId();
          console.log(`[WAF-Bridge] ⛔ WAF block from content.js for userId=${userId}, status=${msg.status}`);
          handleWafBlock(userId, msg.status);
          sendResponse({ success: true });
          break;
        }
        // --- [Phase 3.4] Update per-session proxy ---
        case 'updateSessionProxy': {
          const state = await getState();
          const session = state.sessions.find(s => s.id === msg.sessionId);
          if (session) {
            session.proxyConfig = msg.proxyConfig;
            await saveState(state);
            if (state.activeSessionId === msg.sessionId) {
              applyProxy(msg.proxyConfig);
            }
            sendAccountInfo();
          }
          sendResponse({ success: true });
          break;
        }
        // --- [NEW 8.0] Open sidePanel from popup ---
        case 'openSidePanel': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true; // keep sendResponse channel open
});

// ===== [PROXY] Listen for proxy config changes from popup =====
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    // Proxy config changed
    if (changes.proxyConfig) {
      const newConfig = changes.proxyConfig.newValue;
      const newHash = configHash(newConfig);
      if (newHash !== lastAppliedConfigHash) {
        console.log('[Proxy] Storage config changed. Applying proxy...');
        applyProxy(newConfig);
      }
    }
    // Sessions changed → rebuild context menu
    if (changes[STORAGE_KEY]) rebuildContextMenuSafe();
  }
});

// ===== [UI] SidePanel: open on action click =====
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
// Action click → open popup (proxy config). User manually opens panel via popup button.

// ===== [INIT] Keep-Alive alarm (7.0 pattern) =====
try {
  chrome.alarms.create('keepAliveWS', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAliveWS') {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[Bridge] 💓 KeepAlive: triggering reconnect check...');
        connectWS();
      }
    }
  });
} catch (e) {}

// ===== [INIT] Thứ tự khởi động (thống nhất pattern Account) =====
async function init() {
  if (initialized) return;
  initialized = true;

  // 1. Load config từ storage (proxy + accounts + quota + logs + WAF state)
  await loadConfig();
  await loadLog();
  await loadWaf();

  // 2. Apply proxy nếu có cached config
  const proxyResult = await chrome.storage.local.get('proxyConfig');
  if (proxyResult?.proxyConfig) {
    console.log('[Init] Restoring cached proxy config...');
    applyProxy(proxyResult.proxyConfig);
  }

  // 3. Connect WS to server
  setTimeout(() => connectWS(), 1500);

  // 4. Start request counter (webRequest — already registered above)
  // 5. Start WAF listener (webRequest — already registered above)
  // 6. Register message listener (already registered above)

  // 7. Rebuild context menu
  rebuildContextMenuSafe();

  // 8. Keep-alive alarm (already registered above)

  // 9. Update badge
  updateBadge();

  // 10. Periodic WAF cleanup + auto-reset
  setInterval(() => {
    let changed = false;
    for (const uid of Object.keys(wafState)) {
      if (Date.now() >= wafState[uid].until) {
        delete wafState[uid];
        changed = true;
      }
    }
    if (changed) {
      saveWaf();
      updateBadge();
      broadcastUpdate();
    }
  }, 10000);

  // [NEW 8.0] Periodic quota & account sync to server
  setInterval(() => sendQuotaSync(), 5000);
  setInterval(() => sendAccountInfo(), 10000);

  console.log('[Init] ✅ Z.AI Bridge 8.0 initialized.');
}

chrome.runtime.onInstalled.addListener(() => { init(); });
chrome.runtime.onStartup.addListener(() => { init(); });
init();
