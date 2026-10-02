import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUTPUT_ROOT = path.join(ROOT, 'outputs', 'report_function_tests_20260715');
const RESULTS_FILE = path.join(OUTPUT_ROOT, 'results.json');
const OUTPUT_FILE = path.join(OUTPUT_ROOT, '功能測試結果_20260716.xlsx');
const PREVIEW_DIR = path.join(OUTPUT_ROOT, '_previews', 'results');
const DATA_COMPARISON_DIR = path.join(OUTPUT_ROOT, 'data_comparisons');
const MAP_SCREENSHOT_DIR = path.join(OUTPUT_ROOT, 'map_screenshots');
const data = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));

await fs.rm(PREVIEW_DIR, { recursive: true, force: true });
await fs.mkdir(PREVIEW_DIR, { recursive: true });
const workbook = Workbook.create();
buildSummary(workbook, data);
buildRoutes(workbook, data);
buildDetails(workbook, data);
buildCoverage(workbook, data);
buildLimits(workbook, data);
buildMaps(workbook, data);
await buildComparisons(workbook, data);
await buildTestDataComparisons(workbook);

const comparisonSections = [
  ['01_送貨優先級', 'A1:P46'],
  ['02_送貨時間窗', 'A47:P81'],
  ['03_收貨優先級', 'A82:P116'],
  ['04_收貨軟性時間窗', 'A117:P151'],
  ['05_途中客戶改約', 'A152:P186'],
];
const testDataComparisonSections = [
  ['01_正常情況', 'A1:P36'],
  ['02_調整測資參數', 'A37:P72'],
];

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(OUTPUT_FILE);
await fs.rm(`${OUTPUT_FILE}.inspect.ndjson`, { force: true });
const finalWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(OUTPUT_FILE));
for (const sheetName of ['測試摘要', '路線結果', '每站明細', '資料覆蓋', '限制測試', 'Google Maps', '路線對比', '測資對比']) {
  const preview = ['路線對比', '測資對比'].includes(sheetName)
    ? await finalWorkbook.render({ sheetName, autoCrop: 'all', scale: 0.65, format: 'png' })
    : await finalWorkbook.render({ sheetName, autoCrop: 'all', scale: 1.15, format: 'png' });
  await fs.writeFile(path.join(PREVIEW_DIR, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}
for (const [name, range] of comparisonSections) {
  const comparisonPreview = await finalWorkbook.render({ sheetName: '路線對比', range, scale: 1, format: 'png' });
  await fs.writeFile(path.join(PREVIEW_DIR, `路線對比_${name}.png`), new Uint8Array(await comparisonPreview.arrayBuffer()));
}
for (const [name, range] of testDataComparisonSections) {
  const comparisonPreview = await finalWorkbook.render({ sheetName: '測資對比', range, scale: 1, format: 'png' });
  await fs.writeFile(path.join(PREVIEW_DIR, `測資對比_${name}.png`), new Uint8Array(await comparisonPreview.arrayBuffer()));
}

const inspect = await finalWorkbook.inspect({
  kind: 'workbook,sheet,table,formula',
  maxChars: 10000,
  tableMaxRows: 8,
  tableMaxCols: 12,
});
const errors = await finalWorkbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
});
if (!errors.ndjson.includes('matched 0 entries')) throw new Error(`結果工作簿公式錯誤：${errors.ndjson}`);
const comparisonCheck = await finalWorkbook.inspect({
  kind: 'table',
  sheetId: '路線對比',
  range: 'A1:P10',
  include: 'values,formulas',
  tableMaxRows: 10,
  tableMaxCols: 16,
});
const comparisonFormula = finalWorkbook.worksheets.getItem('路線對比').getRange('H4').formulas?.[0]?.[0];
if (!comparisonCheck.ndjson.includes('D02') || comparisonFormula !== '=G4-F4') {
  throw new Error(`路線對比摘要或差值公式缺漏：${comparisonCheck.ndjson}`);
}
await fs.rm(`${OUTPUT_FILE}.inspect.ndjson`, { force: true });
console.log(JSON.stringify({ output: OUTPUT_FILE, passed: data.passed, failed: data.failed }, null, 2));
process.exit(0);

