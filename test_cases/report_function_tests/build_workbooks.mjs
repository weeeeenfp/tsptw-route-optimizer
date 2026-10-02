import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUTPUT_ROOT = path.resolve(ROOT, 'outputs', 'report_function_tests_20260715');
const INPUT_DIR = path.join(OUTPUT_ROOT, 'inputs');
const PREVIEW_DIR = path.join(OUTPUT_ROOT, '_previews');

const SEND_SOURCE = path.join(ROOT, '報告用測資', '正常測資_送.xlsx');
const RECEIVE_SOURCE = path.join(ROOT, '報告用測資', '正常測資_收.xlsx');
const BAST_SOURCE = path.join(ROOT, 'samples', 'request_payload_bast.xlsx');
const HEADERS = ['id', 'name', 'address', 'time_window_start', 'time_window_end', 'priority', 'service_time_seconds'];
const COMPANY = {
  name: '國立勤益科技大學',
  address: '411030臺中市太平區坪林里中山路二段57號',
};
const RECEIVING_START = {
  name: '國軍臺中總醫院',
  address: '411臺中市太平區光明里中山路二段348號',
};
const DELIVERY_SOURCE_ROWS = [
  [0, '國軍臺中總醫院', '411臺中市太平區光明里中山路二段348號'],
  [1, '偈亭泡菜鍋 太平店', '411臺中市太平區宜昌里中山路三段21號'],
  [2, '馬卡龍公園', '411臺中市太平區新高里環中東路四段19號'],
  [3, '十全公園', '401臺中市東區東英里東英八街213號'],
  [4, '台新醫院', '401臺中市東區振興路441號'],
  [5, '六扇門時尚湯鍋-台中太平店', '41161臺中市太平區太平里太平路645號'],
  [6, 'Starbucks星巴克 太平中興門市', '411臺中市太平區成功里中興東路136號'],
  [7, '棠刺身專賣', '411臺中市太平區坪林里中山路二段43號'],
  [8, '何劉 米粒食事處', '411臺中市太平區中山路一段269號'],
  [9, '童話泡芙', '411臺中市太平區東和里中山路一段153號'],
].map(([id, name, address]) => ({
  id, name, address, time_window_start: '09:00', time_window_end: '17:00', priority: 3, service_time_seconds: 600,
}));
const RECEIVING_SOURCE_ROWS = [
  [0, '臺中市太平區長億國民小學', '411臺中市太平區長億里太平三街295號'],
  [1, '享千葉火鍋-大里店', '412臺中市大里區中興路二段381號'],
  [2, '忠孝路夜市', '402臺中市南區城隍里忠孝路136號'],
  [3, '宮原眼科', '400臺中市中區綠川里中山路20號'],
  [4, '一中街夜市', '404臺中市北區一中街'],
  [5, '交通部公路局臺中區監理所臺中市監理站', '404臺中市北區北屯路77號'],
  [6, '臺中市立東山高級中學', '406臺中市北屯區水景里景賢六路200號'],
  [7, '東原羽球館', '406臺中市北屯區東光路724巷1-69號'],
  [8, '世界健身俱樂部 台中太平店Sport', '41155臺中市太平區新高里立功路115號'],
  [9, '彭城堂台菜海鮮餐廳', '411臺中市太平區宜昌里宜昌路377號'],
].map(([id, name, address]) => ({
  id, name, address, time_window_start: '12:00', time_window_end: '18:00', priority: 3, service_time_seconds: 600,
}));

await fs.mkdir(INPUT_DIR, { recursive: true });
await fs.mkdir(PREVIEW_DIR, { recursive: true });

await writeCanonicalSource(SEND_SOURCE, '送貨', DELIVERY_SOURCE_ROWS);
await writeCanonicalSource(RECEIVE_SOURCE, '收貨', RECEIVING_SOURCE_ROWS);
await writeCanonicalSource(BAST_SOURCE, '送貨', DELIVERY_SOURCE_ROWS);
const sendSource = cloneRows(DELIVERY_SOURCE_ROWS);
const receiveSource = cloneRows(RECEIVING_SOURCE_ROWS);
const scenarios = buildScenarios(sendSource, receiveSource);
scenarios.forEach(scenario => {
  scenario.file = `inputs/${scenario.case_id}_${scenario.title}.xlsx`;
});
const requestedCase = process.argv[2] || '';
const selectedScenarios = requestedCase ? scenarios.filter(item => item.case_id === requestedCase) : scenarios;
if (!selectedScenarios.length) throw new Error(`找不到測試情境：${requestedCase}`);

