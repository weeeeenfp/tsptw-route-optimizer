# LLM 協作規則與前後端交互格式

本文件給參與本專案的不同 LLM 閱讀，目標是讓負責資料庫、後端、前端、文件或測試的 LLM 在接手後能立刻理解系統邊界、資料格式與協作規則。

本專案採用「合約先行」原則：任何資料庫欄位、API request/response、前端畫面狀態，都必須以本文件與 `README.md` 中定義的資料格式為準。若要更動欄位或語意，必須同步更新文件、測試與範例資料。

## 角色分工

| 角色 | 負責範圍 | 不應直接修改 |
| --- | --- | --- |
| Backend LLM | API、路線求解流程、輸入驗證、Google Maps 串接、演算法整合 | 前端 UI 細節、資料庫 migration 規則 |
| Frontend LLM | 使用者表單、路線結果顯示、延誤提示、API 呼叫、錯誤訊息呈現 | 求解器邏輯、資料庫 schema |
| Database LLM | 資料表、索引、migration、查詢效能、資料保存格式 | API response 語意、前端畫面流程 |
| QA/Test LLM | 單元測試、API 測試、輸入邊界測試、回歸測試 | 未經需求確認的功能改寫 |
| Docs LLM | README、CHANGELOG、API 規格、協作規則 | 程式邏輯與 schema 的未授權更動 |

## 核心規則

1. 合約先行：新增或修改欄位前，先更新本文件的「API 合約」與「資料欄位定義」。
2. 向後相容：除非明確標記 breaking change，不可移除既有欄位。
3. 時間格式一致：前端輸入建議使用 `HH:MM` 或 `HH:MM:SS`，後端驗證後統一轉為秒數。
4. Index 以 `locations` 陣列順序為準：`route_indices`、`depot_index`、`start_index`、`end_index` 都指向 `locations` 的陣列 index，不是資料庫 ID。
5. DB ID 與 route index 不可混用：資料庫主鍵可叫 `id` 或 `location_id`，但演算法用的順序必須明確叫 `location_index` 或 `route_index`。
6. Google Maps 導航網址每段最多 10 個點，前端不可假設只有一個導航 URL。
7. 軟性時間窗開啟時，超時不是錯誤；應顯示延誤資訊。
8. `priority` 數字越小越優先，合法值為 1 到 5。
9. 所有 API 錯誤必須可被前端顯示給使用者，不可只回傳堆疊追蹤。
10. 每次改動需更新 `CHANGELOG.md`，若改變使用方式也需更新 `README.md`。

## 目前系統流程

```text
Frontend
    ↓ GET /api/v1/health
    ↓ POST /api/v1/optimize-route
API_main.py
    ↓
core/app_config.py 合併 config 與 payload
    ↓
core/input_validator.py 驗證輸入與上下限
    ↓
core/route_service.py 整理延後配送、優先權、起終點
    ↓
core/google_maps_api.py 取得 time_matrix / distance_matrix
    ↓
core/or_tools_engine.py 或 core/dp_engine.py 求解
    ↓
core/route_service.py 組 response
    ↓
Frontend 顯示路線、延誤、導航網址
```

## API 合約

### Endpoint

```text
POST /api/v1/optimize-route
Content-Type: application/json
```

Health check：

```text
GET /api/v1/health
```

前端啟動後可先呼叫 health check 確認 API 是否可連線。

地址驗證（前端新增訂單時先確認地址可導航）：

```text
POST /api/v1/validate-address
Content-Type: application/json

request:  { "google_maps_api_key": "string | optional", "addresses": ["string", ...] }   # 1–25 筆
response: { "status": "SUCCESS", "data": { "results": [
              { "address": "原輸入", "valid": true/false, "partial_match": bool,
                "formatted_address": "Google 定位地址", "location_type": "ROOFTOP|...",
                "lat": number, "lng": number, "reason": "string | null" } ] } }
```

- 判定規則：Geocoding 查無結果，或首要型別只到行政區/郵遞區號層級（`locality`、`administrative_area_*` 等）→ `valid=false` 並附 `reason`。
- 後端未設定金鑰時回 `{"status":"SKIPPED", ...}`，前端應軟性放行並提示；Geocoding 服務錯誤回 502 `{"status":"ERROR"}`。
- 結果快取在 `geocode_validate_cache.json`（gitignore），同地址不重打 API。

### CORS

前端開發網址必須列在 `config.json` 的 `api_server.cors_allow_origins`。

預設允許：

```json
[
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]
```

若前端改用其他 port，請同步更新 `config.json`，並重新啟動 API。

### Request Schema

