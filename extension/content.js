// content.js - Injected into the page's isolated world

// Cross-browser API wrapper (Chrome + Firefox)
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
let indicator = null;
let currentRequestId = null;
let isStreaming = false; // ✅ Fix P2: Track streaming state to throttle remote_log
let isWafBlocked = false; // 🚨 WAF Shield: chặn gửi tiếp khi bị 403/429/503
let wafUnlockTimer = null; // ⏱️ Tự động mở khóa WAF sau 60s (CAPTCHA đã giải)

// 🛡️ Client-Side Rate Limiter — tối thiểu 4s giữa các request
const MIN_REQUEST_INTERVAL_MS = 4000;
let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS && lastRequestTime > 0) {
    const wait =
      MIN_REQUEST_INTERVAL_MS - elapsed + Math.floor(Math.random() * 800);
    console.log(
      `[Content] 🛡️ Rate limit: waiting ${wait}ms before next request`,
    );
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

console.log("[Content] Z.AI Bridge content script loaded (Network Mode).");

// 1. Inject inject.js vào MAIN world
const script = document.createElement("script");
script.src = browserAPI.runtime.getURL("inject.js");
script.onload = () => script.remove();
(document.documentElement || document.head).appendChild(script);

let sendBuffer = [];
let sendBufferTimer = null;

function safeSend(msgObj) {
  // ⚡ V7.0 Max-Speed Stream: Gửi TỨC THÌ stream_chunk/stream_end qua WS không qua setTimeout đệm
  if (msgObj.type === "stream_chunk" || msgObj.type === "stream_end" || msgObj.type === "usage" || msgObj.type === "search_results") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msgObj));
      } catch (e) {
        console.error("[Content] Direct WS send failed:", e);
      }
    }
    return;
  }

  sendBuffer.push(JSON.stringify(msgObj));

  if (!sendBufferTimer) {
    sendBufferTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          const batch = sendBuffer.join("\n");
          ws.send(batch);
        } catch (e) {
          console.error("[Content] Batch send failed:", e);
        }
      }
      sendBuffer = [];
      sendBufferTimer = null;
    }, 15);
  }
}

// 2. Lắng nghe message từ inject.js (chạy ở MAIN world)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.type === "Z_AI_SSE_DELTA" && data.payload) {
    const sseData = data.payload;

    if (
      sseData.data &&
      sseData.data.phase === "done" &&
      sseData.data.done === true
    ) {
      if (isStreaming) {
        console.log("[Content] Received 'done' phase from network. Closing stream.");
        isStreaming = false;
        safeSend({ type: "stream_end", requestId: currentRequestId });
      }
      return;
    }

    if (sseData.data && sseData.data.delta_content !== undefined) {
      isStreaming = true;
      safeSend({
        type: "stream_chunk",
        chunk: `data: ${JSON.stringify(sseData)}\n\n`,
        requestId: currentRequestId,
      });
    }
  } else if (data.type === "Z_AI_SSE_DELTAS" && data.payloads) {
    for (const payload of data.payloads) {
      if (
        payload.data &&
        payload.data.phase === "done" &&
        payload.data.done === true
      ) {
        if (isStreaming) {
          console.log("[Content] Received 'done' phase from batch. Closing stream.");
          isStreaming = false;
          safeSend({ type: "stream_end", requestId: currentRequestId });
        }
        continue;
      }
      if (payload.data && payload.data.delta_content !== undefined) {
        isStreaming = true;
        safeSend({
          type: "stream_chunk",
          chunk: `data: ${JSON.stringify(payload)}\n\n`,
          requestId: currentRequestId,
        });
      }
    }
  } else if (data.type === "Z_AI_STREAM_END_RAW") {
    if (isStreaming) {
      console.log("[Content] Received Z_AI_STREAM_END_RAW while streaming. Closing stream.");
      isStreaming = false;
      safeSend({ type: "stream_end", requestId: currentRequestId });
    }
  } else if (data.type === "Z_AI_WAF_BLOCK") {
    // 🚨 WAF Shield: bật cờ + hiện indicator + auto-unlock sau 60s
    console.log(
      "[Content] 🚨 WAF block detected from inject.js! Status:",
      data.status,
    );
    isWafBlocked = true;
    updateIndicator(
      "🚨 WAF BLOCKED! Solve CAPTCHA (auto-retry in 60s)",
      "#FF5722",
    );
    safeSend({
      type: "waf_block",
      status: data.status,
      requestId: currentRequestId,
    });
    // ⏱️ Tự reset sau 60s — cho phép retry sau khi user giải CAPTCHA
    if (wafUnlockTimer) clearTimeout(wafUnlockTimer);
    wafUnlockTimer = setTimeout(() => {
      isWafBlocked = false;
      wafUnlockTimer = null;
      updateIndicator("🟡 WAF cooldown ended — retry allowed", "#FF9800");
      console.log("[Content] 🛡️ WAF auto-unlocked after 60s cooldown.");
    }, 60000);
  } else if (data.type === "Z_AI_USAGE" && data.usage) {
    console.log("[Content] 📊 Usage data from Z.AI API:", JSON.stringify(data.usage));
    safeSend({
      type: "usage",
      usage: data.usage,
      requestId: currentRequestId
    });
  } else if (data.type === "Z_AI_SEARCH_RESULTS" && data.results) {
    console.log("[Content] 🔍 Search results received:", data.results.length, "results");
    safeSend({
      type: "search_results",
      results: data.results,
      requestId: currentRequestId
    });
  } else if (data.type === "Z_AI_SEARCH_PHASE") {
    console.log("[Content] 🔍 Search phase:", data.phase);
    safeSend({
      type: "search_phase",
      phase: data.phase,
      requestId: currentRequestId
    });
  }
});

