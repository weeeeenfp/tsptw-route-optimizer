import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUTPUT_ROOT = path.join(ROOT, 'outputs', 'report_function_tests_20260715');
const RESULTS_FILE = path.join(OUTPUT_ROOT, 'results.json');
const SCREENSHOT_DIR = path.join(OUTPUT_ROOT, 'map_screenshots');
const PNPM_MODULE_DIR = path.join(import.meta.dirname, 'node_modules', '.pnpm');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORT = { width: 1280, height: 900 };
const requestedCase = process.argv.find(arg => arg.startsWith('--case='))?.split('=')[1]?.toUpperCase();
const debug = process.argv.includes('--debug');

const caseNames = {
  D01: 'D01_送貨_基準',
  D02: 'D02_送貨_優先級',
  D03: 'D03_送貨_時間窗',
  D04: 'D04_送貨_服務時間',
  R01: 'R01_收貨_基準',
  R02: 'R02_收貨_優先級',
  R03: 'R03_收貨_軟性時間窗',
  R04: 'R04_收貨_服務時間',
  R05: 'R05_收貨_超過25點',
  E01: 'E01_途中重排_狀態更新',
  E02: 'E02_途中重排_客戶改約',
};

const results = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
const cases = results.results.filter(item => caseNames[item.case_id] && item.driver_navigation_urls?.length);
const selectedCases = requestedCase ? cases.filter(item => item.case_id === requestedCase) : cases;
if (!selectedCases.length) throw new Error(`找不到可截圖案例：${requestedCase || '全部'}`);

const playwrightCorePackage = (await fs.readdir(PNPM_MODULE_DIR))
  .filter(name => name.startsWith('playwright-core@'))
  .sort()
  .at(-1);
if (!playwrightCorePackage) throw new Error(`找不到 Playwright Core：${PNPM_MODULE_DIR}`);
const playwrightCorePath = path.join(PNPM_MODULE_DIR, playwrightCorePackage, 'node_modules', 'playwright-core', 'index.mjs');
const { chromium } = await import(pathToFileURL(playwrightCorePath).href);

await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME_PATH,
  args: [
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    '--lang=zh-TW',
    '--disable-features=Translate,MediaRouter',
  ],
});

const outputRecords = [];
try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    screen: VIEWPORT,
    locale: 'zh-TW',
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });

  for (const item of selectedCases) {
    for (let index = 0; index < item.driver_navigation_urls.length; index += 1) {
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      const url = item.driver_navigation_urls[index];
      const filename = screenshotFilename(item.case_id, index, item.driver_navigation_urls.length);
      const outputPath = path.join(SCREENSHOT_DIR, filename);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await dismissConsent(page);
        await waitForMapRoute(page);
        await collapseDirectionsPanel(page);
        await page.waitForTimeout(5000);
        await page.screenshot({ path: outputPath, type: 'png', animations: 'disabled' });

        if (debug) {
          const labels = await page.locator('[aria-label]').evaluateAll(nodes =>
            nodes.map(node => node.getAttribute('aria-label')).filter(Boolean).filter(label => /收合|展開|collapse|expand/i.test(label)),
          );
          console.log(JSON.stringify({ case_id: item.case_id, segment: index + 1, panelLabels: [...new Set(labels)] }));
        }

        const stat = await fs.stat(outputPath);
        outputRecords.push({ case_id: item.case_id, segment: index + 1, filename, bytes: stat.size, url });
        console.log(`[map] ${item.case_id} ${index + 1}/${item.driver_navigation_urls.length}: ${filename}`);
      } finally {
        await page.close();
      }
    }
  }

  await context.close();
} finally {
  await browser.close();
}

let manifestRecords = outputRecords;
if (requestedCase) {
  const existingManifest = await readExistingManifest();
  manifestRecords = existingManifest
    .filter(record => record.case_id !== requestedCase)
    .concat(outputRecords)
    .sort((left, right) => left.case_id.localeCompare(right.case_id) || left.segment - right.segment);
}

await fs.writeFile(
  path.join(SCREENSHOT_DIR, 'screenshot_manifest.json'),
  JSON.stringify({
    captured_at: '2026-07-16',
    viewport: VIEWPORT,
    source: 'outputs/report_function_tests_20260715/results.json',
    screenshots: manifestRecords,
  }, null, 2),
  'utf8',
);

console.log(JSON.stringify({
  captured_screenshots: outputRecords.length,
  manifest_screenshots: manifestRecords.length,
  directory: SCREENSHOT_DIR,
}, null, 2));

function screenshotFilename(caseId, segmentIndex, segmentCount) {
  const base = caseNames[caseId];
  if (segmentCount === 1) return `${base}_主路線.png`;
  if (segmentCount === 2) return `${base}_${segmentIndex === 0 ? '主路線' : '返程'}.png`;
  if (segmentIndex === segmentCount - 1) return `${base}_第${segmentIndex + 1}段_返程.png`;
  return `${base}_第${segmentIndex + 1}段.png`;
}

async function dismissConsent(page) {
  const buttonNames = [/全部接受/i, /接受全部/i, /同意/i, /Accept all/i, /I agree/i];
  for (const name of buttonNames) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function waitForMapRoute(page) {
  try {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      return /分鐘|小時|公里|km|min/.test(text);
    }, null, { timeout: 30000 });
  } catch {
    console.warn(`[map] 未偵測到時間文字，改用固定等待：${page.url()}`);
  }
  await page.waitForTimeout(5000);
}

async function collapseDirectionsPanel(page) {
  const selectors = [
    'button[aria-label*="收合"]',
    'button[aria-label*="隱藏側欄"]',
    'button[aria-label*="Collapse"]',
    '[role="button"][aria-label*="收合"]',
    '[role="button"][aria-label*="Collapse"]',
    'button[jsaction*="pane.collapse"]',
    '[jsaction*="pane.collapse"]',
  ];
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    if (await control.isVisible().catch(() => false)) {
      await control.click({ force: true });
      await page.waitForTimeout(1200);
      return;
    }
  }

  const leftPanelWidth = await page.evaluate(() => {
    const elements = [...document.querySelectorAll('div')];
    const candidate = elements
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left <= 80 && rect.width >= 350 && rect.width <= 550 && rect.height >= 500)
      .sort((a, b) => b.rect.height - a.rect.height)[0];
    return candidate?.rect.width || 0;
  });
  if (leftPanelWidth >= 350) {
    await page.mouse.click(Math.min(leftPanelWidth + 7, 500), Math.round(VIEWPORT.height / 2));
    await page.waitForTimeout(1200);
  }
}

async function readExistingManifest() {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(SCREENSHOT_DIR, 'screenshot_manifest.json'), 'utf8'));
    return Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
  } catch {
    return [];
  }
}