for (const scenario of selectedScenarios) {
  const workbook = buildScenarioWorkbook(scenario);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  const filename = `${scenario.case_id}_${scenario.title}.xlsx`;
  const outputPath = path.join(INPUT_DIR, filename);
  await output.save(outputPath);
  await fs.rm(`${outputPath}.inspect.ndjson`, { force: true });

  for (const sheetName of ['locations', '測試說明']) {
    const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1.25, format: 'png' });
    await fs.writeFile(
      path.join(PREVIEW_DIR, `${scenario.case_id}_${sheetName}.png`),
      new Uint8Array(await preview.arrayBuffer()),
    );
  }
}

await fs.writeFile(
  path.join(OUTPUT_ROOT, 'manifest.json'),
  JSON.stringify({
    generated_at: '2026-07-16',
    company: COMPANY,
    receiving_start: RECEIVING_START,
    send_source: SEND_SOURCE,
    receive_source: RECEIVE_SOURCE,
    scenarios,
  }, null, 2),
  'utf8',
);

console.log(JSON.stringify({ output_root: OUTPUT_ROOT, workbook_count: selectedScenarios.length, requested_case: requestedCase || 'ALL' }, null, 2));
process.exit(0);

async function writeCanonicalSource(filePath, kind, rows) {
  const workbook = Workbook.create();
  const locations = workbook.worksheets.add('locations');
  const notes = workbook.worksheets.add('使用說明');
  locations.showGridLines = false;
  notes.showGridLines = false;
  locations.freezePanes.freezeRows(1);

  locations.getRangeByIndexes(0, 0, 1, HEADERS.length).values = [HEADERS];
  locations.getRangeByIndexes(1, 0, rows.length, HEADERS.length).values =
    rows.map(row => HEADERS.map(header => row[header] ?? ''));
  locations.getRange(`A1:G${rows.length + 1}`).format.font = { name: 'Microsoft JhengHei', size: 10 };
  locations.getRange('A1:G1').format = {
    fill: '#155E75',
    font: { name: 'Microsoft JhengHei', size: 10, bold: true, color: '#FFFFFF' },
    rowHeight: 26,
    verticalAlignment: 'center',
  };
  locations.getRange(`A2:G${rows.length + 1}`).format = {
    borders: { insideHorizontal: { style: 'thin', color: '#D6E4E8' } },
    verticalAlignment: 'center',
  };
  locations.getRange(`A2:A${rows.length + 1}`).format.numberFormat = '0';
  locations.getRange(`F2:G${rows.length + 1}`).format.numberFormat = '0';
  locations.getRange('A:A').format.columnWidth = 9;
  locations.getRange('B:B').format.columnWidth = 34;
  locations.getRange('C:C').format.columnWidth = 58;
  locations.getRange('D:E').format.columnWidth = 22;
  locations.getRange('F:G').format.columnWidth = 22;
  locations.getRange(`B2:C${rows.length + 1}`).format.wrapText = true;
  locations.getRange(`A2:G${rows.length + 1}`).format.rowHeight = 34;
  locations.getRange(`F2:F${rows.length + 1}`).dataValidation = {
    rule: { type: 'whole', operator: 'between', formula1: 1, formula2: 5 },
  };
  locations.getRange(`G2:G${rows.length + 1}`).dataValidation = {
    rule: { type: 'whole', operator: 'between', formula1: 0, formula2: 86400 },
  };
  const table = locations.tables.add(`A1:G${rows.length + 1}`, true, `${kind === '送貨' ? 'Delivery' : 'Receiving'}Locations`);
  table.style = 'TableStyleMedium2';

  notes.getRange('A1:F1').merge();
  notes.getRange('A1').values = [[`${kind}正常測資`]];
  notes.getRange('A1:F1').format = {
    fill: '#155E75',
    font: { name: 'Microsoft JhengHei', size: 16, bold: true, color: '#FFFFFF' },
    rowHeight: 34,
    verticalAlignment: 'center',
  };
  const noteRows = [
    ['資料角色', `本檔只包含 ${rows.length} 個實際${kind}站點，不包含公司。`],
    ['公司名稱', COMPANY.name],
    ['公司地址', COMPANY.address],
    ['公司設定方式', '請在前端「系統管理員模式」設定；公司會由系統加在 locations index 0。'],
    ['ID 規則', 'Excel 內 ID 需為唯一整數；ID 0 是一般客戶，可正常配送或收貨。'],
    ['時間格式', 'time_window_start / time_window_end 統一使用 HH:MM 24 小時制。'],
    ['優先級', 'priority 為 1 到 5，數字越小越優先；本基準皆為 3。'],
    ['服務時間', 'service_time_seconds 單位為秒；本基準每站 600 秒（10 分鐘）。'],
    ['站點規模', kind === '收貨'
      ? '25 個節點內是建議適用規模，不是硬上限；超過仍可執行，請依站數增加 OR-Tools timeout。'
      : '送貨 Excel 最多 24 個實際站點，加上公司後最多 25 個正式地點。'],
  ];
  notes.getRange(`A3:B${noteRows.length + 2}`).values = noteRows;
  notes.getRange(`A3:A${noteRows.length + 2}`).format = { fill: '#E6F4F1', font: { bold: true, color: '#164E63' } };
  notes.getRange(`A3:B${noteRows.length + 2}`).format.font = { name: 'Microsoft JhengHei', size: 11 };
  notes.getRange(`A3:B${noteRows.length + 2}`).format.borders = { insideHorizontal: { style: 'thin', color: '#D6E4E8' } };
  notes.getRange('A:A').format.columnWidth = 22;
  notes.getRange('B:B').format.columnWidth = 90;
  notes.getRange(`B3:B${noteRows.length + 2}`).format.wrapText = true;
  notes.getRange(`A3:B${noteRows.length + 2}`).format.autofitRows();

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(filePath);
  await fs.rm(`${filePath}.inspect.ndjson`, { force: true });
  for (const sheetName of ['locations', '使用說明']) {
    const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1.25, format: 'png' });
    await fs.writeFile(
      path.join(PREVIEW_DIR, `source_${kind}_${sheetName}.png`),
      new Uint8Array(await preview.arrayBuffer()),
    );
  }
}

