import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUTPUT_ROOT = path.join(ROOT, 'outputs', 'report_function_tests_20260715');
const manifest = JSON.parse(await fs.readFile(path.join(OUTPUT_ROOT, 'manifest.json'), 'utf8'));
const config = await readConfig();
const apiKey = String(config.google_maps_api_key || '').trim();
if (!apiKey) throw new Error('未設定 Google Maps API Key，無法重建報告用矩陣');

const scenarios = new Map(manifest.scenarios.map(item => [item.case_id, item]));
const definitions = {
  delivery: {
    file: path.join(OUTPUT_ROOT, 'delivery_matrix.json'),
    addresses: [
      manifest.company.address,
      ...scenarios.get('D01').rows.map(row => row.address),
    ],
  },
  receiving: {
    file: path.join(OUTPUT_ROOT, 'receiving_matrix.json'),
    addresses: [
      manifest.company.address,
      manifest.receiving_start.address,
      ...scenarios.get('R01').rows.map(row => row.address),
    ],
  },
};

const summary = {};
for (const [kind, definition] of Object.entries(definitions)) {
  const matrix = await fetchDistanceMatrix(definition.addresses, apiKey);
  await fs.writeFile(definition.file, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  summary[kind] = { file: definition.file, location_count: definition.addresses.length };
}
console.log(JSON.stringify(summary, null, 2));

async function readConfig() {
  const base = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  try {
    const local = JSON.parse(await fs.readFile(path.join(ROOT, 'config.local.json'), 'utf8'));
    return { ...base, ...local };
  } catch (error) {
    if (error.code === 'ENOENT') return base;
    throw error;
  }
}

async function fetchDistanceMatrix(addresses, key) {
  const timeMatrix = Array.from({ length: addresses.length }, () => Array(addresses.length).fill(0));
  const distanceMatrix = Array.from({ length: addresses.length }, () => Array(addresses.length).fill(0));
  const chunkSize = 10;

  for (let row = 0; row < addresses.length; row += chunkSize) {
    const origins = addresses.slice(row, row + chunkSize);
    for (let col = 0; col < addresses.length; col += chunkSize) {
      const destinations = addresses.slice(col, col + chunkSize);
      const query = new URLSearchParams({
        origins: origins.join('|'),
        destinations: destinations.join('|'),
        mode: 'driving',
        language: 'zh-TW',
        key,
      });
      const response = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${query}`);
      if (!response.ok) throw new Error(`Google Distance Matrix HTTP ${response.status}`);
      const data = await response.json();
      if (data.status !== 'OK') throw new Error(`Google Distance Matrix ${data.status}: ${data.error_message || 'unknown error'}`);
      data.rows.forEach((resultRow, rowOffset) => {
        resultRow.elements.forEach((element, colOffset) => {
          if (element.status !== 'OK') {
            throw new Error(`Google Distance Matrix element ${element.status}: ${origins[rowOffset]} -> ${destinations[colOffset]}`);
          }
          timeMatrix[row + rowOffset][col + colOffset] = element.duration.value;
          distanceMatrix[row + rowOffset][col + colOffset] = element.distance.value;
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return { addresses, time_matrix: timeMatrix, distance_matrix: distanceMatrix };
}
