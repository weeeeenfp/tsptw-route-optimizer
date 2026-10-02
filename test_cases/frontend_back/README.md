# frontend_back

收貨流程前端 fixture，來源為專案根目錄的 `request_payload_back.xlsx`。

- 用途：搭配 `?fixture=bast&receive_fixture=back` 測試「送貨 bast、收貨 back」的完整接續流程。
- 格式：欄位與送貨 Excel 一致，時間窗統一為 24 小時制 `HH:MM`。
- 注意：第 1 列是標題列，不是站點；`id=0` 是公司/起訖點，收貨正式站點會排除這列。
- 建議測試 URL：`http://127.0.0.1:3000/index.html?fixture=bast&receive_fixture=back&v=20260628c`。
- 目前實測紀錄：`results_2026-06-28.md`。
