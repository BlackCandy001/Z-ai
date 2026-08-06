(function() {
  console.log('[Inject] Z.AI Bridge Network Interception loaded.');

  // ⚡ V7.0 Page Visibility Override & requestAnimationFrame Unfreezer
  // Ep React và Chromium luon coi Tab o trang thai Active / Visible 60 FPS ngam
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });

    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    document.addEventListener('webkitvisibilitychange', (e) => e.stopImmediatePropagation(), true);
    window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
    window.addEventListener('focusout', (e) => e.stopImmediatePropagation(), true);

    const nativeRAF = window.requestAnimationFrame;
    const nativeCAF = window.cancelAnimationFrame;
    const rafCallbacks = new Map();
    let rafCounter = 0;

    window.requestAnimationFrame = function(callback) {
      const handle = ++rafCounter;
      const rafId = nativeRAF.call(window, (timestamp) => {
        if (rafCallbacks.has(handle)) {
          clearTimeout(rafCallbacks.get(handle).timerId);
          rafCallbacks.delete(handle);
          callback(timestamp);
        }
      });
      
      const timerId = setTimeout(() => {
        if (rafCallbacks.has(handle)) {
          rafCallbacks.delete(handle);
          try { nativeCAF.call(window, rafId); } catch (e) {}
          callback(performance.now());
        }
      }, document.hidden ? 40 : 16);

      rafCallbacks.set(handle, { rafId, timerId });
      return handle;
    };

    window.cancelAnimationFrame = function(handle) {
      if (rafCallbacks.has(handle)) {
        const { rafId, timerId } = rafCallbacks.get(handle);
        clearTimeout(timerId);
        try { nativeCAF.call(window, rafId); } catch (e) {}
        rafCallbacks.delete(handle);
      }
    };
    console.log('[Inject] 🚀 Page Visibility Override & RAF Unfreezer active (Tab forced ACTIVE 24/7).');
  } catch (e) {
    console.error('[Inject] Page Visibility Override error:', e);
  }

  // ← NEW: Search mode flag — set by content.js via postMessage
  window.__zai_search_enabled = false;

  // ← NEW: Listen for search enable message from content.js
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'Z_AI_ENABLE_SEARCH') {
      console.log('[Inject] 🔍 Search enable message received. Setting __zai_search_enabled = true');
      window.__zai_search_enabled = true;
    }
  });

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const [request, config] = args;
    let url = '';
    
    if (request instanceof Request) {
      url = request.url;
    } else if (typeof request === 'string') {
      url = request;
    }

    // Can thiệp vào endpoint chat của Z.AI (bắt mọi biến thể URL /chat/completions)
    if (url.includes('/chat/completions')) {
      console.log('[Inject] Target API detected:', url.split('?')[0]);

      // ← NEW: Check if search mode is requested → modify fetch payload
      const searchEnabled = window.__zai_search_enabled === true;
      let modifiedArgs = args;

      if (searchEnabled) {
        try {
          let body = null;

          if (request instanceof Request) {
            const cloned = request.clone();
            body = await cloned.json();
          } else if (config && config.body) {
            if (typeof config.body === 'string') {
              body = JSON.parse(config.body);
            } else {
              body = config.body;
            }
          }

          if (body) {
            if (body.features) {
              body.features.web_search = true;
              console.log('[Inject] 🔍 Search mode: features.web_search set to TRUE');
            } else {
              body.features = { image_generation: false, web_search: true, auto_web_search: false, preview_mode: true, flags: [] };
              console.log('[Inject] 🔍 Search mode: created features with web_search = TRUE');
            }

            const bodyStr = JSON.stringify(body);

            if (request instanceof Request) {
              modifiedArgs = [new Request(request, {
                body: bodyStr,
                method: request.method,
                headers: request.headers,
              })];
            } else {
              modifiedArgs = [request, { ...config, body: bodyStr }];
            }

            window.__zai_search_enabled = false;
          }
        } catch (e) {
          console.error('[Inject] Failed to modify request body for search:', e);
          window.__zai_search_enabled = false;
        }
      }
      
      const response = await originalFetch.apply(this, modifiedArgs);
      
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        console.log('[Inject] 🚨 WAF/Rate limit detected! Status:', response.status);
        window.postMessage({
          type: 'Z_AI_WAF_BLOCK',
          status: response.status
        }, '*');
        return response;
      }
      
      const contentType = response.headers.get('Content-Type') || '';

      if (contentType.toLowerCase().includes('text/event-stream') || url.includes('/chat/completions')) {
        console.log('[Inject] SSE Stream detected. Intercepting via TransformStream...');
        
        let sseBuffer = '';
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        
        const interceptor = new TransformStream({
          transform(chunk, controller) {
            try {
              const text = decoder.decode(chunk, { stream: true });
              sseBuffer += text;
              const lines = sseBuffer.split('\n');
              sseBuffer = lines.pop() || '';
              
              const linesForBrowser = [];

              for (const line of lines) {
                let isThinkingLine = false;
                if (line.startsWith('data: ')) {
                  const jsonStr = line.substring(6).trim();
                  if (jsonStr !== '[DONE]') {
                    try {
                      const parsed = JSON.parse(jsonStr);
                      queuePostMessage(parsed);

                      if (parsed.data && parsed.data.phase === 'thinking') {
                        isThinkingLine = true;
                      }

                      if (parsed.data && parsed.data.phase === 'other' && parsed.data.usage) {
                        window.postMessage({
                          type: 'Z_AI_USAGE',
                          usage: parsed.data.usage,
                        }, '*');
                      }

                      if (parsed.data && parsed.data.search_results) {
                        window.postMessage({
                          type: 'Z_AI_SEARCH_RESULTS',
                          results: parsed.data.search_results,
                        }, '*');
                      }

                      if (parsed.data && parsed.data.phase === 'searching') {
                        window.postMessage({
                          type: 'Z_AI_SEARCH_PHASE',
                          phase: 'searching',
                        }, '*');
                      }
                    } catch (e) {}
                  }
                }
                if (!isThinkingLine) {
                  linesForBrowser.push(line);
                }
              }

              if (linesForBrowser.length > 0) {
                const filteredText = linesForBrowser.join('\n') + '\n';
                controller.enqueue(encoder.encode(filteredText));
              }
            } catch (e) {
              console.error('[Inject] SSE transform error:', e);
              controller.enqueue(chunk);
            }
          },
          flush() {
            if (sseBuffer.trim()) {
              const line = sseBuffer.trim();
              if (line.startsWith('data: ')) {
                const jsonStr = line.substring(6).trim();
                if (jsonStr !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(jsonStr);
                    queuePostMessage(parsed);
                  } catch (e) {}
                }
              }
            }
            flushInjectBuffer();
            window.postMessage({ type: 'Z_AI_STREAM_END_RAW' }, '*');
          }
        });
        
        const interceptedBody = response.body.pipeThrough(interceptor);
        
        const newHeaders = new Headers(response.headers);
        newHeaders.delete('content-encoding');
        newHeaders.delete('content-length');
        
        return new Response(interceptedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }
      return response;
    }

    return originalFetch.apply(this, args);
  };

  try {
    Object.defineProperty(window, 'fetch', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: window.fetch
    });

    const nativeGetDescriptor = Object.getOwnPropertyDescriptor;
    Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
      enumerable: false,
      configurable: true,
      writable: false,
      value: function(obj, prop) {
        if (obj === window && prop === 'fetch') {
          return {
            value: window.fetch,
            writable: true,
            enumerable: false,
            configurable: true
          };
        }
        return nativeGetDescriptor.apply(this, arguments);
      }
    });

    const nativeToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === window.fetch) {
        return "function fetch() { [native code] }";
      }
      return nativeToString.apply(this, arguments);
    };
    window.fetch.toString = function() {
      return "function fetch() { [native code] }";
    };
  } catch (e) {
    console.error('[Inject] Failed to patch toString / PropertyDescriptor:', e);
  }

  let injectBuffer = [];
  let injectTimer = null;

  function flushInjectBuffer() {
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = null;
    }
    if (injectBuffer.length > 0) {
      window.postMessage({
        type: 'Z_AI_SSE_DELTAS',
        payloads: [...injectBuffer]
      }, '*');
      injectBuffer = [];
    }
  }

  function queuePostMessage(parsed) {
    if (!parsed) return;
    
    // ⚡ Bắt 100% tất cả gói tin delta_content (kể cả chuỗi rỗng/xuống dòng) hoặc phase done -> phát ĐƠN TỨC THÌ (0ms)
    if (parsed.data && (parsed.data.delta_content !== undefined || (parsed.data.phase === 'done' && parsed.data.done === true))) {
      window.postMessage({
        type: 'Z_AI_SSE_DELTA',
        payload: parsed
      }, '*');
      return;
    }

    injectBuffer.push(parsed);
    if (!injectTimer) {
      injectTimer = setTimeout(flushInjectBuffer, 50);
    }
  }
})();