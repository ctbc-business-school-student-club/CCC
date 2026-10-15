/**
 * 小型演唱會入場通關系統 - 前端主邏輯 (app.js)
 * 部署於 GitHub Pages，透過 fetch 呼叫 Google Apps Script API (Code.gs 的 doPost)
 */

// ==========================================
// 1. 全域變數與狀態管理
// ==========================================
const API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL || "").trim();
const IS_LOCAL_MOCK = !API_URL; // 未設定 API 網址時使用假資料

let currentUser = null;   // { email, name, role }
let sessionToken = null;  // 後端登入後發給的憑證
let html5Qrcode = null;   // 即時鏡頭掃描器
let fileScanner = null;   // 拍照核銷專用解碼器
let currentFacingMode = "environment"; // 預設使用手機後置鏡頭

let isScanProcessing = false; // 是否正在處理核銷中
let recentScans = new Set();  // 防重複觸發快取
let statsTimer = null;        // 5 秒輪詢計時器

const mockDb = {
  whitelist: [
    { email: "admin@concert.com", name: "活動總召 (管理者)", role: "管理者" },
    { email: "staff@concert.com", name: "檢票小組 A (工作人員)", role: "檢票人員" }
  ],
  attendees: [
    { category: "校內", ticketType: "校內票", identifier: "學號：10954001 (財金四)", name: "陳大明", detail: "班級: 財金四", email: "student1@mail.edu.tw", phone: "0912345678", token: "TKN-CAMPUS001", status: "未入場", checkInTime: "-" },
    { category: "校內", ticketType: "校內票", identifier: "學號：11054002 (國企三)", name: "林小華", detail: "班級: 國企三", email: "student2@mail.edu.tw", phone: "0923456789", token: "TKN-CAMPUS002", status: "已入場", checkInTime: "2026-10-09 19:15:20" },
    { category: "校外", ticketType: "校外票", identifier: "身分證後5碼：***12345", name: "張美玲", detail: "性別: 女 | 票種: 單人預售票", email: "guest1@gmail.com", phone: "0934567890", token: "TKN-OFFSITE001", status: "未入場", checkInTime: "-" },
    { category: "校外", ticketType: "公關票", identifier: "身分證後5碼：***99887", name: "王貴賓", detail: "性別: 男 | 票種: 貴賓公關票", email: "vip@example.com", phone: "0988776655", token: "TKN-VIP001", status: "未入場", checkInTime: "-" }
  ]
};

// ==========================================
// 2. 初始化與後端通訊
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("concert_session");
  if (saved) {
    try {
      const data = JSON.parse(saved);
      if (data && data.user && data.sessionToken) {
        currentUser = data.user;
        sessionToken = data.sessionToken;
        showAppView();
      }
    } catch (e) {
      localStorage.removeItem("concert_session");
    }
  }

  if (IS_LOCAL_MOCK) {
    console.log("💡 config.js 尚未設定 API_URL，目前為 [本地測試模式]，使用假資料。");
  }

  adaptResponsiveLayout();
});

function adaptResponsiveLayout() {
  const details = document.getElementById("manualEntryDetails");
  if (!details) return;
  // 電腦螢幕保持展開，手機螢幕預設收起節省垂直滾動空間
  if (window.innerWidth >= 768) {
    details.open = true;
  } else {
    details.open = false;
  }
}
window.addEventListener("resize", adaptResponsiveLayout);

/**
 * 呼叫 Apps Script API
 * 使用 Content-Type: text/plain 可避免瀏覽器 CORS 預檢 (Apps Script 不支援 OPTIONS)
 */
async function callBackend(action, ...args) {
  if (IS_LOCAL_MOCK) {
    await new Promise(r => setTimeout(r, 300));
    return handleMockApi(action, args);
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, args, sessionToken }),
      redirect: "follow"
    });
    const res = await response.json();

    // 登入逾時 → 自動回到登入畫面
    if (res && res.code === "AUTH_REQUIRED") {
      forceLogout(res.message);
    }
    return res;
  } catch (err) {
    console.error("API 呼叫失敗:", err);
    return { success: false, code: "NETWORK_ERROR", message: "無法連線到伺服器，請確認網路連線" };
  }
}

