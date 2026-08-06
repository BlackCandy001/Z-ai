// ============================================================
// BrowserLauncher.ts — Chrome Daemon & Multi-Extension Auto-Launcher
// Automated launch of dedicated Chrome/Edge mini window
// with Z.AI Bridge V7.0 extension and Z.AI Account Manager extension.
// ============================================================

import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

export class BrowserLauncher {
    private chromeProcess: ChildProcess | null = null;

    /**
     * Tìm đường dẫn thực thi Google Chrome hoặc Microsoft Edge trên Windows
     */
    private findBrowserExecutable(): string | null {
        const candidatePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
            process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe') : '',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ];

        for (const p of candidatePaths) {
            if (p && fs.existsSync(p)) return p;
        }
        return null;
    }

    /**
     * Tìm đường dẫn Z.AI Bridge Extension trên đĩa cứng thật
     */
    private findBridgeExtensionPath(): string | null {
        const exeDir = path.dirname(process.execPath);
        const candidates = [
            path.join(exeDir, 'extension'),
            path.join(process.cwd(), 'extension'),
            path.join(process.cwd(), 'dist/release/extension'),
            path.join(process.cwd(), 'reverse Z ai 7.0/extension'),
            path.join(__dirname, '../../extension'),
            'C:\\Users\\DELL\\Downloads\\CÁC phiên bản Zai\\reverse Z ai 7.0\\extension',
            'C:\\Users\\DELL\\Downloads\\CÁC phiên bản Zai\\reverse Z ai 7.0\\dist\\release\\extension'
        ];

        for (const p of candidates) {
            if (p && fs.existsSync(p) && fs.existsSync(path.join(p, 'manifest.json'))) {
                return p;
            }
        }
        return null;
    }

    /**
     * Tìm đường dẫn Z.AI Account Manager Extension trên đĩa cứng thật
     */
    private findAccountExtensionPath(): string | null {
        const exeDir = path.dirname(process.execPath);
        const candidates = [
            path.join(exeDir, '../../Z ai Account'),
            path.join(process.cwd(), '../Z ai Account'),
            path.join(process.cwd(), 'Z ai Account'),
            path.join(__dirname, '../../../Z ai Account'),
            'C:\\Users\\DELL\\Downloads\\CÁC phiên bản Zai\\Z ai Account'
        ];

        for (const p of candidates) {
            if (p && fs.existsSync(p) && fs.existsSync(path.join(p, 'manifest.json'))) {
                return p;
            }
        }
        return null;
    }

    /**
     * Dọn dẹp tệp Lock rác của Chrome Profile để tránh Chrome tự động kết nối vào session cũ đã đóng
     */
    private cleanupProfileLock(profileDir: string): void {
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const file of lockFiles) {
            const lockPath = path.join(profileDir, file);
            if (fs.existsSync(lockPath)) {
                try { fs.unlinkSync(lockPath); } catch (e) {}
            }
        }
    }

    /**
     * Khởi chạy Chrome Mini Window kèm 2 Extension
     */
    public launch(): boolean {
        const exePath = this.findBrowserExecutable();
        if (!exePath) {
            console.warn('[BrowserLauncher] ⚠️ Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy.');
            return false;
        }

        const bridgeExtPath = this.findBridgeExtensionPath();
        const accountExtPath = this.findAccountExtensionPath();

        const extPaths: string[] = [];
        if (bridgeExtPath) {
            console.log(`[BrowserLauncher] 🔗 Đã phát hiện Z.AI Bridge Extension: ${bridgeExtPath}`);
            extPaths.push(bridgeExtPath);
        } else {
            console.warn('[BrowserLauncher] ⚠️ KHÔNG tìm thấy Z.AI Bridge Extension trên đĩa cứng!');
        }

        if (accountExtPath) {
            console.log(`[BrowserLauncher] 🔗 Đã phát hiện Z.AI Account Manager: ${accountExtPath}`);
            extPaths.push(accountExtPath);
        } else {
            console.warn('[BrowserLauncher] ⚠️ KHÔNG tìm thấy Z.AI Account Manager trên đĩa cứng!');
        }

        const profileDir = path.resolve(process.cwd(), 'ZaiProfile');
        if (!fs.existsSync(profileDir)) {
            try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
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
            this.chromeProcess = spawn(exePath, args, { detached: true, stdio: 'ignore' });
            this.chromeProcess.unref();
            console.log(`[BrowserLauncher] ✅ Khởi chạy Trình duyệt thành công!`);
            return true;
        } catch (e: any) {
            console.error(`[BrowserLauncher] ❌ Lỗi khởi chạy trình duyệt: ${e.message}`);
            return false;
        }
    }
}
