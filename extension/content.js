// content.js — Z.AI Bridge V7.0 | CORE MODULE
// Chỉ chứa Critical Path: WS + SSE relay + Indicator.
// Heavy modules được lazy load khi cần:
//   - dom-optimizer.js  → 3s sau khi trang load xong
//   - send-engine.js    → khi nhận lệnh send_prompt từ WS server

// Cross-browser API wrapper
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// =========================================================
// Shared state — accessible by lazy-loaded modules
// via window.__zai namespace
// =========================================================
window.__zai = {
  isStreaming: false,
  isWafBlocked: false,
  currentRequestId: null,
  lastRequestTime: 0,
  wafUnlockTimer: null,
  // [8.0] Hang detection
  requestStartTime: 0,
  lastChunkTime: 0,
  chunkCount: 0,
};

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
let indicator = null;

console.log('[Content] Z.AI Bridge content script loaded (Core). Lazy loading enabled.');

// =========================================================
// 1. Inject inject.js vào MAIN world — NGAY LẬP TỨC
//    (phải chặn fetch trước khi React app load)
// =========================================================
const script = document.createElement('script');
script.src = browserAPI.runtime.getURL('inject.js');
script.onload = () => script.remove();
(document.documentElement || document.head).appendChild(script);

// =========================================================
// Helpers — expose qua window.__zai_safeSend để send-engine dùng
// =========================================================
function safeSend(msgObj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msgObj));
    } catch (e) {
      console.error('[Content] WS send failed:', e);
    }
  }
}
window.__zai_safeSend = safeSend;

// =========================================================
// 2. SSE Relay — window.addEventListener("message")
//    Relay SSE chunks từ inject.js (MAIN world) → WS server
// =========================================================
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.type === 'Z_AI_SSE_DELTA' && data.payload) {
    // Z_AI_SSE_DELTA chỉ xử lý done phase (0ms immediate) — delta_content KHÔNG đi qua path này nữa
    const sseData = data.payload;
    if (sseData.data && sseData.data.phase === 'done' && sseData.data.done === true) {
      if (window.__zai.isStreaming) {
        console.log('[Content] done phase received. Closing stream.');
        window.__zai.isStreaming = false;
        safeSend({ type: 'stream_end', requestId: window.__zai.currentRequestId });
      }
      return;
    }
    // Ignore mọi delta_content từ Z_AI_SSE_DELTA để tránh nhân đôi với Z_AI_SSE_DELTAS
  } else if (data.type === 'Z_AI_SSE_DELTAS' && data.payloads) {
    // Z_AI_SSE_DELTAS là path duy nhất xử lý token — 16ms micro-batch
    for (const payload of data.payloads) {
      if (payload.data && payload.data.delta_content !== undefined) {
        window.__zai.isStreaming = true;
        // [8.0] Cập nhật chunk tracking cho hang detector
        window.__zai.lastChunkTime = Date.now();
        window.__zai.chunkCount++;
        safeSend({
          type: 'stream_chunk',
          chunk: `data: ${JSON.stringify(payload)}\n\n`,
          requestId: window.__zai.currentRequestId,
        });
      }
    }
  } else if (data.type === 'Z_AI_STREAM_END_RAW') {
    if (window.__zai.isStreaming) {
      console.log('[Content] Z_AI_STREAM_END_RAW received. Closing stream.');
      window.__zai.isStreaming = false;
      stopHangDetector();
      updateIndicator(`✅ Done • ${window.__zai.chunkCount} chunks`, '#4CAF50');
      safeSend({ type: 'stream_end', requestId: window.__zai.currentRequestId });
    }
  } else if (data.type === 'Z_AI_WAF_ABORT') {
    // send-engine.js (MAIN world) báo WAF block về content.js (ISOLATED world)
    safeSend({ type: 'stream_end', requestId: window.__zai.currentRequestId, error: 'WAF_BLOCKED' });
  } else if (data.type === 'Z_AI_UPDATE_STATE') {
    // send-engine cập nhật state (lastRequestTime) về ISOLATED world
    if (data.lastRequestTime !== undefined) window.__zai.lastRequestTime = data.lastRequestTime;
  } else if (data.type === 'Z_AI_WAF_BLOCK') {
    console.log('[Content] 🚨 WAF block! Status:', data.status);
    window.__zai.isWafBlocked = true;
    updateIndicator('🚨 WAF BLOCKED! Solve CAPTCHA (auto-retry in 60s)', '#FF5722');
    safeSend({ type: 'waf_block', status: data.status, requestId: window.__zai.currentRequestId });
    // [NEW 8.0] WAF bridge: forward to background.js for unified WAF state (Account Manager)
    chrome.runtime.sendMessage({ action: 'waf_block_from_content', status: data.status }).catch(() => {});
    if (window.__zai.wafUnlockTimer) clearTimeout(window.__zai.wafUnlockTimer);
    window.__zai.wafUnlockTimer = setTimeout(() => {
      window.__zai.isWafBlocked = false;
      window.__zai.wafUnlockTimer = null;
      updateIndicator('🟡 WAF cooldown ended — retry allowed', '#FF9800');
      console.log('[Content] 🛡️ WAF auto-unlocked after 60s.');
    }, 60000);
  } else if (data.type === 'Z_AI_USAGE' && data.usage) {
    console.log('[Content] 📊 Usage:', JSON.stringify(data.usage));
    safeSend({ type: 'usage', usage: data.usage, requestId: window.__zai.currentRequestId });
  } else if (data.type === 'Z_AI_SEARCH_RESULTS' && data.results) {
    safeSend({ type: 'search_results', results: data.results, requestId: window.__zai.currentRequestId });
  } else if (data.type === 'Z_AI_SEARCH_PHASE') {
    safeSend({ type: 'search_phase', phase: data.phase, requestId: window.__zai.currentRequestId });
  }
});