// ==========================================
// 3. 登入與權限控管
// ==========================================

async function handleLogin(e) {
  e.preventDefault();
  const emailInput = document.getElementById("loginEmail");
  const alertBox = document.getElementById("loginAlert");
  const loginBtn = document.getElementById("loginBtn");

  const email = emailInput.value.trim();
  if (!email) return;

  loginBtn.disabled = true;
  loginBtn.innerText = "驗證白名單中...";
  alertBox.style.display = "none";

  const res = await callBackend("loginUser", email);
  loginBtn.disabled = false;
  loginBtn.innerText = "確認登入 ➔";

  if (res.success) {
    currentUser = res.user;
    sessionToken = res.sessionToken;
    localStorage.setItem("concert_session", JSON.stringify({ user: currentUser, sessionToken }));
    showAppView();
  } else {
    alertBox.innerText = res.message || "登入失敗，請確認電子郵件";
    alertBox.style.display = "block";
  }
}

function handleLogout() {
  if (confirm("確定要登出系統嗎？")) {
    callBackend("logout"); // 通知後端作廢憑證 (不需等待)
    forceLogout();
  }
}

function forceLogout(message) {
  stopScanner();
  clearInterval(statsTimer);
  currentUser = null;
  sessionToken = null;
  localStorage.removeItem("concert_session");

  document.getElementById("appView").style.display = "none";
  document.getElementById("loginView").style.display = "flex";
  document.getElementById("loginEmail").value = "";

  const alertBox = document.getElementById("loginAlert");
  if (message) {
    alertBox.innerText = message;
    alertBox.style.display = "block";
  } else {
    alertBox.style.display = "none";
  }
}

function showAppView() {
  document.getElementById("loginView").style.display = "none";
  document.getElementById("appView").style.display = "block";

  document.getElementById("currentUserName").innerText = currentUser.name;
  const roleBadge = document.getElementById("currentUserRole");
  roleBadge.innerText = currentUser.role;

  if (currentUser.role === "管理者") {
    roleBadge.className = "role-badge role-admin";
    document.getElementById("whitelistTabBtn").style.display = "flex";
  } else {
    roleBadge.className = "role-badge role-staff";
    document.getElementById("whitelistTabBtn").style.display = "none";
  }

  updateStatsPollingUI();
  switchTab("scanner");
  startStatsPolling();
}

// ==========================================
// 4. 頁籤切換邏輯
// ==========================================

