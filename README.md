# Z.AI Bridge V8.0 — Universal Extension & Server Bridge
**Version**: 8.0.0 (Release Build v1.0.8)  
**Tác giả**: Z.AI Bridge Engineering Team  
**Mục đích**: Cầu nối 2 chiều hiệu năng cao (Reverse Proxy & Extension Bridge) giữa VS Code (Zen / Cline / Roo Code) và trình duyệt Z.AI (`chat.z.ai`), hỗ trợ đầy đủ các mô hình AI thế hệ mới nhất như **GLM-5.2**, **GLM-5.1** & **Deep Think**.

---

## 🌟 CÁC TÍNH NĂNG VÀ NÂNG CẤP NỔI BẬT BẢN 8.0 (v1.0.8)

### 1. 👥 Quản lý Đa Tài khoản & Tự động Luân chuyển (Multi-Account Manager & Auto-Rotate)
- **Snapshot & Restore tức thì**: Lưu trữ trạng thái nhiều tài khoản Z.AI (Cookies, LocalStorage, SessionStorage, JWT token expiration).
- **Phân lập Quota theo từng User**: Mỗi tài khoản được cấp một bộ đếm giới hạn (Bucket) riêng biệt (`AccountRateLimiter`), tự động luân chuyển sang tài khoản mới khi tài khoản hiện tại chạm ngưỡng giới hạn.
- **WAF Auto-Cooldown**: Tự động cách ly và ngưng gửi request với tài khoản bị dính WAF/Captcha trong 60 giây, bảo vệ tài khoản khỏi nguy cơ bị khóa.

### 2. 🪟 Hợp nhất Giao diện vào Chrome SidePanel (Unified SidePanel UI)
- **Tích hợp toàn diện vào thanh bên**: Cả mục **Quản lý tài khoản**, **Cấu hình Proxy** và **Cài đặt hạn mức Quota** được đưa vào chung một SidePanel tiện lợi với thiết kế kính mờ (Glassmorphism) hiện đại.
- **Popup mở nhanh**: Bấm icon Extension để kiểm tra trạng thái Server Health thời gian thực và mở SidePanel chỉ với một cú click.

### 3. 🧠 Hệ thống Phân biệt Treo vs Suy nghĩ (Hang Detection Engine)
- **Bắt trọn luồng SSE Thinking ngầm**: Chuyển tiếp toàn bộ các gói tin suy nghĩ từ tầng mạng của Z.AI lên Extension và Server.
- **Chế độ Heartbeat tinh gọn (0% Lag Terminal & VS Code)**: Ẩn việc xả hàng chục nghìn chữ suy nghĩ thô ra màn hình console để triệt tiêu 100% hiện tượng đơ giật UI/Terminal, chỉ cập nhật tiến độ mỗi 15 giây (`🧠 Thinking — 45s • 350 chunks • ~8c/s`).
- **Cảnh báo Treo thông minh**: Chỉ phát cảnh báo `⚠️ NGHI NGỜ TREO` khi thực sự không nhận được bất kỳ mẩu dữ liệu (chunk) nào trong **90 giây liên tiếp**.

### 4. 🛡️ Cơ chế Chống WAF & Jitter Delay Tự nhiên
- **Anti-Bot Jitter Delay**: Thêm khoảng trễ ngẫu nhiên từ **2–5 giây** trước khi dispatch prompt lên trình duyệt, xóa bỏ hoàn toàn pattern gửi tin cơ học đều đặn.
- **Giữ kết nối 24/7 (Silent Audio Engine)**: Ép trình duyệt xếp tab Z.AI vào danh sách Media Tab ngầm, không bao giờ bị đóng băng React State khi thu nhỏ Minimize `_`.

### 5. 🧹 Khử trùng lặp Log & Tối ưu I/O Terminal
- Chỉ in thông báo khi hạn mức Quota hoặc danh sách tài khoản **thực sự thay đổi**, giữ cửa sổ Terminal luôn sạch sẽ, dễ quan sát.

---

## 🏗️ CẤU TRÚC HỆ THỐNG (SYSTEM ARCHITECTURE)

```
[ VS Code / Cline / Zen ]
           │  (OpenAI-Compatible API / HTTP POST /v1/chat/completions)
           ▼
[ Z.AI Bridge Server (Port 8888) ] ── (AccountRateLimiter & Hang Tracker)
           │  (WebSocket 2-way Port 8899)
           ▼
[ Chrome Extension (Background + Content Script + inject.js) ]
           │  (DOM Automation & Network Interception)
           ▼
[ Trình duyệt chat.z.ai ] ── (GLM-5.2 / GLM-5.1 / Deep Think Engine)
```

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT & KHỞI ĐỘNG

### Cách 1: Sử dụng Bản Đóng Gói Độc Lập `.exe` (Khuyên Dùng)
1. Tải và giải nén thư mục `dist/release/`.
2. Mở trình duyệt Chrome hoặc Edge, truy cập `chrome://extensions` $\rightarrow$ Bật **Developer mode** (Chế độ dành cho nhà phát triển).
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén) $\rightarrow$ Chọn thư mục `dist/release/extension/`.
4. Mở tab `https://chat.z.ai/` và đăng nhập tài khoản Z.AI.
5. Chạy tệp **`z-ai-bridge.exe`** tại `dist/release/z-ai-bridge.exe`.
6. Mở VS Code (Cline / Zen / Roo Code) và bắt đầu sử dụng với Base URL `http://127.0.0.1:8888/v1`!

### Cách 2: Chạy từ Mã Nguồn (Source Code)
```bash
# Cài đặt thư viện
npm install

# Khởi động server phát triển
npm start

# Hoặc build bản phát hành sản phẩm
npm run build:prod
```

---

## ⚙️ CẤU HÌNH TRÌNH DUYỆT CHẠY NGẦM KHI THU NHỎ (MINIMIZE `_`)

Để Windows và Chrome/Edge không đóng băng tab chat khi thu nhỏ xuống Taskbar, hãy thêm 2 cờ sau vào Shortcut trình duyệt:
```text
--disable-background-timer-throttling --disable-backgrounding-occluded-windows
```

* **Google Chrome**:
  ```text
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --disable-background-timer-throttling --disable-backgrounding-occluded-windows
  ```
* **Microsoft Edge**:
  ```text
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --profile-directory=Default --disable-background-timer-throttling --disable-backgrounding-occluded-windows
  ```

---

## 📝 NHẬT KÝ PHIÊN BẢN (CHANGELOG)

* **v1.0.8 (v8.0.0)**:
  * Hợp nhất giao diện Quản lý tài khoản & Proxy vào Chrome SidePanel.
  * Tích hợp cơ chế đo nhịp tim Token Suy nghĩ & Ẩn raw thinking stream triệt tiêu lag 100%.
  * Thêm bộ đệm Jitter ngẫu nhiên 2–5s chống WAF.
  * Khử trùng lặp log Terminal định kỳ.
* **v1.0.7 (v7.0.0)**:
  * Tích hợp Silent Audio Keep-Alive Engine chạy ngầm 24/7.
  * Hỗ trợ 4-layer form submit tự động.
  * Tối ưu hóa cắt tỉa DOM chống lag phiên dài.

---

© 2026 Z.AI Bridge Engineering Team. Released for Advanced Agentic Coding Integration.