function buildSummary(workbook, results) {
  const sheet = workbook.worksheets.add('測試摘要');
  setupSheet(sheet);
  title(sheet, 'A1:J1', '正常收送貨測資功能測試結果');
  sheet.getRange('A3:B5').values = [
    ['執行日期', results.executed_at],
    ['求解策略', results.solver_strategy],
    ['出發假設', `送貨 ${results.departure_assumptions.delivery} / 收貨 ${results.departure_assumptions.receiving}`],
  ];
  sheet.getRange('D3:E5').values = [['總案例', results.results.length], ['通過', results.passed], ['失敗', results.failed]];
  sheet.getRange('D3:D5').format = { fill: '#E6F4F1', font: { bold: true, color: '#155E75' } };
  sheet.getRange('E3:E5').format = { font: { bold: true, size: 15, color: '#0F766E' }, horizontalAlignment: 'center' };
  sheet.getRange('A7:J7').values = [[
    '案例', '名稱', '判定', '後端狀態', '行駛(分)', '服務(分)', '等待(分)', '遲到(分)', '導航連結數', '測試目的',
  ]];
  const rows = results.results.map(item => [
    item.case_id,
    item.title,
    item.passed ? 'PASS' : 'FAIL',
    item.actual_status,
    item.total_travel_minutes ?? '',
    item.total_service_minutes ?? '',
    item.total_waiting_minutes ?? '',
    item.total_lateness_minutes ?? '',
    (item.driver_navigation_urls || []).length,
    item.purpose,
  ]);
  sheet.getRangeByIndexes(7, 0, rows.length, 10).values = rows;
  styleTable(sheet, `A7:J${rows.length + 7}`);
  sheet.getRange(`C8:C${rows.length + 7}`).conditionalFormats.addCustom('=C8="PASS"', { fill: '#DCFCE7', font: { color: '#166534', bold: true } });
  sheet.getRange(`C8:C${rows.length + 7}`).conditionalFormats.addCustom('=C8="FAIL"', { fill: '#FEE2E2', font: { color: '#991B1B', bold: true } });
  sheet.getRange('A:A').format.columnWidth = 11;
  sheet.getRange('B:B').format.columnWidth = 34;
  sheet.getRange('C:D').format.columnWidth = 15;
  sheet.getRange('E:I').format.columnWidth = 14;
  sheet.getRange('J:J').format.columnWidth = 52;
  sheet.getRange(`J8:J${rows.length + 7}`).format.wrapText = true;
  sheet.getRange(`A8:J${rows.length + 7}`).format.autofitRows();
}

function buildRoutes(workbook, results) {
  const sheet = workbook.worksheets.add('路線結果');
  setupSheet(sheet);
  title(sheet, 'A1:K1', '成功排程路線與時間比較');
  sheet.getRange('A3:K3').values = [[
    '案例', '種類', '起點 index', '終點 index', '路線 index', '路線站名', '行駛(分)', '服務(分)', '等待(分)', '遲到(分)', '矩陣來源',
  ]];
  const routeResults = results.results.filter(item => item.route_indices && item.route_indices.length);
  const rows = routeResults.map(item => [
    item.case_id,
    item.kind,
    item.selected_start_index ?? '',
    item.selected_end_index ?? '',
    item.route_indices.join(' -> '),
    (item.route_sequence || []).join(' -> '),
    item.total_travel_minutes,
    item.total_service_minutes,
    item.total_waiting_minutes,
    item.total_lateness_minutes,
    item.matrix_source,
  ]);
  sheet.getRangeByIndexes(3, 0, rows.length, 11).values = rows;
  styleTable(sheet, `A3:K${rows.length + 3}`);
  sheet.getRange('A:D').format.columnWidth = 16;
  sheet.getRange('E:E').format.columnWidth = 30;
  sheet.getRange('F:F').format.columnWidth = 56;
  sheet.getRange('G:J').format.columnWidth = 14;
  sheet.getRange('K:K').format.columnWidth = 46;
  sheet.getRange(`E4:F${rows.length + 3}`).format.wrapText = true;
  sheet.getRange(`K4:K${rows.length + 3}`).format.wrapText = true;
  sheet.getRange(`A4:K${rows.length + 3}`).format.autofitRows();
}

