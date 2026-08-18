"use strict";
// ============================================================
// BrowserLauncher.ts — Chrome Daemon & Multi-Extension Auto-Launcher
// Automated launch of dedicated Chrome/Edge mini window
// with Z.AI Bridge V7.0 extension and Z.AI Account Manager extension.
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserLauncher = void 0;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class BrowserLauncher {
    chromeProcess = null;
    /**
     * Tìm đường dẫn thực thi Google Chrome hoặc Microsoft Edge trên Windows
     */
    findBrowserExecutable() {
        const candidatePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA ? path_1.default.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
            process.env['PROGRAMFILES(X86)'] ? path_1.default.join(process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe') : '',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
        for (const p of candidatePaths) {
            if (p && fs_1.default.existsSync(p))
                return p;
        }
        return null;
    }
    /**
     * Tìm đường dẫn Z.AI Bridge Extension trên đĩa cứng thật
     */
    findBridgeExtensionPath() {
        const exeDir = path_1.default.dirname(process.execPath);
        const candidates = [
            path_1.default.join(exeDir, 'extension'),
            path_1.default.join(process.cwd(), 'extension'),
            path_1.default.join(process.cwd(), 'dist/release/extension'),
            path_1.default.join(process.cwd(), 'reverse Z ai 7.0/extension'),
            path_1.default.join(__dirname, '../../extension'),
            'C:\\Users\\DELL\\Downloads\\CÁC phiên bản Zai\\reverse Z ai 7.0\\extension',
            'C:\\Users\\DELL\\Downloads\\CÁC phiên bản Zai\\reverse Z ai 7.0\\dist\\release\\extension'
        ];
        for (const p of candidates) {
            if (p && fs_1.default.existsSync(p) && fs_1.default.existsSync(path_1.default.join(p, 'manifest.json'))) {
                return p;
            }
        }
        return null;
    }
    /**
     * Tìm đường dẫn Z.AI Account Manager Extension trên đĩa cứng thật
     */
    findAccountExtensionPath() {
        const exeDir = path_1.default.dirname(process.execPath);
        const candidates = [
            path_1.default.join(exeDir, '../../Z ai Account'),
            path_1.default.join(process.cwd(), '../Z ai Account'),
            path_1.default.join(process.cwd(), 'Z ai Account'),
            path_1.default.join(__dirname, '../../../Z ai Account'),
            'C:\\Users\\DELL\\Downloads\\CÁC phiên bản Zai\\Z ai Account'
        ];
        for (const p of candidates) {
            if (p && fs_1.default.existsSync(p) && fs_1.default.existsSync(path_1.default.join(p, 'manifest.json'))) {
                return p;
            }
        }
        return null;
    }
    /**
     * Dọn dẹp tệp Lock rác của Chrome Profile để tránh Chrome tự động kết nối vào session cũ đã đóng
     */
    cleanupProfileLock(profileDir) {
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const file of lockFiles) {
            const lockPath = path_1.default.join(profileDir, file);
            if (fs_1.default.existsSync(lockPath)) {
                try {
                    fs_1.default.unlinkSync(lockPath);
                }
                catch (e) { }
            }
        }
    }
    /**
     * Khởi chạy Chrome Mini Window kèm 2 Extension
     */
    launch() {
        const exePath = this.findBrowserExecutable();
        if (!exePath) {
            console.warn('[BrowserLauncher] ⚠️ Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy.');
            return false;
        }
        const bridgeExtPath = this.findBridgeExtensionPath();
        const accountExtPath = this.findAccountExtensionPath();
        const extPaths = [];
        if (bridgeExtPath) {
            console.log(`[BrowserLauncher] 🔗 Đã phát hiện Z.AI Bridge Extension: ${bridgeExtPath}`);
            extPaths.push(bridgeExtPath);
        }
        else {
            console.warn('[BrowserLauncher] ⚠️ KHÔNG tìm thấy Z.AI Bridge Extension trên đĩa cứng!');
        }
        if (accountExtPath) {
            console.log(`[BrowserLauncher] 🔗 Đã phát hiện Z.AI Account Manager: ${accountExtPath}`);
            extPaths.push(accountExtPath);
        }
        else {
            console.warn('[BrowserLauncher] ⚠️ KHÔNG tìm thấy Z.AI Account Manager trên đĩa cứng!');
        }
        const profileDir = path_1.default.resolve(process.cwd(), 'ZaiProfile');
        if (!fs_1.default.existsSync(profileDir)) {
            try {
                fs_1.default.mkdirSync(profileDir, { recursive: true });
            }
            catch (e) { }
        }
        // Dọn dẹp lock cũ của Chrome
        this.cleanupProfileLock(profileDir);
        const args = [
            `--user-data-dir=${profileDir}`,
            '--window-size=1000,700',
            '--window-position=100,100',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
        ];
        if (extPaths.length > 0) {
            const jointExts = extPaths.join(',');
            args.push(`--disable-extensions-except=${jointExts}`);
            args.push(`--load-extension=${jointExts}`);
        }
        args.push('https://chat.z.ai');
        console.log(`[BrowserLauncher] 🚀 Đang khởi chạy Trình duyệt Chrome ngầm (Multi-Extension Mode)...`);
        console.log(`[BrowserLauncher] 📍 Exe: ${exePath}`);
        console.log(`[BrowserLauncher] 📁 Profile: ${profileDir}`);
        try {
            // Khởi chạy trực tiếp qua spawn không dùng shell (tránh cmd.exe làm hỏng tham số dấu phẩy)
            this.chromeProcess = (0, child_process_1.spawn)(exePath, args, { detached: true, stdio: 'ignore' });
            this.chromeProcess.unref();
            console.log(`[BrowserLauncher] ✅ Khởi chạy Trình duyệt thành công!`);
            return true;
        }
        catch (e) {
            console.error(`[BrowserLauncher] ❌ Lỗi khởi chạy trình duyệt: ${e.message}`);
            return false;
        }
    }
}
exports.BrowserLauncher = BrowserLauncher;