function cloneRows(rows) {
  return rows.map(row => ({ ...row }));
}

function buildScenarios(sendRows, receiveRows) {
  const deliveryBase = cloneRows(sendRows).map(row => ({ ...row, priority: 3, service_time_seconds: 600 }));
  const receivingBase = cloneRows(receiveRows).map(row => ({ ...row, priority: 3, service_time_seconds: 600 }));

  const deliveryPriority = cloneRows(deliveryBase).map(row => ({ ...row, priority: row.id === 9 ? 1 : 5 }));
  const deliveryWindows = cloneRows(deliveryBase);
  const deliveryWindowValues = [
    ['09:00', '17:00'], ['09:05', '09:20'], ['09:30', '09:45'], ['09:45', '10:00'], ['10:00', '10:15'],
    ['10:20', '10:35'], ['10:35', '10:50'], ['11:10', '11:20'], ['11:30', '11:40'], ['11:50', '12:00'],
  ];
  deliveryWindows.forEach((row, index) => {
    [row.time_window_start, row.time_window_end] = deliveryWindowValues[index];
  });
  const deliveryService = cloneRows(deliveryBase);
  [300, 600, 900, 1200, 300, 600, 900, 1200, 180, 600].forEach((seconds, index) => {
    deliveryService[index].service_time_seconds = seconds;
  });

  const receivingPriority = cloneRows(receivingBase).map(row => ({ ...row, priority: row.id === 6 ? 1 : 5 }));
  const receivingWindows = cloneRows(receivingBase);
  const receivingWindowValues = [
    ['12:00', '12:20'], ['12:15', '12:35'], ['12:35', '12:55'], ['12:50', '13:10'], ['13:10', '13:30'],
    ['13:25', '13:45'], ['13:45', '14:05'], ['14:10', '14:30'], ['14:25', '14:45'], ['14:45', '15:05'],
  ];
  receivingWindows.forEach((row, index) => {
    [row.time_window_start, row.time_window_end] = receivingWindowValues[index];
  });
  const receivingService = cloneRows(receivingBase);
  [300, 600, 900, 1200, 300, 600, 900, 1200, 180, 600].forEach((seconds, index) => {
    receivingService[index].service_time_seconds = seconds;
  });
  const receivingLarge = Array.from({ length: 30 }, (_, index) => {
    const source = receivingBase[index % receivingBase.length];
    return {
      ...source,
      id: index,
      name: `${source.name}（大量收貨 ${index + 1}）`,
      priority: 3,
      service_time_seconds: 600,
    };
  });

  const firstCustomer = [{ ...deliveryBase[0], id: 0 }];
  const maxRows = Array.from({ length: 24 }, (_, index) => {
    const source = deliveryBase[index % deliveryBase.length];
    return { ...source, id: index, name: `${source.name}（上限測試 ${index + 1}）` };
  });
  const tooManyRows = [...maxRows, { ...deliveryBase[4], id: 24, name: `${deliveryBase[4].name}（超量第 25 站）` }];
  const badTime = cloneRows(deliveryBase); badTime[0].time_window_start = '24:00';
  const reversedTime = cloneRows(deliveryBase); reversedTime[1].time_window_start = '18:00'; reversedTime[1].time_window_end = '17:00';
  const badPriority = cloneRows(deliveryBase); badPriority[2].priority = 6;
  const badService = cloneRows(deliveryBase); badService[3].service_time_seconds = 86401;
  const missingAddress = cloneRows(deliveryBase); missingAddress[4].address = '';

  return [
    scenario('D01', '送貨_基準', 'delivery', deliveryBase, '公司由管理員設定為國立勤益科技大學；確認 09:00 出發、10 個送貨點全部進入路線並回公司。', 'SUCCESS'),
    scenario('D02', '送貨_優先級', 'delivery', deliveryPriority, '將 ID 9 設為優先權 1、其他客戶設為 5，和 D01 比較提早幅度。', 'SUCCESS'),
    scenario('D03', '送貨_等待與軟性遲到', 'delivery', deliveryWindows, '以連續窄時間窗觸發等待及不可避免的遲到，確認仍回傳延誤最少解。', 'SUCCESS'),
    scenario('D04', '送貨_單站服務時間', 'delivery', deliveryService, '每站使用不同上下貨秒數，核對純行駛時間與總耗時分開計算。', 'SUCCESS'),
    scenario('R01', '收貨_基準', 'receiving', receivingBase, '從已完成的送貨點國軍臺中總醫院開始收貨，10 個收貨點完成後固定回國立勤益科技大學。', 'SUCCESS'),
    scenario('R02', '收貨_優先級', 'receiving', receivingPriority, '將 ID 6 設為優先權 1，確認收貨也保留優先級軟性偏好。', 'SUCCESS'),
    scenario('R03', '收貨_等待與軟性遲到', 'receiving', receivingWindows, '以窄時間窗確認等待、遲到與建議最晚出發資訊可計算。', 'SUCCESS'),
    scenario('R04', '收貨_單站服務時間', 'receiving', receivingService, '每站使用不同收貨停留時間，固定回公司且不套用 LIFO。', 'SUCCESS'),
    scenario('R05', '收貨_超過25點', 'receiving', receivingLarge, '以 30 個實際收貨站點確認 25 點僅為建議規模，Excel 與後端不得因站數直接拒絕。', 'SUCCESS', 'route', 10),
    scenario('L01', '合法下限_1站', 'delivery', firstCustomer, '公司由管理員欄位提供，Excel 只有 1 個實際站點時仍為合法 2 點路線。', 'SUCCESS', 'validation'),
    scenario('L02', '建議規模_24站', 'delivery', maxRows, '實際站點 24 筆，加公司共 25 個正式地點，為建議適用規模且無警告。', 'SUCCESS', 'validation'),
    scenario('L03', '超過建議規模_25站', 'delivery', tooManyRows, '實際站點 25 筆，加公司共 26 點；送貨已無硬性上限，應通過匯入並提示效能警告。', 'SUCCESS', 'validation'),
    scenario('L04', '非法時間_24點', 'delivery', badTime, '24:00 不是合法 24 小時制，前端不可靜默改成 23:00。', 'REJECTED', 'validation'),
    scenario('L05', '非法時間窗_開始晚於結束', 'delivery', reversedTime, '開始 18:00、結束 17:00，前端應指出資料列。', 'REJECTED', 'validation'),
    scenario('L06', '非法優先級_6', 'delivery', badPriority, '優先級只允許 1 到 5，不能忽略後套用預設值。', 'REJECTED', 'validation'),
    scenario('L07', '非法服務時間_86401秒', 'delivery', badService, '服務時間上限為 86400 秒，超過應擋下。', 'REJECTED', 'validation'),
    scenario('L08', '非法必要欄位_空白地址', 'delivery', missingAddress, '任一資料列地址空白時應擋下，不可靜默略過該站。', 'REJECTED', 'validation'),
  ];
}