// =========================================================
// 3. Remote Logging (error/warn only — không flood WS)
// =========================================================
let isLogging = false;
const originalLog = console.log;
console.log = (...args) => originalLog.apply(console, args);

const originalError = console.error;
console.error = (...args) => {
  originalError.apply(console, args);
  if (isLogging || window.__zai.isStreaming) return;
  isLogging = true;
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'remote_log', logType: 'error', text: args.join(' ') }));
    }
  } catch (e) {} finally { isLogging = false; }
};

const originalWarn = console.warn;
console.warn = (...args) => {
  originalWarn.apply(console, args);
  if (isLogging || window.__zai.isStreaming) return;
  isLogging = true;
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'remote_log', logType: 'warn', text: args.join(' ') }));
    }
  } catch (e) {} finally { isLogging = false; }
};

// =========================================================
// 4. Connection Indicator
// =========================================================
let currentIndicatorText = '🔴 Z.AI Bridge Disconnected';
let currentIndicatorColor = '#f44336';

function updateIndicator(text, color) {
  currentIndicatorText = text;
  currentIndicatorColor = color;
  if (!indicator) indicator = document.getElementById('z-ai-bridge-indicator');
  if (indicator) {
    indicator.innerText = text;
    indicator.style.background = color;
  }
}

function injectIndicator() {
  const createIndicator = () => {
    if (document.getElementById('z-ai-bridge-indicator')) return;
    indicator = document.createElement('div');
    indicator.id = 'z-ai-bridge-indicator';
    indicator.style.cssText =
      'position:fixed;bottom:20px;right:20px;color:white;padding:8px 12px;zIndex:999999;borderRadius:4px;fontSize:12px;fontWeight:bold;fontFamily:sans-serif;boxShadow:0 2px 10px rgba(0,0,0,0.3);pointerEvents:none;';
    indicator.innerText = currentIndicatorText;
    indicator.style.background = currentIndicatorColor;
    if (document.body) document.body.appendChild(indicator);
  };
  if (document.body) createIndicator();
  else document.addEventListener('DOMContentLoaded', createIndicator);
}
injectIndicator();

// =========================================================
// 4b. Hang Detector — phân biệt "đang suy nghĩ" vs "bị treo"
// =========================================================
const HANG_WARN_MS  = 45_000; // 45s im lặng → cảnh báo vàng
const HANG_CRIT_MS  = 90_000; // 90s im lặng → cảnh báo đỏ
let _hangDetectorInterval = null;

