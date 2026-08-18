// dom-optimizer.js — Z.AI Bridge V7.0 | High-Performance DOM Optimizer
// Xác thực chính xác 100% cấu trúc DOM Z.AI:
// - User Message:      .chat-user
// - Assistant Message: .chat-assistant
// - Markdown Body:     .markdown-prose

(function() {
  if (window.__zai_dom_optimizer_active) return;
  window.__zai_dom_optimizer_active = true;
  console.log('[DOMOptimizer] 🚀 Activating verified .chat-user / .chat-assistant Message Pruner...');

  // =========================================================
  // 1. CSS Containment & Ẩn phần tử
  // =========================================================
  const style = document.createElement('style');
  style.id = 'z-ai-dom-optimizer';
  style.textContent = `
    /* ===== THINKING: Ẩn nội dung chain nặng ===== */
    .thinking-chain-container,
    .thinking-block,
    [class*="thinking-chain"],
    [class*="thinkingBlock"],
    [class*="thinking-pulse"] {
      display: none !important;
    }

    /* ===== THINKING TOAST — Thông báo nhỏ gọn giữa đỉnh trang ===== */
    #z-ai-thinking-toast {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #a78bfa;
      border: 1px solid #4c1d95;
      border-radius: 20px;
      padding: 7px 16px;
      font-size: 13px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 20px rgba(139,92,246,0.3);
      z-index: 999998;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.25s ease, transform 0.25s ease;
    }
    #z-ai-thinking-toast.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    @keyframes z-ai-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    #z-ai-thinking-toast .dot {
      width: 7px;
      height: 7px;
      background: #a78bfa;
      border-radius: 50%;
      animation: z-ai-pulse 1.2s infinite;
    }
    #z-ai-thinking-toast .dot:nth-child(2) { animation-delay: 0.2s; }
    #z-ai-thinking-toast .dot:nth-child(3) { animation-delay: 0.4s; }

    /* ===== MESSAGES CŨ: Ẩn dứt điểm 100% không để lại khoảng trống ===== */
    .z-ai-old-message,
    .chat-user.z-ai-old-message,
    .chat-assistant.z-ai-old-message {
      display: none !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
      visibility: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* ===== OUTPUT: CSS Containment — ngăn reflow cascade ===== */
    .markdown-prose,
    .prose,
    .chat-assistant,
    .chat-user,
    article {
      contain: content;
      content-visibility: auto;
      contain-intrinsic-size: auto 600px;
    }

    pre, code {
      contain: content;
      content-visibility: auto;
      contain-intrinsic-size: auto 600px;
    }

    /* ===== CAPTCHA & Toasts: Luôn hiển thị ===== */
    [class*="captcha"],
    [class*="challenge"],
    [class*="verify"],
    [class*="slider"],
    iframe[src*="captcha"],
    [class*="error"],
    [data-sonner-toaster],
    [data-sonner-toast] {
      display: block !important;
      visibility: visible !important;
      content-visibility: visible !important;
      contain: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // =========================================================
  // 2. 🧠 Thinking Toast Manager (Network-Driven via inject.js)
  // =========================================================
  let _toastEl = null;
  let _thinkingHideTimer = null;
  let _isThinking = false;

  function getOrCreateToast() {
    if (_toastEl) return _toastEl;
    _toastEl = document.createElement('div');
    _toastEl.id = 'z-ai-thinking-toast';
    _toastEl.innerHTML = `
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
      <span style="margin-left:4px">AI đang suy nghĩ...</span>
    `;
    document.body.appendChild(_toastEl);
    return _toastEl;
  }

  function showThinkingToast() {
    if (_isThinking) return;
    _isThinking = true;
    if (_thinkingHideTimer) {
      clearTimeout(_thinkingHideTimer);
      _thinkingHideTimer = null;
    }
    if (!document.body) return;
    const toast = getOrCreateToast();
    toast.classList.add('visible');
  }

  function hideThinkingToast(immediate = false) {
    if (!_isThinking && (!_toastEl || !_toastEl.classList.contains('visible'))) return;
    _isThinking = false;
    if (_thinkingHideTimer) {
      clearTimeout(_thinkingHideTimer);
      _thinkingHideTimer = null;
    }
    
    const doHide = () => {
      if (_toastEl) _toastEl.classList.remove('visible');
    };

    if (immediate) {
      doHide();
    } else {
      _thinkingHideTimer = setTimeout(doHide, 300);
    }
  }

  // =========================================================
  // 3. 🙈 Message Pruner — Bộ chọn chuẩn xác .chat-user & .chat-assistant
  // =========================================================
  let hideMsgTimer = null;

  function pruneDOM() {
    hideMsgTimer = null;

    // 1. Quét tất cả các hàng tin nhắn (User và Assistant)
    const messages = Array.from(document.querySelectorAll('.chat-user, .chat-assistant'));
    const total = messages.length;
    // Giữ lại 4 tin nhắn gần nhất (~ 2 lượt hỏi - đáp mới nhất)
    const KEEP = 4;

    if (total > KEEP) {
      const hideCount = total - KEEP;
      for (let i = 0; i < hideCount; i++) {
        if (!messages[i].classList.contains('z-ai-old-message')) {
          messages[i].classList.add('z-ai-old-message');
          console.log(`[DOMOptimizer] 🙈 Ẩn tin nhắn cũ #${i + 1}/${total} (${messages[i].classList.contains('chat-user') ? 'User' : 'Assistant'})`);
        }
      }
      // Đảm bảo các tin nhắn mới nhất luôn hiển thị
      for (let i = hideCount; i < total; i++) {
        if (messages[i].classList.contains('z-ai-old-message')) {
          messages[i].classList.remove('z-ai-old-message');
        }
      }
    } else if (total > 0) {
      for (let i = 0; i < total; i++) {
        if (messages[i].classList.contains('z-ai-old-message')) {
          messages[i].classList.remove('z-ai-old-message');
        }
      }
    }

    // 2. Thu gọn code blocks > 30 dòng
    const codeBlocks = document.querySelectorAll('pre:not(.code-pruned)');
    for (const block of codeBlocks) {
      const text = block.textContent || '';
      const lines = text.split('\n');
      if (lines.length > 30) {
        block.dataset.fullContent = text;
        block.classList.add('code-pruned');

        block.style.cssText = 'max-height:280px;overflow:hidden;position:relative;';

        const overlay = document.createElement('div');
        overlay.className = 'z-ai-code-overlay';
        overlay.style.cssText = [
          'position:absolute;bottom:0;left:0;right:0;height:80px;',
          'background:linear-gradient(transparent,rgba(20,20,30,0.95));',
          'display:flex;align-items:flex-end;justify-content:center;',
          'padding-bottom:8px;z-index:10;pointer-events:auto;'
        ].join('');

        const btn = document.createElement('button');
        btn.innerText = `▼ Show all ${lines.length} lines`;
        btn.style.cssText = 'padding:4px 14px;background:#2196F3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;';
        btn.onclick = () => {
          block.style.maxHeight = 'none';
          block.style.overflow = 'auto';
          overlay.remove();
        };

        overlay.appendChild(btn);
        block.appendChild(overlay);
      }
    }
  }

  function scheduleOptimizer(delay = 400) {
    if (hideMsgTimer) clearTimeout(hideMsgTimer);
    hideMsgTimer = setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => pruneDOM(), { timeout: 1000 });
      } else {
        pruneDOM();
      }
    }, delay);
  }

  // =========================================================
  // 4. Triggers & Event Listeners
  // =========================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const type = event.data?.type;

    if (type === 'Z_AI_SET_THINKING') {
      if (event.data.thinking) {
        showThinkingToast();
      } else {
        hideThinkingToast(false);
        scheduleOptimizer(200);
      }
    } else if (type === 'Z_AI_STREAM_END_RAW') {
      hideThinkingToast(true);
      scheduleOptimizer(50);
    } else if (type === 'Z_AI_SSE_DELTA') {
      const phase = event.data?.payload?.data?.phase;
      if (phase === 'answer' || phase === 'done') {
        hideThinkingToast(true);
      }
    }
  });

  // MutationObserver toàn diện trên document.body
  const hideMsgObserver = new MutationObserver((mutations) => {
    let shouldPrune = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldPrune = true;
        break;
      }
    }
    if (shouldPrune) scheduleOptimizer(400);
  });

  const OBSERVER_CONFIG = { childList: true, subtree: true };

  const startObserving = () => {
    hideMsgObserver.observe(document.body || document.documentElement, OBSERVER_CONFIG);
    // Chạy dọn dẹp ngay lập tức (đã bỏ setInterval 1.5s polling thừa)
    pruneDOM();
  };

  // Pause optimizer khi tab ẩn để tiết kiệm CPU; resume + quét 1 lần khi tab hiện lại
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideMsgObserver.disconnect();
      if (hideMsgTimer) { clearTimeout(hideMsgTimer); hideMsgTimer = null; }
      console.log('[DOMOptimizer] 🛌 Tab hidden — observer paused.');
    } else {
      hideMsgObserver.observe(document.body || document.documentElement, OBSERVER_CONFIG);
      pruneDOM();
      console.log('[DOMOptimizer] 👁️ Tab visible — observer resumed.');
    }
  });

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving);
  }

  console.log('[DOMOptimizer] ✅ Verified .chat-user & .chat-assistant Pruner activated!');
})();
