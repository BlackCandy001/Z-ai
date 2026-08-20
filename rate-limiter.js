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
exports.AccountRateLimiter = exports.RateLimiter = exports.DEFAULT_RATE_LIMIT_CONFIG = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.DEFAULT_RATE_LIMIT_CONFIG = {
    maxRequestsPerMinute: 10,
    maxRequestsPerHour: 59,
    minIntervalMs: 3000, // 3 seconds between requests
    cooldownAfterWAFMs: 300000, // 5 minutes cooldown after WAF block
};
class RateLimiter {
    config;
    minuteTimestamps = [];
    hourTimestamps = [];
    lastRequestTime = 0;
    wafCooldownUntil = 0;
    statePath;
    // [NEW 8.0] Browser-synced counters — take max of server vs browser counts
    browserMinuteCount = 0;
    browserHourCount = 0;
    browserWafBlocked = false;
    lastBrowserSync = 0;
    constructor(config) {
        this.config = { ...exports.DEFAULT_RATE_LIMIT_CONFIG, ...config };
        const isPackaged = typeof process.pkg !== 'undefined';
        let baseDir;
        if (isPackaged) {
            baseDir = path.dirname(process.execPath);
        }
        else {
            const normalizedDir = __dirname.replace(/\\/g, '/');
            if (normalizedDir.endsWith('/dist/server')) {
                baseDir = path.join(__dirname, '../../');
            }
            else if (normalizedDir.endsWith('/src')) {
                baseDir = path.join(__dirname, '../');
            }
            else {
                baseDir = __dirname;
            }
        }
        this.statePath = path.join(baseDir, 'rate-limit-state.json');
        this.loadState();
    }
    loadState() {
        try {
            if (fs.existsSync(this.statePath)) {
                const raw = fs.readFileSync(this.statePath, 'utf8');
                const parsed = JSON.parse(raw);
                const now = Date.now();
                this.minuteTimestamps = (parsed.minuteTimestamps || []).filter((t) => now - t < 60000);
                this.hourTimestamps = (parsed.hourTimestamps || []).filter((t) => now - t < 3600000);
                this.lastRequestTime = parsed.lastRequestTime || 0;
                this.wafCooldownUntil = parsed.wafCooldownUntil || 0;
                console.log(`[RateLimiter] 💾 State restored: ${this.hourTimestamps.length} requests in the past hour.`);
            }
        }
        catch (e) {
            console.error('[RateLimiter] Error loading state from disk:', e);
        }
    }
    saveState() {
        try {
            const state = {
                minuteTimestamps: this.minuteTimestamps,
                hourTimestamps: this.hourTimestamps,
                lastRequestTime: this.lastRequestTime,
                wafCooldownUntil: this.wafCooldownUntil
            };
            fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
        }
        catch (e) {
            console.error('[RateLimiter] Error saving state to disk:', e);
        }
    }
    // [NEW 8.0] Receive real-time quota data from Chrome Extension via WS quota_sync
    syncFromBrowser(data) {
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
    async acquire() {
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
    reportWAFBlock() {
        this.wafCooldownUntil = Date.now() + this.config.cooldownAfterWAFMs;
        console.log(`[RateLimiter] 🚨 WAF block reported! Cooldown until ${new Date(this.wafCooldownUntil).toISOString()}`);
        this.saveState();
    }
    reportError() {
        const backoffMs = 2000;
        this.lastRequestTime = Math.max(this.lastRequestTime, Date.now() + backoffMs);
        console.log(`[RateLimiter] ⚠️ Error reported. Backoff ${backoffMs}ms applied.`);
    }
    getStatus() {
        const now = Date.now();
        let minuteCount = 0;
        let hourCount = 0;
        for (const t of this.minuteTimestamps) {
            if (now - t < 60000)
                minuteCount++;
        }
        for (const t of this.hourTimestamps) {
            if (now - t < 3600000)
                hourCount++;
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
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        console.log('[RateLimiter] 🔄 Config updated:', JSON.stringify(this.config));
    }
    reset() {
        this.minuteTimestamps = [];
        this.hourTimestamps = [];
        this.lastRequestTime = 0;
        this.wafCooldownUntil = 0;
        this.browserMinuteCount = 0;
        this.browserHourCount = 0;
        this.browserWafBlocked = false;
        if (fs.existsSync(this.statePath)) {
            try {
                fs.unlinkSync(this.statePath);
            }
            catch (e) { }
        }
        console.log('[RateLimiter] 🔄 All rate limits reset.');
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.RateLimiter = RateLimiter;
// ============================================================
// AccountRateLimiter — Per-account rate limiting (Phase 3.5)
// Mỗi userId có 1 RateLimiter bucket riêng.
// Khi auto-rotate sang account B, account B có bucket riêng (quota mới).
// ============================================================
class AccountRateLimiter {
    limiters = new Map();
    defaultConfig;
    globalLimiter; // Fallback cho requests không có userId
    constructor(config) {
        this.defaultConfig = config || {};
        this.globalLimiter = new RateLimiter(config);
    }
    getRateLimiter(userId) {
        if (!userId || userId === 'unknown')
            return this.globalLimiter;
        if (!this.limiters.has(userId)) {
            this.limiters.set(userId, new RateLimiter(this.defaultConfig));
        }
        return this.limiters.get(userId);
    }
    async acquire(userId) {
        const limiter = userId ? this.getRateLimiter(userId) : this.globalLimiter;
        return limiter.acquire();
    }
    syncFromBrowser(userId, data) {
        const limiter = this.getRateLimiter(userId);
        limiter.syncFromBrowser(data);
    }
    reportWAFBlock(userId) {
        if (userId) {
            this.getRateLimiter(userId).reportWAFBlock();
        }
        else {
            this.globalLimiter.reportWAFBlock();
        }
    }
    getStatus(userId) {
        if (userId) {
            return this.getRateLimiter(userId).getStatus();
        }
        return this.globalLimiter.getStatus();
    }
    getAllStatuses() {
        const result = {};
        for (const [uid, limiter] of this.limiters) {
            result[uid] = limiter.getStatus();
        }
        result['global'] = this.globalLimiter.getStatus();
        return result;
    }
    updateConfig(newConfig) {
        this.defaultConfig = { ...this.defaultConfig, ...newConfig };
        this.globalLimiter.updateConfig(newConfig);
        for (const limiter of this.limiters.values()) {
            limiter.updateConfig(newConfig);
        }
    }
    reset(userId) {
        if (userId) {
            this.getRateLimiter(userId).reset();
        }
        else {
            this.globalLimiter.reset();
            for (const limiter of this.limiters.values()) {
                limiter.reset();
            }
        }
    }
}
exports.AccountRateLimiter = AccountRateLimiter;