```json
{
  "google_maps_api_key": "string | optional",
  "solver": "ortools | dp | optional",
  "solver_timeout_seconds": "integer | optional | 1..300",
  "depot_index": "integer | optional",
  "current_index": "integer | optional",
  "current_time_seconds": "HH:MM | HH:MM:SS | integer | optional",
  "start_index": "integer | optional",
  "end_index": "integer | null | optional",
  "end_candidate_indices": ["integer"],
  "completed_indices": ["integer"],
  "cancelled_indices": ["integer"],
  "skipped_indices": ["integer"],
  "manual_route_indices": ["integer"],
  "constraints": {
    "allow_late_arrival": "boolean",
    "late_penalty_per_second": "integer | 0..1000000",
    "waiting_time_cost_per_second": "integer | 0..1000000",
    "preserve_remaining_order": "boolean",
    "route_order_penalty_per_second": "integer | 0..1000000",
    "route_order_interval_seconds": "integer | 1..86400"
  },
  "priority": {
    "default_priority": "integer | 1..5",
    "priority_interval_seconds": "integer | 1..86400",
    "priority_penalty_per_second": "integer | 0..1000000"
  },
  "service": {
    "default_service_time_seconds": "integer | 0..86400"
  },
  "ortools": {
    "first_solution_strategy": "PATH_CHEAPEST_ARC | PARALLEL_CHEAPEST_INSERTION | LOCAL_CHEAPEST_INSERTION | GLOBAL_CHEAPEST_ARC | AUTOMATIC",
    "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH | GREEDY_DESCENT | SIMULATED_ANNEALING | TABU_SEARCH | AUTOMATIC"
  },
  "locations": [
    {
      "id": "integer",
      "name": "string",
      "address": "string",
      "time_window": ["HH:MM", "HH:MM"],
      "priority": "integer | optional | 1..5",
      "delay_by_seconds": "integer | optional | 0..86400",
      "delay_until_seconds": "HH:MM | HH:MM:SS | integer | optional",
      "rescheduled_time_window": ["HH:MM", "HH:MM"],
      "service_time_seconds": "integer | optional | 0..86400",
      "status": "pending | in_progress | completed | delayed | cancelled | skipped | optional"
    }
  ]
}
```

### Request Example

```json
{
  "solver": "ortools",
  "solver_timeout_seconds": 5,
  "depot_index": 0,
  "start_index": 0,
  "end_candidate_indices": [7, 8, 9],
  "constraints": {
    "allow_late_arrival": true,
    "late_penalty_per_second": 1000,
    "waiting_time_cost_per_second": 1,
    "preserve_remaining_order": true,
    "route_order_penalty_per_second": 20,
    "route_order_interval_seconds": 600
  },
  "priority": {
    "default_priority": 3,
    "priority_interval_seconds": 1800,
    "priority_penalty_per_second": 20
  },
  "service": {
    "default_service_time_seconds": 600
  },
  "locations": [
    {
      "id": 0,
      "name": "公司",
      "address": "台中市...",
      "time_window": ["08:00", "23:59:59"]
    },
    {
      "id": 1,
      "name": "固定客戶 A",
      "address": "台中市...",
      "time_window": ["09:00", "18:00"],
      "priority": 1,
      "service_time_seconds": 300
    },
    {
      "id": 2,
      "name": "臨時延後客戶 B",
      "address": "台中市...",
      "time_window": ["08:00", "10:00"],
      "delay_until_seconds": "11:00"
    }
  ]
}
```

### Success Response Schema

```json
{
  "status": "SUCCESS",
  "data": {
    "total_time_minutes": "number",
    "total_travel_minutes": "number",
    "total_service_minutes": "number",
    "total_elapsed_minutes": "number",
    "total_distance_km": "number",
    "total_lateness_minutes": "number",
    "route_sequence": ["string"],
    "route_indices": ["integer"],
    "route_details": [
      {
        "order": "integer",
        "index": "integer",
        "active_index": "integer | optional",
        "name": "string",
        "arrival_time_seconds": "integer | null",
        "service_start_time_seconds": "integer | null",
        "waiting_time_seconds": "integer",
        "waiting_time_minutes": "number",
        "service_completion_time_seconds": "integer | null",
        "original_time_window": ["integer", "integer"],
        "effective_time_window": ["integer", "integer"],
        "service_time_seconds": "integer",
        "charged_service_time_seconds": "integer",
        "lateness_seconds": "integer",
        "priority": "integer",
        "delay": {
          "delay_by_seconds": "integer",
          "delay_until_seconds": "integer | string | null",
          "effective_start_seconds": "integer"
        }
      }
    ],
    "driver_navigation_urls": ["string"],
    "selected_start_index": "integer",
    "selected_end_index": "integer",
    "reoptimization": {
      "mode": "full_route | in_transit",
      "current_index": "integer",
      "active_indices": ["integer"],
      "remaining_delivery_indices": ["integer"],
      "removed_indices": ["integer"],
      "completed_indices": ["integer"],
      "cancelled_indices": ["integer"],
      "skipped_indices": ["integer"],
      "no_remaining_deliveries": "boolean | optional"
    }
  }
}
```

### Error Response Schema

```json
{
  "status": "ERROR | FAILED",
  "message": "string"
}
```

語意：

| status | 使用情境 | 前端建議 |
| --- | --- | --- |
| `SUCCESS` | 成功取得路線 | 顯示路線、站點明細與導航網址 |
| `ERROR` | 輸入格式、API key、Google Maps 或系統資料錯誤 | 顯示可修正錯誤 |
| `FAILED` | 求解器找不到路線 | 提示調整時間窗、開啟軟性時間窗或延長 timeout |

## 資料欄位定義

### 時間

前端顯示與輸入：

```text
HH:MM 或 HH:MM:SS
```

後端與資料庫儲存建議：

```text
seconds_from_day_start integer
```

合法範圍：

| 欄位 | 範圍 |
| --- | --- |
| `time_window` 秒數 | 0 到 86399 |
| `delay_by_seconds` | 0 到 86400 |
| `delay_until_seconds` | 0 到 86399 |
| `service_time_seconds` | 0 到 86400 |
| `current_index` / `completed_indices` / `cancelled_indices` / `skipped_indices` | 0 到 `locations.length - 1` |

