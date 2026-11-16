import { chromium } from 'playwright-core';
import { createApp } from '../src/server.js';

const exec = process.env.PLAYWRIGHT_CHROME ?? '/tmp/pw-browsers/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';

const server = createApp({ dbPath: ':memory:', replayRate: 60_000 });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: exec, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1460, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
const expectedValidationErrors = [];
page.on('response', async (response) => {
  if (response.status() >= 400) {
    let body = '';
    try {
      body = (await response.text()).slice(0, 300);
    } catch {}
    const line = `http ${response.status()} ${response.request().method()} ${response.url()} :: ${body}`;
    // Typing an invalid expression in the editor intentionally provokes a 400
    // from live validation; that is product behaviour, not a defect.
    if (response.status() === 400 && response.url().includes('/api/versions/')) expectedValidationErrors.push(line);
    else errors.push(line);
  }
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.log(`✗ ${name}: ${error.message}`);
    errors.push(`${name}: ${error.message}`);
  }
};

await step('load console', async () => {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#active-summary .list-item.active');
});

await step('seed events', async () => {
  for (let i = 0; i < 5; i += 1) {
    await page.click('#sim-step');
    await page.waitForTimeout(180);
  }
  await page.waitForFunction(() => document.querySelector('#counts')?.textContent?.includes('原始事件'));
});

await step('counters update', async () => {
  const text = await page.textContent('#counts');
  if (!text.includes('原始事件')) throw new Error('counts missing');
});

await step('rules tab lists version', async () => {
  await page.click('.tab[data-view="rules"]');
  await page.waitForSelector('.version.selected');
});

await step('new draft shows editor', async () => {
  await page.click('#new-draft');
  await page.waitForFunction(() => document.querySelector('#editor-status')?.textContent?.includes('草稿'));
});

await step('invalid expression surfaces error', async () => {
  await page.fill('#ed-group', 'foo(bar)');
  await page.waitForTimeout(1200);
  const err = await page.textContent('#ed-error');
  if (!err || !err.includes('函数') && !err.includes('字段')) throw new Error(`expected validation error, got "${err}"`);
});

await step('valid change classifies as rebuild', async () => {
  await page.fill('#ed-group', 'lower(region)');
  await page.waitForTimeout(1600);
  const summary = await page.textContent('#change-summary');
  if (!summary.includes('必须重建')) throw new Error(`expected rebuild banner, got ${summary.slice(0, 120)}`);
  await page.waitForSelector('#preview table, #preview .empty');
});

await step('migrate classification on aggregate change', async () => {
  await page.fill('#ed-group', 'coalesce(device, "unknown")');
  await page.waitForTimeout(1000);
  await page.selectOption('#ed-aggregate', 'avg');
  await page.waitForTimeout(1600);
  const summary = await page.textContent('#change-summary');
  if (!summary.includes('可以迁移')) throw new Error(`expected migrate banner, got ${summary.slice(0, 120)}`);
});

await step('publish migrate immediately', async () => {
  await page.click('#publish-direct');
  await page.waitForTimeout(1200);
  const text = await page.textContent('#topbar-status');
  if (!text.includes('v2')) throw new Error(`expected v2 active, got ${text}`);
});

await step('launch legacy executor', async () => {
  await page.click('.tab[data-view="overview"]');
  await page.click('#legacy-launch');
  await page.waitForFunction(() => document.querySelector('#sim-status')?.textContent?.includes('旧执行器'));
});

await step('shadow rebuild from the UI', async () => {
  await page.click('.tab[data-view="rules"]');
  await page.click('#new-draft');
  await page.waitForFunction(() => document.querySelector('#editor-status')?.textContent?.includes('草稿'));
  await page.fill('#ed-label', '按地区重新分组');
  await page.fill('#ed-group', 'lower(coalesce(region, "unknown"))');
  await page.waitForTimeout(1600);
  const summary = await page.textContent('#change-summary');
  if (!summary.includes('必须重建')) throw new Error(`expected rebuild banner, got ${summary.slice(0, 120)}`);
  await page.click('#publish-shadow');
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#topbar-status')?.textContent ?? '';
      return /v3/.test(status) && !/重建中/.test(status);
    },
    { timeout: 20_000 },
  );
});

await step('shadow rebuild job is visible and complete', async () => {
  await page.click('.tab[data-view="overview"]');
  await page.waitForSelector('#jobs .change');
  const jobs = await page.textContent('#jobs');
  if (!jobs.includes('已完成')) throw new Error(`expected a finished job, got ${jobs.slice(0, 160)}`);
  if (!jobs.includes('影子追赶')) throw new Error('expected shadow strategy label');
});

await step('stale executor reports are recorded, not merged', async () => {
  await page.waitForFunction(
    () => Number(document.querySelector('#counts')?.textContent?.match(/过期上报\s*(\d+)/)?.[1] ?? 0) > 0
      || (document.querySelector('#stale-list')?.textContent ?? '').includes('凭据过期'),
    { timeout: 20_000 },
  );
  const stale = await page.textContent('#stale-list');
  if (!stale.includes('凭据过期') && !stale.includes('规则版本过期')) {
    throw new Error(`expected stale rejection in list, got ${stale.slice(0, 160)}`);
  }
});

await step('pause and resume from the UI', async () => {
  await page.waitForFunction(() => !document.querySelector('#pause-btn')?.disabled);
  await page.click('#pause-btn');
  await page.waitForFunction(() => document.querySelector('#topbar-status')?.textContent?.includes('已暂停'));
  await page.waitForFunction(() => !document.querySelector('#resume-btn')?.disabled);
  await page.click('#resume-btn');
  await page.waitForFunction(() => document.querySelector('#topbar-status')?.textContent?.includes('执行器活动'));
});

await step('results tab renders', async () => {
  await page.click('.tab[data-view="results"]');
  await page.waitForSelector('#results-table table, #results-table .empty');
  await page.waitForSelector('#adj-table table');
});

await step('timeline verify', async () => {
  await page.click('.tab[data-view="timeline"]');
  await page.waitForSelector('#epoch-timeline .epoch-row');
  await page.click('#verify-btn');
  await page.waitForFunction(() => document.querySelector('#verify-result')?.textContent?.includes('通过'), { timeout: 15_000 });
});

await step('help tab', async () => {
  await page.click('.tab[data-view="help"]');
  await page.waitForSelector('#help-fields table');
});

await page.screenshot({ path: '/tmp/console-help.png', fullPage: true });
await page.click('.tab[data-view="overview"]');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/console-overview.png', fullPage: true });

const unexpectedConsole = consoleErrors.filter(
  (text) => !/Failed to load resource: the server responded with a status of 400/.test(text),
);
for (const text of unexpectedConsole) errors.push(`console: ${text}`);
console.log(`（预期中的校验 400：${expectedValidationErrors.length} 次；无其他控制台错误：${unexpectedConsole.length === 0}）`);
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nAll UI checks passed.');
await browser.close();
server.closeDb();
server.close();
process.exit(errors.length ? 1 : 0);
