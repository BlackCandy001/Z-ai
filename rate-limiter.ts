import * as fs from 'fs';
import * as path from 'path';

/**
 * rate-limiter.ts — Z.AI Bridge 8.0 Rate Limiter
 *
 * CHANGES vs 7.0:
 *   - Removed all process.exit(0) calls — server never crashes on quota hit
 *   - Per-minute limit: HOLD (await sleep until window resets) instead of exit
 *   - Per-hour limit: HARD REJECT (return allowed:false) instead of exit
 *   - WAF cooldown: HARD REJECT + notify client instead of exit
 *   - NEW: syncFromBrowser() — accept real-time quota data from Extension
 *
 * Features:
 *   - Sliding window rate limiting (per-minute HOLD, per-hour HARD REJECT)
 *   - Minimum interval enforcement between consecutive requests
 *   - WAF block detection with automatic cooldown
 *   - Real-time Browser-Synced Rate Limiting via quota_sync WS message
 */

export interface RateLimitConfig {
    maxRequestsPerMinute: number;
    maxRequestsPerHour: number;
    minIntervalMs: number;
    cooldownAfterWAFMs: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
    maxRequestsPerMinute: 10,
    maxRequestsPerHour: 59,
    minIntervalMs: 3000,        // 3 seconds between requests
    cooldownAfterWAFMs: 60000,  // 1 minute cooldown after WAF block
};

export interface RateLimitResult {
    allowed: boolean;
    reason?: string;
    retryAfterMs?: number;
}

// Browser quota sync payload (received via WS quota_sync message)
export interface BrowserQuotaSync {
    userId: string;
    perMinute: number;   // actual request count in last 60s from browser
    perHour: number;     // actual request count in last 3600s from browser
    wafBlocked: boolean; // browser reports WAF blocked
}

export class RateLimiter {
    private config: RateLimitConfig;
    private minuteTimestamps: number[] = [];
    private hourTimestamps: number[] = [];
    private lastRequestTime: number = 0;
    private wafCooldownUntil: number = 0;
    private statePath: string;

    // [NEW 8.0] Browser-synced counters — take max of server vs browser counts
    private browserMinuteCount: number = 0;
    private browserHourCount: number = 0;
    private browserWafBlocked: boolean = false;
    private lastBrowserSync: number = 0;

    constructor(config?: Partial<RateLimitConfig>) {
        this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };

