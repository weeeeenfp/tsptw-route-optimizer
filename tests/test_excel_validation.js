const assert = require('node:assert/strict');
const { parseTimeValue, validateRows } = require('../excel_validation.js');
const COMPANY_NAME = '國立勤益科技大學';
const COMPANY_ADDRESS = '411030臺中市太平區坪林里中山路二段57號';

const headers = [
  'id',
  'name',
  'address',
  'time_window_start',
  'time_window_end',
  'priority',
  'service_time_seconds',
];

function row(overrides = {}) {
  return Object.assign({
    id: 1,
    name: '測試站點',
    address: '台中市太平區中山路二段348號',
    time_window_start: '09:00',
    time_window_end: '17:00',
    priority: 3,
    service_time_seconds: 600,
  }, overrides);
}

assert.equal(parseTimeValue('23:59', true).value, '23:59');
assert.match(parseTimeValue('24:00', false).error, /24 小時制/);
assert.match(parseTimeValue('09:60', false).error, /24 小時制/);

let result = validateRows([row()], headers, { kind: '送貨' });
assert.equal(result.ok, true);

result = validateRows([row({ time_window_start: '18:00', time_window_end: '17:00' })], headers, { kind: '送貨' });
assert.equal(result.ok, false);
assert.match(result.errors.join('\n'), /開始時間不可晚於結束時間/);

result = validateRows([row({ priority: 0 })], headers, { kind: '送貨' });
assert.equal(result.ok, false);
assert.match(result.errors.join('\n'), /優先權必須是 1 到 5/);

result = validateRows([row({ service_time_seconds: 86401 })], headers, { kind: '送貨' });
assert.equal(result.ok, false);
assert.match(result.errors.join('\n'), /0 到 86400/);

const maxRows = Array.from({ length: 24 }, (_, index) => row({ id: index + 1, name: `站點 ${index + 1}` }));
result = validateRows(maxRows, headers, { kind: '送貨' });
assert.equal(result.ok, true);
assert.equal(result.warnings.length, 0);
// 送貨站點超過建議規模只提示效能警告，不再擋下整份檔案
result = validateRows([...maxRows, row({ id: 25, name: '超量站點' })], headers, { kind: '送貨' });
assert.equal(result.ok, true);
assert.match(result.warnings.join('\n'), /超過建議規模/);
const receivingRows = Array.from({ length: 30 }, (_, index) => row({ id: index, name: `收貨站點 ${index}` }));
result = validateRows(receivingRows, headers, { kind: '收貨' });
assert.equal(result.ok, true);
assert.match(result.warnings.join('\n'), /超過建議規模/);

const legacyRows = [
  row({ id: 0, name: COMPANY_NAME, address: COMPANY_ADDRESS }),
  row({ id: 1, name: '客戶', address: '台中市太平區宜昌路1號' }),
];
result = validateRows(legacyRows, headers, {
  kind: '送貨',
  companyAddress: COMPANY_ADDRESS,
  inferCompanyFromFirstRow: true,
});
assert.equal(result.ok, true);
assert.equal(result.stationCount, 1);

console.log('Excel import validation: 14 checks passed');
