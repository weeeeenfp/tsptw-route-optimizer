# LogiOps 前端說明（給其他 LLM / 開發者）

本文件詳細說明 `index.html`（介紹首頁）/ `app.html`（系統主頁）/ `style.css` / `app.js` 這套**純靜態前端**（無框架、無建置步驟），讓其他 LLM 或開發者能快速理解並安全修改。後端契約請以 [`LLM_COLLABORATION_GUIDE.md`](LLM_COLLABORATION_GUIDE.md) 為準；前端**不得**更動求解邏輯或資料庫結構。

---

## 1. 這是什麼

LogiOps 是 TSPTW（有時間窗的旅行推銷員問題）智慧物流排程系統的前端介面，功能：

1. 上傳訂單 Excel/CSV → 解析 → 對應欄位 → 送後端最佳化
2. 顯示最佳路線（時間軸）、貨物裝車順序、統計數據
3. 送貨/收貨管理：司機導航連結、標記送達/收貨、回報異常／改約（自動重新規劃）
4. 手動調整路線順序（前端自建 Google Maps 導航連結）

技術：原生 HTML/CSS/JS + [SheetJS(xlsx)](https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js) CDN。無打包工具，直接用靜態伺服器即可。

---

## 2. 檔案職責

| 檔案 | 內容 |
|------|------|
| `index.html` | **介紹首頁（landing page）**：Hero（左文字＋右路線動畫的兩欄）、使用流程四步驟（每列文字與示意圖左右交錯，偶數列以 `flex-direction:row-reverse` 換邊）、進入系統 CTA。步驟示意圖為 inline SVG 線稿，沿用地圖動畫的單色語彙。900px 以下一律改回上下堆疊。刻意維持精簡，不放痛點／功能／技術架構等長篇介紹。CTA 連到 `app.html`（含 `?fixture=` 範例連結）。獨立頁面、只共用 `style.css` 的設計 tokens，不載入 `app.js`。Hero 下方的衛星俯瞰路線軌道動畫（`.sat`）：底圖為**真實 OSM 路網線稿**，路線以 Dijkstra 沿實際道路計算，兩者由 `scripts/build_landing_map.py` 產生後注入 `<!-- SAT:MAP -->` / `<!-- SAT:STOPS -->` 標記區塊（**標記內的內容請勿手改**，重跑產生器會整段覆蓋）。動畫與互動由頁尾一小段 inline JS 驅動（播放／暫停、點站點釘選查看、鍵盤可操作），車輛位置一律由 `getPointAtLength()` 從路線幾何取得，不另存座標。只用 `--amb` 與灰階單色，並支援 `prefers-reduced-motion`。**首頁刻意不揭露實際地點**：頁面與 HTML 原始碼都不含地名、店名或經緯度，站點只以「第 N 站」與預計抵達時間呈現；要換地區或站點請改產生器內的 bbox 與 `STOPS`。圖資授權：© OpenStreetMap contributors（ODbL），頁面已標示。 |
| `app.html` | 系統主頁版面骨架：Header（連線設定 + 角色切換 + 連線燈）、三個分頁（訂單上傳 / 路線&堆疊 / 送貨或收貨管理）、忙碌遮罩、toast 容器。資源以 `?v=YYYYMMDD` 做快取破壞。品牌 logo 可點回首頁。 |
| `landing_scroll.js` | **首頁專用**的捲動進場動畫。以 `IntersectionObserver` 在元素進入視窗時掛 `.in`（只進場一次，捲回去不重播）；啟動時才在 `<html>` 掛 `.reveal-on`，因此沒有 JS 或不支援時內容維持可見，不會整頁空白。樣式寫在 `index.html`。 |
| `cursor_glow.js` | 游標光暈拖曳的背景效果，首頁與系統頁共用。兩層光暈以不同追隨速度跟著游標，落差即拖曳感；固定在 `z-index:-1` 只出現在頁面底色上，`pointer-events:none` 不攔截點擊。觸控裝置與 `prefers-reduced-motion` 不啟用。 |
| `style.css` | **淺色主題**設計變數（`:root` tokens）與所有元件樣式。所有顏色一律取自 token，元件內不得寫死色碼；強調色另備 `--amb-rgb` 等通道值供 `rgba(var(--amb-rgb),a)` 使用，強調色當底色時前景字色用 `--on-accent`。 |
| `app.js` | 全部邏輯：狀態、Excel 解析、欄位對應、呼叫後端、渲染、ETA 計算、異常重規劃、手動調整、角色切換、健康檢查。 |
| `start-frontend.bat` | Windows 一鍵啟動：在 `127.0.0.1:5173`（後端 CORS 白名單內）啟動靜態伺服器並開瀏覽器。 |