function switchTab(tabName) {
  const tabs = ["scanner", "query", "stats", "whitelist"];
  tabs.forEach(t => {
    const pane = document.getElementById(`tab-${t}`);
    if (pane) pane.classList.remove("active");
  });

  const activePane = document.getElementById(`tab-${tabName}`);
  if (activePane) activePane.classList.add("active");

  document.querySelectorAll(".tab-btn").forEach(btn => {
    if (btn.getAttribute("onclick").includes(`'${tabName}'`)) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  if (tabName === "scanner") {
    initScanner();
  } else {
    stopScanner();
  }

  if (tabName === "whitelist" && currentUser.role === "管理者") {
    loadWhitelist();
  }

  if (tabName === "stats") {
    fetchStats();
  }
}

// ==========================================
// 5. 相機與 QR Code 掃描器邏輯
// GitHub Pages 是一般 HTTPS 網頁 (沒有 iframe 限制)，所有手機瀏覽器都能開啟即時鏡頭。
// 若使用者拒絕相機權限，會自動切換為「拍照核銷」並提供重試按鈕。
// ==========================================

async function initScanner() {
  if (html5Qrcode && html5Qrcode.isScanning) return;

  const reader = document.getElementById("reader");
  const prompt = document.getElementById("startCameraPrompt");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
    showCameraFallback("此瀏覽器不支援即時鏡頭 (需使用 HTTPS 網址開啟)，請使用拍照核銷。");
    return;
  }

  try {
    if (prompt) prompt.style.display = "none";
    if (reader) reader.style.display = "block";

    if (!html5Qrcode) {
      html5Qrcode = new Html5Qrcode("reader");
    }

    await html5Qrcode.start(
      { facingMode: currentFacingMode },
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      onScanSuccess,
      onScanFailure
    );

    updateScannerStatusDot(true);
  } catch (err) {
    console.warn("即時相機無法啟動:", err);
    const msg = String(err && err.name ? err.name : err);
    if (msg.includes("NotAllowed") || msg.includes("Permission")) {
      showCameraFallback("相機權限被拒絕。請在瀏覽器網址列的設定中允許相機，再按「重新啟動鏡頭」。");
    } else {
      showCameraFallback("即時鏡頭無法啟動，可改用拍照核銷。");
    }
  }
}

/**
 * 即時鏡頭無法使用時的備援畫面：重新啟動鏡頭 / 拍照核銷
 */
function showCameraFallback(notice) {
  updateScannerStatusDot(false);
  const reader = document.getElementById("reader");
  const prompt = document.getElementById("startCameraPrompt");
  if (reader) reader.style.display = "none";
  if (!prompt) return;

  prompt.style.display = "flex";
  prompt.innerHTML = `
    <div style="font-size: 2.4rem; line-height: 1;">📷</div>
    <p style="font-size: 0.85rem; color: #fbbf24; line-height: 1.5; max-width: 360px; margin: 0;">${escapeHtml(notice)}</p>
    <button onclick="initScanner()" class="btn btn-primary" style="width: 100%; max-width: 360px; padding: 14px; font-size: 1rem;">
      🔄 重新啟動鏡頭
    </button>
    <label class="btn btn-secondary" style="width: 100%; max-width: 360px; padding: 14px; font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
      📸 拍照核銷 QR Code
      <input type="file" accept="image/*" capture="environment" style="display: none;" onchange="handleFileScan(event)">
    </label>
  `;
}

async function stopScanner() {
  if (html5Qrcode && html5Qrcode.isScanning) {
    try {
      await html5Qrcode.stop();
    } catch (err) {
      console.error("停止鏡頭失敗:", err);
    }
  }
  updateScannerStatusDot(false);
}

async function switchCamera() {
  await stopScanner();
  currentFacingMode = (currentFacingMode === "environment") ? "user" : "environment";
  initScanner();
}

function updateScannerStatusDot(active) {
  const dot = document.getElementById("scannerStatusDot");
  if (dot) {
    if (active) dot.classList.remove("paused");
    else dot.classList.add("paused");
  }
}

async function handleFileScan(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;

  if (!fileScanner) {
    fileScanner = new Html5Qrcode("fileScanReader");
  }

  let decodedText = null;
  try {
    decodedText = await fileScanner.scanFile(file, false);
  } catch (err) {
    alert("❌ 照片中找不到 QR Code，請靠近一點、保持畫面清晰後重新拍攝。");
  } finally {
    input.value = "";
  }

  if (decodedText) {
    await onScanSuccess(decodedText);
  }
}

async function onScanSuccess(decodedText) {
  if (isScanProcessing || recentScans.has(decodedText)) {
    return;
  }

  isScanProcessing = true;
  recentScans.add(decodedText);
  setTimeout(() => recentScans.delete(decodedText), 5000);

  if (html5Qrcode && html5Qrcode.isScanning) {
    try { html5Qrcode.pause(true); } catch (e) { }
  }

  // 立即跳出微光 Loading 反饋，消除心理等待感
  showScanLoading(decodedText);

  const res = await callBackend("verifyTicket", decodedText);
  showScanOverlay(res);
}

function onScanFailure(error) { }

function getTicketBadgeClass(ticketType, category) {
  if (ticketType && ticketType.includes("公關")) return "role-vip";
  if (category === "校內" || (ticketType && ticketType.includes("校內"))) return "role-campus";
  return "role-offcampus";
}

function showScanLoading(tokenPreview = "") {
  const overlay = document.getElementById("scanOverlay");
  const icon = document.getElementById("overlayIcon");
  const title = document.getElementById("overlayTitle");
  const desc = document.getElementById("overlayDesc");
  const confirmBtn = document.getElementById("overlayConfirmBtn");

  overlay.className = "scan-overlay show loading";
  icon.innerHTML = `<span class="spin">⚡</span>`;
  title.innerText = "驗票處理中...";
  desc.innerHTML = `
    <div style="font-size: 0.95rem; opacity: 0.9; margin-top: 4px;">
      正在比對雲端名單並進行安全核銷...
      ${tokenPreview ? `<div style="font-size: 0.8rem; color: #a5b4fc; margin-top: 4px;">(${escapeHtml(tokenPreview)})</div>` : ""}
    </div>
  `;
  if (confirmBtn) {
    confirmBtn.style.display = "none";
  }
}

function showScanOverlay(res) {
  const overlay = document.getElementById("scanOverlay");
  const icon = document.getElementById("overlayIcon");
  const title = document.getElementById("overlayTitle");
  const desc = document.getElementById("overlayDesc");
  const confirmBtn = document.getElementById("overlayConfirmBtn");

  if (confirmBtn) {
    confirmBtn.style.display = "inline-flex";
  }

  overlay.className = "scan-overlay show";
  const att = res.attendee || {};
  const ticketType = att.ticketType || (att.category === "校內" ? "校內票" : "校外票");
  const badgeClass = getTicketBadgeClass(ticketType, att.category);

  if (res.success) {
    overlay.classList.add("success");
    icon.innerText = "✓";
    title.innerText = "核銷成功！歡迎入場";

    desc.innerHTML = `
      <div class="overlay-attendee-card">
        <div class="overlay-attendee-header">
          <span class="role-badge ${badgeClass}">${escapeHtml(ticketType)}</span>
          <span class="overlay-attendee-name">${escapeHtml(att.name || "觀眾")}</span>
        </div>
        ${att.identifier ? `<div class="overlay-attendee-id">${escapeHtml(att.identifier)}</div>` : ""}
        ${att.detail ? `<div class="overlay-attendee-detail">${escapeHtml(att.detail)}</div>` : ""}
      </div>
    `;
    if (confirmBtn) {
      confirmBtn.innerHTML = "✅ 確認，繼續驗票 ➜";
    }
    updateLastResultCard(true, att, res.message);
  } else {
    overlay.classList.add("danger");
    icon.innerText = "✕";
    title.innerText = res.code === "ALREADY_CHECKED_IN" ? "已入場！請勿重複核銷" : "驗票失敗";

    if (res.code === "ALREADY_CHECKED_IN" && att.name) {
      desc.innerHTML = `
        <div style="margin-bottom: 6px; font-weight: 600;">⚠️ 此票券已於先前完成核銷：</div>
        <div class="overlay-attendee-card">
          <div class="overlay-attendee-header">
            <span class="role-badge ${badgeClass}">${escapeHtml(ticketType)}</span>
            <span class="overlay-attendee-name">${escapeHtml(att.name)}</span>
          </div>
          ${att.identifier ? `<div class="overlay-attendee-id">${escapeHtml(att.identifier)}</div>` : ""}
          <div class="overlay-attendee-detail" style="color: #fca5a5;">原入場時間：${escapeHtml(att.checkInTime || "-")}</div>
        </div>
      `;
    } else {
      desc.innerText = res.message || "無效的 QR Code";
    }
    if (confirmBtn) {
      confirmBtn.innerHTML = "關閉，繼續驗票 ➜";
    }
    updateLastResultCard(false, att, res.message);
  }

  // 自動聚焦在確認按鈕上，工作人員若有外接鍵盤可直接按 Enter 或空白鍵
  if (confirmBtn) {
    setTimeout(() => { try { confirmBtn.focus(); } catch (e) { } }, 100);
  }
}

/**
 * 點擊確認按鈕後，關閉覆蓋層並恢復相機驗票
 */
function confirmAndResumeScan() {
  const overlay = document.getElementById("scanOverlay");
  if (!overlay) return;
  overlay.className = "scan-overlay";
  isScanProcessing = false;
  if (html5Qrcode && html5Qrcode.isScanning) {
    try { html5Qrcode.resume(); } catch (e) { }
  }
}

function updateLastResultCard(success, att, msg) {
  const card = document.getElementById("lastResultCard");
  const statusColor = success ? "var(--success)" : "var(--danger)";
  att = att || {};
  const ticketType = att.ticketType || (att.category === "校內" ? "校內票" : (att.category ? "校外票" : "未知"));
  const badgeClass = getTicketBadgeClass(ticketType, att.category);

  card.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
      <span style="font-weight: 800; color: ${statusColor}; font-size: 1rem;">
        ${success ? "✅ 驗票成功" : "❌ 驗票未通過"}
      </span>
      <span class="role-badge ${badgeClass}">${escapeHtml(ticketType)}</span>
    </div>
    <div style="font-size: 1.15rem; font-weight: 800; color: var(--text-main); margin-bottom: 4px;">
      ${escapeHtml(att.name || "未知持票人")}
    </div>
    <div class="result-card-identifier">
      ${escapeHtml(att.identifier || att.detail || "無身分資訊")}
    </div>
    <div style="font-size: 0.82rem; color: var(--text-muted); line-height: 1.4;">
      狀態：${escapeHtml(msg || "-")}<br/>
      時間：${escapeHtml(att.checkInTime || "-")}
    </div>
  `;
}

async function handleManualVerify(e) {
  e.preventDefault();
  const input = document.getElementById("manualTokenInput");
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const token = input.value.trim();
  if (!token) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = "⚡ 核銷驗票中...";
  }

  showScanLoading(token);
  const res = await callBackend("verifyTicket", token);
  showScanOverlay(res);
  input.value = "";

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerText = "手動核銷驗票";
  }
}

// ==========================================
// 6. 觀眾查詢邏輯
// ==========================================

function handleQueryKeyPress(e) {
  if (e.key === "Enter") {
    executeAttendeeQuery();
  }
}

function toggleClearQueryBtn() {
  const input = document.getElementById("queryKeywordInput");
  const btn = document.getElementById("clearQueryBtn");
  if (!input || !btn) return;
  btn.style.display = input.value.trim() ? "block" : "none";
}

function clearQueryInput() {
  const input = document.getElementById("queryKeywordInput");
  if (!input) return;
  input.value = "";
  toggleClearQueryBtn();
  const countEl = document.getElementById("queryResultsCount");
  if (countEl) countEl.style.display = "none";
  input.focus();
}

async function executeAttendeeQuery() {
  const input = document.getElementById("queryKeywordInput");
  const countEl = document.getElementById("queryResultsCount");
  const keyword = input.value.trim();
  if (!keyword) {
    alert("請輸入搜尋姓名、學號、電話、Email 或 Token");
    return;
  }

  const tbody = document.getElementById("queryResultTableBody");
  tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 25px;">⚡ 正在查詢雲端名單...</td></tr>`;

  const res = await callBackend("queryAttendee", keyword);

  if (res.success && res.data && res.data.length > 0) {
    if (countEl) {
      countEl.innerText = `🔍 搜尋「${keyword}」共找到 ${res.data.length} 筆資料`;
      countEl.style.display = "block";
    }

    tbody.innerHTML = res.data.map((item, idx) => {
      const isCheckedIn = item.status === "已入場";
      const statusBadge = isCheckedIn
        ? `<span class="status-badge status-checked-in">已入場</span>`
        : `<span class="status-badge status-not-checked-in">未入場</span>`;

      const safePhone = String(item.phone || "").trim();
      const phoneHtml = safePhone
        ? `<a href="tel:${escapeHtml(safePhone)}" class="phone-link">📞 ${escapeHtml(safePhone)}</a>`
        : `<span style="color: var(--text-dim);">-</span>`;

      // 快速操作按鈕
      const quickActionHtml = isCheckedIn
        ? `<span style="font-size: 0.8rem; color: var(--success); font-weight: 600;">✓ 已放行</span>`
        : `<button type="button" class="btn-quick-verify" onclick="handleQuickVerifyFromQuery('${escapeJs(item.token)}', '${escapeJs(item.name)}')">⚡ 快速核銷</button>`;

      return `
        <tr class="attendee-query-row ${isCheckedIn ? 'is-checked-in' : ''}">
          <td data-label="身分分類" class="td-category">
            <span class="role-badge ${item.category === "校內" ? "role-admin" : "role-staff"}">${escapeHtml(item.category)}</span>
          </td>
          <td data-label="姓名" class="td-name">
            <strong>${escapeHtml(item.name)}</strong>
          </td>
          <td data-label="班級/票種詳情" class="td-detail">
            ${escapeHtml(item.detail || "-")}
          </td>
          <td data-label="連絡電話" class="td-phone">
            ${phoneHtml}
          </td>
          <td data-label="入場狀態" class="td-status">
            ${statusBadge}
          </td>
          <td data-label="入場時間" class="td-time">
            ${escapeHtml(item.checkInTime || "-")}
          </td>
          <td data-label="快速操作" class="td-action">
            ${quickActionHtml}
          </td>
        </tr>
      `;
    }).join("");
  } else if (!res.success) {
    if (countEl) countEl.style.display = "none";
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 30px;">${escapeHtml(res.message || "查詢失敗")}</td></tr>`;
  } else {
    if (countEl) countEl.style.display = "none";
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">查無符合「${escapeHtml(keyword)}」的報名資料</td></tr>`;
  }
}

async function handleQuickVerifyFromQuery(token, name) {
  if (!token) {
    alert("此觀眾無可用 Token，無法核銷");
    return;
  }
  if (!confirm(`確定要為「${name}」立即完成入場核銷嗎？`)) {
    return;
  }
  showScanLoading(token);
  const res = await callBackend("verifyTicket", token);
  showScanOverlay(res);
  // 重新查詢更新列表狀態
  executeAttendeeQuery();
}

// ==========================================
// 7. 實時統計與輪詢控制 (依角色調整)
// ==========================================

function updateStatsPollingUI() {
  const dot = document.getElementById("statsPollingDot");
  const notice = document.getElementById("statsPollingNoticeText");
  if (!dot || !notice) return;

  if (currentUser && currentUser.role === "管理者") {
    dot.classList.remove("paused");
    notice.innerText = "15 秒自動更新中 (管理者)";
  } else {
    dot.classList.add("paused");
    notice.innerText = "手動更新模式 (切換分頁或點擊刷新)";
  }
}

/**
 * 啟動統計輪詢：
 * - 一般檢票人員：完全不啟動背景定時輪詢，保留所有後端頻寬與 Lock 給現場掃描
 * - 管理者：每 15 秒自動輪詢一次
 */
function startStatsPolling() {
  clearInterval(statsTimer);
  statsTimer = null;

  if (!currentUser || currentUser.role !== "管理者") {
    return;
  }

  fetchStats();
  statsTimer = setInterval(fetchStats, 15000);
}

async function fetchStats(isManual = false) {
  if (!sessionToken && !IS_LOCAL_MOCK) return;

  const refreshBtn = document.getElementById("refreshStatsBtn");
  if (isManual && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerText = "更新中...";
  }

  try {
    const res = await callBackend("getStats");
    if (!(res.success && res.data)) return;

    const d = res.data;
    document.getElementById("statTotalRegistered").innerText = d.totalRegistered;
    document.getElementById("statTotalCheckedIn").innerText = d.totalCheckedIn;
    document.getElementById("statTotalNotCheckedIn").innerText = d.totalNotCheckedIn;
    document.getElementById("statAttendanceRate").innerText = d.attendanceRate + "%";
    document.getElementById("statProgressBar").style.width = d.attendanceRate + "%";

    document.getElementById("campusStatCount").innerText = `${d.campus.checkedIn} / ${d.campus.registered} 人`;
    const campusRate = d.campus.registered > 0 ? (d.campus.checkedIn / d.campus.registered) * 100 : 0;
    document.getElementById("campusProgressBar").style.width = campusRate + "%";

    document.getElementById("offCampusStatCount").innerText = `${d.offCampus.checkedIn} / ${d.offCampus.registered} 人`;
    const offCampusRate = d.offCampus.registered > 0 ? (d.offCampus.checkedIn / d.offCampus.registered) * 100 : 0;
    document.getElementById("offCampusProgressBar").style.width = offCampusRate + "%";

    const logsList = document.getElementById("recentLogsList");
    if (d.recentLogs && d.recentLogs.length > 0) {
      logsList.innerHTML = d.recentLogs.map(log => `
        <li class="log-item">
          <div>
            <span style="font-weight: 700;">${escapeHtml(log.name)}</span>
            <span class="role-badge ${log.category === "校內" ? "role-admin" : "role-staff"}" style="font-size: 0.65rem; margin-left: 6px;">${escapeHtml(log.category)}</span>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(log.time)} 核銷</div>
        </li>
      `).join("");
    } else {
      logsList.innerHTML = `<li style="color: var(--text-muted); text-align: center; padding: 20px;">尚無最新核銷紀錄</li>`;
    }
  } finally {
    if (isManual && refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerText = "🔄 重新整理";
    }
  }
}

// ==========================================
// 8. 白名單管理與 Token/QR Code 補產生 (管理者權限)
// ==========================================

async function loadWhitelist() {
  const tbody = document.getElementById("whitelistTableBody");
  tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">載入中...</td></tr>`;

  const res = await callBackend("getWhitelist");

  if (!res.success) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger); padding: 20px;">${escapeHtml(res.message || "載入失敗")}</td></tr>`;
    return;
  }
  if (!res.data || res.data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">目前尚無白名單資料</td></tr>`;
    return;
  }

  tbody.innerHTML = res.data.map(user => `
    <tr>
      <td style="font-family: monospace;">${escapeHtml(user.email)}</td>
      <td style="font-weight: 700;">${escapeHtml(user.name)}</td>
      <td>
        <span class="role-badge ${user.role === "管理者" ? "role-admin" : "role-staff"}">${escapeHtml(user.role)}</span>
      </td>
      <td>
        <button onclick="openEditUserModal('${escapeHtml(escapeJs(user.email))}', '${escapeHtml(escapeJs(user.name))}', '${escapeHtml(escapeJs(user.role))}')" class="btn btn-secondary btn-sm" style="margin-right: 6px;">編輯</button>
        <button onclick="handleDeleteUser('${escapeHtml(escapeJs(user.email))}')" class="btn btn-danger btn-sm">刪除</button>
      </td>
    </tr>
  `).join("");
}