// Remote Logging
// Only forward error/warn logs, not all console.log (Issue #5 fix)
let isLogging = false;

const originalLog = console.log;
console.log = (...args) => {
  originalLog.apply(console, args);
};

const originalError = console.error;
console.error = (...args) => {
  originalError.apply(console, args);
  if (isLogging) return;
  isLogging = true;
  try {
    if (isStreaming) return; // Skip safeSend to prevent WS flood during streaming
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "remote_log",
          logType: "error",
          text: args.join(" "),
        }),
      );
    }
  } catch (e) {
    originalError.apply(console, ["[Content] Failed to send remote log:", e]);
  } finally {
    isLogging = false;
  }
};

const originalWarn = console.warn;
console.warn = (...args) => {
  originalWarn.apply(console, args);
  if (isLogging) return;
  isLogging = true;
  try {
    if (isStreaming) return; // Skip safeSend to prevent WS flood during streaming
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "remote_log",
          logType: "warn",
          text: args.join(" "),
        }),
      );
    }
  } catch (e) {
    originalError.apply(console, ["[Content] Failed to send remote log:", e]);
  } finally {
    isLogging = false;
  }
};

function updateIndicator(text, color) {
  if (!indicator) indicator = document.getElementById("z-ai-bridge-indicator");
  if (indicator) {
    indicator.innerText = text;
    indicator.style.background = color;
  }
}

function injectIndicator() {
  const createIndicator = () => {
    if (document.getElementById("z-ai-bridge-indicator")) return;
    indicator = document.createElement("div");
    indicator.id = "z-ai-bridge-indicator";
    indicator.style.cssText =
      "position:fixed;bottom:20px;right:20px;background:#f44336;color:white;padding:8px 12px;zIndex:999999;borderRadius:4px;fontSize:12px;fontWeight:bold;fontFamily:sans-serif;boxShadow:0 2px 10px rgba(0,0,0,0.3);pointerEvents:none;";
    indicator.innerText = "🔴 Z.AI Bridge Disconnected";
    document.body.appendChild(indicator);
  };
  // Use DOMContentLoaded instead of polling (Issue #11 fix)
  if (document.body) {
    createIndicator();
  } else {
    document.addEventListener("DOMContentLoaded", createIndicator);
  }
}
injectIndicator();