---

## 3. 如何執行（重要：CORS 與來源限制）

後端 CORS 白名單只允許這些來源（見 `config.json` 的 `api_server.cors_allow_origins`）：
`http://localhost:3000`、`http://127.0.0.1:3000`、`http://localhost:5173`、`http://127.0.0.1:5173`

因此前端**必須**從上述其中一個 origin 開啟，瀏覽器的跨來源 `fetch` 才會被授權：

```bash
# 在專案資料夾
python -m http.server 5173          # 或雙擊 start-frontend.bat
# 開 http://127.0.0.1:5173 （介紹首頁）→「🚀 進入系統」→ app.html
```

- ❌ **不要用 `file://`（雙擊 HTML）開啟** → origin 變成 `null`，被 CORS 擋掉，前端會顯示「離線」。
- 部署到其他網域時，須把該網域加進後端 `cors_allow_origins` 並重新部署。
- 更新檔案後若沒看到變化：**強制重新整理（Ctrl+F5）**，或調高 `app.html` 中資源的 `?v=` 版本號（瀏覽器會快取舊的 `app.js`）。

預設後端（API Base）：`https://tsptw.onrender.com`（Render 免費方案，閒置後首次喚醒約 30–60 秒；載入時會 `pingHealth()` 預熱）。

---

## 4. 兩種角色（介面切換）

Header 右上的按鈕 `toggleRole()` 切換 `body` 的 `role-user` class：

- **🛠 系統管理員（預設）**：顯示全部，含 API Base / Maps Key / 逾時 / 演算法策略 / solver_metadata / 站點技術資訊。
- **👤 一般使用者**：隱藏所有 `.admin-only` 元素（連線與設定），但**保留連線狀態燈號（`#dot`）**。

加新的「僅管理員可見」元素時，掛上 `class="admin-only"` 即可（JS 動態渲染的技術資訊可改用 CSS：`body.role-user .你的class{display:none}`，例如 `.dc-cid`）。隱藏的輸入欄位仍存在於 DOM，`getElementById().value` 照常可讀，功能不受影響。

---

## 5. 後端 API 契約（前端怎麼用）

### 端點
- `POST /api/v1/optimize-route`（**連字號**，非底線）
- `GET /api/v1/health` → `{"status":"OK"}`

### 送出（request）
```jsonc
{
  "google_maps_api_key": "AIza…",        // 空字串時省略，後端用自己的設定
  "operation_type": "delivery",          // 送貨 delivery；收貨 receiving（兩者皆無 25 點硬上限）
  "solver_timeout_seconds": 5,            // 求解上限；前端預設 5（重新規劃時上限壓到 15）
  "depot_index": 0,                       // 起訖點＝locations[0]
  "ortools": {                            // 可選；省略則用後端預設策略
    "first_solution_strategy": "PARALLEL_CHEAPEST_INSERTION | PATH_CHEAPEST_ARC | LOCAL_CHEAPEST_INSERTION | GLOBAL_CHEAPEST_ARC | AUTOMATIC",
    "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH | GREEDY_DESCENT | SIMULATED_ANNEALING | TABU_SEARCH | AUTOMATIC"
  },
  "locations": [
    { "id": 0, "name": "公司", "address": "…", "time_window": ["00:00","23:59"] }
    // time_window 一律送 ["HH:MM","HH:MM"] 字串（後端會轉成秒）
  ]
}
```

