import * as readline from 'readline';
import { WebSocketServer, WebSocket } from 'ws';
import { RateLimiter, AccountRateLimiter, RateLimitConfig, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter';
import { UsageTracker } from './src/utils/usage-tracker';

async function askQuestion(query: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

export class ZChat {
    private wss: WebSocketServer | null = null;
    private wsConnection: WebSocket | null = null;
    private bgConnection: WebSocket | null = null;
    private offscreenConnection: WebSocket | null = null;
    private contentConnection: WebSocket | null = null;
    public proxyManager: any = null;
    private currentStreamResolver: ((chunk: string) => void) | null = null;
    private currentEndResolver: ((err?: string) => void) | null = null;
    private chatLock = Promise.resolve();
    public rateLimiter: AccountRateLimiter;
    public _accountRateLimiter: AccountRateLimiter; // alias
    public usageTracker!: UsageTracker;
    private _lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
    private _currentSearchResults: any[] | null = null;

    // [Phase 3.3-3.5] Account tracking — nhận từ extension qua WS
    private _activeUserId: string | null = null;
    private _availableAccounts: Array<{ userId: string; email: string; name: string; tokenExp: number }> = [];
    private _accountSwitchInProgress: boolean = false;

    // 🔗 Z.AI chat_id tracking — persist across requests
    private currentZaiChatId: string | null = null;

    // Fix H03: Per-request context thay vì singleton resolvers.
    private _activeCtx: {
        chatIdResolve: ((id: string | null) => void) | null;
        navigationResolve: ((ok: boolean) => void) | null;
        pageReadyResolve: ((ready: boolean) => void) | null;
    } | null = null;

    // 🔑 Biết liệu đã có cuộc hội thoại đang mở trên browser chưa
    // → đat trực tiếp trong ZChat, không phụ thuộc vào conversationId từ Zen
    private _hasBrowserSession: boolean = false;

    // 🔄 Smart Session Rolling — ngăn prompt tokens tích lũy quá ngưỡng
    // Dựa trên công thức thực đo: prompt_tokens(n) = 728 + (n-1)*55
    // Ngưỡng 3500 tokens ≈ sau 50 turns → response_time bắt đầu > 3.3s
    private _sessionTurnCount: number = 0;
    private readonly SESSION_TOKEN_THRESHOLD = 3500;  // tokens — reset khi đạt
    private readonly SESSION_TURN_THRESHOLD = 25;     // turns — reset dự phòng

    public get hasBrowserSession(): boolean {
        return this._hasBrowserSession;
    }

    public get lastUsage() {
        return this._lastUsage;
    }

    public get currentSearchResults(): any[] | null {
        return this._currentSearchResults;
    }

    public getActiveAccount(): string | null {
        return this._activeUserId;
    }

    public get activeUserId(): string | null {
        return this._activeUserId;
    }

    public get availableAccounts(): Array<{ userId: string; email: string; name: string; tokenExp: number }> {
        return this._availableAccounts;
    }

    public resetBrowserSession(): void {
        this._hasBrowserSession = false;
        console.log('[System] 🔴 Browser session reset.');
    }

    public broadcastProxyConfig(config: any) {
        if (this.bgConnection && this.bgConnection.readyState === WebSocket.OPEN) {
            console.log('[System] Broadcasting apply_proxy config to extension background SW.');
            this.bgConnection.send(JSON.stringify({ action: 'apply_proxy', config }));
        } else {
            console.log('[System] Background connection not active. Skipping proxy config broadcast.');
        }
    }

    constructor(rateLimitConfig?: Partial<RateLimitConfig>) {
        this.rateLimiter = new AccountRateLimiter(rateLimitConfig || DEFAULT_RATE_LIMIT_CONFIG);
        this.usageTracker = new UsageTracker();
        console.log('[RateLimiter] ✅ Initialized with config:', JSON.stringify(this.rateLimiter.getStatus()));
    }

    public isConnected(): boolean {
        return this.wsConnection !== null;
    }

    public async initBrowser() {
        console.log('[System] Khoi dong WebSocket Server tren cong 8899 de ket noi voi Chrome Extension...');
        
        const url = require('url');
        // Start WebSocket Server
        const WS_PORT = parseInt(process.env.WS_PORT || '8899', 10);
        this.wss = new WebSocketServer({ port: WS_PORT });
        
        this.wss.on('connection', (ws, req) => {
            const parsedUrl = url.parse(req.url || '', true);
            const client = parsedUrl.query.client;

            if (client === 'background') {
                console.log('[System] Z.AI Bridge Extension (Background Worker) da ket noi!');
                this.bgConnection = ws;
                
                ws.on('message', (messageStr) => {
                    if (ws !== this.bgConnection) return;
                    try {
                        const msg = JSON.parse(messageStr.toString());
                        if (msg.type === 'request_proxy_config') {
                            console.log('[System] Background SW requested proxy config.');
                            if (this.proxyManager) {
                                const proxyCfg = this.proxyManager.getConfig(false);
                                ws.send(JSON.stringify({ action: 'apply_proxy', config: proxyCfg }));
                            }
} else if (msg.type === 'quota_sync') {
                            // [NEW 8.0] Real-time browser quota sync — per-account
                            const syncUserId = msg.userId || 'unknown';
                            this.rateLimiter.syncFromBrowser(syncUserId, {
                                userId: syncUserId,
                                perMinute: msg.perMinute || 0,
                                perHour: msg.perHour || 0,
                                wafBlocked: msg.wafBlocked || false,
                            });
                        } else if (msg.type === 'account_info') {
                            // [Phase 3.3-3.5] Receive account info from extension
                            const prevActive = this._activeUserId;
                            const prevCount = this._availableAccounts.length;
                            this._activeUserId = msg.activeUserId || null;
                            this._availableAccounts = msg.availableAccounts || [];
                            if (prevActive !== this._activeUserId || prevCount !== this._availableAccounts.length) {
                                console.log(`[System] 📡 Account info: active=${this._activeUserId}, available=${this._availableAccounts.length} accounts`);
                            }
                        }
                    } catch (e) {}
                });
                
                ws.on('close', () => {
                    console.log('[System] Z.AI Bridge Extension (Background) da ngat ket noi.');
                    if (ws === this.bgConnection) {
                        this.bgConnection = null;
                    }
                });
            } else if (client === 'offscreen') {
                console.log('[System] Z.AI Bridge Extension (Offscreen Document 24/7) da ket noi!');
                this.offscreenConnection = ws;
                this.wsConnection = ws;
                this._hasBrowserSession = true;

                ws.on('message', (messageStr) => {
                    this.wsConnection = ws;
                    const rawStr = messageStr.toString();
                    const lines = rawStr.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const msg = JSON.parse(line);
                            if (msg.type === 'stream_chunk' && this.currentStreamResolver) {
                                this.currentStreamResolver(msg.chunk);
                            } else if (msg.type === 'usage' && msg.usage) {
                                console.log(`[System] 📊 Usage from Z.AI API: prompt=${msg.usage.prompt_tokens}, completion=${msg.usage.completion_tokens}, total=${msg.usage.total_tokens}`);
                                this._lastUsage = { promptTokens: msg.usage.prompt_tokens || 0, completionTokens: msg.usage.completion_tokens || 0, totalTokens: msg.usage.total_tokens || 0 };
                            } else if (msg.type === 'stream_end' && this.currentEndResolver) {
                                this.currentEndResolver(msg.error);
                            } else if (msg.type === 'page_ready') {
                                console.log(`[System] ✅ page_ready signal received (context: ${msg.context}${msg.timedOut ? ', timedOut' : ''})`);
                                if (this._activeCtx?.pageReadyResolve) {
                                    this._activeCtx.pageReadyResolve(true);
                                    this._activeCtx.pageReadyResolve = null;
                                }
                            }
                        } catch (e) {}
                    }
                });

                ws.on('close', () => {
                    console.log('[System] Z.AI Bridge Extension (Offscreen Document) da ngat ket noi.');
                    if (ws === this.offscreenConnection) this.offscreenConnection = null;
                });
            } else {
                console.log('[System] Z.AI Bridge Extension (Content Script) da ket noi!');
                this.contentConnection = ws;
                if (!this.wsConnection) this.wsConnection = ws;
                this._hasBrowserSession = true;

                ws.on('message', (messageStr) => {
                    this.wsConnection = ws;
                    const rawStr = messageStr.toString();
                    const lines = rawStr.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const msg = JSON.parse(line);
                            if (msg.type === 'stream_chunk' && this.currentStreamResolver) {
                                this.currentStreamResolver(msg.chunk);
                            } else if (msg.type === 'usage' && msg.usage) {
                                console.log(`[System] 📊 Usage from Z.AI API: prompt=${msg.usage.prompt_tokens}, completion=${msg.usage.completion_tokens}, total=${msg.usage.total_tokens}`);
                                this._lastUsage = { promptTokens: msg.usage.prompt_tokens || 0, completionTokens: msg.usage.completion_tokens || 0, totalTokens: msg.usage.total_tokens || 0 };
                            } else if (msg.type === 'stream_end' && this.currentEndResolver) {
                                this.currentEndResolver(msg.error);
                            } else if (msg.type === 'page_ready') {
                                console.log(`[System] ✅ page_ready signal received (context: ${msg.context}${msg.timedOut ? ', timedOut' : ''})`);
                                if (this._activeCtx?.pageReadyResolve) {
                                    this._activeCtx.pageReadyResolve(true);
                                    this._activeCtx.pageReadyResolve = null;
                                }
                            }
                        } catch (e) {}
                    }
                });

                ws.on('close', () => {
                    console.log('[System] Z.AI Bridge Extension (Content Script) da ngat ket noi.');
                    if (ws === this.contentConnection) this.contentConnection = null;
                });
            }
        });

        console.log('[System] WebSocket Server khoi dong thanh cong.');
        console.log('[System] Vui long mo Chrome chinh thuc (da load extension) va truy cap https://chat.z.ai/ de ket noi.\n');
    }

    public async chat(prompt: string, onToken?: (token: string) => void, conversationId: string = '', isNewChat: boolean = false, isSearch: boolean = false) {
        // Enforce sequential prompts using a promise lock
        const result = this.chatLock.then(async () => {
            await this.executeChat(prompt, onToken, conversationId, isNewChat, isSearch);
        });
        this.chatLock = result.catch(() => {});
        return result;
    }

    /**
     * Fix H02+H05+H03: Chờ extension báo page_ready (textarea sẵn sàng).
     * Thay thế magic setTimeout — event-driven, không có timing cứng.
     */
    private async waitForPageReady(timeoutMs: number = 13000): Promise<boolean> {
        return new Promise((resolve) => {
            if (this._activeCtx) this._activeCtx.pageReadyResolve = resolve;
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
    private async waitForWSConnection(timeoutMs: number = 10000): Promise<boolean> {
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

    private async executeChat(prompt: string, onToken?: (token: string) => void, conversationId: string = '', isNewChat: boolean = false, isSearch: boolean = false) {
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

        let requestError: string | null = null;
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
        let currentPhase: 'thinking' | 'output' | null = null;
        let streamEndResolve: ((value: string | null) => void) | null = null;
        const streamEndPromise = new Promise<string | null>((resolve) => {
            streamEndResolve = resolve;
        });

        // [8.0] Hang Detection — theo dõi velocity stream
        let lastChunkTime = Date.now();
        let chunkCount = 0;
        const requestStartTime = Date.now();

        // Hook stream handlers
        this.currentStreamResolver = (chunkStr: string) => {
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
                    if (jsonStr === '[DONE]') continue;
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
                            } else if (json.message && json.message.content) {
                                content = json.message.content;
                            } else if (json.delta && json.delta.content) {
                                content = json.delta.content;
                            } else if (json.content) {
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
                            } else {
                                if (currentPhase === 'thinking') {
                                    currentPhase = 'output';
                                    console.log('[ZChat] 📝 AI hoàn thành suy nghĩ, bắt đầu trả lời...');
                                }
                            }
                            
                            if (onToken) {
                                onToken(content);
                            } else {
                                process.stdout.write(content);
                            }
                        }
                    } catch (e) {}
                }
            }
        };

        this.currentEndResolver = (err?: string) => {
            if (streamEndResolve) {
                streamEndResolve(err || null);
            }
        };

        // [8.0] Random delay 2–5s trước khi gửi prompt lên browser
        // Mục đích: chống Z.AI detect pattern gửi tin đều đặn (anti-bot / anti-WAF)
        const delayMs = Math.floor(Math.random() * 3000) + 2000; // [2000, 5000) ms
        console.log(`[ZChat] ⏳ Random pre-send delay: ${delayMs}ms (anti-WAF jitter)...`);
        await new Promise(r => setTimeout(r, delayMs));

        // Send prompt over available websocket connections (Offscreen Document 24/7 + Content Script)
        const payload = JSON.stringify({ action: 'send_prompt', prompt, isNewChat, isSearch });
        let sentCount = 0;

        if (this.offscreenConnection && this.offscreenConnection.readyState === 1) {
            try { this.offscreenConnection.send(payload); sentCount++; } catch (e) {}
        }
        if (this.contentConnection && this.contentConnection.readyState === 1) {
            try { this.contentConnection.send(payload); sentCount++; } catch (e) {}
        }
        if (sentCount === 0 && this.wsConnection && this.wsConnection.readyState === 1) {
            try { this.wsConnection.send(payload); } catch (e) {}
        }

        // Wait until request finishes (event-driven, no polling — Issue #2 fix)
        const timeoutPromise = new Promise<string>(resolve => 
            setTimeout(() => resolve('Loi: Cho phan hoi tu Z.ai qua 20 phut.'), 1200000)
        );
        
        // [8.0] Hang Detection — Phân biệt "đang suy nghĩ" vs "bị treo"
        // Phát hiện: nếu > 90s không có chunk mới → cảnh báo nghi ngờ treo
        const WARN_NO_CHUNK_MS = 90_000;   // 90s không chunk mới → cảnh báo
        const PROGRESS_INTERVAL_MS = 15_000; // in 15s một lần
        let requestDone = false;

        const progressInterval = setInterval(() => {
            if (requestDone) return;
            const elapsed = Math.round((Date.now() - requestStartTime) / 1000);
            const silentSec = Math.round((Date.now() - lastChunkTime) / 1000);
            const phase = currentPhase === 'thinking' ? '🧠 Thinking' : chunkCount > 0 ? '📝 Streaming' : '⏳ Chờ phản hồi đầu tiên';

            if (chunkCount === 0 && elapsed > WARN_NO_CHUNK_MS / 1000) {
                // Chưa nhận được chunk nào sau ngưỡng → nghi ngờ Z.AI bị treo
                console.warn(`[ZChat] ⚠️  NGHI NGỜ TREO — ${elapsed}s, chưa có chunk nào! (Kiểm tra Chrome + CAPTCHA)`);
            } else if (chunkCount > 0 && silentSec > WARN_NO_CHUNK_MS / 1000) {
                // Đã có chunk nhưng im lặng quá lâu → stream đang ngắt giữa chừng?
                console.warn(`[ZChat] ⚠️  NGHI NGỜ TREO — Im lặng ${silentSec}s kể từ chunk cuối (tổng ${chunkCount} chunks). Kiểm tra Chrome!`);
            } else {
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

        // Reset phase
        if (currentPhase === 'thinking') {
            currentPhase = 'output';
        }

        this.currentStreamResolver = null;
        this.currentEndResolver = null;

        } finally {
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

    public getRateLimitStatus() {
        return this.rateLimiter.getStatus();
    }

    public updateRateLimitConfig(config: Partial<RateLimitConfig>) {
        this.rateLimiter.updateConfig(config);
        console.log('[RateLimiter] 🔄 Config updated:', JSON.stringify(this.rateLimiter.getStatus()));
    }

    public reportWAFBlock() {
        this.rateLimiter.reportWAFBlock();
    }

    public resetRateLimits() {
        this.rateLimiter.reset();
    }

    public async close() {
        if (this.wss) {
            try {
                this.wss.close();
            } catch (e) {}
            this.wss = null;
        }
        this.wsConnection = null;
        console.log('[System] ZChat bridge closed.');
    }
}

async function main() {
    const chatEngine = new ZChat({
        maxRequestsPerMinute: 10,
        maxRequestsPerHour: 59,
        minIntervalMs: 3000,
        cooldownAfterWAFMs: 60000,
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
    } else {
        while (true) {
            prompt = await askQuestion('\nUser: ');
            if (!prompt.trim()) continue;
            if (['exit', 'quit'].includes(prompt.toLowerCase())) break;
            
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