function buildDetails(workbook, results) {
  const sheet = workbook.worksheets.add('每站明細');
  setupSheet(sheet);
  title(sheet, 'A1:M1', '每站到達、等待、服務與遲到明細');
  sheet.getRange('A3:M3').values = [[
    '案例', '順序', 'index', '站名', '到達', '開始服務', '完成服務', '時間窗開始', '時間窗結束', '等待(分)', '服務(分)', '遲到(分)', '優先級',
  ]];
  const rows = [];
  results.results.forEach(item => {
    (item.route_details || []).forEach(detail => rows.push([
      item.case_id,
      detail.order,
      detail.index,
      detail.name,
      hm(detail.arrival_time_seconds),
      hm(detail.service_start_time_seconds),
      hm(detail.service_completion_time_seconds),
      hm((detail.effective_time_window || [])[0]),
      hm((detail.effective_time_window || [])[1]),
      roundMinutes(detail.waiting_time_seconds),
      roundMinutes(detail.charged_service_time_seconds),
      roundMinutes(detail.lateness_seconds),
      detail.priority ?? '',
    ]));
  });
  sheet.getRangeByIndexes(3, 0, rows.length, 13).values = rows;
  styleTable(sheet, `A3:M${rows.length + 3}`);
  sheet.getRange('A:C').format.columnWidth = 11;
  sheet.getRange('D:D').format.columnWidth = 40;
  sheet.getRange('E:I').format.columnWidth = 15;
  sheet.getRange('J:M').format.columnWidth = 13;
  sheet.getRange(`D4:D${rows.length + 3}`).format.wrapText = true;
  sheet.getRange(`J4:L${rows.length + 3}`).conditionalFormats.add('colorScale', {
    criteria: [
      { type: 'lowestValue', color: '#DCFCE7' },
      { type: 'percentile', value: 50, color: '#FEF3C7' },
      { type: 'highestValue', color: '#FECACA' },
    ],
  });
}

function buildCoverage(workbook, results) {
  const sheet = workbook.worksheets.add('資料覆蓋');
  setupSheet(sheet);
  title(sheet, 'A1:E1', '來源 Excel 每筆資料測試覆蓋');
  sheet.getRange('A3:E3').values = [['種類', 'ID', '名稱', '覆蓋案例', '覆蓋數']];
  const rows = results.row_coverage.map(item => [item.kind, item.id, item.name, item.cases.join(', '), item.cases.length]);
  sheet.getRangeByIndexes(3, 0, rows.length, 5).values = rows;
  styleTable(sheet, `A3:E${rows.length + 3}`);
  sheet.getRange('A:B').format.columnWidth = 12;
  sheet.getRange('C:C').format.columnWidth = 48;
  sheet.getRange('D:D').format.columnWidth = 46;
  sheet.getRange('E:E').format.columnWidth = 12;
}

function buildLimits(workbook, results) {
  const sheet = workbook.worksheets.add('限制測試');
  setupSheet(sheet);
  title(sheet, 'A1:G1', 'Excel 輸入上下限與錯誤攔截');
  sheet.getRange('A3:G3').values = [['案例', '名稱', '預期', '實際', '判定', '資料筆數', '驗證訊息']];
  const items = results.results.filter(item => item.case_id.startsWith('L'));
  const rows = items.map(item => [
    item.case_id,
    item.title,
    item.expected_status,
    item.actual_status,
    item.passed ? 'PASS' : 'FAIL',
    item.validation.row_count,
    (item.validation.errors || []).join('；') || '合法資料',
  ]);
  sheet.getRangeByIndexes(3, 0, rows.length, 7).values = rows;
  styleTable(sheet, `A3:G${rows.length + 3}`);
  sheet.getRange('A:A').format.columnWidth = 11;
  sheet.getRange('B:B').format.columnWidth = 38;
  sheet.getRange('C:F').format.columnWidth = 15;
  sheet.getRange('G:G').format.columnWidth = 74;
  sheet.getRange(`G4:G${rows.length + 3}`).format.wrapText = true;
}