        const isPackaged = typeof (process as any).pkg !== 'undefined';
        let baseDir: string;
        if (isPackaged) {
            baseDir = path.dirname(process.execPath);
        } else {
            const normalizedDir = __dirname.replace(/\\/g, '/');
            if (normalizedDir.endsWith('/dist/server')) {
                baseDir = path.join(__dirname, '../../');
            } else if (normalizedDir.endsWith('/src')) {
                baseDir = path.join(__dirname, '../');
            } else {
                baseDir = __dirname;
            }
        }
        this.statePath = path.join(baseDir, 'rate-limit-state.json');
        this.loadState();
    }

    private loadState(): void {
        try {
            if (fs.existsSync(this.statePath)) {
                const raw = fs.readFileSync(this.statePath, 'utf8');
                const parsed = JSON.parse(raw);
                const now = Date.now();
                this.minuteTimestamps = (parsed.minuteTimestamps || []).filter((t: number) => now - t < 60000);
                this.hourTimestamps = (parsed.hourTimestamps || []).filter((t: number) => now - t < 3600000);
                this.lastRequestTime = parsed.lastRequestTime || 0;
                this.wafCooldownUntil = parsed.wafCooldownUntil || 0;
                console.log(`[RateLimiter] 💾 State restored: ${this.hourTimestamps.length} requests in the past hour.`);
            }
        } catch (e) {
            console.error('[RateLimiter] Error loading state from disk:', e);
        }
    }

    private saveState(): void {
        try {
            const state = {
                minuteTimestamps: this.minuteTimestamps,
                hourTimestamps: this.hourTimestamps,
                lastRequestTime: this.lastRequestTime,
                wafCooldownUntil: this.wafCooldownUntil
            };
            fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
        } catch (e) {
            console.error('[RateLimiter] Error saving state to disk:', e);
        }
    }

    // [NEW 8.0] Receive real-time quota data from Chrome Extension via WS quota_sync
    syncFromBrowser(data: BrowserQuotaSync): void {
        const changed = this.lastBrowserSync === 0 ||
                        this.browserMinuteCount !== data.perMinute ||
                        this.browserHourCount !== data.perHour ||
                        this.browserWafBlocked !== data.wafBlocked;

        this.browserMinuteCount = data.perMinute;
        this.browserHourCount = data.perHour;
        this.browserWafBlocked = data.wafBlocked;
        this.lastBrowserSync = Date.now();

        if (changed) {
            console.log(`[RateLimiter] 🔄 Browser sync: min=${data.perMinute}, hour=${data.perHour}, waf=${data.wafBlocked}`);
        }

        // If browser reports WAF, activate server-side cooldown too
        if (data.wafBlocked && Date.now() >= this.wafCooldownUntil) {
            this.wafCooldownUntil = Date.now() + this.config.cooldownAfterWAFMs;
            this.saveState();
        }
    }

    async acquire(): Promise<RateLimitResult> {
        const now = Date.now();

        // 1. WAF cooldown check (HARD REJECT — no exit)
        if (now < this.wafCooldownUntil) {
            const retryAfterMs = this.wafCooldownUntil - now;
            console.log(`[RateLimiter] 🚫 WAF cooldown active. ${Math.ceil(retryAfterMs / 1000)}s remaining.`);
            return { allowed: false, reason: 'waf_cooldown', retryAfterMs };
        }

        // [NEW 8.0] Browser WAF check (fresh sync within 10s)
        if (this.browserWafBlocked && (now - this.lastBrowserSync) < 10000) {
            const retryAfterMs = this.config.cooldownAfterWAFMs;
            console.log(`[RateLimiter] 🚫 Browser reports WAF block. HARD REJECT.`);
            return { allowed: false, reason: 'waf_cooldown', retryAfterMs };
        }

        // 2. Clean old timestamps (sliding window)
        this.minuteTimestamps = this.minuteTimestamps.filter(t => now - t < 60000);
        this.hourTimestamps = this.hourTimestamps.filter(t => now - t < 3600000);

        // [NEW 8.0] Take max of server count vs browser-reported count for accuracy
        const effectiveMinuteCount = Math.max(this.minuteTimestamps.length, this.browserMinuteCount);
        const effectiveHourCount = Math.max(this.hourTimestamps.length, this.browserHourCount);

        // 3. Per-hour limit — HARD REJECT (không gửi request → tránh ban tài khoản)
        if (effectiveHourCount >= this.config.maxRequestsPerHour) {
            const oldestInHour = this.hourTimestamps.length > 0 ? Math.min(...this.hourTimestamps) : now - 3600000;
            const retryAfterMs = 3600000 - (now - oldestInHour);
            console.log(`[RateLimiter] 🚫 Per-hour limit exceeded (${effectiveHourCount}/${this.config.maxRequestsPerHour}). HARD REJECT.`);
            return { allowed: false, reason: 'per_hour_exceeded', retryAfterMs: Math.max(retryAfterMs, 60000) };
        }

        // 4. Per-minute limit — HOLD (ngâm request cho đến khi reset)
        if (effectiveMinuteCount >= this.config.maxRequestsPerMinute) {
            const oldestInMinute = this.minuteTimestamps.length > 0 ? Math.min(...this.minuteTimestamps) : now - 60000;
            const retryAfterMs = 60000 - (now - oldestInMinute);
            console.log(`[RateLimiter] ⏳ Per-minute limit (${effectiveMinuteCount}/${this.config.maxRequestsPerMinute}). HOLDING for ${Math.ceil(retryAfterMs / 1000)}s...`);
            await this.sleep(retryAfterMs + 500); // +500ms buffer

            // After hold: re-check per-hour (may have changed)
            const nowAfterHold = Date.now();
            this.minuteTimestamps = this.minuteTimestamps.filter(t => nowAfterHold - t < 60000);
            this.hourTimestamps = this.hourTimestamps.filter(t => nowAfterHold - t < 3600000);
            const effectiveHourAfterHold = Math.max(this.hourTimestamps.length, this.browserHourCount);
            if (effectiveHourAfterHold >= this.config.maxRequestsPerHour) {
                const oldestInHour2 = this.hourTimestamps.length > 0 ? Math.min(...this.hourTimestamps) : nowAfterHold - 3600000;
                const retryAfterMs2 = 3600000 - (nowAfterHold - oldestInHour2);
                return { allowed: false, reason: 'per_hour_exceeded', retryAfterMs: Math.max(retryAfterMs2, 60000) };
            }
            console.log(`[RateLimiter] ✅ Hold complete. Proceeding with request.`);
        }

        // 5. Record request + min interval
        const expectedRequestTime = Math.max(Date.now(), this.lastRequestTime + this.config.minIntervalMs);
        const waitMs = expectedRequestTime - Date.now();
        this.lastRequestTime = expectedRequestTime;
        this.minuteTimestamps.push(expectedRequestTime);
        this.hourTimestamps.push(expectedRequestTime);
        this.saveState();

        if (waitMs > 0) {
            console.log(`[RateLimiter] ⏳ Min interval not met. Waiting ${waitMs}ms...`);
            await this.sleep(waitMs);
        }

        return { allowed: true };
    }

    reportWAFBlock(): void {
        this.wafCooldownUntil = Date.now() + this.config.cooldownAfterWAFMs;
        console.log(`[RateLimiter] 🚨 WAF block reported! Cooldown until ${new Date(this.wafCooldownUntil).toISOString()}`);
        this.saveState();
    }

    reportError(): void {
        const backoffMs = 2000;
        this.lastRequestTime = Math.max(this.lastRequestTime, Date.now() + backoffMs);
        console.log(`[RateLimiter] ⚠️ Error reported. Backoff ${backoffMs}ms applied.`);
    }

    getStatus(): Record<string, any> {
        const now = Date.now();
        let minuteCount = 0;
        let hourCount = 0;
        for (const t of this.minuteTimestamps) {
            if (now - t < 60000) minuteCount++;
        }
        for (const t of this.hourTimestamps) {
            if (now - t < 3600000) hourCount++;
        }
        return {
            requestsThisMinute: Math.max(minuteCount, this.browserMinuteCount),
            requestsThisHour: Math.max(hourCount, this.browserHourCount),
            maxRequestsPerMinute: this.config.maxRequestsPerMinute,
            maxRequestsPerHour: this.config.maxRequestsPerHour,
            minIntervalMs: this.config.minIntervalMs,
            cooldownAfterWAFMs: this.config.cooldownAfterWAFMs,
            wafCooldownActive: now < this.wafCooldownUntil,
            wafCooldownRemainingMs: Math.max(0, this.wafCooldownUntil - now),
            lastRequestTime: this.lastRequestTime,
            lastBrowserSync: this.lastBrowserSync,
            browserWafBlocked: this.browserWafBlocked,
        };
    }

    updateConfig(newConfig: Partial<RateLimitConfig>): void {
        this.config = { ...this.config, ...newConfig };
        console.log('[RateLimiter] 🔄 Config updated:', JSON.stringify(this.config));
    }

    reset(): void {
        this.minuteTimestamps = [];
        this.hourTimestamps = [];
        this.lastRequestTime = 0;
        this.wafCooldownUntil = 0;
        this.browserMinuteCount = 0;
        this.browserHourCount = 0;
        this.browserWafBlocked = false;
        if (fs.existsSync(this.statePath)) {
            try { fs.unlinkSync(this.statePath); } catch (e) {}
        }
        console.log('[RateLimiter] 🔄 All rate limits reset.');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================
// AccountRateLimiter — Per-account rate limiting (Phase 3.5)
// Mỗi userId có 1 RateLimiter bucket riêng.
// Khi auto-rotate sang account B, account B có bucket riêng (quota mới).
// ============================================================

export class AccountRateLimiter {
    private limiters: Map<string, RateLimiter> = new Map();
    private defaultConfig: Partial<RateLimitConfig>;
    private globalLimiter: RateLimiter; // Fallback cho requests không có userId

    constructor(config?: Partial<RateLimitConfig>) {
        this.defaultConfig = config || {};
        this.globalLimiter = new RateLimiter(config);
    }

    getRateLimiter(userId: string): RateLimiter {
        if (!userId || userId === 'unknown') return this.globalLimiter;
        if (!this.limiters.has(userId)) {
            this.limiters.set(userId, new RateLimiter(this.defaultConfig));
        }
        return this.limiters.get(userId)!;
    }

    async acquire(userId?: string): Promise<RateLimitResult> {
        const limiter = userId ? this.getRateLimiter(userId) : this.globalLimiter;
        return limiter.acquire();
    }

    syncFromBrowser(userId: string, data: BrowserQuotaSync): void {
        const limiter = this.getRateLimiter(userId);
        limiter.syncFromBrowser(data);
    }

    reportWAFBlock(userId?: string): void {
        if (userId) {
            this.getRateLimiter(userId).reportWAFBlock();
        } else {
            this.globalLimiter.reportWAFBlock();
        }
    }

    getStatus(userId?: string): Record<string, any> {
        if (userId) {
            return this.getRateLimiter(userId).getStatus();
        }
        return this.globalLimiter.getStatus();
    }

    getAllStatuses(): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [uid, limiter] of this.limiters) {
            result[uid] = limiter.getStatus();
        }
        result['global'] = this.globalLimiter.getStatus();
        return result;
    }

    updateConfig(newConfig: Partial<RateLimitConfig>): void {
        this.defaultConfig = { ...this.defaultConfig, ...newConfig };
        this.globalLimiter.updateConfig(newConfig);
        for (const limiter of this.limiters.values()) {
            limiter.updateConfig(newConfig);
        }
    }

    reset(userId?: string): void {
        if (userId) {
            this.getRateLimiter(userId).reset();
        } else {
            this.globalLimiter.reset();
            for (const limiter of this.limiters.values()) {
                limiter.reset();
            }
        }
    }
}