function startHangDetector() {
  window.__zai.requestStartTime = Date.now();
  window.__zai.lastChunkTime    = Date.now();
  window.__zai.chunkCount       = 0;

  if (_hangDetectorInterval) clearInterval(_hangDetectorInterval);
  _hangDetectorInterval = setInterval(() => {
    const now       = Date.now();
    const totalSec  = Math.round((now - window.__zai.requestStartTime) / 1000);
    const silentSec = Math.round((now - window.__zai.lastChunkTime)    / 1000);
    const chunks    = window.__zai.chunkCount;

    if (chunks === 0) {
      // Chưa nhận được token nào
      if (totalSec >= HANG_CRIT_MS / 1000) {
        updateIndicator(`⚠️ NGHI NGỜ TREO | ${totalSec}s | 0 chunks | Kiểm tra CAPTCHA!`, '#d32f2f');
      } else if (totalSec >= HANG_WARN_MS / 1000) {
        updateIndicator(`⏳ Đang chờ... ${totalSec}s | 0 chunks (CAPTCHA?)`, '#f57f17');
      } else {
        updateIndicator(`🧠 Thinking... ${totalSec}s | 0 chunks`, '#5c6bc0');
      }
    } else {
      // Đã có token — thực sự đang streaming
      if (silentSec >= HANG_CRIT_MS / 1000) {
        updateIndicator(`⚠️ Im lặng ${silentSec}s | ${chunks} chunks | Stream gãy?`, '#d32f2f');
      } else if (silentSec >= HANG_WARN_MS / 1000) {
        updateIndicator(`⏳ Streaming chậm... | ${silentSec}s im | ${chunks} chunks`, '#ef6c00');
      } else {
        const rate = Math.round(chunks / Math.max(totalSec, 1));
        updateIndicator(`📝 Streaming • ${totalSec}s • ${chunks} chunks • ~${rate}c/s`, '#00897b');
      }
    }
  }, 5000); // kiểm tra mỗi 5 giây
}

function stopHangDetector() {
  if (_hangDetectorInterval) {
    clearInterval(_hangDetectorInterval);
    _hangDetectorInterval = null;
  }
}

// =========================================================
// 5. Page Ready Detection
// =========================================================
let _pageReadyObserver = null;
let _pageReadyTimeout = null;

function waitForPageReadyAndSignal(context) {
  if (_pageReadyObserver) { _pageReadyObserver.disconnect(); _pageReadyObserver = null; }
  if (_pageReadyTimeout) { clearTimeout(_pageReadyTimeout); _pageReadyTimeout = null; }

  const ta = document.querySelector('textarea');
  if (ta) {
    console.log(`[Content] ✅ page_ready (immediate) — context: ${context}`);
    safeSend({ type: 'page_ready', context });
    return;
  }

  _pageReadyObserver = new MutationObserver(() => {
    const ta2 = document.querySelector('textarea');
    if (ta2) {
      _pageReadyObserver.disconnect();
      _pageReadyObserver = null;
      clearTimeout(_pageReadyTimeout);
      _pageReadyTimeout = null;
      console.log(`[Content] ✅ page_ready (observed) — context: ${context}`);
      safeSend({ type: 'page_ready', context });
    }
  });
  _pageReadyObserver.observe(document.documentElement, { childList: true, subtree: true });

  _pageReadyTimeout = setTimeout(() => {
    if (_pageReadyObserver) { _pageReadyObserver.disconnect(); _pageReadyObserver = null; }
    _pageReadyTimeout = null;
    console.warn('[Content] ⚠️ page_ready timeout (15s)');
    safeSend({ type: 'page_ready', context, timedOut: true });
  }, 15000);
}

// =========================================================
// 6. LAZY LOADER ENGINE
// =========================================================
let _domOptimizerLoaded = false;
let _sendEngineLoaded = false;
let _sendEnginePromise = null;