function buildMaps(workbook, results) {
  const sheet = workbook.worksheets.add('Google Maps');
  setupSheet(sheet);
  title(sheet, 'A1:E1', 'Google Maps 路線比對連結');
  sheet.getRange('A3:E3').values = [['案例', '路線段', '起訖／用途', 'Google Maps URL', '核對狀態']];
  const rows = [];
  results.results.forEach(item => {
    (item.driver_navigation_urls || []).forEach((url, index) => {
      rows.push([
        item.case_id,
        index + 1,
        item.title,
        url,
        '連結已產生；視覺截圖需可用的互動瀏覽器環境',
      ]);
    });
  });
  sheet.getRangeByIndexes(3, 0, rows.length, 5).values = rows;
  styleTable(sheet, `A3:E${rows.length + 3}`);
  sheet.getRange('A:B').format.columnWidth = 12;
  sheet.getRange('C:C').format.columnWidth = 40;
  sheet.getRange('D:D').format.columnWidth = 70;
  sheet.getRange('E:E').format.columnWidth = 48;
  sheet.getRange(`A4:E${rows.length + 3}`).format.rowHeight = 22;
}

async function buildComparisons(workbook, results) {
  const sheet = workbook.worksheets.add('路線對比');
  setupSheet(sheet);
  const byId = new Map(results.results.map(item => [item.case_id, item]));
  const pairs = [
    { title: '送貨優先級', baseId: 'D01', changedId: 'D02', purpose: '優先級排序', image: '比較_送貨_基準_vs_優先級.png' },
    { title: '送貨指定時間窗', baseId: 'D01', changedId: 'D03', purpose: '指定時間窗', image: '比較_送貨_基準_vs_時間窗.png' },
    { title: '收貨優先級', baseId: 'R01', changedId: 'R02', purpose: '優先級排序', image: '比較_收貨_基準_vs_優先級.png' },
    { title: '收貨軟性時間窗', baseId: 'R01', changedId: 'R03', purpose: '軟性時間窗', image: '比較_收貨_基準_vs_軟性時間窗.png' },
    { title: '途中客戶改約', baseId: 'E01', changedId: 'E02', purpose: '途中重新規劃', image: '比較_途中狀態更新_vs_客戶改約.png' },
  ].map(pair => {
    const base = byId.get(pair.baseId);
    const changed = byId.get(pair.changedId);
    return {
      ...pair,
      base,
      changed,
      keyPoint: comparisonKeyPoint(pair.changedId, changed),
      summary: comparisonSummary(base, changed),
    };
  });

  for (const pair of pairs) {
    if (!pair.base || !pair.changed) throw new Error(`缺少路線對比案例：${pair.baseId}/${pair.changedId}`);
  }

  title(sheet, 'A1:P1', '路線改動重點與 Google Maps 對比');
  sheet.getRange('A3:P3').values = [[
    '對比項目', '基準', '變更後', '變更目的', '關鍵站點／規則',
    '原行駛', '新行駛', 'Δ行駛', '原等待', '新等待', 'Δ等待',
    '原遲到', '新遲到', 'Δ遲到', '改動摘要', '結果來源',
  ]];
  const summaryRows = pairs.map(pair => [
    pair.title,
    pair.baseId,
    pair.changedId,
    pair.purpose,
    pair.keyPoint,
    pair.base.total_travel_minutes,
    pair.changed.total_travel_minutes,
    null,
    pair.base.total_waiting_minutes,
    pair.changed.total_waiting_minutes,
    null,
    pair.base.total_lateness_minutes,
    pair.changed.total_lateness_minutes,
    null,
    pair.summary,
    '最新 results.json',
  ]);
  sheet.getRangeByIndexes(3, 0, summaryRows.length, 16).values = summaryRows;
  for (let row = 4; row <= 8; row += 1) {
    sheet.getRange(`H${row}`).formulas = [[`=G${row}-F${row}`]];
    sheet.getRange(`K${row}`).formulas = [[`=J${row}-I${row}`]];
    sheet.getRange(`N${row}`).formulas = [[`=M${row}-L${row}`]];
  }
  styleTable(sheet, 'A3:P8');
  sheet.getRange('C4:C8').format = {
    fill: '#FEF3C7', font: { bold: true, color: '#991B1B' },
    borders: { preset: 'outside', style: 'medium', color: '#DC2626' },
  };
  sheet.getRange('E4:E8').format = { fill: '#FFF7D6', font: { bold: true, color: '#7C2D12' }, wrapText: true };
  sheet.getRange('O4:P8').format = { fill: '#FFF7D6', wrapText: true };
  sheet.getRange('F4:N8').format.numberFormat = '0.00';
  for (const range of ['H4:H8', 'K4:K8', 'N4:N8']) {
    sheet.getRange(range).conditionalFormats.add('cellIs', {
      operator: 'greaterThan', formula: 0,
      format: { fill: '#FEF3C7', font: { bold: true, color: '#991B1B' }, border: { preset: 'outside', style: 'medium', color: '#DC2626' } },
    });
    sheet.getRange(range).conditionalFormats.add('cellIs', {
      operator: 'lessThan', formula: 0,
      format: { fill: '#DCFCE7', font: { bold: true, color: '#166534' } },
    });
  }
  sheet.getRange('A10:P10').merge();
  sheet.getRange('A10').values = [['標示規則：黃色＋紅框＝變更後或增加的成本；綠色＝時間下降。下方圖片使用 2026-07-16 最新公司位置與測資重新擷取；長路線的返程分段請見 map_screenshots 資料夾。']];
  sheet.getRange('A10:P10').format = {
    fill: '#FFF7D6', font: { bold: true, color: '#7C2D12' }, rowHeight: 28, verticalAlignment: 'center',
    borders: { preset: 'outside', style: 'medium', color: '#F59E0B' },
  };

  sheet.getRange('A:A').format.columnWidth = 24;
  sheet.getRange('B:C').format.columnWidth = 12;
  sheet.getRange('D:D').format.columnWidth = 18;
  sheet.getRange('E:E').format.columnWidth = 42;
  sheet.getRange('F:N').format.columnWidth = 11;
  sheet.getRange('O:O').format.columnWidth = 48;
  sheet.getRange('P:P').format.columnWidth = 38;
  sheet.getRange('A4:P8').format.rowHeight = 48;
  sheet.getRange('A4:P8').format.verticalAlignment = 'center';

  let sectionRow = 12;
  for (const pair of pairs) {
    const baseRoute = pair.base.route_indices.join(' → ');
    const changedRoute = pair.changed.route_indices.join(' → ');
    sheet.getRange(`A${sectionRow}:P${sectionRow + 34}`).format.fill = '#FFFFFF';
    sheet.getRange(`A${sectionRow}:P${sectionRow}`).merge();
    sheet.getRange(`A${sectionRow}`).values = [[`${pair.title}｜${pair.baseId} vs ${pair.changedId}`]];
    sheet.getRange(`A${sectionRow}:P${sectionRow}`).format = {
      fill: '#155E75', font: { size: 14, bold: true, color: '#FFFFFF' }, rowHeight: 30, verticalAlignment: 'center',
    };

    sheet.getRange(`A${sectionRow + 1}:H${sectionRow + 1}`).merge();
    sheet.getRange(`J${sectionRow + 1}:P${sectionRow + 1}`).merge();
    sheet.getRange(`A${sectionRow + 1}`).values = [[`基準 ${pair.baseId}｜行駛 ${pair.base.total_travel_minutes} 分｜等待 ${pair.base.total_waiting_minutes} 分｜遲到 ${pair.base.total_lateness_minutes} 分`]];
    sheet.getRange(`J${sectionRow + 1}`).values = [[`變更後 ${pair.changedId}｜行駛 ${pair.changed.total_travel_minutes} 分｜等待 ${pair.changed.total_waiting_minutes} 分｜遲到 ${pair.changed.total_lateness_minutes} 分`]];
    sheet.getRange(`A${sectionRow + 1}:H${sectionRow + 1}`).format = { fill: '#E8F1F8', font: { bold: true, color: '#1E3A5F' }, rowHeight: 28 };
    sheet.getRange(`J${sectionRow + 1}:P${sectionRow + 1}`).format = {
      fill: '#FEF3C7', font: { bold: true, color: '#991B1B' }, rowHeight: 28,
      borders: { preset: 'outside', style: 'medium', color: '#DC2626' },
    };

    sheet.getRange(`A${sectionRow + 2}:H${sectionRow + 3}`).merge();
    sheet.getRange(`J${sectionRow + 2}:P${sectionRow + 3}`).merge();
    sheet.getRange(`A${sectionRow + 2}`).values = [[`原路線：${baseRoute}`]];
    sheet.getRange(`J${sectionRow + 2}`).values = [[`新路線：${changedRoute}`]];
    sheet.getRange(`A${sectionRow + 2}:H${sectionRow + 3}`).format = { fill: '#F8FAFC', wrapText: true, verticalAlignment: 'center' };
    sheet.getRange(`J${sectionRow + 2}:P${sectionRow + 3}`).format = {
      fill: '#FFF7D6', font: { bold: true, color: '#991B1B' }, wrapText: true, verticalAlignment: 'center',
      borders: { preset: 'outside', style: 'medium', color: '#DC2626' },
    };

    sheet.getRange(`A${sectionRow + 4}:P${sectionRow + 4}`).merge();
    sheet.getRange(`A${sectionRow + 4}`).values = [[`重點：${pair.keyPoint}。${pair.summary}`]];
    sheet.getRange(`A${sectionRow + 4}:P${sectionRow + 4}`).format = {
      fill: '#FEF3C7', font: { bold: true, color: '#991B1B' }, rowHeight: 34, verticalAlignment: 'center', wrapText: true,
      borders: { preset: 'outside', style: 'medium', color: '#F59E0B' },
    };

    sheet.getRange(`A${sectionRow + 5}:P${sectionRow + 5}`).merge();
    sheet.getRange(`A${sectionRow + 5}`).values = [[`下圖為主路線 1280 x 900 原圖 1:1 並排；基準共 ${pair.base.driver_navigation_urls.length} 段，變更後共 ${pair.changed.driver_navigation_urls.length} 段。完整網址與返程分段請見「Google Maps」工作表及 map_screenshots 資料夾。`]];
    sheet.getRange(`A${sectionRow + 5}:P${sectionRow + 5}`).format = {
      fill: '#E8F1F8', font: { italic: true, color: '#1E3A5F' }, rowHeight: 24,
    };

    const imageStartRow = sectionRow + 6;
    const imageBytes = await fs.readFile(path.join(MAP_SCREENSHOT_DIR, pair.image));
    sheet.images.add({
      dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`,
      anchor: {
        from: { row: imageStartRow - 1, col: 0 },
        extent: { widthPx: 1900, heightPx: 911 },
      },
    });
    sheet.getRange(`A${imageStartRow}:P${imageStartRow + 27}`).format.rowHeight = 25;
    sectionRow += 35;
  }
  sheet.getRange(`A${sectionRow}:P${sectionRow + 1}`).format = { fill: '#FFFFFF', rowHeight: 20 };
}

function comparisonKeyPoint(caseId, changed) {
  if (caseId === 'D02' || caseId === 'R02') {
    const detail = changed?.priority_comparison;
    if (detail) {
      return `資料 ID ${detail.target_id} 的路線順位由 ${detail.baseline_rank} 提前至 ${detail.priority_rank}`;
    }
  }
  if (caseId === 'D03' || caseId === 'R03') {
    return `套用時間窗後等待 ${changed.total_waiting_minutes} 分、遲到 ${changed.total_lateness_minutes} 分，仍回傳可執行路線`;
  }
  if (caseId === 'E02') {
    return `${hm(changed.reoptimization?.current_time_seconds)} 從 index ${changed.reoptimization?.current_index} 重排，最後仍回公司`;
  }
  return '依最新測試結果比較路線順序與時間成本';
}

function comparisonSummary(base, changed) {
  const travel = roundDelta(changed.total_travel_minutes, base.total_travel_minutes);
  const waiting = roundDelta(changed.total_waiting_minutes, base.total_waiting_minutes);
  const lateness = roundDelta(changed.total_lateness_minutes, base.total_lateness_minutes);
  return `行駛 ${signedMinutes(travel)}；等待 ${signedMinutes(waiting)}；遲到 ${signedMinutes(lateness)}。`;
}

function roundDelta(next, previous) {
  return Math.round((Number(next || 0) - Number(previous || 0)) * 100) / 100;
}

function signedMinutes(value) {
  if (value === 0) return '不變';
  return `${value > 0 ? '+' : ''}${value} 分`;
}

async function buildTestDataComparisons(workbook) {
  const sheet = workbook.worksheets.add('測資對比');
  setupSheet(sheet);
  sheet.getRange('A1:P72').format.fill = '#FFFFFF';
  title(sheet, 'A1:P1', '測資內容與參數改動視覺對比');
  sheet.getRange('A2:P2').merge();
  sheet.getRange('A2').values = [['直接對照輸入資料；顏色儲存格代表相較基準測資有修改的欄位。']];
  sheet.getRange('A2:P2').format = {
    fill: '#E8F1F8', font: { bold: true, color: '#1E3A5F' }, rowHeight: 26, verticalAlignment: 'center',
  };

  const sections = [
    {
      row: 3,
      title: '正常情況｜D01 送貨基準與 R01 收貨基準',
      file: '測資對比_01_正常情況.png',
      note: '基準測資：時間格式統一為 24 小時制，未套用優先級、窄時間窗或不同服務時間。',
    },
    {
      row: 38,
      title: '調整測資參數｜D02 優先級與 R03 收貨時間窗',
      file: '測資對比_02_調整測資參數.png',
      note: '紫色＝優先級 1；黃色＝其他優先級調整；藍色＝重新設定的時間窗。',
    },
  ];

  for (const section of sections) {
    sheet.getRange(`A${section.row}:P${section.row}`).merge();
    sheet.getRange(`A${section.row}`).values = [[section.title]];
    sheet.getRange(`A${section.row}:P${section.row}`).format = {
      fill: '#155E75', font: { size: 13, bold: true, color: '#FFFFFF' }, rowHeight: 28, verticalAlignment: 'center',
    };

    const imageRow = section.row + 1;
    const imageBytes = await fs.readFile(path.join(DATA_COMPARISON_DIR, section.file));
    sheet.images.add({
      dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`,
      anchor: { from: { row: imageRow - 1, col: 0 }, extent: { widthPx: 1900, heightPx: 1069 } },
    });
    sheet.getRange(`A${imageRow}:P${imageRow + 31}`).format.rowHeightPx = 34;

    const noteRow = imageRow + 32;
    sheet.getRange(`A${noteRow}:P${noteRow}`).merge();
    sheet.getRange(`A${noteRow}`).values = [[section.note]];
    sheet.getRange(`A${noteRow}:P${noteRow}`).format = {
      fill: '#FFF7D6', font: { bold: true, color: '#7C2D12' }, rowHeight: 26, verticalAlignment: 'center',
      borders: { preset: 'outside', style: 'medium', color: '#F59E0B' },
    };
  }
  sheet.getRange('A:P').format.columnWidth = 15;
}