#### 出發時間語意（2026-08-14）

起點（`start_index`，未指定時為 `depot_index`）**一定在自己時間窗的開始時刻出發**，兩個求解器一致：

- 初始路線：出發時間＝`locations[depot].time_window[0]`（前端寫入畫面上的「預計出發時間」）。
- 途中重排：出發時間＝`current_time_seconds`（後端會把目前站的有效時間窗改成 `[t, t]`）。
- 回傳的起點 `arrival_time_seconds` / `service_completion_time_seconds` 因此等於該時刻，前端可直接顯示。

OR-Tools 這邊由 `or_tools_engine._pin_departure_time()` 把 `routing.Start(0)` 的 Time 累計值鎖在該時刻；
不鎖的話，Time 維度對等待時間收費（`SetSlackCostCoefficientForAllVehicles`）而起點時間窗上界是一整天，
求解器會自行延後出發把等待成本歸零（設 07:30 卻回 08:55 出發）。**改動求解器時不可拿掉這個約束**，
並保留起點的 slack（首站時間窗較晚時要靠它等待，否則直接無解）。回歸測試：`tests/test_departure_time.py`。

### 地點 index

`locations` 陣列順序是演算法 index：

```json
{
  "locations": [
    {"id": 100, "name": "公司"},
    {"id": 205, "name": "客戶 A"}
  ]
}
```

此時：

```text
公司 index = 0
客戶 A index = 1
```

即使資料庫 ID 是 `100` 或 `205`，`route_indices` 仍回傳 `[0, 1, 0]`。

## 前端協作規則

Frontend LLM 必須遵守：

1. 表單時間輸入使用 24 小時制，不提供 `25:00`、`24:00` 之類選項。
2. 開發時先呼叫 `GET /api/v1/health` 檢查 API 是否可連線。
3. 若使用時間選擇器，送 API 前格式化為 `HH:MM` 或 `HH:MM:SS`。
4. 至少要有 2 個正式地點。`delivery` 與 `receiving` 都不設硬性站點上限，25 點內只是建議適用規模；超過時應依站數提高 `solver_timeout_seconds`。途中重排可額外加入 1 個 `virtual_current_position=true` 的虛擬目前位置作為起點。
5. `priority` UI 建議使用 1 到 5 的選項，不使用自由輸入。
6. 導航按鈕要支援多個 `driver_navigation_urls`。
7. 若 `total_lateness_minutes > 0`，結果頁需要明顯顯示延誤摘要。
8. `route_details` 應顯示每站抵達時間、延誤與有效時間窗。
9. 若要支援上下貨/等待時間，前端只負責蒐集欄位並轉成秒數，不在前端重新計算路線。
10. 途中重排時，前端應送完整 `locations`、`current_index`、已完成/取消/跳過 index，以及最新延後或等待時間。
11. 不要自行重新排序 API 回傳的 `route_indices`。
12. 不要把資料庫 ID 當作 route index。
13. 若 API 回 `ERROR` 或 `FAILED`，顯示 `message`，並保留使用者輸入方便修改。

### 前端 v2 實際送出 / 接收的欄位（2026-06-17 重寫）

前端為「後端驅動」：除了「司機手動拖曳順序時自建導航連結」外，不做任何路由/ETA/逾時計算。所有呼叫共用同一函式 `runOptimize()`，每次都送**完整 `locations`（原始順序）**。

**前端送出（request）**

| 欄位 | 何時 | 來源 / 規則 |
| --- | --- | --- |
| `google_maps_api_key` | 每次 | Maps Key 欄位（`AIza…`）；空則省略（用後端設定） |
| `operation_type` | 每次 | 送貨為 `"delivery"`、收貨為 `"receiving"`；兩者都無硬性站點上限，此欄位用來區分行程種類與前端顯示。 |
| `solver` = `"ortools"`、`solver_timeout_seconds` | 每次 | 預設 timeout 5 |
| `depot_index` = 0 | 每次 | locations[0] 為公司/起點 |
| `current_time_seconds` | **僅途中重排** | 完成/回報時送目前時間。**初始路線不送**（出發時間改寫進 depot `time_window` 起點；初始就送會被當成途中重排而求不出解）。 |
| `ortools.{first_solution_strategy, local_search_metaheuristic}` | 每次 | 管理員區，預設 PATH_CHEAPEST_ARC + GUIDED_LOCAL_SEARCH |
| `end_index` = 0 **或** `end_candidate_indices` | 每次 | 回公司休息／自訂休息點（休息點附加為 locations） |
| `service`、`constraints` | 選用 | 管理員區填寫；**留空＝省略，沿用後端 config.json** |
| `current_index` / `completed_indices` / `cancelled_indices` / `skipped_indices` | 途中 | 由各站 `status` 推導；有任一非空即視為途中重排 |
| `manual_route_indices` | **只在「✓ 完成調整」時** | 手動調整後的剩餘站點順序（原始 index，不含起點/終點）。送出後後端固定照此順序算時間；編輯期間的每一次 ▲▼／拖曳都不打 API |
| `locations[].{id,name,address,time_window}` | 每次 | `time_window` 為 `["HH:MM","HH:MM"]` |
| `locations[].rescheduled_time_window` | 改約站 | 延後/提前/改營業時間，覆蓋有效時間窗 |
| `locations[].status` | 非 pending | `completed`/`delayed`/`cancelled`/`skipped`/`in_progress` |
| `locations[].priority`、`locations[].service_time_seconds` | 有才送 | 來自 Excel 欄位；沒有就不送（用後端預設） |