function lazyLoadScript(filename) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = browserAPI.runtime.getURL(filename);
    s.onload = () => { s.remove(); resolve(); };
    s.onerror = () => { console.error(`[Content] ❌ Failed to load ${filename}`); resolve(); };
    (document.head || document.documentElement).appendChild(s);
  });
}

function lazyLoadDOMOptimizer() {
  if (_domOptimizerLoaded) return;
  _domOptimizerLoaded = true;
  lazyLoadScript('dom-optimizer.js').then(() => {
    console.log('[Content] ✅ dom-optimizer.js loaded (deferred 3s).');
  });
}

function lazyLoadSendEngine() {
  if (_sendEngineLoaded) return Promise.resolve();
  if (_sendEnginePromise) return _sendEnginePromise;
  _sendEnginePromise = lazyLoadScript('send-engine.js').then(() => {
    _sendEngineLoaded = true;
    console.log('[Content] ✅ send-engine.js loaded on-demand.');
  });
  return _sendEnginePromise;
}

// Trigger DOM optimizer duy nhất: DOMContentLoaded (chống trường hợp content.js load sau khi event đã fire)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', lazyLoadDOMOptimizer, { once: true });
} else {
  lazyLoadDOMOptimizer();
}

// =========================================================
// 7. WebSocket Connection + Heartbeat
// =========================================================
let heartbeatTimer = null;

function connectWS() {
  if (ws) try { ws.close(); } catch (e) {}
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

  ws = new WebSocket('ws://127.0.0.1:8899?client=content');

  ws.onopen = () => {
    console.log('[Content] Connected to WS server.');
    window.__zai.isWafBlocked = false;
    if (window.__zai.wafUnlockTimer) {
      clearTimeout(window.__zai.wafUnlockTimer);
      window.__zai.wafUnlockTimer = null;
    }
    updateIndicator('🟢 Z.AI Bridge Connected (Network Mode)', '#4CAF50');
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // 💓 10s Heartbeat — giữ WS mở 24/7
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
      }
    }, 10000);

    waitForPageReadyAndSignal('startup');
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.action === 'send_prompt') {
        window.__zai.currentRequestId = data.requestId;
        console.log(`[Content] ${data.isNewChat ? '🆕 New' : '➡️ Continuing'} conversation.`);

        // Lazy load send-engine vào MAIN world (qua <script> tag)
        await lazyLoadSendEngine();

        // ✅ Fix cross-world: dùng postMessage thay vì gọi trực tiếp
        // content.js (ISOLATED world) không thể gọi hàm từ MAIN world
        window.postMessage({
          type: 'Z_AI_TRIGGER_SEND',
          prompt: data.prompt,
          isSearch: data.isSearch || false,
          requestId: data.requestId,
          isWafBlocked: window.__zai.isWafBlocked,
          lastRequestTime: window.__zai.lastRequestTime,
        }, '*');

        // [8.0] Khởi động hang detector
        startHangDetector();
        updateIndicator('🧠 Thinking... 0s | 0 chunks', '#5c6bc0');

      } else if (data.action === 'cancel_stream') {
        // cancel_stream không cần send-engine
        const textarea = document.querySelector('textarea');
        if (textarea) {
          // Tìm nút Stop đơn giản không cần load send-engine
          const container = textarea.closest('form') || textarea.parentElement?.parentElement;
          if (container) {
            const stopBtn = Array.from(container.querySelectorAll('button'))
              .find(btn => btn.querySelector('rect'));
            if (stopBtn) stopBtn.click();
          }
        }
      } else if (data.action === 'reset_page') {
        console.log('[Content] reset_page received — keeping current page.');
        waitForPageReadyAndSignal('reset_ignored');
      } else if (data.action === 'apply_proxy') {
        console.log('[Content] apply_proxy received (handled by background.js).');
      }
    } catch (e) {
      console.error('[Content] Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    updateIndicator('🔴 Z.AI Bridge Disconnected (Reconnecting...)', '#f44336');
    if (!reconnectTimer) {
      const delay = reconnectAttempts < 5 ? 300 : Math.min(1000 * Math.pow(1.5, reconnectAttempts), 15000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, delay);
    }
  };
}

// 🚀 Khởi động WS ngay khi content script load
connectWS();