function setupSheet(sheet) {
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(3);
  sheet.getUsedRange()?.format && (sheet.getUsedRange().format.font = { name: 'Microsoft JhengHei', size: 10 });
}

function title(sheet, range, text) {
  sheet.getRange(range).merge();
  sheet.getRange(range.split(':')[0]).values = [[text]];
  sheet.getRange(range).format = {
    fill: '#155E75',
    font: { name: 'Microsoft JhengHei', size: 16, bold: true, color: '#FFFFFF' },
    rowHeight: 34,
    verticalAlignment: 'center',
  };
}

function styleTable(sheet, range) {
  const tableRange = sheet.getRange(range);
  tableRange.format.font = { name: 'Microsoft JhengHei', size: 10 };
  tableRange.format.borders = { insideHorizontal: { style: 'thin', color: '#D6E4E8' } };
  tableRange.getRow(0).format = { fill: '#0F766E', font: { bold: true, color: '#FFFFFF' }, rowHeight: 26 };
}

function hm(seconds) {
  if (seconds == null || seconds === '') return '';
  const safe = ((Math.round(Number(seconds)) % 86400) + 86400) % 86400;
  return `${String(Math.floor(safe / 3600)).padStart(2, '0')}:${String(Math.floor((safe % 3600) / 60)).padStart(2, '0')}`;
}

function roundMinutes(seconds) {
  return Math.round((Number(seconds || 0) / 60) * 100) / 100;
}