不送：`delay_by_seconds`、`delay_until_seconds`（改用 `rescheduled_time_window`）。

**前端接收並顯示（response.data）**

`total_travel_minutes`(行駛；缺則 fallback `total_time_minutes`)、`total_elapsed_minutes`(總耗時)、`total_distance_km`、`route_indices`(原始 index)、`route_details[].{arrival_time_seconds, lateness_seconds, waiting_time_minutes}`、`driver_navigation_urls`、`selected_start_index`/`selected_end_index`、`reoptimization`、`solver_metadata`。逾時與抵達一律以 `route_details` 為準，前端不自行判定。

### 前端部署 / 環境

- 前端為純靜態（`index.html` 介紹首頁 + `app.html` 系統主頁 + `app.js` + `style.css`，無建置）。須從 CORS 白名單來源開啟（`http://127.0.0.1:5173` 或 `:3000`），不可用 `file://`。
- 資源以 `?v=` 版本號破壞快取；更新後請硬重新整理（Ctrl+F5）。
- 後端若更新欄位（如 `rescheduled_time_window`、`total_travel_minutes`），需**重新部署**才會生效；前端對缺欄位已 graceful fallback。

## 後端協作規則

Backend LLM 必須遵守：

1. 所有輸入必須先經過 `core/input_validator.py`。
2. 新增 request 欄位時，必須同步更新：
   - `README.md`
   - `LLM_COLLABORATION_GUIDE.md`
   - `tests/`
   - `CHANGELOG.md`
3. API response 不可移除既有欄位，除非標記 breaking change。
4. 錯誤訊息必須是使用者可理解的文字。
5. 求解器回傳的 index 必須對應原始 `locations` 陣列。
6. Google Maps 導航網址每段最多 10 點。
7. 軟性時間窗不可回傳無解，除非連軟性條件都無法產生路線。
8. 若新增 solver，需在 `core/route_service.py` 的 `SOLVERS` 登錄，並補測試。

## 資料庫協作規則

目前程式尚未正式接資料庫。Database LLM 若要加入資料庫，請先以 API 合約為準，不要直接改 API 欄位語意。

### 建議資料表

#### route_requests

| 欄位 | 型別建議 | 說明 |
| --- | --- | --- |
| `id` | uuid / integer pk | 路線請求 ID |
| `solver` | string | `ortools` 或 `dp` |
| `depot_index` | integer | 預設起終點 index |
| `start_index` | integer nullable | 實際出發 index |
| `end_index` | integer nullable | 實際結束 index |
| `end_candidate_indices` | json | 候選結束點 |
| `allow_late_arrival` | boolean | 是否允許延誤 |
| `late_penalty_per_second` | integer | 延誤懲罰 |
| `created_at` | datetime | 建立時間 |

#### route_request_locations

| 欄位 | 型別建議 | 說明 |
| --- | --- | --- |
| `id` | uuid / integer pk | 資料庫主鍵 |
| `route_request_id` | fk | 對應 route_requests |
| `location_index` | integer | 對應 payload 中 locations 陣列順序 |
| `external_location_id` | integer nullable | payload 中的 `id` |
| `name` | string | 地點名稱 |
| `address` | string | 地址 |
| `time_window_start_seconds` | integer | 最早可抵達秒數 |
| `time_window_end_seconds` | integer | 最晚可抵達秒數 |
| `priority` | integer | 1 到 5 |
| `delay_by_seconds` | integer | 延後秒數 |
| `delay_until_seconds` | integer nullable | 延後到指定秒數 |
| `service_time_seconds` | integer | 服務時間 |

#### route_results

| 欄位 | 型別建議 | 說明 |
| --- | --- | --- |
| `id` | uuid / integer pk | 結果 ID |
| `route_request_id` | fk | 對應 route_requests |
| `status` | string | `SUCCESS` / `FAILED` / `ERROR` |
| `total_time_minutes` | numeric | 行駛加服務時間，供既有前端相容 |
| `total_travel_minutes` | numeric | 純路線行駛時間 |
| `total_service_minutes` | numeric | 實際計入的上下貨/服務時間 |
| `total_elapsed_minutes` | numeric | 經過時間，包含時間窗等待 |
| `total_distance_km` | numeric | 總距離 |
| `total_lateness_minutes` | numeric | 總延誤 |
| `selected_start_index` | integer | 實際起點 |
| `selected_end_index` | integer | 實際終點 |
| `driver_navigation_urls` | json | 導航網址陣列 |
| `raw_response` | json | 完整 API response |

#### route_result_stops

| 欄位 | 型別建議 | 說明 |
| --- | --- | --- |
| `id` | uuid / integer pk | 明細 ID |
| `route_result_id` | fk | 對應 route_results |
| `order` | integer | 路線順序 |
| `location_index` | integer | 地點 index |
| `name` | string | 地點名稱 |
| `arrival_time_seconds` | integer nullable | 抵達秒數 |
| `lateness_seconds` | integer | 延誤秒數 |
| `effective_start_seconds` | integer | 有效開始時間 |
| `effective_end_seconds` | integer | 有效結束時間 |
| `priority` | integer | 優先權 |