### 回傳（response.data）
```jsonc
{
  "status": "SUCCESS",
  "data": {
    "total_time_minutes": 120.9,          // 行駛時間（不含服務）
    "total_elapsed_minutes": 140.5,       // 含服務時間總耗時
    "total_distance_km": 33.17,
    "total_lateness_minutes": 0.0,        // 0＝全部準時
    "route_sequence": ["公司","客戶A","公司"],
    "route_indices": [0, 1, 0],           // ★ locations[] 的「陣列索引」，不是 location.id
    "route_details": [ /* 每站明細，可能為 [] */ ],
    "driver_navigation_urls": ["https://www.google.com/maps/dir/?…"],
    "selected_start_index": 0,
    "selected_end_index": 0,
    "solver_metadata": { "solver":"ortools", "first_solution_strategy":"…", "local_search_metaheuristic":"…" },
    "reoptimization": { "mode":"full_route|in_transit", "current_index":0, "removed_indices":[…], … }
  }
}
```

> ⚠️ **最常見的雷**：`route_indices` 是 `locations[]` 的**陣列索引**，不是 `location.id`。前端用 `S.locations[locIdx]` 取站點（見 `buildStops()`），**不要**用 `.find(l => l.id === locIdx)`。

### 後端原生支援的「中途例外」欄位（目前前端已直接使用）
後端 `optimize-route` 接受 `current_index` / `current_time_seconds` / `completed_indices` / `cancelled_indices` / `skipped_indices` / 每站 `status` / `rescheduled_time_window`，會自動排除已完成、取消或跳過的站，並把回傳索引映回原始 `locations` index。

目前前端不再自行重建 locations 子集；每次後端重排都送完整 `locations`，並保持原始陣列順序。例外：

- 正常照預估完成時間送達：只更新本地狀態，不重打 API。
- 完成時間被手動改早或改晚：先用 `applyLocalScheduleShift()` 依既有路線順序平移後續 ETA；若不造成剩餘站點逾時，前端直接更新時間，不打後端。若會逾時或司機跳站，才送 `current_index`、`current_time_seconds` 與 terminal index 清單重排。
- 收貨模式下，若標記收貨完成的實際時間需要回後端重排，前端仍必須送 `current_index=完成站` 與 `current_time_seconds=實際完成時間`，讓下一站 ETA 從司機現況重算。
- 延後/改約：送 `status="delayed"` 與 `rescheduled_time_window`，並另外在 payload 尾端加入同地址、`virtual_current_position=true` 的「虛擬目前位置」作為 `current_index`；原始延後站仍保留為未來配送點。
- 取消/跳過：送 terminal status，並可用該站作為 `current_index`。
- 復原 pending：不送 `current_index`，讓該站重新回到完整路線；收貨模式下仍需保留 `start_index=S.receive.plan.restIndex`。

### 送貨最終站（收貨起點）

送貨完成後的最終站由使用者在上傳區明確選擇：

- `回公司`：payload 使用 `end_index=0`。
- `從送貨點挑選備選`：使用者可從送貨點勾選多個備選休息點，payload 使用 `end_index=null` 與 `end_candidate_indices=[使用者勾選的送貨點 indices]`，後端從候選清單挑出 `selected_end_index` 後前端寫入 `S.ui.finalEndIndex` 定案。
- `讓系統推薦`：payload 使用 `end_index=null` 與 `end_candidate_indices=[全部送貨點 indices]`，後端回傳 `selected_end_index` 後前端寫入 `S.ui.finalEndIndex` 定案。

若最終站本身是送貨點，該站仍是需要服務的送貨站，不能從 `orderedStops()` 排除。只有公司、虛擬目前位置、收貨起點這類控制點才是純終點。

---

## 6. 前端狀態模型（`app.js` 的 `S`）

```js
const S = {
  raw: [],          // 解析後的 Excel/fixture 列
  headers: [],      // 欄名
  colMap: {},       // 系統欄位 → 欄名
  loc: [],          // 完整 locations，固定原始順序；每站可帶 status/rescheduled_time_window/service_time_seconds
  resp: null,       // 後端回傳的 data{}
  receive: {        // 收貨 Excel 與推薦方案
    raw: [],
    headers: [],
    colMap: {},
    plan: null,
    active: false
  },
  ui: {             // 介面狀態
    mode: "delivery",
    role: "admin",
    endMode: "depot",
    manualEndIndices: [],
    finalEndIndex: null,
    optimizing: false,
    lastAction: null
  }
};
```