function scenario(caseId, title, kind, rows, purpose, expectedStatus, execution = 'route', solverTimeoutSeconds = 5) {
  return {
    case_id: caseId,
    title,
    kind,
    purpose,
    expected_status: expectedStatus,
    execution,
    departure_time: kind === 'receiving' ? '12:00' : '09:00',
    solver_timeout_seconds: solverTimeoutSeconds,
    row_count: rows.length,
    rows,
  };
}

function buildScenarioWorkbook(scenarioDef) {
  const workbook = Workbook.create();
  const locations = workbook.worksheets.add('locations');
  const notes = workbook.worksheets.add('測試說明');
  locations.showGridLines = false;
  notes.showGridLines = false;
  locations.freezePanes.freezeRows(1);

  locations.getRangeByIndexes(0, 0, 1, HEADERS.length).values = [HEADERS];
  const values = scenarioDef.rows.map(row => HEADERS.map(header => row[header] ?? ''));
  locations.getRangeByIndexes(1, 0, values.length, HEADERS.length).values = values;
  locations.getRange(`A1:G${values.length + 1}`).format.font = { name: 'Microsoft JhengHei', size: 10 };
  locations.getRange('A1:G1').format = {
    fill: '#155E75',
    font: { name: 'Microsoft JhengHei', size: 10, bold: true, color: '#FFFFFF' },
    rowHeight: 26,
    verticalAlignment: 'center',
  };
  locations.getRange(`A2:G${values.length + 1}`).format.borders = {
    insideHorizontal: { style: 'thin', color: '#D6E4E8' },
    bottom: { style: 'thin', color: '#9CB8C0' },
  };
  locations.getRange(`A2:A${values.length + 1}`).format.numberFormat = '0';
  locations.getRange(`F2:G${values.length + 1}`).format.numberFormat = '0';
  locations.getRange('A:A').format.columnWidth = 9;
  locations.getRange('B:B').format.columnWidth = 30;
  locations.getRange('C:C').format.columnWidth = 54;
  locations.getRange('D:E').format.columnWidth = 22;
  locations.getRange('F:G').format.columnWidth = 22;
  locations.getRange(`B2:C${values.length + 1}`).format.wrapText = true;
  if (!scenarioDef.case_id.startsWith('L06')) {
    locations.getRange(`F2:F${values.length + 1}`).dataValidation = { rule: { type: 'whole', operator: 'between', formula1: 1, formula2: 5 } };
  }
  if (!scenarioDef.case_id.startsWith('L07')) {
    locations.getRange(`G2:G${values.length + 1}`).dataValidation = { rule: { type: 'whole', operator: 'between', formula1: 0, formula2: 86400 } };
  }

  notes.getRange('A1:F1').merge();
  notes.getRange('A1').values = [[`${scenarioDef.case_id} ${scenarioDef.title}`]];
  notes.getRange('A1:F1').format = {
    fill: '#155E75',
    font: { name: 'Microsoft JhengHei', size: 16, bold: true, color: '#FFFFFF' },
    rowHeight: 34,
    verticalAlignment: 'center',
  };
  const noteRows = [
    ['測試種類', scenarioDef.kind === 'receiving' ? '收貨' : '送貨'],
    ['執行方式', scenarioDef.execution === 'route' ? '實際呼叫後端排程' : 'Excel 匯入限制驗證'],
    ['預期狀態', scenarioDef.expected_status],
    ['預設出發時間', scenarioDef.departure_time],
    ['資料筆數', scenarioDef.row_count],
    ['求解 timeout', `${scenarioDef.solver_timeout_seconds} 秒`],
    ['測試目的', scenarioDef.purpose],
    ['來源', scenarioDef.kind === 'receiving' ? '正常測資_收.xlsx' : '正常測資_送.xlsx'],
    ['操作', '前端先設定公司地點，載入本檔；送貨按「送出後端排程」，收貨則在送貨完成後按「開始收貨」。'],
  ];
  notes.getRange(`A3:B${noteRows.length + 2}`).values = noteRows;
  notes.getRange(`A3:A${noteRows.length + 2}`).format = { fill: '#E6F4F1', font: { bold: true, color: '#164E63' } };
  notes.getRange(`A3:B${noteRows.length + 2}`).format.font = { name: 'Microsoft JhengHei', size: 11 };
  notes.getRange(`A3:B${noteRows.length + 2}`).format.borders = { insideHorizontal: { style: 'thin', color: '#D6E4E8' } };
  notes.getRange('A:A').format.columnWidth = 22;
  notes.getRange('B:B').format.columnWidth = 86;
  notes.getRange(`B3:B${noteRows.length + 2}`).format.wrapText = true;
  notes.getRange(`A3:B${noteRows.length + 2}`).format.autofitRows();
  return workbook;
}