### DB 注意事項

1. 資料庫主鍵不可取代 `location_index`。
2. 儲存時間建議使用秒數，前端顯示時再轉回 `HH:MM`。
3. `raw_request` / `raw_response` 可保留完整 JSON，方便除錯與回放。
4. 若加入 migration，需在 PR 中說明 migration 是否可逆。

## GitHub 協作規則

### Branch 命名

```text
feature/<short-name>
fix/<short-name>
docs/<short-name>
test/<short-name>
refactor/<short-name>
```

範例：

```text
feature/db-route-results
docs/api-contract
test/input-validation
```

### Commit 訊息

使用簡短 prefix：

```text
feat: add route result persistence
fix: validate time window upper bound
docs: update api contract
test: add navigation url limit tests
refactor: split route service helpers
```

### PR 必填格式

```markdown
## Summary
- 

## Changed Areas
- [ ] Frontend
- [ ] Backend
- [ ] Database
- [ ] Tests
- [ ] Docs

## API Contract Changes
- [ ] No API contract change
- [ ] Request changed
- [ ] Response changed
- [ ] Error behavior changed

## Database Changes
- [ ] No DB change
- [ ] Migration added
- [ ] Migration tested

## Validation
- [ ] `python -m unittest discover -s tests`
- [ ] `python scripts/run_routing.py`
- [ ] Manual API test

## Notes for Other LLMs
-
```

## 前端交接紀錄

### 2026-06-15：每站上下貨/等待時間

後端方向：

- 後端會提供全域預設 `service.default_service_time_seconds = 600`，代表每站預設上下貨/服務時間 10 分鐘。
- 單一站點如果有特殊等待、簽收、卸貨需求，可在 `locations[].service_time_seconds` 覆蓋預設值。
- `service_time_seconds` 單位固定是秒，合法範圍是 0 到 86400。
- 後端 `route_details[]` 會回傳每站實際採用的 `service_time_seconds`，前端可選擇顯示或用於除錯。
- 出發點不計上下貨/服務時間；如果最後只是回到原點，也不計服務時間。
- API 會回傳 `total_travel_minutes` 與 `total_service_minutes`，前端應分開顯示路線行駛與上下貨/等待。
- `route_details[].charged_service_time_seconds` 是該站本次路線實際計入的服務時間；出發點與回原點通常為 0。

建議前端 LLM 調整方向：

- Excel/CSV 欄位對應可新增可選欄位，例如 `service_time_seconds`、`服務時間秒數`、`上下貨時間秒數`。
- 如果使用者資料沒有填服務時間，建議不要送該站 `service_time_seconds`，讓後端套用 `config.json` 的 600 秒預設值。
- 如果 UI 讓使用者輸入「分鐘」，送 API 前必須轉成秒數，例如 10 分鐘送 `600`。
- 結果頁若要顯示站點設定值，資料來源可用 `route_details[].service_time_seconds`；若要顯示本次路線實際計入時間，資料來源應使用 `route_details[].charged_service_time_seconds`。
- 若要顯示總結，建議使用 `total_travel_minutes` 顯示「路線行駛時間」，用 `total_service_minutes` 顯示「上下貨/等待時間」。
- 前端不串接資料庫（2026-07-12 起 Supabase 整合已移除）；配送狀態只存在前端記憶體與後端回應，若未來要持久化請先依「資料庫協作規則」提案。
- 不要改變 `route_indices`、`locIdx`、`locId` 的語意；路線順序仍以後端回傳的陣列 index 為準。

### 2026-06-15：配送途中事件與剩餘路線重排

後端方向：

- 後端支援 `current_index`，代表司機目前所在地點 index；途中重排時會以此作為新的起點。
- 後端支援 `completed_indices`、`cancelled_indices`、`skipped_indices`，這些站點會從本次重排中排除。
- 站點也可直接帶 `status`：`completed`、`cancelled`、`skipped` 會排除；`pending`、`in_progress`、`delayed` 仍會參與重排。
- 後端會先用 active locations 求解，再把 `route_indices` 映回原始 `locations` index。前端不可用過濾後 index 覆蓋原始 index。
- 回傳 `data.reoptimization` 供前端顯示目前重排狀態；`route_details[].active_index` 只供除錯，不應取代 `index`。

建議前端 LLM 調整方向：

- 司機按下「重新排程」時，送完整 `locations`，不要只送剩餘站點，避免 index 對不上。
- 本地狀態中已送達的站點整理成 `completed_indices`；取消配送整理成 `cancelled_indices`；本輪跳過整理成 `skipped_indices`。
- 客戶要求延後時，更新該站 `delay_until_seconds` 或 `delay_by_seconds` 後再送重排。
- 客戶等待/簽收時間改變時，更新該站 `service_time_seconds`。
- 客戶優先順序改變時，更新該站 `priority`。
- 重排成功後，以新的 `route_indices` 與 `route_details` 更新剩餘站點順序；已完成站點仍保留在歷史紀錄，不放回待送清單。
- 若回傳 `reoptimization.no_remaining_deliveries = true`，代表本輪已無剩餘配送點，前端可顯示「剩餘配送已完成」。

### 2026-06-17：前端 API 使用流程與途中貨態更新