畫面顯示列由 `orderedStops()` 依後端 `resp.route_indices` 與 `resp.route_details` 即時整理。路線順序與抵達、等待、開始作業、完成作業、逾時資訊一律以後端回傳為準；文案在送貨模式顯示「卸貨」，在收貨模式顯示「收貨」。

---

## 7. 主要流程

1. **上傳/fixture → 最佳化**：`readXL()` 或 `loadFixtureFromQuery()` 載入資料 → `buildColMap()` 自動對應欄位 → `runOptimize()` 組 payload 並呼叫後端 → `render()` 渲染兩個分頁。
2. **路線分頁**：顯示行駛/總耗時、總里程、配送站點、送達紀錄、`solver_metadata`、路線時間軸與裝車順序。
3. **送貨/收貨管理分頁**：顯示測試時間、下一站預估、最新狀態、Google Maps 導航連結與任務卡片。
4. **正常送達**：`markDone()` 若測試完成時間等於後端預估完成時間，只更新本地狀態並 render，不重打後端。
5. **提前/延後完成**：若測試完成時間不同於預估完成時間，`markDone()` 會先本地平移後續 `route_details`。只有平移後會造成逾時，或使用者跳站完成，才送 `current_index`、`current_time_seconds` 與 `completed_indices` 給後端重排。
6. **異常回報**：`submitReport()` 依類型設定 `delayed/cancelled/skipped`；delayed 使用 `rescheduled_time_window` 與虛擬目前位置，cancel/skipped 使用 terminal status 重排。
7. **手動調整路線**：`toggleEditRoute()` 進入編輯後，時間軸可用 ▲▼／拖曳調整，期間只改畫面與導航連結、不打 API；按「✓ 完成調整」才帶 `manual_route_indices` 送一次後端，由後端依該順序重算 ETA。
8. **收貨接續流程**：若有收貨 Excel，送貨排程完成後 `prepareReceivingPlan()` 會以目前選定的送貨最終站作為收貨起點並試算收貨路線；送貨完成後顯示收貨準備卡，`startReceiving()` 以該收貨起點與目前時間正式開始收貨，並把收貨起點時間窗鎖定為目前時間，終點固定回公司。收貨開始後的後續 `runOptimize()` 必須保留 `start_index=S.receive.plan.restIndex`；標記收貨完成且需後端重排時才另外送完成站作為 `current_index`。

---

## 7.5 介面結構與 UI 慣例（2026-08-14 改版後）

**訂單上傳頁的順序＝實際操作順序**：步驟列 `#upSteps` → 上傳卡 `#uploadCard` → 提示區 `#alertArea` →
排程設定 `#planSettingsCard`（預計出發時間＋最終站合成一張卡）→ 資料預覽 → 收貨預覽 → 管理員卡片（公司地點／進階參數）→
固定動作列 `#ctaBar`。**新增卡片時請維持這個順序**，設定類放預覽之前、管理員專用放最後。

| UI 元件 | 由誰維護 | 備註 |
|---|---|---|
| 已載入檔案列 `#fileChip` / `#recvFileChip` | `renderUploadState()` | 有資料時取代整屏 dropzone；檔名存在 `S.ui.fileName` / `S.ui.recvFileName` |
| 三步驟指示 `#step1~3` | `renderUploadState()` | `.on`＝進行中、`.done`＝完成，狀態由 `S.raw` / `S.resp` 推導 |
| 固定動作列 `#ctaBar`＋`#sendBtn` | `renderUploadState()` | 只在上傳頁且有資料時出現；摘要有 `.cta-full`／`.cta-min` 兩版，窄螢幕用 CSS 切換。顯示時 `body.has-cta` 會把 toast 往上推 |
| 站點卡片 | `cardHTML()` | 地址一行＋`.chip` 橫排（時間窗／預估抵達／卸貨起訖），不再每個欄位佔兩行；每張卡自帶 `stopNavUrl()` 的「🗺 導航」 |
| 優先權徽章 | `priorityTag()` | 只有 `priority < DEFAULT_PRIORITY(3)` 才顯示，預設值不標 |

**UI 慣例**：

