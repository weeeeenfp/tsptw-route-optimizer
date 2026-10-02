(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ExcelImportValidation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 送貨與收貨都不設硬性站點上限；24 筆（連同公司共 25 個地點）只是建議適用規模，
  // 超過時只提示效能警告，不擋下整份檔案。
  const RECOMMENDED_STATIONS = 24;
  const RECOMMENDED_RECEIVING_STATIONS = RECOMMENDED_STATIONS;
  const MAX_STATIONS = RECOMMENDED_STATIONS;   // 保留舊名稱供既有呼叫端相容
  const MAX_SERVICE_SECONDS = 86400;
  const COLUMN_HINTS = {
    id: ['ID', 'id', '編號', '序號'],
    name: ['Name (名稱)', 'Name', 'name', '名稱', '地點名稱', '站點名稱'],
    address: ['Address (地址)', 'Address', 'address', '地址', '配送地址'],
    tw_start: ['Time Window Start', 'tw_start', 'time_window_start', '開始時間', '最早'],
    tw_end: ['Time Window End', 'tw_end', 'time_window_end', '結束時間', '最晚'],
    priority: ['Priority', 'priority', '優先權', '優先序'],
    service: ['Service', 'service_time_seconds', '服務時間'],
  };

  function inferColumns(headers) {
    const normalized = (headers || []).map(header => [header, String(header).trim().toLowerCase()]);
    const result = {};
    Object.entries(COLUMN_HINTS).forEach(([key, hints]) => {
      const lowerHints = hints.map(hint => hint.toLowerCase());
      const match = normalized.find(([, lower]) => lowerHints.includes(lower));
      result[key] = match ? match[0] : '';
    });
    return result;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, '').toLowerCase();
  }

  function parseTimeValue(value, isEnd) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return { value: isEnd ? '23:59' : '00:00' };

    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      const second = Number(match[3] || 0);
      if (hour > 23 || minute > 59 || second > 59) {
        return { error: `時間「${text}」不是合法 24 小時制` };
      }
      return {
        value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        seconds: hour * 3600 + minute * 60 + second,
      };
    }

    const number = Number(text);
    if (!Number.isFinite(number)) return { error: `時間「${text}」格式無法辨識` };
    if (number > 0 && number < 1) {
      const seconds = Math.round(number * 86400);
      return { value: secondsToHM(seconds), seconds };
    }
    if (!Number.isInteger(number) && number > 1 && number < 60000) {
      const seconds = Math.round((number % 1) * 86400);
      return { value: secondsToHM(seconds), seconds };
    }
    if (isEnd && number === 0) return { value: '23:59', seconds: 86340 };
    if (!Number.isInteger(number) || number < 0 || number > 86399) {
      return { error: `時間秒數「${text}」必須介於 0 到 86399` };
    }
    return { value: secondsToHM(number), seconds: number };
  }

  function secondsToHM(seconds) {
    const safe = Math.max(0, Math.min(86399, Math.round(seconds)));
    const hour = Math.floor(safe / 3600);
    const minute = Math.floor((safe % 3600) / 60);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function validateRows(rows, headers, options) {
    const settings = Object.assign({ kind: '送貨', companyAddress: '', inferCompanyFromFirstRow: false }, options || {});
    const columns = inferColumns(headers);
    const errors = [];
    const warnings = [];
    ['id', 'name', 'address'].forEach(key => {
      if (!columns[key]) errors.push(`缺少必要欄位：${key === 'id' ? 'ID' : key === 'name' ? '名稱' : '地址'}`);
    });
    if (errors.length) return { ok: false, errors, warnings, columns, stationCount: 0 };

    const seenIds = new Set();
    rows.forEach((row, index) => {
      const excelRow = index + 2;
      const rawId = row[columns.id];
      const id = Number(rawId);
      if (String(rawId == null ? '' : rawId).trim() === '' || !Number.isInteger(id)) {
        errors.push(`第 ${excelRow} 列 ID 必須是整數`);
      } else if (seenIds.has(id)) {
        errors.push(`第 ${excelRow} 列 ID ${id} 重複`);
      } else {
        seenIds.add(id);
      }

      if (!String(row[columns.name] == null ? '' : row[columns.name]).trim()) errors.push(`第 ${excelRow} 列名稱不可空白`);
      if (!String(row[columns.address] == null ? '' : row[columns.address]).trim()) errors.push(`第 ${excelRow} 列地址不可空白`);

      const start = parseTimeValue(columns.tw_start ? row[columns.tw_start] : '', false);
      const end = parseTimeValue(columns.tw_end ? row[columns.tw_end] : '', true);
      if (start.error) errors.push(`第 ${excelRow} 列開始時間：${start.error}`);
      if (end.error) errors.push(`第 ${excelRow} 列結束時間：${end.error}`);
      if (!start.error && !end.error && start.seconds != null && end.seconds != null && start.seconds > end.seconds) {
        errors.push(`第 ${excelRow} 列開始時間不可晚於結束時間`);
      }

      if (columns.priority) {
        const raw = String(row[columns.priority] == null ? '' : row[columns.priority]).trim();
        if (raw) {
          const priority = Number(raw);
          if (!Number.isInteger(priority) || priority < 1 || priority > 5) errors.push(`第 ${excelRow} 列優先權必須是 1 到 5 的整數`);
        }
      }

      if (columns.service) {
        const raw = String(row[columns.service] == null ? '' : row[columns.service]).trim();
        if (raw) {
          const seconds = Number(raw);
          if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SERVICE_SECONDS) {
            errors.push(`第 ${excelRow} 列服務時間必須是 0 到 ${MAX_SERVICE_SECONDS} 的整數秒數`);
          }
        }
      }
    });

    let companyAddress = settings.companyAddress;
    if (!companyAddress && settings.inferCompanyFromFirstRow && rows.length) {
      const firstId = Number(rows[0][columns.id]);
      if (firstId === 0) companyAddress = String(rows[0][columns.address] || '').trim();
    }
    let stationCount = rows.length;
    if (settings.kind === '送貨' && companyAddress && rows.length) {
      const firstAddress = String(rows[0][columns.address] || '').trim();
      if (normalizeText(firstAddress) === normalizeText(companyAddress)) stationCount -= 1;
    }
    if (stationCount < 1) errors.push(`${settings.kind} Excel 至少需要 1 筆實際站點`);
    if (stationCount > RECOMMENDED_STATIONS) {
      warnings.push(`${settings.kind}站點共 ${stationCount} 筆，超過建議規模 ${RECOMMENDED_STATIONS} 筆；仍可執行，但建議增加求解 timeout`);
    }

    return { ok: errors.length === 0, errors, warnings, columns, stationCount };
  }

  return { inferColumns, parseTimeValue, validateRows, RECOMMENDED_STATIONS, MAX_STATIONS, RECOMMENDED_RECEIVING_STATIONS, MAX_SERVICE_SECONDS };
});