function openAddUserModal() {
  document.getElementById("userModalTitle").innerText = "新增系統使用者";
  document.getElementById("editOriginalEmail").value = "";
  document.getElementById("modalEmail").value = "";
  document.getElementById("modalName").value = "";
  document.getElementById("modalRole").value = "檢票人員";
  document.getElementById("userModal").classList.add("show");
}

function openEditUserModal(email, name, role) {
  document.getElementById("userModalTitle").innerText = "修改系統使用者資料";
  document.getElementById("editOriginalEmail").value = email;
  document.getElementById("modalEmail").value = email;
  document.getElementById("modalName").value = name;
  document.getElementById("modalRole").value = role;
  document.getElementById("userModal").classList.add("show");
}

function closeUserModal() {
  document.getElementById("userModal").classList.remove("show");
}

async function handleSaveUser(e) {
  e.preventDefault();
  const origEmail = document.getElementById("editOriginalEmail").value;
  const email = document.getElementById("modalEmail").value.trim();
  const name = document.getElementById("modalName").value.trim();
  const role = document.getElementById("modalRole").value;

  const res = origEmail
    ? await callBackend("updateWhitelistUser", origEmail, email, name, role)
    : await callBackend("addWhitelistUser", email, name, role);

  if (res.success) {
    closeUserModal();
    loadWhitelist();
    alert(res.message);
  } else {
    alert("儲存失敗: " + res.message);
  }
}

