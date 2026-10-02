# 測資包說明

本資料夾集中放置可重跑的後端測資。每份測資都在 `payloads/`，格式包含：

- `case_id`：測資代號。
- `title`：測試名稱。
- `purpose`：這份測資要刻意測的情境或限制。
- `payload`：送給後端 `/api/v1/optimize-route` 的資料。
- `mock_matrix`：成功求解案例使用的假距離/時間矩陣設定，避免測試時呼叫 Google Maps API。
- `expected`：本案例預期結果，供 runner 自動判斷。

執行方式：

```bash
python test_cases/run_test_cases.py
```

目前測資涵蓋：

| 測資 | 目的 |
| --- | --- |
| `01_minimum_valid_route.json` | 觸碰最小配送點限制，確認 2 點可成功求解。 |
| `02_maximum_25_locations.json` | 25 點（建議適用規模）可成功求解。 |
| `03_soft_time_window_lateness.json` | 測試軟性時間窗，確認超時不會直接無解。 |
| `04_in_transit_reoptimization.json` | 測試配送途中從目前位置重排，排除已完成/取消站點。 |
| `05_no_remaining_deliveries.json` | 測試已無剩餘配送點時仍回傳成功狀態。 |
| `06_large_scale_32_locations.json` | 送貨無硬性站點上限，確認 32 個地點仍可通過驗證並求出完整路線。 |
| `07_invalid_24_hour_time.json` | 測試 `24:00` 不被接受，只允許 24 小時制合法時間。 |
| `08_invalid_navigation_limit.json` | 測試 Google Maps 導航單段最多 10 點的限制。 |
| `09_invalid_service_time_limit.json` | 測試服務時間不可超過 86400 秒。 |

最近一次執行結果記錄於 `results_2026-06-16.md`。

## 前端 fixture 測資

除了後端 payload 測資外，目前也有可直接給靜態前端載入的 fixture：

| Fixture | 路徑 | 用途 |
| --- | --- | --- |
| `taiping` | `test_cases/frontend_taiping/taiping.json` | 前端匯入與一般配送流程測試。 |
| `bast` | `test_cases/frontend_bast/bast.json` | BAST 真實地址測資，搭配途中送達、延後、取消、跳過與復原流程測試。 |

前端載入方式：

```text
http://127.0.0.1:3000/index.html?fixture=bast
```

BAST 前端情境測試結果記錄於 `test_cases/frontend_bast/results_2026-06-27.md`。

所有內建 delivery fixture 與後端測資都固定使用「國立勤益科技大學」（`411030臺中市太平區坪林里中山路二段57號`）作為公司 `locations[0]`；fixture 的 `rows` 只放實際配送站。
