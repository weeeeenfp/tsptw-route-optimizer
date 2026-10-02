# Frontend BAST fixture

本資料夾提供前端可直接載入的 BAST 真實地址測資。

使用方式：

```text
http://127.0.0.1:3000/index.html?fixture=bast
```

資料來源：`request_payload_bast.json`。

注意事項：

- 第一列欄位由 JSON `headers` 提供，不會被視為站點。
- 公司由 fixture 的 `company` 欄位固定為「國立勤益科技大學」，不列入 `rows`。
- `rows` 共 10 筆，全部都是實際配送站；送出時前端會將公司加入 `locations[0]`。
- 時間窗皆為 24 小時制字串。
- 前端測試預設出發時間為 `09:00`，由畫面上的出發時間欄位覆蓋 depot 起始時間。