async function handleDeleteUser(email) {
  if (!confirm(`確定要將 ${email} 從白名單中移除嗎？`)) return;
  const res = await callBackend("deleteWhitelistUser", email);
  if (res.success) {
    loadWhitelist();
    alert(res.message);
  } else {
    alert("刪除失敗: " + res.message);
  }
}

async function triggerBackfillTokens() {
  if (confirm("即將為未生成 Token 的報名補齊 Token，並產生缺少的 QR CODE 圖片至 Google Drive（已存在的 Token 與圖片不會被覆蓋），是否繼續？")) {
    const res = await callBackend("backfillMissingTokensAndQrCodes");
    alert(res.message || "處理完成");
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJs(str) {
  if (!str) return "";
  return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ==========================================
// 本地測試 Mock 介面 (config.js 未設定 API_URL 時使用)
// ==========================================
function handleMockApi(action, args) {
  if (action === "loginUser") {
    const match = mockDb.whitelist.find(u => u.email.toLowerCase() === String(args[0]).toLowerCase());
    if (match) return { success: true, user: match, sessionToken: "mock-session" };
    return { success: false, message: "無權限存取系統 (測試模式：請用 admin@concert.com 或 staff@concert.com)" };
  }

  if (action === "logout") return { success: true };

  if (action === "verifyTicket") {
    const match = mockDb.attendees.find(a => a.token === args[0]);
    if (!match) return { success: false, code: "NOT_FOUND", message: "無效的 QR Code Token" };
    const attendeePayload = {
      name: match.name,
      category: match.category,
      ticketType: match.ticketType || (match.category === "校內" ? "校內票" : "校外票"),
      identifier: match.identifier || "-",
      detail: match.detail,
      token: match.token,
      checkInTime: match.checkInTime
    };
    if (match.status === "已入場") {
      return {
        success: false,
        code: "ALREADY_CHECKED_IN",
        message: "已入場，請使用其他入場編號",
        attendee: attendeePayload
      };
    }
    match.status = "已入場";
    match.checkInTime = new Date().toLocaleString();
    attendeePayload.checkInTime = match.checkInTime;
    return {
      success: true,
      message: "核銷成功！歡迎入場",
      attendee: attendeePayload
    };
  }

  if (action === "getStats") {
    const total = mockDb.attendees.length;
    const checkedIn = mockDb.attendees.filter(a => a.status === "已入場");
    const count = (cat, onlyIn) => mockDb.attendees.filter(a => a.category === cat && (!onlyIn || a.status === "已入場")).length;
    return {
      success: true,
      data: {
        totalRegistered: total,
        totalCheckedIn: checkedIn.length,
        totalNotCheckedIn: total - checkedIn.length,
        attendanceRate: Math.round((checkedIn.length / total) * 100),
        campus: { registered: count("校內"), checkedIn: count("校內", true), notCheckedIn: count("校內") - count("校內", true) },
        offCampus: { registered: count("校外"), checkedIn: count("校外", true), notCheckedIn: count("校外") - count("校外", true) },
        recentLogs: checkedIn.map(a => ({ name: a.name, category: a.category, time: a.checkInTime }))
      }
    };
  }

  if (action === "queryAttendee") {
    const q = String(args[0]).toLowerCase();
    const list = mockDb.attendees.filter(a => a.name.includes(q) || a.token.toLowerCase().includes(q) || a.email.includes(q));
    return { success: true, data: list };
  }

  if (action === "getWhitelist") return { success: true, data: mockDb.whitelist };
  if (action === "addWhitelistUser") {
    mockDb.whitelist.push({ email: args[0], name: args[1], role: args[2] });
    return { success: true, message: "新增成功 (測試模式)" };
  }
  if (action === "updateWhitelistUser") {
    const user = mockDb.whitelist.find(u => u.email === args[0]);
    if (user) { user.email = args[1]; user.name = args[2]; user.role = args[3]; }
    return { success: true, message: "更新成功 (測試模式)" };
  }
  if (action === "deleteWhitelistUser") {
    mockDb.whitelist = mockDb.whitelist.filter(u => u.email !== args[0]);
    return { success: true, message: "刪除成功 (測試模式)" };
  }
  if (action === "backfillMissingTokensAndQrCodes") {
    return { success: true, message: "補產生完成 (測試模式)" };
  }

  return { success: false, message: "未知指令" };
}