// ============================================================
// 🧠 Full DOM Optimizer — Ẩn thinking + Containment + Hide Old Messages
// Giảm tải browser khi stream code lớn, chống lag và treo trang
// ============================================================

(function optimizeZaiDOM() {
  const style = document.createElement("style");
  style.id = "z-ai-dom-optimizer";
  style.textContent = `
    /* ===== THINKING: Ẩn hoàn toàn ===== */
    .thinking-chain-container,
    .thinking-block {
      display: none !important;
      max-height: 0 !important;
      overflow: hidden !important;
      visibility: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* ===== MESSAGES CŨ: Chỉ ẩn tin cũ thông qua class tĩnh được JS quản lý ===== */
    .z-ai-old-message {
      display: none !important;
    }

    /* ===== OUTPUT: CSS Containment — ngăn reflow cascade ===== */
    .prose,
    .chat-assistant,
    .chat-user,
    article {
      contain: content;
      content-visibility: auto;
      contain-intrinsic-size: auto 800px;
    }

    pre, code {
      contain: content;
      content-visibility: auto;
      contain-intrinsic-size: auto 600px;
    }

    [class*="captcha"],
    [class*="challenge"],
    [class*="verify"],
    [class*="slider"],
    iframe[src*="captcha"],
    [class*="error"],
    [class*="toast"],
    [class*="notification"] {
      display: block !important;
      visibility: visible !important;
      content-visibility: visible !important;
      contain: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  let hideMsgTimer = null;

  function pruneDOM() {
    hideMsgTimer = null;

    // 1. Ẩn tin nhắn cũ (giữ lại 2 tin nhắn mới nhất)
    const containers = document.querySelectorAll(
      ".chat-assistant, .chat-user, article",
    );
    const total = containers.length;
    if (total > 2) {
      for (let i = 0; i < total - 2; i++) {
        if (!containers[i].classList.contains("z-ai-old-message")) {
          containers[i].classList.add("z-ai-old-message");
        }
      }
      for (let i = Math.max(0, total - 2); i < total; i++) {
        containers[i].classList.remove("z-ai-old-message");
      }
    }

    // 2. 🚀 Prune Completed Code Blocks > 30 dòng (Giải phóng 80-90% thẻ <span> syntax highlight khỏi DOM)
    const codeBlocks = document.querySelectorAll("pre:not(.code-pruned)");
    for (const block of codeBlocks) {
      const text = block.textContent || "";
      const lines = text.split("\n");
      if (lines.length > 30) {
        block.dataset.fullContent = text;
        block.classList.add("code-pruned");

        const previewText = lines.slice(0, 10).join("\n") +
          `\n\n... ▼ ${lines.length - 20} lines hidden (Click to expand full code) ▼ ...\n\n` +
          lines.slice(-10).join("\n");

        const btn = document.createElement("button");
        btn.innerText = `🔍 Expand Full Code (${lines.length} lines)`;
        btn.style.cssText = "display:block;margin:8px 0;padding:6px 12px;background:#2196F3;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";

        const previewContainer = document.createElement("div");
        previewContainer.className = "pruned-code-wrapper";

        const pre = document.createElement("pre");
        pre.textContent = previewText;
        pre.style.cssText = "opacity:0.85;max-height:350px;overflow:auto;";

        btn.onclick = () => {
          pre.textContent = block.dataset.fullContent;
          pre.style.opacity = "1";
          pre.style.maxHeight = "none";
          btn.style.display = "none";
        };

        previewContainer.appendChild(pre);
        previewContainer.appendChild(btn);
        block.replaceWith(previewContainer);
      }
    }
  }

  function scheduleOptimizer() {
    if (hideMsgTimer) return;
    hideMsgTimer = setTimeout(pruneDOM, 1000);
  }

  // 🚀 Scoped MutationObserver: Khoanh vùng vào chat container (KHÔNG quét document.documentElement)
  const hideMsgObserver = new MutationObserver((mutations) => {
    let shouldPrune = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldPrune = true;
        break;
      }
    }
    if (shouldPrune) scheduleOptimizer();
  });

  const startObserving = () => {
    const chatContainer = document.querySelector('[class*="chat"]') ||
      document.querySelector('main') ||
      document.body;
    hideMsgObserver.observe(chatContainer, {
      childList: true,
      subtree: false // 🚀 Không dùng subtree để triệt hạ hàng trăm observer callback/giây
    });
    pruneDOM();
  };

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener("DOMContentLoaded", startObserving);
  }

  console.log(
    "[Content] 🧠 JS Scoped DOM Optimizer & Code Pruner activated (1000ms throttle).",
  );
})();

// ============================================================
// 🟢 Page Ready Detection — Chờ textarea rồi báo server
// ============================================================

let _pageReadyObserver = null;
let _pageReadyTimeout = null;

function waitForPageReadyAndSignal(context) {
  if (_pageReadyObserver) {
    _pageReadyObserver.disconnect();
    _pageReadyObserver = null;
  }
  if (_pageReadyTimeout) {
    clearTimeout(_pageReadyTimeout);
    _pageReadyTimeout = null;
  }

  const ta = document.querySelector("textarea");
  if (ta) {
    console.log(`[Content] ✅ page_ready (immediate) — context: ${context}`);
    safeSend({ type: "page_ready", context });
    return;
  }

  _pageReadyObserver = new MutationObserver(() => {
    const ta2 = document.querySelector("textarea");
    if (ta2) {
      _pageReadyObserver.disconnect();
      _pageReadyObserver = null;
      clearTimeout(_pageReadyTimeout);
      _pageReadyTimeout = null;
      console.log(`[Content] ✅ page_ready (observed) — context: ${context}`);
      safeSend({ type: "page_ready", context });
    }
  });
  _pageReadyObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  _pageReadyTimeout = setTimeout(() => {
    if (_pageReadyObserver) {
      _pageReadyObserver.disconnect();
      _pageReadyObserver = null;
    }
    _pageReadyTimeout = null;
    console.warn(`[Content] ⚠️ page_ready timeout (15s) — proceeding anyway`);
    safeSend({ type: "page_ready", context, timedOut: true });
  }, 15000);
}

let heartbeatTimer = null;

function connectWS() {
  if (ws)
    try {
      ws.close();
    } catch (e) {}
  
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  ws = new WebSocket("ws://127.0.0.1:8899?client=content");

  ws.onopen = () => {
    console.log("[Content] Connected to WS");
    isWafBlocked = false; // 🚨 WAF Shield: reset cờ khi reconnect
    if (wafUnlockTimer) {
      clearTimeout(wafUnlockTimer);
      wafUnlockTimer = null;
    }
    updateIndicator("🟢 Z.AI Bridge Connected (Network Mode)", "#4CAF50");
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // 💓 10s Heartbeat Ping giữ kết nối WebSocket mở 24/7 ngầm
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch (e) {}
      }
    }, 10000);

    // Báo server biết trang đã sẵn sàng (chờ textarea)
    waitForPageReadyAndSignal("startup");
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.action === "send_prompt") {
        currentRequestId = data.requestId;
        if (data.isNewChat) {
          console.log("[Content] 🆕 Starting a new conversation (isNewChat = true).");
        } else {
          console.log("[Content] ➡️ Continuing active conversation (isNewChat = false).");
        }
        handleSendPrompt(data.prompt, data.isSearch || false);
      } else if (data.action === "cancel_stream") {
        // Logic dừng stream (bấm nút stop trên UI nếu cần)
        const textarea = document.querySelector("textarea");
        if (textarea) {
          const { stopBtn } = getZAIActionButtons(textarea);
          if (stopBtn) stopBtn.click();
        }
      } else if (data.action === "reset_page") {
        console.log("[Content] ℹ️ reset_page received but ignored to keep current chat page.");
        waitForPageReadyAndSignal("reset_ignored");
      }
    } catch (e) {
      console.error("[Content] Error parsing WS message:", e);
    }
  };

  ws.onclose = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (sendBuffer.length > 0) {
      sendBuffer = [];
    }
    if (sendBufferTimer) {
      clearTimeout(sendBufferTimer);
      sendBufferTimer = null;
    }
    updateIndicator("🔴 Z.AI Bridge Disconnected (Reconnecting...)", "#f44336");
    
    // ⚡ Fast Reconnect (300ms) để không bỏ lỡ request giữa các turn
    if (!reconnectTimer) {
      const delay = reconnectAttempts < 5 ? 300 : Math.min(1000 * Math.pow(1.5, reconnectAttempts), 15000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWS();
      }, delay);
    }
  };
}
connectWS(); // 🚀 Khởi động kết nối WebSocket ngay khi content script load
// 🖱️ Cubic Bezier Curve Mouse Trajectory Simulation with Jitter (Anti-WAF V1)
function cubicBezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

async function simulateMouseTrail(fromX, fromY, toRect, durationMs = 250) {
  const toX = toRect.left + toRect.width / 2;
  const toY = toRect.top + toRect.height / 2;

  const cp1x = fromX + (toX - fromX) * 0.3 + (Math.random() - 0.5) * 80;
  const cp1y = fromY + (toY - fromY) * 0.3 + (Math.random() - 0.5) * 80;
  const cp2x = fromX + (toX - fromX) * 0.7 + (Math.random() - 0.5) * 80;
  const cp2y = fromY + (toY - fromY) * 0.7 + (Math.random() - 0.5) * 80;

  const steps = Math.max(10, Math.floor(durationMs / 16));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bezierX = cubicBezier(t, fromX, cp1x, cp2x, toX);
    const bezierY = cubicBezier(t, fromY, cp1y, cp2y, toY);

    const jitterX = (Math.random() - 0.5) * 4;
    const jitterY = (Math.random() - 0.5) * 4;

    const currentX = Math.round(bezierX + jitterX);
    const currentY = Math.round(bezierY + jitterY);

    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: currentX,
        clientY: currentY,
      })
    );
    await new Promise((r) => setTimeout(r, 12 + Math.floor(Math.random() * 6)));
  }
}

// Helper: Nhận diện chính xác Nút Send (mũi tên ↑) và Nút Stop (hình vuông rect/■) trên Z.AI
function getZAIActionButtons(textarea) {
  if (!textarea) return { sendBtn: null, stopBtn: null };
  const container = textarea.closest("form") || textarea.parentElement?.parentElement || textarea.parentElement;
  if (!container) return { sendBtn: null, stopBtn: null };

  const buttons = Array.from(container.querySelectorAll("button"));
  let sendBtn = null;
  let stopBtn = null;

  for (const btn of buttons) {
    const hasSquare = btn.querySelector("rect") || (btn.innerText && btn.innerText.includes("■"));
    const hasArrow = btn.querySelector("path") || (btn.innerText && btn.innerText.includes("↑"));
    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();

    if (hasSquare || ariaLabel.includes("stop") || ariaLabel.includes("cancel")) {
      stopBtn = btn;
    } else if (hasArrow || btn.type === "submit" || btn.id === "send-message-button") {
      sendBtn = btn;
    }
  }

  if (!sendBtn && !stopBtn && buttons.length > 0) {
    const lastBtn = buttons[buttons.length - 1];
    if (lastBtn.querySelector("rect")) {
      stopBtn = lastBtn;
    } else {
      sendBtn = lastBtn;
    }
  }

  return { sendBtn, stopBtn };
}

// ============================================================
// 🛠️ Module 3 (V7.0): Network-Aware UI Desync Auto-Recovery
// ============================================================
async function ensureSendButtonReady() {
  const textarea = document.querySelector("textarea");
  if (!textarea) return false;

  const { sendBtn, stopBtn } = getZAIActionButtons(textarea);

  // ⚡ Nếu phát hiện Nút Stop đang bật (UI bị treo ngầm ở trạng thái loading cũ)
  if (stopBtn) {
    console.warn("[Content V7] 🚨 Stuck loading state detected! Auto-clicking Stop button to unlock UI...");
    try {
      stopBtn.click();
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {}
    isStreaming = false;
  }

  // ⚡ Unblock state cho sendBtn nếu bị disable ngầm
  if (sendBtn) {
    if (sendBtn.disabled || sendBtn.getAttribute("disabled") !== null) {
      console.log("[Content V7] 🔓 Unblocking send button state without reloading page...");
      sendBtn.disabled = false;
      sendBtn.removeAttribute("disabled");
    }
  }

  return true;
}

// ============================================================
// 🛠️ Module 1 (V7.0): Background-Aware Dual Input Engine
// ============================================================
async function setBackgroundAwareInput(textarea, prompt) {
  console.log(`[Content V7] ⚡ Universal Input Engine: Setting prompt (${prompt.length} chars) with React Tracker Fix.`);
  const lastValue = textarea.value;
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  
  nativeSetter.call(textarea, prompt);

  // 🚀 React 16+ _valueTracker fix so React internal state accepts text update in background/foreground
  const tracker = textarea._valueTracker;
  if (tracker) {
    tracker.setValue(lastValue);
  }
  
  // 🚀 Kích hoạt trực tiếp sự kiện React Fiber onChange & onInput trong bộ nhớ ngầm
  const fakeInputEvent = { target: textarea, currentTarget: textarea, bubbles: true };
  triggerReactFiberHandler(textarea, "input", fakeInputEvent);
  triggerReactFiberHandler(textarea, "change", fakeInputEvent);

  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: prompt.slice(-1) }));
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// Helper: Kích hoạt trực tiếp hàm xử lý sự kiện trong bộ nhớ của React Fiber Node
function triggerReactFiberHandler(element, eventType, fakeEvent) {
  if (!element) return false;
  for (const key of Object.keys(element)) {
    if (key.startsWith("__reactProps$") || key.startsWith("__reactEventHandlers$")) {
      const props = element[key];
      if (props) {
        const handlerName = "on" + eventType.charAt(0).toUpperCase() + eventType.slice(1);
        if (typeof props[handlerName] === "function") {
          try {
            props[handlerName](fakeEvent);
            console.log(`[Content V7] ⚡ Direct React Fiber ${handlerName} executed in memory!`);
            return true;
          } catch (e) {
            console.warn(`[Content V7] React Fiber ${handlerName} error:`, e);
          }
        }
      }
    }
  }
  return false;
}

// ============================================================
// 🛠️ Module 2 (V7.0): Background-Aware Smart Event Dispatcher (Tri-Layered Engine)
// ============================================================
async function dispatchBackgroundAwareSend(textarea, sendBtn) {
  await new Promise((r) => setTimeout(r, 100));

  if (textarea) {
    const actionBtns = getZAIActionButtons(textarea);
    if (actionBtns.sendBtn) sendBtn = actionBtns.sendBtn;
  }

  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.removeAttribute("disabled");
  }

  const parentForm = textarea ? textarea.closest("form") : (sendBtn ? sendBtn.closest("form") : null);

  // 🚀 Lớp 1: Submit Form HTML5 native (Hoạt động 100% khi Tab ngầm / Trình duyệt Minimize / Cả single-line & multi-line prompt)
  if (parentForm) {
    try {
      // Gọi requestSubmit() không tham số để tránh lỗi TypeError khi sendBtn là div/svg
      parentForm.requestSubmit();
      console.log("[Content V7] 🚀 Message dispatched via parentForm.requestSubmit().");
      return;
    } catch (e) {
      console.warn("[Content V7] parentForm.requestSubmit() error, trying submitter:", e);
      if (sendBtn && (sendBtn instanceof HTMLButtonElement || sendBtn instanceof HTMLInputElement)) {
        try {
          parentForm.requestSubmit(sendBtn);
          console.log("[Content V7] 🚀 Message dispatched via parentForm.requestSubmit(sendBtn).");
          return;
        } catch (err) {}
      }
    }
  }

  // 🚀 Lớp 2: Kích hoạt trực tiếp React Fiber onSubmit handler của Form
  if (parentForm) {
    const fakeSubmit = { preventDefault: () => {}, stopPropagation: () => {}, target: parentForm, currentTarget: parentForm, bubbles: true };
    const fiberSubmitSuccess = triggerReactFiberHandler(parentForm, "submit", fakeSubmit);
    if (fiberSubmitSuccess) {
      console.log("[Content V7] 🚀 Message dispatched via React Fiber parentForm onSubmit.");
      return;
    }
  }

  // 🚀 Lớp 3: Click nút Send trực tiếp (Native click + React Fiber)
  if (sendBtn) {
    try {
      sendBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      sendBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      sendBtn.click();
      console.log("[Content V7] 🚀 Message dispatched via native sendBtn.click().");
      return;
    } catch (e) {}
  }

  // 🚀 Lớp 4: Enter Key / Ctrl+Enter Key trên Textarea (Fallback cuối cùng)
  if (textarea) {
    try {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: false, bubbles: true, cancelable: true }));
      console.log("[Content V7] 🚀 Message dispatched via Textarea Enter event.");
    } catch (e) {}
  }
}

// ============================================================
// 🛠️ Dispatcher nhập liệu & gửi tin nhắn V7.0
// ============================================================

// ⚡ V7.0 Ultra Performance: Auto-prune old DOM message nodes to keep chat.z.ai DOM lightweight (<50 nodes)
function pruneOldChatDOM() {
  try {
    const messageNodes = document.querySelectorAll("[data-message-author-role], .chat-message, .message-item, div[class*='message_']");
    if (messageNodes.length > 20) {
      console.log(`[Content V7] 🧹 Pruning ${messageNodes.length - 10} old DOM message nodes to prevent browser lag...`);
      const nodesToRemove = Array.from(messageNodes).slice(0, messageNodes.length - 10);
      for (const node of nodesToRemove) {
        try { node.remove(); } catch (e) {}
      }
    }
  } catch (e) {
    console.warn("[Content V7] Prune DOM error:", e);
  }
}

async function handleSendPrompt(prompt, isSearch) {
  if (isSearch) {
    console.log("[Content V7] 🔍 Search mode: sending Z_AI_ENABLE_SEARCH to inject.js");
    window.postMessage({ type: "Z_AI_ENABLE_SEARCH" }, "*");
  }

  if (isWafBlocked) {
    console.warn("[Content V7] 🚨 WAF blocked — aborting send. Solve CAPTCHA first.");
    safeSend({ type: "stream_end", requestId: currentRequestId, error: "WAF_BLOCKED" });
    return;
  }

  await rateLimit();

  // 1. Tự động kiểm tra và bấm nút Stop nếu UI bị treo ngầm từ turn trước
  await ensureSendButtonReady();

  // 2. Chờ textarea sẵn sàng
  const maxRetries = 30;
  let retries = 0;
  let textarea = document.querySelector("textarea");
  while (!textarea && retries < maxRetries) {
    await new Promise((r) => setTimeout(r, 500));
    textarea = document.querySelector("textarea");
    retries++;
  }
  if (!textarea) return;

  // 2.5 Tự động cắt tỉa các node DOM tin nhắn cũ để chống ngốn RAM & giật lag khi chat phiên dài
  pruneOldChatDOM();

  // 3. Điền prompt hỗ trợ Background / React Tracker Fix
  await setBackgroundAwareInput(textarea, prompt);

  // 4. Tìm nút Send và kích hoạt Tri-Layered Engine
  const { sendBtn } = getZAIActionButtons(textarea);
  await dispatchBackgroundAwareSend(textarea, sendBtn);
}