後端方向：

- API request model 已支援 `current_time_seconds` 與 `locations[].rescheduled_time_window`，前端送出的途中重排時間與改約時間窗會被保留並進入求解流程。
- API 錯誤回傳維持 HTTP 400 或 500，但 body 固定使用 `{ "status": "ERROR" | "FAILED", "message": "..." }`，前端可統一讀 `message` 顯示。
- 前端每次呼叫 `/api/v1/optimize-route` 都應送完整 `locations`，不要只送剩餘站點；後端會自行依狀態排除已完成、取消或跳過的站。
- `current_index` 表示司機當下所在位置。若司機剛完成某站並準備重排，建議把 `current_index` 設為剛完成的站點 index，並把該站加入 `completed_indices` 或標記 `status="completed"`。
- `current_time_seconds` 表示重排發生當下時間，例如 `"14:20"`。後端會把目前位置鎖定在這個時間開始重新計算。
- 客戶臨時不在家且重新約定可收貨時間時，前端應更新該站 `rescheduled_time_window`，例如 `["15:30", "17:00"]`；不要只用「延後幾分鐘」推估結束時間。
- `delay_by_seconds`、`delay_until_seconds` 仍保留相容，但新功能優先使用 `rescheduled_time_window`。
- 若只是單站上下貨、簽收或現場處理時間變長，更新該站 `service_time_seconds`；若是必須等客戶營業時間，使用時間窗或 `rescheduled_time_window`。

前端建議流程：

1. 初次排程：送完整 `locations`，`depot_index=0`，通常 `start_index` 可省略或設為 0，`end_index=0` 表示最後回公司。
2. 司機出發後：前端保存原始 `locations` 陣列順序，不要因畫面排序而改變 index。
3. 每送完一站：把該站加入 `completed_indices`，或把 `locations[i].status` 設為 `"completed"`。若只是照後端預估完成時間完成，前端可只更新本地狀態，不必重排；若完成時間早於或晚於預估完成時間，再同時送 `current_index=i` 與 `current_time_seconds` 重排。
4. 客戶臨時不在家但稍後可收：該站保留在待配送，設定 `locations[i].status="delayed"` 並填 `locations[i].rescheduled_time_window=["HH:MM","HH:MM"]`。若司機已在該站，前端會在 payload 尾端加入同地址且 `virtual_current_position=true` 的虛擬目前位置，並把 `current_index` 指向虛擬點；原始延後站仍作為未來配送點。
5. 客戶取消：把該站加入 `cancelled_indices`，或設 `status="cancelled"`。
6. 本輪暫時不送：把該站加入 `skipped_indices`，或設 `status="skipped"`。
7. 道路或現場事件造成現在位置改變：若目前位置是既有站點，用該站 index 當 `current_index`；若是非既有點，前端需先把目前位置新增到 `locations`，再用新 index 當 `current_index`。
8. 重排成功後：用 `data.route_indices` 更新剩餘配送順序，用 `data.route_details` 顯示每站到站、等待、開始下貨、完成、延誤；不要自行重新排序。

### 2026-06-27：前端 BAST 途中配送狀態機

目前前端 `app.js` 的實作狀態：

- `fixture=bast` 會讀取 `test_cases/frontend_bast/bast.json`，以 `samples/request_payload_bast.json` 的真實地址做前端測試；公司固定為「國立勤益科技大學」（`411030臺中市太平區坪林里中山路二段57號`），並由前端加入 `locations[0]`。
- 配送管理頁提供 `目前測試時間`，預設 `09:00`，用於模擬司機從早上 9 點開始配送。
- 每張配送卡顯示後端 `route_details` 的 `arrival_time_seconds`、`service_start_time_seconds`、`service_completion_time_seconds`、`waiting_time_minutes` 與 `lateness_seconds`。
- 正常照預估完成時間送達：前端只更新 `S.loc[i].status="completed"`、`deliveredAtTime` 與畫面，不呼叫後端。
- 完成時間被手動改早或改晚：前端呼叫後端，送 `current_index=i`、`current_time_seconds=測試完成時間`、`completed_indices`。
- 延後/改約：前端送 `status="delayed"` 與 `rescheduled_time_window=[新開始, 新結束]`，並新增同地址且 `virtual_current_position=true` 的虛擬目前位置作為 `current_index`。這可避免同一原始站點同時是 current start 與未來待配送點時被路線起點規則隱藏。
- 取消/跳過：前端送 `status="cancelled"` 或 `status="skipped"`，並可把該站作為 `current_index`；後端會排除 terminal stop 並保留目前位置起點。
- 復原：前端把站點改回 `pending` 後不送 `current_index`，避免復原站被視為起點而從待配送清單消失。
- BAST 前端測試紀錄放在 `test_cases/frontend_bast/results_2026-06-27.md`。

若後端未來原生支援同一原始站點同時作為起點與未來配送點，前端的虛擬目前位置 workaround 可以重新評估。

### 2026-07-12：手動新增訂單

前端新增「➕ 新增訂單」功能（純前端，API 合約不變）：

