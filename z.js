"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZChat = void 0;
const readline = __importStar(require("readline"));
const crypto = __importStar(require("crypto"));
const ws_1 = require("ws");
const rate_limiter_1 = require("./rate-limiter");
const usage_tracker_1 = require("./src/utils/usage-tracker");
async function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}
class ZChat {
    wss = null;
    wsConnection = null;
    bgConnection = null;
    offscreenConnection = null;
    contentConnection = null;
    proxyManager = null;
    currentStreamResolver = null;
    currentEndResolver = null;
    chatLock = Promise.resolve();
    rateLimiter;
    _accountRateLimiter; // alias
    usageTracker;
    _lastUsage = null;
    _currentSearchResults = null;
    // [Phase 3.3-3.5] Account tracking — nhận từ extension qua WS
    _activeUserId = null;
    _availableAccounts = [];
    _accountSwitchInProgress = false;
    // 🔗 Z.AI chat_id tracking — persist across requests
    currentZaiChatId = null;
    // Fix H03: Per-request context thay vì singleton resolvers.
    _activeCtx = null;
    // 🔑 Biết liệu đã có cuộc hội thoại đang mở trên browser chưa
    // → đat trực tiếp trong ZChat, không phụ thuộc vào conversationId từ Zen
    _hasBrowserSession = false;
    // 🔄 Smart Session Rolling — ngăn prompt tokens tích lũy quá ngưỡng
    // Dựa trên công thức thực đo: prompt_tokens(n) = 728 + (n-1)*55
    // Ngưỡng 3500 tokens ≈ sau 50 turns → response_time bắt đầu > 3.3s
    _sessionTurnCount = 0;
    SESSION_TOKEN_THRESHOLD = 3500; // tokens — reset khi đạt
    SESSION_TURN_THRESHOLD = 25; // turns — reset dự phòng
    get hasBrowserSession() {
        return this._hasBrowserSession;
    }
    get lastUsage() {
        return this._lastUsage;
    }
    get currentSearchResults() {
        return this._currentSearchResults;
    }
    getActiveAccount() {
        return this._activeUserId;
    }
    get activeUserId() {
        return this._activeUserId;
    }
    get availableAccounts() {
        return this._availableAccounts;
    }
    resetBrowserSession() {
        this._hasBrowserSession = false;
        console.log('[System] 🔴 Browser session reset.');
    }
    broadcastProxyConfig(config) {
        if (this.bgConnection && this.bgConnection.readyState === ws_1.WebSocket.OPEN) {
            console.log('[System] Broadcasting apply_proxy config to extension background SW.');
            this.bgConnection.send(JSON.stringify({ action: 'apply_proxy', config }));
        }
        else {
            console.log('[System] Background connection not active. Skipping proxy config broadcast.');
        }
    }
    constructor(rateLimitConfig) {
        this.rateLimiter = new rate_limiter_1.AccountRateLimiter(rateLimitConfig || rate_limiter_1.DEFAULT_RATE_LIMIT_CONFIG);
        this.usageTracker = new usage_tracker_1.UsageTracker();
        console.log('[RateLimiter] ✅ Initialized with config:', JSON.stringify(this.rateLimiter.getStatus()));
    }
    isConnected() {
        return this.wsConnection !== null;
    }
    async initBrowser() {
        console.log('[System] Khoi dong WebSocket Server tren cong 8899 de ket noi voi Chrome Extension...');
        const url = require('url');
        // Start WebSocket Server
        const WS_PORT = parseInt(process.env.WS_PORT || '8899', 10);
        this.wss = new ws_1.WebSocketServer({ port: WS_PORT });
        this.wss.on('connection', (ws, req) => {
            const parsedUrl = url.parse(req.url || '', true);
            const client = parsedUrl.query.client;
            if (client === 'background') {
                console.log('[System] Z.AI Bridge Extension (Background Worker) da ket noi!');
                this.bgConnection = ws;
                ws.on('message', (messageStr) => {
                    if (ws !== this.bgConnection)
                        return;
                    try {
                        const msg = JSON.parse(messageStr.toString());
                        if (msg.type === 'request_proxy_config') {
                            console.log('[System] Background SW requested proxy config.');
                            if (this.proxyManager) {
                                const proxyCfg = this.proxyManager.getConfig(false);
                                ws.send(JSON.stringify({ action: 'apply_proxy', config: proxyCfg }));
                            }
                        }
                        else if (msg.type === 'quota_sync') {
                            // [NEW 8.0] Real-time browser quota sync — per-account
                            const syncUserId = msg.userId || 'unknown';
                            this.rateLimiter.syncFromBrowser(syncUserId, {
                                userId: syncUserId,
                                perMinute: msg.perMinute || 0,
                                perHour: msg.perHour || 0,
                                wafBlocked: msg.wafBlocked || false,
                            });
                        }
                        else if (msg.type === 'account_info') {
                            // [Phase 3.3-3.5] Receive account info from extension
                            const prevActive = this._activeUserId;
                            const prevCount = this._availableAccounts.length;
                            this._activeUserId = msg.activeUserId || null;
                            this._availableAccounts = msg.availableAccounts || [];
                            if (prevActive !== this._activeUserId || prevCount !== this._availableAccounts.length) {
                                console.log(`[System] 📡 Account info: active=${this._activeUserId}, available=${this._availableAccounts.length} accounts`);
                            }
                        }
                    }
                    catch (e) { }
                });
                ws.on('close', () => {
                    console.log('[System] Z.AI Bridge Extension (Background) da ngat ket noi.');
                    if (ws === this.bgConnection) {
                        this.bgConnection = null;
                    }
                });
            }
            else if (client === 'offscreen') {
                console.log('[System] Z.AI Bridge Extension (Offscreen Document 24/7) da ket noi!');
                this.offscreenConnection = ws;
                this.wsConnection = ws;
                this._hasBrowserSession = true;
                ws.on('message', (messageStr) => {
                    this.wsConnection = ws;
                    const rawStr = messageStr.toString();
                    const lines = rawStr.split('\n');
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        try {
                            const msg = JSON.parse(line);
                            if (msg.type === 'stream_chunk' && this.currentStreamResolver) {
                                this.currentStreamResolver(msg.chunk);
                            }
                            else if (msg.type === 'usage' && msg.usage) {
                                console.log(`[System] 📊 Usage from Z.AI API: prompt=${msg.usage.prompt_tokens}, completion=${msg.usage.completion_tokens}, total=${msg.usage.total_tokens}`);
                                this._lastUsage = { promptTokens: msg.usage.prompt_tokens || 0, completionTokens: msg.usage.completion_tokens || 0, totalTokens: msg.usage.total_tokens || 0 };
                            }
                            else if (msg.type === 'stream_end' && this.currentEndResolver) {
                                this.currentEndResolver(msg.error);
                            }
                            else if (msg.type === 'waf_block') {
                                console.warn(`[System] 🚨 WAF block received from browser (status=${msg.status}). Activating cooldown + resolving pending stream.`);
                                this.rateLimiter.reportWAFBlock(this._activeUserId || undefined);
                                if (this.currentEndResolver) {
                                    this.currentEndResolver('WAF blocked (HTTP ' + (msg.status || '405') + ') — cooldown activated');
                                }
                            }
                            else if (msg.type === 'page_ready') {
                                console.log(`[System] ✅ page_ready signal received (context: ${msg.context}${msg.timedOut ? ', timedOut' : ''})`);
                                if (this._activeCtx?.pageReadyResolve) {
                                    this._activeCtx.pageReadyResolve(true);
                                    this._activeCtx.pageReadyResolve = null;
                                }
                            }
                        }
                        catch (e) { }
                    }
                });
                ws.on('close', () => {
                    console.log('[System] Z.AI Bridge Extension (Offscreen Document) da ngat ket noi.');
                    if (ws === this.offscreenConnection)
                        this.offscreenConnection = null;
                });
            }
            else {
                console.log('[System] Z.AI Bridge Extension (Content Script) da ket noi!');
                this.contentConnection = ws;
                if (!this.wsConnection)
                    this.wsConnection = ws;
                this._hasBrowserSession = true;
                ws.on('message', (messageStr) => {
                    this.wsConnection = ws;
                    const rawStr = messageStr.toString();
                    const lines = rawStr.split('\n');
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        try {
                            const msg = JSON.parse(line);
                            if (msg.type === 'stream_chunk' && this.currentStreamResolver) {
                                this.currentStreamResolver(msg.chunk);
                            }
                            else if (msg.type === 'usage' && msg.usage) {
                                console.log(`[System] 📊 Usage from Z.AI API: prompt=${msg.usage.prompt_tokens}, completion=${msg.usage.completion_tokens}, total=${msg.usage.total_tokens}`);
                                this._lastUsage = { promptTokens: msg.usage.prompt_tokens || 0, completionTokens: msg.usage.completion_tokens || 0, totalTokens: msg.usage.total_tokens || 0 };
                            }
                            else if (msg.type === 'stream_end' && this.currentEndResolver) {
                                this.currentEndResolver(msg.error);
                            }
                            else if (msg.type === 'waf_block') {
                                console.warn(`[System] 🚨 WAF block received from browser (status=${msg.status}). Activating cooldown + resolving pending stream.`);
                                this.rateLimiter.reportWAFBlock(this._activeUserId || undefined);
                                if (this.currentEndResolver) {
                                    this.currentEndResolver('WAF blocked (HTTP ' + (msg.status || '405') + ') — cooldown activated');
                                }
                            }
                            else if (msg.type === 'page_ready') {
                                console.log(`[System] ✅ page_ready signal received (context: ${msg.context}${msg.timedOut ? ', timedOut' : ''})`);
                                if (this._activeCtx?.pageReadyResolve) {
                                    this._activeCtx.pageReadyResolve(true);
                                    this._activeCtx.pageReadyResolve = null;
                                }
                            }
                        }
                        catch (e) { }
                    }
                });
                ws.on('close', () => {
                    console.log('[System] Z.AI Bridge Extension (Content Script) da ngat ket noi.');
                    if (ws === this.contentConnection)
                        this.contentConnection = null;
                });
            }
        });
        console.log('[System] WebSocket Server khoi dong thanh cong.');
        console.log('[System] Vui long mo Chrome chinh thuc (da load extension) va truy cap https://chat.z.ai/ de ket noi.\n');
    }
    async chat(prompt, onToken, conversationId = '', isNewChat = false, isSearch = false) {
        // Enforce sequential prompts using a promise lock
        const result = this.chatLock.then(async () => {
            await this.executeChat(prompt, onToken, conversationId, isNewChat, isSearch);
        });
        this.chatLock = result.catch(() => { });
        return result;
    }
    /**
     * Fix H02+H05+H03: Chờ extension báo page_ready (textarea sẵn sàng).
     * Thay thế magic setTimeout — event-driven, không có timing cứng.
     */
    async waitForPageReady(timeoutMs = 13000) {
        return new Promise((resolve) => {
            if (this._activeCtx)
                this._activeCtx.pageReadyResolve = resolve;
            setTimeout(() => {
                if (this._activeCtx?.pageReadyResolve === resolve) {
                    this._activeCtx.pageReadyResolve = null;
                    console.warn('[System] ⚠️ waitForPageReady timeout — proceeding anyway');
                    resolve(false);
                }
            }, timeoutMs);
        });
    }
    /**
     * Tự động chờ kết nối lại WebSocket nếu bị ngắt kết nối ngầm (MV3 idle suspension)
     */
    async waitForWSConnection(timeoutMs = 10000) {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.wsConnection && this.wsConnection.readyState === 1) {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutTimer);
                    resolve(true);
                }
            }, 200);
            const timeoutTimer = setTimeout(() => {
                clearInterval(checkInterval);
                resolve(this.wsConnection !== null && this.wsConnection.readyState === 1);
            }, timeoutMs);
        });
    }
    async executeChat(prompt, onToken, conversationId = '', isNewChat = false, isSearch = false) {
        if (!this.wsConnection || this.wsConnection.readyState !== 1) {
            console.log('[System] ⚠️ WebSocket is disconnected (MV3 idle suspension). Waiting for extension reconnect (up to 10s)...');
            const reconnected = await this.waitForWSConnection(10000);
            if (!reconnected) {
                throw new Error('Extension is not connected. Make sure Chrome is running and Z.AI Bridge extension is active.');
            }
            console.log('[System] 🔄 WebSocket reconnected successfully! Proceeding to send prompt.');
        }
        // [FIX 8.0.1] Rate limit check is handled solely by zen.ts router (handleMessages)
        // to avoid double acquire() which would consume 2 slots per request.
        // Router returns HTTP 429 with Retry-After; checking here would throw Error
        // caught as 500, losing retry info. Keep only read-only status log for debug.
        const status = this.rateLimiter.getStatus();
        console.log(`[RateLimiter] 📊 Current quota (read-only): ${status.requestsThisMinute}/${status.maxRequestsPerMinute} per min, ${status.requestsThisHour}/${status.maxRequestsPerHour} per hour`);
        // 🔄 Smart Session Rolling — Tự động reset phiên khi ngưỡng bị vượt
        // Ngăn prompt tokens tích lũy gây lag phiên dài (đo được: +55 tokens/turn)
        const lastPromptTokens = this._lastUsage?.promptTokens ?? 0;
        const tokenOverflow = lastPromptTokens >= this.SESSION_TOKEN_THRESHOLD;
        const turnOverflow = this._sessionTurnCount >= this.SESSION_TURN_THRESHOLD;
        if ((tokenOverflow || turnOverflow) && !isNewChat) {
            const reason = tokenOverflow
                ? `prompt_tokens=${lastPromptTokens} >= ${this.SESSION_TOKEN_THRESHOLD}`
                : `turns=${this._sessionTurnCount} >= ${this.SESSION_TURN_THRESHOLD}`;
            console.log(`[ZChat] 🔄 Auto Session Roll triggered — ${reason}. Khởi động phiên mới ngầm...`);
            isNewChat = true;
            this._sessionTurnCount = 0;
        }
        // Reset per-request state
        this._lastUsage = null;
        this._currentSearchResults = null;
        // Fix H03: khởi tạo per-request context
        this._activeCtx = {
            chatIdResolve: null,
            navigationResolve: null,
            pageReadyResolve: null,
        };
        let requestError = null;
        let sseBuffer = '';
        try {
            if (isNewChat) {
                console.log(`[Page] Khoi tao cuoc tro chuyen moi...`);
                this.wsConnection.send(JSON.stringify({ action: 'reset_page' }));
                console.log('[Page] Waiting for page_ready signal (reset)...');
                await this.waitForPageReady(1000);
                this._hasBrowserSession = true;
                console.log('[Page] page_ready received, proceeding to send prompt.');
            }
            // Tin nhắn tiếp theo: gửi thẳng vào chat đang mở, không điều hướng
            // ✅ Fix P2: Single string buffer thay vì array + join — giảm GC pressure
            sseBuffer = '';
            let currentPhase = null;
            let streamEndResolve = null;
            const streamEndPromise = new Promise((resolve) => {
                streamEndResolve = resolve;
            });
            // [8.0] Hang Detection — theo dõi velocity stream
            let lastChunkTime = Date.now();
            let chunkCount = 0;
            const requestStartTime = Date.now();
            // Hook stream handlers
            this.currentStreamResolver = (chunkStr) => {
                // Debug: only log when DEBUG_STREAM is enabled (Issue #1 fix)
                if (process.env.DEBUG_STREAM) {
                    console.log(`[ZChat RAW CHUNK]`, chunkStr.substring(0, 200));
                }
                // [8.0] Cập nhật thời gian chunk cuối cùng và đếm
                lastChunkTime = Date.now();
                chunkCount++;
                sseBuffer += chunkStr;
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6).trim();
                        if (jsonStr === '[DONE]')
                            continue;
                        try {
                            const json = JSON.parse(jsonStr);
                            let content = '';
                            let phase = '';
                            if (json.data) {
                                content = json.data.delta_content || '';
                                phase = json.data.phase || '';
                            }
                            if (!content) {
                                if (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) {
                                    content = json.choices[0].delta.content;
                                }
                                else if (json.message && json.message.content) {
                                    content = json.message.content;
                                }
                                else if (json.delta && json.delta.content) {
                                    content = json.delta.content;
                                }
                                else if (json.content) {
                                    content = json.content;
                                }
                            }
                            if (content) {
                                if (phase === 'thinking') {
                                    if (currentPhase !== 'thinking') {
                                        currentPhase = 'thinking';
                                        console.log('[ZChat] 🧠 AI bắt đầu suy nghĩ...');
                                    }
                                    // [Giải pháp 1]: Bỏ qua stream raw thinking text để triệt tiêu 100% lag terminal/VSCode
                                    // Vẫn theo dõi chunkCount và lastChunkTime đầy đủ để phát hiện treo/suy nghĩ
                                    continue;
                                }
                                else {
                                    if (currentPhase === 'thinking') {
                                        currentPhase = 'output';
                                        console.log('[ZChat] 📝 AI hoàn thành suy nghĩ, bắt đầu trả lời...');
                                    }
                                }
                                if (onToken) {
                                    onToken(content);
                                }
                                else {
                                    process.stdout.write(content);
                                }
                            }
                        }
                        catch (e) { }
                    }
                }
            };
            this.currentEndResolver = (err) => {
                if (streamEndResolve) {
                    streamEndResolve(err || null);
                }
            };
            // [8.0] Random delay 2–5s trước khi gửi prompt lên browser
            // Mục đích: chống Z.AI detect pattern gửi tin đều đặn (anti-bot / anti-WAF)
            const delayMs = Math.floor(Math.random() * 3000) + 2000; // [2000, 5000) ms
            console.log(`[ZChat] ⏳ Random pre-send delay: ${delayMs}ms (anti-WAF jitter)...`);
            await new Promise(r => setTimeout(r, delayMs));
            // Send prompt over available websocket connections (single-target prioritized to avoid double-dispatch)
            const requestId = crypto.randomUUID();
            const payload = JSON.stringify({ action: 'send_prompt', requestId, prompt, isNewChat, isSearch });
            const target = (this.offscreenConnection && this.offscreenConnection.readyState === 1)
                ? this.offscreenConnection
                : ((this.contentConnection && this.contentConnection.readyState === 1)
                    ? this.contentConnection
                    : this.wsConnection);
            if (target && target.readyState === 1) {
                try {
                    target.send(payload);
                }
                catch (e) { }
            }
            // Wait until request finishes (event-driven, no polling — Issue #2 fix)
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('Loi: Cho phan hoi tu Z.ai qua 20 phut.'), 1200000));
            // [8.0] Hang Detection — Phân biệt "đang suy nghĩ" vs "bị treo"
            // Phát hiện: nếu > 90s không có chunk mới → cảnh báo nghi ngờ treo
            const WARN_NO_CHUNK_MS = 90_000; // 90s không chunk mới → cảnh báo
            const PROGRESS_INTERVAL_MS = 15_000; // in 15s một lần
            let requestDone = false;
            const progressInterval = setInterval(() => {
                if (requestDone)
                    return;
                const elapsed = Math.round((Date.now() - requestStartTime) / 1000);
                const silentSec = Math.round((Date.now() - lastChunkTime) / 1000);
                const phase = currentPhase === 'thinking' ? '🧠 Thinking' : chunkCount > 0 ? '📝 Streaming' : '⏳ Chờ phản hồi đầu tiên';
                if (chunkCount === 0 && elapsed > WARN_NO_CHUNK_MS / 1000) {
                    // Chưa nhận được chunk nào sau ngưỡng → nghi ngờ Z.AI bị treo
                    console.warn(`[ZChat] ⚠️  NGHI NGỜ TREO — ${elapsed}s, chưa có chunk nào! (Kiểm tra Chrome + CAPTCHA)`);
                }
                else if (chunkCount > 0 && silentSec > WARN_NO_CHUNK_MS / 1000) {
                    // Đã có chunk nhưng im lặng quá lâu → stream đang ngắt giữa chừng?
                    console.warn(`[ZChat] ⚠️  NGHI NGỜ TREO — Im lặng ${silentSec}s kể từ chunk cuối (tổng ${chunkCount} chunks). Kiểm tra Chrome!`);
                }
                else {
                    // Bình thường: vẫn đang hoạt động
                    const chunkInfo = chunkCount > 0 ? `, ${chunkCount} chunks, im lặng ${silentSec}s` : ', chưa có chunk';
                    console.log(`[ZChat] ${phase} — ${elapsed}s tổng cộng${chunkInfo}${elapsed > 60 ? ' (CAPTCHA? Kéo slider nếu có)' : ''}`);
                }
            }, PROGRESS_INTERVAL_MS);
            const result = await Promise.race([streamEndPromise, timeoutPromise]);
            requestDone = true;
            clearInterval(progressInterval);
            if (result) {
                requestError = result;
            }
            // [Anti-WAF] Empty Stream Defense: Nếu stream kết thúc rỗng không có lỗi trong < 15s → Nghi ngờ HTML Block Page
            const elapsedSec = (Date.now() - requestStartTime) / 1000;
            if (!requestError && chunkCount === 0 && elapsedSec < 15) {
                console.warn('[ZChat] 🚨 Stream ended with 0 chunks in ' + elapsedSec.toFixed(1) + 's — suspected WAF block page (HTML/405). Activating cooldown.');
                this.rateLimiter.reportWAFBlock(this._activeUserId || undefined);
                requestError = 'WAF block page detected (empty stream)';
            }
            // Reset phase
            if (currentPhase === 'thinking') {
                currentPhase = 'output';
            }
            this.currentStreamResolver = null;
            this.currentEndResolver = null;
        }
        finally {
            sseBuffer = '';
            // Fix H03: đảm bảo _activeCtx luôn được giải phóng dù có throw
            this._activeCtx = null;
        }
        // ← NEW: Record usage if available from Z.AI API
        if (this._lastUsage) {
            this.usageTracker.recordFromAPI({
                conversationId,
                promptTokens: this._lastUsage.promptTokens,
                completionTokens: this._lastUsage.completionTokens,
                totalTokens: this._lastUsage.totalTokens,
                model: 'GLM-5.1',
            });
        }
        if (requestError) {
            // Detect WAF-related errors and activate cooldown
            const errLower = requestError.toLowerCase();
            if (errLower.includes('waf') || errLower.includes('blocked') ||
                errLower.includes('captcha') || errLower.includes('403') ||
                errLower.includes('405') || errLower.includes('429') ||
                errLower.includes('rate limit')) {
                console.log('[RateLimiter] 🚨 WAF-related error detected in response, activating cooldown...');
                this.rateLimiter.reportWAFBlock();
            }
            throw new Error(requestError);
        }
        // 🔄 Tăng bộ đếm turn sau mỗi request thành công
        this._sessionTurnCount++;
        const currentTokens = this._lastUsage?.promptTokens ?? 0;
        console.log(`[ZChat] 📊 Session state: turn=${this._sessionTurnCount}/${this.SESSION_TURN_THRESHOLD}, prompt_tokens=${currentTokens}/${this.SESSION_TOKEN_THRESHOLD}`);
    }
    getRateLimitStatus() {
        return this.rateLimiter.getStatus();
    }
    updateRateLimitConfig(config) {
        this.rateLimiter.updateConfig(config);
        console.log('[RateLimiter] 🔄 Config updated:', JSON.stringify(this.rateLimiter.getStatus()));
    }
    reportWAFBlock() {
        this.rateLimiter.reportWAFBlock();
    }
    resetRateLimits() {
        this.rateLimiter.reset();
    }
    async close() {
        if (this.wss) {
            try {
                this.wss.close();
            }
            catch (e) { }
            this.wss = null;
        }
        this.wsConnection = null;
        console.log('[System] ZChat bridge closed.');
    }
}
exports.ZChat = ZChat;
async function main() {
    const chatEngine = new ZChat({
        maxRequestsPerMinute: 10,
        maxRequestsPerHour: 59,
        minIntervalMs: 3000,
    });
    await chatEngine.initBrowser();
    const args = process.argv.slice(2);
    let prompt = args.join(' ');
    if (!chatEngine.isConnected()) {
        console.log('[System] Dang cho Chrome Extension ket noi qua WebSocket...');
        while (!chatEngine.isConnected()) {
            await new Promise(r => setTimeout(r, 1000));
        }
        console.log('[System] Extension da ket noi. Tiep tuc execution...');
    }
    if (prompt) {
        process.stdout.write('Assistant: ');
        await chatEngine.chat(prompt);
    }
    else {
        while (true) {
            prompt = await askQuestion('\nUser: ');
            if (!prompt.trim())
                continue;
            if (['exit', 'quit'].includes(prompt.toLowerCase()))
                break;
            process.stdout.write('Assistant: ');
            await chatEngine.chat(prompt);
        }
    }
    await chatEngine.close();
    process.exit(0);
}
if (require.main === module || process.env.RUN_AS_CLI === 'true' || process.argv.includes('--cli')) {
    main().catch(console.error);
}