- 任何會動到上傳頁狀態（資料、出發時間、終點、換頁）的函式，最後都要呼叫 `renderUploadState()`。
- 新的可點元素不要自己關掉 outline：全域 `:focus-visible` 已提供焦點環，鍵盤操作要看得見。
- 司機會在手機上單手操作：主要動作在 `@media (pointer:coarse)` 下最小高度 44px，新增按鈕請沿用 `.btn` / `.dc-nav`。
- 空狀態一律用 `.empty > .empty-card`，並附一顆帶去下一步的按鈕。
- 頁籤是 `role="tab"` + `aria-selected`（由 `sw()` 同步），對應的 `.view` 是 `role="tabpanel"`；toast 容器 `#toasts` 有 `aria-live="polite"`。
- **手機（`@media(max-width:600px)`）的三條底線**，改版面時請一併顧到：
  ① 頁面不可有橫向捲軸（`document.scrollWidth` 必須等於視窗寬），只有 `.tw` 這類明確可捲的容器例外；
  ② 四個頁籤要在 390px 內排得下（超出時仍會橫捲，但不應該是常態）；
  ③ 貼底的固定元素（`.cta-bar`、`#toasts`）要留 `env(safe-area-inset-bottom)`，否則被 iPhone 的 home indicator 蓋住。
- 桌機專用的「一屏一步」高度（首頁 `.lp-step` 的 `min-height`）在 900px 以下一律歸零；
  堆疊後照撐會在每張卡下方留大片空白。新增這類「撐高度」的樣式時記得補上窄螢幕的歸零規則。

## 8. 慣例與雷區（修改前必讀）

- **`route_indices` 是陣列索引，不是 id**（見 §5）。
- **`time_window` 一律送 `["HH:MM","HH:MM"]` 字串**；內部比較時用 `twEndSec()` 轉秒。
- **CORS**：前端必須從白名單 origin 開啟（§3）。連不上分兩種：`fetch` 拋例外＝離線/CORS（紅燈）；有 HTTP 回應但非 2xx＝後端在線但出錯（綠燈＋顯示 `detail`）。
- **快取**：改檔後用 `?v=` 版本號或 Ctrl+F5，否則瀏覽器吃舊的 `app.js`。
- **重新規劃求解上限**壓在 15s，避免中途回報等太久；初始排程用使用者設定（預設 5s）。
- **忙碌遮罩** `setBusy(on,msg)`：任何較久的後端運算都應包起來，避免使用者以為沒反應。
- 新增「僅管理員」資訊請用 `.admin-only`（§4）。

---

## 9. 快速對照：要改某功能看哪裡（`app.js`）

| 想改什麼 | 函式 |
|---|---|
| 送出 payload / 端點 / 策略 | `buildPayload()`、`runOptimize()`、`solverConfig()` |
| Excel/fixture 轉 locations | `buildLocFromRaw()`、`loadFixtureFromQuery()` |
| 收貨 Excel / 送貨最終站 / 收貨起點 | `readReceiveXL()`、`endpoint()`、`prepareReceivingPlan()`、`startReceiving()` |
| 解析回應 / 建立顯示列 | `orderedStops()`、`makeRow()` |
| 統計、solver_metadata、時間軸 | `renderStats()`、`renderTimeline()`、`fmtHM()` |
| 導航連結、送貨/收貨卡片 | `renderNav()`、`renderList()`、`cardHTML()` |
| 標記送達/收貨、本地時間平移、異常回報 | `markDone()`、`applyLocalScheduleShift()`、`submitReport()`、`revertStop()` |
| 手動調整路線 | `toggleEditRoute()`、`dragStart()`、`dragDrop()`、`buildManualNav()` |
| 上傳頁狀態（檔案列／步驟／固定動作列） | `renderUploadState()` |
| 單站導航連結 / 優先權徽章 | `stopNavUrl()`、`priorityTag()` |
| 測試時間 / 下一站預估 | `renderDriverSim()`、`testClockHM()`、`setTestClock()` |
| 角色切換 | `toggleRole()` + CSS `.admin-only` |
| 連線狀態 / 預熱 | `pingHealth()`、`setDot()`、`setBusy()` |
