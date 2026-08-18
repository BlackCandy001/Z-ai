// popup.js — Z.AI Bridge 8.0
// Controller logic for the Popup: server status check + open sidePanel

document.addEventListener('DOMContentLoaded', () => {
    const statusDot  = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const btnOpen    = document.getElementById('btnOpen');

    // ── Server Health ──
    function checkServerHealth() {
        fetch('http://127.0.0.1:8888/v1/health')
            .then(r => r.json())
            .then(d => {
                const ok = d && d.status === 'ok';
                if (statusDot) statusDot.classList.toggle('online', ok);
                if (statusText) statusText.textContent = ok ? 'Online' : 'Offline';
            })
            .catch(() => {
                if (statusDot) statusDot.classList.remove('online');
                if (statusText) statusText.textContent = 'Offline';
            });
    }

    checkServerHealth();
    setInterval(checkServerHealth, 3000);

    // ── Open SidePanel ──
    if (btnOpen) {
        btnOpen.addEventListener('click', async () => {
            try {
                // Method 1: Open sidePanel directly for the current window with user gesture
                const currentWindow = await chrome.windows.getCurrent();
                if (currentWindow && currentWindow.id) {
                    await chrome.sidePanel.open({ windowId: currentWindow.id });
                }
            } catch (err) {
                console.warn('[Popup] Direct window sidePanel.open failed, trying tabId:', err);
                try {
                    // Method 2: Fallback with active tabId
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab && tab.id) {
                        await chrome.sidePanel.open({ tabId: tab.id });
                    }
                } catch (err2) {
                    console.warn('[Popup] tabId sidePanel.open failed, sending to background:', err2);
                    // Method 3: Fallback via background message
                    chrome.runtime.sendMessage({ action: 'openSidePanel' });
                }
            }
            // Close the popup after opening side panel
            window.close();
        });
    }
});
