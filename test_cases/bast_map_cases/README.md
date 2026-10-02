# BAST 真實地圖測資

本資料夾以專案既有的 `request_payload_bast.json` 為母版，建立多個真實地址情境，方便直接從 Google Maps 導航連結看路線差異。

執行方式：

```bash
python test_cases/bast_map_cases/run_bast_map_cases.py
```

執行後會產生：

- `generated_payloads/*.json`：每個情境實際送給後端的 payload。
- `results_2026-07-16.md`：每個情境的路線順序、時間拆分、延誤與 Google Maps 導航連結。

測資特色：

- 公司固定為 `國立勤益科技大學`，地址固定為 `411030臺中市太平區坪林里中山路二段57號`，且永遠位於 `locations[0]` / `depot_index=0`。
- 使用 `request_payload_bast.json` 的公司與 10 個真實送貨地址。
- 使用 `matrix_cache.json` 中既有 Google 距離矩陣，不會重新打 Google Maps API。
- 每個情境都保留原始 `locations` index，方便對照地圖與前端資料。

目前情境：

| case_id | 測試目的 |
| --- | --- |
| `bast_01_baseline` | 原始 BAST 路線，作為地圖比較基準。 |
| `bast_02_customer_delay` | 送到一半才發現客戶不在，從目前位置重排，延後站點後續仍要配送，最後回公司。 |
| `bast_03_priority_customer` | 固定客戶提高優先權，觀察排序是否提前。 |
| `bast_04_soft_time_window` | 時間窗過短造成必然延誤，確認仍能回傳可執行路線。 |
| `bast_05_in_transit_reroute` | 配送途中重排，排除已完成與取消站點，從目前位置重新規劃，最後仍回原本公司。 |
| `bast_06_flexible_end` | 送完後不強制回公司，從候選休息點中選擇結束地點。 |