- 入口：訂單上傳頁（免 Excel 可直接建單）、送貨資料預覽列、送貨／收貨管理頁；收貨行程開始後也可新增收貨點。
- 手動訂單寫回 `S.raw`（與 Excel 同一份資料源），欄名沿用 `COLS` 可辨識欄名；Excel 缺少的選填欄位會自動補欄位再寫入，維持「所有排程都從同一份 locations 原始順序出發」的原則。
- 訂單 ID 自動編號＝現有最大 ID + 1（排除 990000+ 的虛擬點），因此依 id 排序後新訂單必定在清單尾端，已排程時直接 `S.loc.push()` 不會動到既有站點 index。
- 已排程／途中新增會自動觸發 `runOptimize()` 重排：途中（有任一站點非 pending）會先切到送貨管理頁避免在上傳頁重建 `S.loc` 遺失狀態，並帶目前時間；後端失敗時自動撤回該筆訂單，避免畫面與路線不同步。
- 服務時間輸入單位為分鐘，寫入資料與 payload 前轉為秒；0 或留空視為未填（沿用後端預設），與 Excel 匯入規則一致。

### 2026-06-28：送貨最終站與收貨行程目前規則

已定案需求：

- 出發前最多上傳兩份 Excel：送貨 Excel 與收貨 Excel；沒有收貨 Excel 時就是只送貨，不存在只收貨流程。
- 收貨一定接在送貨後；送貨完成後進入收貨準備，再由司機按「開始收貨」。
- 收貨 Excel 欄位先與送貨 Excel 一致，保留時間窗與優先度；每站未指定服務時間時預設停留 600 秒。
- 收貨有軟性時間窗，允許逾時並找延誤較少的解。
- 收貨不處理 LIFO、車容量與掃碼。
- 送貨最終站由使用者在排程前選擇：`回公司`、`從送貨點挑選備選`、`讓系統推薦`。
- 手動挑選可從送貨點勾選多個備選休息點；手動與系統推薦都使用 `end_candidate_indices`，差別是手動候選為使用者勾選清單，系統推薦為全部送貨點，不串 Google Places。
- 使用者選擇後才顯示定案最終站；若選系統推薦，後端回傳 `selected_end_index` 後前端寫入 `S.ui.finalEndIndex`。
- 收貨終點固定回公司；收貨起點使用已定案的送貨最終站。
- 收貨準備只顯示收貨起點、建議最晚出發時間、預估行駛、預估總耗時、逾時風險與「開始收貨」按鈕。
- 建議最晚出發時間目前取所有收貨點最早關閉時間前 30 分鐘。

目前前端實作：

- `S.receive` 保存收貨 Excel、推薦方案與送貨快照。
- `receive_fixture=` 可在本機測試時載入既有 fixture 作為收貨資料；正式操作仍可用收貨 Excel input。
- `endpoint()` 依 `S.ui.endMode/manualEndIndices/finalEndIndex` 產生 `end_index` 或 `end_candidate_indices`。
- 送貨 `runOptimize()` 成功且有收貨資料時，`prepareReceivingPlan()` 使用 `currentFinalStop()` 作為收貨起點，呼叫後端試算「收貨起點 -> 收貨點 -> 公司」。
- 若最終站本身是送貨點，該站仍必須顯示在送貨清單與時間軸，且後端應計入該站服務時間；不能把 route 最後一點一律視為純終點。
- 司機按 `startReceiving()` 後，前端切到 `receiving` mode，以收貨起點為 `start_index/current_index`、目前時間為 `current_time_seconds`、`end_index=0` 重新排程；同時會把收貨起點本身的 `time_window` 鎖定為目前時間，讓收貨 ETA 從司機按下開始收貨當下起算。
- 收貨正式開始後，取消、跳過、改約、還原等共用 `runOptimize()`；此時 payload 必須保留 `start_index=S.receive.plan.restIndex`，避免還原後退回公司或 00:00 類初始時間估算。若是標記收貨完成且實際完成時間造成後續逾時、需要回後端重排，則必須同時送 `current_index=完成站` 與 `current_time_seconds=實際完成時間`，讓下一站 ETA 從現況開始。
- 收送貨標記完成時，若只是實際完成時間早/晚於預估完成時間，且依原路線順序平移後續 ETA 不會造成剩餘站點逾時，前端使用 `applyLocalScheduleShift()` 直接更新 `route_details`，不回後端跑 OR-Tools；若會逾時或跳站才重排。
- `startReceiving()` 使用收貨專用 payload 呼叫後端，不走通用 `runOptimize()`，避免混入送貨已完成狀態或把初始試算結果誤顯示成正式收貨結果。
- 收貨管理沿用同一套卡片狀態處理已收貨、改約、取消、跳過與還原；收貨沒有 LIFO、掃碼、容量限制。

途中重排範例：

```json
{
  "solver": "ortools",
  "depot_index": 0,
  "current_index": 5,
  "current_time_seconds": "14:20",
  "end_index": 0,
  "completed_indices": [1, 2, 3, 4],
  "cancelled_indices": [],
  "skipped_indices": [],
  "constraints": {
    "allow_late_arrival": true,
    "late_penalty_per_second": 1000,
    "waiting_time_cost_per_second": 1,
    "preserve_remaining_order": true,
    "route_order_penalty_per_second": 20,
    "route_order_interval_seconds": 600
  },
  "service": {
    "default_service_time_seconds": 600
  },
  "locations": [
    { "id": 0, "name": "公司", "address": "台中市...", "time_window": ["08:00", "23:59:59"] },
    { "id": 1, "name": "客戶 A", "address": "台中市...", "time_window": ["09:00", "18:00"], "status": "completed" },
    { "id": 2, "name": "客戶 B", "address": "台中市...", "time_window": ["09:00", "18:00"], "status": "completed" },
    { "id": 3, "name": "客戶 C", "address": "台中市...", "time_window": ["09:00", "18:00"], "status": "completed" },
    { "id": 4, "name": "客戶 D", "address": "台中市...", "time_window": ["09:00", "18:00"], "status": "completed" },
    { "id": 5, "name": "目前位置/剛抵達客戶 E", "address": "台中市...", "time_window": ["09:00", "18:00"], "status": "delayed", "rescheduled_time_window": ["15:30", "17:00"] },
    { "id": 6, "name": "客戶 F", "address": "台中市...", "time_window": ["09:00", "18:00"], "status": "pending" }
  ]
}
```

