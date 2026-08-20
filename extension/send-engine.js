// send-engine.js — Z.AI Bridge V7.0 | On-Demand Lazy Module
// Loaded only when server sends a "send_prompt" action via WebSocket.
// Depends on window.__zai (shared state from content.js core).

(function() {
  // Guard: chỉ chạy 1 lần
  if (window.__zai_send_engine_active) return;
  window.__zai_send_engine_active = true;
  console.log('[SendEngine] ✅ Loaded on-demand. Ready to handle send_prompt.');

  // =========================================================
  // Shared state bridge — đọc/ghi qua window.__zai namespace
  // (được khởi tạo bởi content.js core)
  // =========================================================
  function getState() { return window.__zai || {}; }
  function setState(patch) { Object.assign(window.__zai, patch); }

  // =========================================================
  // 🖱️ Cubic Bezier Curve Mouse Trajectory Simulation (Anti-WAF)
  // =========================================================
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

      document.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(bezierX + jitterX),
          clientY: Math.round(bezierY + jitterY),
        })
      );
      await new Promise((r) => setTimeout(r, 12 + Math.floor(Math.random() * 6)));
    }
  }

  // =========================================================
  // Helper: Nhận diện nút Send (↑) và Stop (■) trên Z.AI
  // =========================================================
  function getZAIActionButtons(textarea) {
    if (!textarea) return { sendBtn: null, stopBtn: null };
    const container = textarea.closest('form') || textarea.parentElement?.parentElement || textarea.parentElement;
    if (!container) return { sendBtn: null, stopBtn: null };

    const buttons = Array.from(container.querySelectorAll('button'));
    let sendBtn = null;
    let stopBtn = null;

    for (const btn of buttons) {
      const hasSquare = btn.querySelector('rect') || (btn.innerText && btn.innerText.includes('■'));
      const hasArrow = btn.querySelector('path') || (btn.innerText && btn.innerText.includes('↑'));
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

      if (hasSquare || ariaLabel.includes('stop') || ariaLabel.includes('cancel')) {
        stopBtn = btn;
      } else if (hasArrow || btn.type === 'submit' || btn.id === 'send-message-button') {
        sendBtn = btn;
      }
    }

    if (!sendBtn && !stopBtn && buttons.length > 0) {
      const lastBtn = buttons[buttons.length - 1];
      if (lastBtn.querySelector('rect')) {
        stopBtn = lastBtn;
      } else {
        sendBtn = lastBtn;
      }
    }

    return { sendBtn, stopBtn };
  }

  // =========================================================
  // Helper: Kích hoạt trực tiếp React Fiber event handler
  // =========================================================
  function triggerReactFiberHandler(element, eventType, fakeEvent) {
    if (!element) return false;
    for (const key of Object.keys(element)) {
      if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
        const props = element[key];
        if (props) {
          const handlerName = 'on' + eventType.charAt(0).toUpperCase() + eventType.slice(1);
          if (typeof props[handlerName] === 'function') {
            try {
              props[handlerName](fakeEvent);
              console.log(`[SendEngine] ⚡ React Fiber ${handlerName} executed in memory!`);
              return true;
            } catch (e) {
              console.warn(`[SendEngine] React Fiber ${handlerName} error:`, e);
            }
          }
        }
      }
    }
    return false;
  }

  // =========================================================
  // Module 3: Network-Aware UI Desync Auto-Recovery
  // =========================================================
  async function ensureSendButtonReady() {
    let textarea = document.querySelector('textarea');
    if (!textarea) return false;

    let { sendBtn, stopBtn } = getZAIActionButtons(textarea);
    let waitCount = 0;

    while ((stopBtn || getState().isStreaming) && !sendBtn && waitCount < 60) {
      console.log(`[SendEngine] ⏳ Z.AI is generating. Waiting... (${waitCount * 500}ms)`);
      await new Promise((r) => setTimeout(r, 500));
      textarea = document.querySelector('textarea') || textarea;
      const btns = getZAIActionButtons(textarea);
      stopBtn = btns.stopBtn;
      sendBtn = btns.sendBtn;
      waitCount++;
    }

    if (stopBtn && !sendBtn) {
      console.warn('[SendEngine] 🚨 Stuck after 30s! Auto-clicking Stop...');
      try {
        stopBtn.click();
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {}
      setState({ isStreaming: false });
    }

    textarea = document.querySelector('textarea') || textarea;
    sendBtn = getZAIActionButtons(textarea).sendBtn || sendBtn;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.removeAttribute('disabled');
    }
    return true;
  }

  // =========================================================
  // Module 1: Background-Aware Dual Input Engine
  // =========================================================
  async function setBackgroundAwareInput(textarea, prompt) {
    console.log(`[SendEngine] ⚡ Setting prompt (${prompt.length} chars) with React Tracker Fix.`);
    const lastValue = textarea.value;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    ).set;

    nativeSetter.call(textarea, prompt);

    const tracker = textarea._valueTracker;
    if (tracker) tracker.setValue(lastValue);

    const fakeInputEvent = { target: textarea, currentTarget: textarea, bubbles: true };
    triggerReactFiberHandler(textarea, 'input', fakeInputEvent);
    triggerReactFiberHandler(textarea, 'change', fakeInputEvent);

    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: prompt.slice(-1) }));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // =========================================================
  // Module 1.5: Human-Like Cadence Typing (Anti-WAF Behavioral)
  // =========================================================
  async function typeLikeHuman(textarea, text) {
    console.log(`[SendEngine] ⌨️ Typing prompt like human (${text.length} chars)...`);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    ).set;
    const parts = text.split(/(\s+)/); // split by words while preserving whitespace
    let acc = '';
    const startTime = Date.now();
    for (const part of parts) {
      if (Date.now() - startTime > 15000) { // Safety guard: max 15s typing
        nativeSetter.call(textarea, text);
        break;
      }
      acc += part;
      nativeSetter.call(textarea, acc);
      const tracker = textarea._valueTracker;
      if (tracker) tracker.setValue(acc.slice(0, acc.length - part.length));
      triggerReactFiberHandler(textarea, 'input', { target: textarea, currentTarget: textarea, bubbles: true });
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: part.slice(-1) || ' ' }));
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 45)));
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // =========================================================
  // Module 2: Background-Aware Smart Event Dispatcher
  // =========================================================
  async function dispatchBackgroundAwareSend(textarea, sendBtn) {
    await new Promise((r) => setTimeout(r, 100));

    if (textarea) {
      const actionBtns = getZAIActionButtons(textarea);
      if (actionBtns.sendBtn) sendBtn = actionBtns.sendBtn;
    }

    let realButton = sendBtn;
    if (realButton && realButton.tagName !== 'BUTTON') {
      realButton = realButton.closest('button') || realButton.closest("[role='button']") || realButton;
    }
    if (realButton) {
      realButton.disabled = false;
      realButton.removeAttribute('disabled');
    }

    // Lớp 1: Native HTML5 requestSubmit
    const parentForm = textarea ? textarea.closest('form') : (realButton ? realButton.closest('form') : null);
    if (parentForm) {
      try {
        parentForm.requestSubmit();
        console.log('[SendEngine] 🚀 Dispatched via parentForm.requestSubmit().');
        return;
      } catch (e) {}
    }

    // Lớp 2: React Fiber onKeyDown(Enter) trên Textarea
    if (textarea) {
      const fakeEnter = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        shiftKey: false, ctrlKey: false, metaKey: false,
        bubbles: true, preventDefault: () => {}, stopPropagation: () => {}
      };
      if (triggerReactFiberHandler(textarea, 'keyDown', fakeEnter)) {
        console.log('[SendEngine] 🚀 Dispatched via React Fiber textarea.onKeyDown(Enter).');
        return;
      }
    }

    // Lớp 3: React Fiber onClick trên button
    if (realButton) {
      const fakeClick = { preventDefault: () => {}, stopPropagation: () => {}, target: realButton, currentTarget: realButton, bubbles: true };
      if (triggerReactFiberHandler(realButton, 'click', fakeClick)) {
        console.log('[SendEngine] 🚀 Dispatched via React Fiber realButton.onClick.');
        return;
      }
    }

    // Lớp 4: Native Mouse Click Fallback
    if (realButton) {
      try {
        realButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        realButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        realButton.click();
        console.log('[SendEngine] 🚀 Dispatched via native realButton.click().');
        return;
      } catch (e) {}
    }

    if (textarea) {
      try {
        textarea.focus();
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: false, bubbles: true, cancelable: true }));
        console.log('[SendEngine] 🚀 Dispatched via native Textarea Enter event.');
      } catch (e) {}
    }
  }


  // =========================================================
  // Auto-Prune Old Chat DOM Nodes
  // =========================================================
  function pruneOldChatDOM() {
    try {
      const messageNodes = document.querySelectorAll("[data-message-author-role], .chat-message, .message-item, div[class*='message_']");
      if (messageNodes.length > 20) {
        console.log(`[SendEngine] 🧹 Pruning ${messageNodes.length - 10} old DOM nodes...`);
        const nodesToRemove = Array.from(messageNodes).slice(0, messageNodes.length - 10);
        for (const node of nodesToRemove) {
          try { node.remove(); } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[SendEngine] Prune DOM error:', e);
    }
  }

  // =========================================================
  // Main: handleSendPrompt — nhận data từ postMessage payload
  // =========================================================
  async function handleSendPrompt(prompt, isSearch, isWafBlocked, lastRequestTime, requestId) {
    // 🛡️ Dedupe: Tránh double-dispatch nếu cả 2 websocket connection gửi cùng lúc
    if (requestId && window.__zai_lastHandledRequestId === requestId) {
      console.log(`[SendEngine] ⏭️ Duplicate requestId (${requestId}) ignored.`);
      return;
    }
    if (requestId) window.__zai_lastHandledRequestId = requestId;

    if (isSearch) {
      console.log('[SendEngine] 🔍 Search mode: sending Z_AI_ENABLE_SEARCH to inject.js');
      window.postMessage({ type: 'Z_AI_ENABLE_SEARCH' }, '*');
    }

    if (isWafBlocked) {
      console.warn('[SendEngine] 🚨 WAF blocked — aborting. Solve CAPTCHA first.');
      // Báo về content.js (ISOLATED world) qua postMessage
      window.postMessage({ type: 'Z_AI_WAF_ABORT', requestId }, '*');
      return;
    }

    // Rate limit (200ms minimum interval)
    const MIN_INTERVAL = 200;
    const now = Date.now();
    const elapsed = now - (lastRequestTime || 0);
    if (elapsed < MIN_INTERVAL && lastRequestTime > 0) {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL - elapsed));
    }
    // Báo content.js cập nhật lastRequestTime
    window.postMessage({ type: 'Z_AI_UPDATE_STATE', lastRequestTime: Date.now() }, '*');

    // 1. Đảm bảo nút Send sẵn sàng
    await ensureSendButtonReady();

    // 2. Chờ textarea
    const maxRetries = 30;
    let retries = 0;
    let textarea = document.querySelector('textarea');
    while (!textarea && retries < maxRetries) {
      await new Promise((r) => setTimeout(r, 500));
      textarea = document.querySelector('textarea');
      retries++;
    }
    if (!textarea) return;

    // 2.2 🖱️ Mô phỏng di chuột Bezier tới textarea (Anti-WAF Behavioral)
    try {
      const fromX = Math.random() * window.innerWidth * 0.4;
      const fromY = Math.random() * window.innerHeight * 0.4;
      const rect = textarea.getBoundingClientRect();
      console.log('[SendEngine] 🖱️ Simulating human mouse trajectory...');
      await simulateMouseTrail(fromX, fromY, rect, 200 + Math.floor(Math.random() * 150));
    } catch (e) {}

    // 2.5 Prune old DOM nodes
    pruneOldChatDOM();

    // 3. Điền prompt (người thật hoặc background)
    if (prompt.length <= 1200) {
      await typeLikeHuman(textarea, prompt);
    } else {
      await setBackgroundAwareInput(textarea, prompt);
    }

    // 4. Chờ React cập nhật state
    await new Promise((r) => setTimeout(r, 50));

    // 5. Re-query sau React re-render
    textarea = document.querySelector('textarea') || textarea;
    let { sendBtn } = getZAIActionButtons(textarea);

    // Theo dõi stream bắt đầu để tránh double-submit
    let streamStarted = false;
    const deltaListener = (e) => {
      if (e.source === window && (e.data?.type === 'Z_AI_SSE_DELTA' || e.data?.type === 'Z_AI_SSE_DELTAS')) {
        streamStarted = true;
      }
    };
    window.addEventListener('message', deltaListener);

    // 6. Gửi tin
    await dispatchBackgroundAwareSend(textarea, sendBtn);

    // 7. Smart Retry: chỉ retry sau 1.5s nếu chưa có stream nào bắt đầu
    await new Promise((r) => setTimeout(r, 1500));
    window.removeEventListener('message', deltaListener);
    if (!streamStarted) {
      const { sendBtn: sendBtn2 } = getZAIActionButtons(document.querySelector('textarea') || textarea);
      if (sendBtn2) {
        console.log('[SendEngine] 🔄 No stream detected after 1500ms — Smart retrying dispatchBackgroundAwareSend...');
        textarea = document.querySelector('textarea') || textarea;
        await dispatchBackgroundAwareSend(textarea, sendBtn2);
      }
    }
  }

  // =========================================================
  // Entry point: Lắng nghe Z_AI_TRIGGER_SEND từ content.js
  // Dùng postMessage vì MAIN world và ISOLATED world có window riêng
  // window.__zai_handleSendPrompt từ MAIN world KHÔNG visible ở ISOLATED world
  // =========================================================
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== 'Z_AI_TRIGGER_SEND') return;

    await handleSendPrompt(
      data.prompt,
      data.isSearch || false,
      data.isWafBlocked || false,
      data.lastRequestTime || 0,
      data.requestId || null
    );
  });

  console.log('[SendEngine] 🎯 Listening for Z_AI_TRIGGER_SEND messages (cross-world postMessage).');
})();