### 2026-08-14：預計出發時間與「出發」按鈕

- **預計出發時間只有一個來源**：訂單上傳頁的 `#depTime`，寫進 `locations[0].time_window[0]`，後端照該時刻出發（見「出發時間語意」）。
- 送貨管理頁原本的「預計出發時間」（`#driverNow`，預設本地時間、改了也不影響排程）已移除，改為 **實際出發時間**：
  - 未出發：顯示「尚未出發」；只有系統管理員看得到可填的時間欄位（預設帶入預計出發時間，供測試指定時刻）。
  - 按「🚚 出發」＝司機離開起點：一般使用者記本地時間、管理員記自填時間；按鈕與欄位隨即鎖住（`S.ui.departedAt`），一趟行程只能按一次。
  - 實際出發時間 ≠ 預計出發時間時，會以 `runOptimize(0, 實際時間)`（起點為目前位置）重新推估後續 ETA；相同則不打 API。
  - 從上傳頁重新排程、結束今日工作會呼叫 `resetDeparture()` 解鎖；「開始收貨」則直接把收貨段的出發時間記為排程基準時間，不需再按一次。
- 管理員測試時鐘改存在 `S.ui.testClock`（不再佔畫面欄位），起始值＝實際出發時間，未出發時退回預計出發時間；`clockHM()` 仍是一般使用者抓本地時間、管理員抓測試時鐘。

### 2026-08-14：手動調整改為按鈕送一次 API

兩處「手動修改路線」原本改一次就打一次 `/optimize-route`（或根本不打），現在統一成**累積變更、按按鈕送一次**：

- **終點／備選休息點**（訂單上傳頁）：`setEndMode()`、`setManualEndCandidate()` 只更新 `S.ui` 與畫面並設 `S.ui.endDirty`，
  由卡片下方的「✓ 套用終點設定」（`applyEndSelection()`）送一次重排。勾五個候選＝一次 API，不是五次。
  尚未排程過時不顯示套用列（本來就要按「送出後端排程」）。
- **時間軸手動調整**（路線 & 堆疊頁）：▲▼／拖曳期間只改 `S.ui.manualOrder` 與畫面；按「✓ 完成調整」（`toggleEditRoute()`）
  才帶 `manual_route_indices` 送一次，**後端照這個順序重算各站抵達/完成時間與導航連結**——先前手動調整完全不進後端，
  站點時間還是舊順序的值。後端失敗時保留手動順序不跳回舊順序。
- 後端：`manual_route_indices` 經 `input_validator`（index 合法、不可重複）→ `_apply_in_transit_state` 換算成剩餘站點 index →
  `_manual_order_precedence_pairs()` 轉成相鄰的 `time(前) <= time(後)` 約束交給 OR-Tools。**DP 引擎不支援此欄位**（會忽略而自行最佳化）。
  回歸測試：`tests/test_manual_route_order.py`。
- 新增 request 欄位務必同步 `API_main.RoutingRequest`，否則 Pydantic 會在進 `route_service` 前就把欄位丟掉。

## LLM 接手前檢查清單

每個 LLM 開始工作前先閱讀：

1. `README.md`
2. `CHANGELOG.md`
3. `LLM_COLLABORATION_GUIDE.md`
4. 相關程式檔案
5. `tests/`

開始改動前先回答：

- 我要改的是前端、後端、資料庫、測試還是文件？
- 是否會改 API request 或 response？
- 是否會改資料庫 schema？
- 是否需要新增測試？
- 是否需要更新 README 或 CHANGELOG？

## 禁止事項

- 不可偷偷改變 `route_indices` 的語意。
- 不可讓前端直接依照資料庫 ID 排路線。
- 不可讓 Google Maps 單段導航網址超過 10 點。
- 不可忽略 API 回傳的 `driver_navigation_urls` 陣列。
- 不可新增欄位卻不更新文件。
- 不可新增輸入限制卻不新增測試。
- 不可把 API key 寫進 GitHub 公開 repo。

## 建議給 LLM 的工作提示格式

之後開 issue 或交給新 LLM 時，建議使用以下格式：

```markdown
### Task
請修改/新增什麼功能？

### Scope
- Frontend:
- Backend:
- Database:
- Tests:
- Docs:

### API Contract
Request 是否改變：
Response 是否改變：
錯誤格式是否改變：

### Data Rules
時間格式：
index 語意：
Google Maps 限制：

### Acceptance Criteria
- [ ] 
- [ ] 

### Validation Commands
```bash
python -m unittest discover -s tests
python scripts/run_routing.py
```
```
