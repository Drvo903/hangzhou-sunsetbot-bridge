import { chromium } from 'playwright';
import { mkdir, writeFile, rename } from 'node:fs/promises';

const BASE_URL = process.env.SUNSETBOT_URL || 'https://sunsetbot.top/';
const OUT = process.env.OUTPUT_FILE || 'public/hangzhou.json';
const TZ = 'Asia/Shanghai';

const eventDefs = [
  ['today_sunrise', '今天日出'], ['today_sunset', '今天日落'],
  ['tomorrow_sunrise', '明天日出'], ['tomorrow_sunset', '明天日落'],
];

function level(q) {
  if (q == null) return null;
  if (q < 0.001) return '不烧';
  if (q < 0.05) return '微微烧';
  if (q < 0.2) return '小烧';
  if (q < 0.4) return '小烧到中烧';
  if (q < 0.6) return '中等烧';
  if (q < 0.8) return '中等烧到大烧';
  if (q < 1.0) return '接近大烧';
  if (q < 1.5) return '典型大烧';
  if (q < 2.0) return '优质大烧';
  return '世纪大烧';
}

const wait = page => page.waitForTimeout(1300);

async function chooseByText(page, text) {
  const target = page.getByText(text, { exact: true }).last();
  await target.waitFor({ state: 'visible', timeout: 15000 });
  await target.click();
  await wait(page);
}

async function chooseHangzhou(page) {
  const inputs = page.locator('input:visible');
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    try {
      await input.fill('杭州');
      await page.waitForTimeout(500);
      const hz = page.getByText(/^(浙江省-)?杭州$/, { exact: false }).last();
      if (await hz.isVisible().catch(() => false)) {
        await hz.click();
        await wait(page);
        return;
      }
      await input.press('Enter');
      await wait(page);
      if ((await page.locator('body').innerText()).includes('浙江省-杭州')) return;
    } catch { /* try the next visible input */ }
  }
  throw new Error('未能在页面中选择杭州；请查看 debug 截图和页面 HTML。');
}

function parseText(text, model) {
  const event = text.match(/浙江省-杭州\s+(日出|日落)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  const quality = text.match(/鲜艳度\s*([0-9.]+)/);
  const aod = text.match(/气溶胶\s*([0-9.]+)/);
  const modelTime = text.match(/(?:凌晨|早晨|上午|中午|下午|傍晚|晚上)?时次\s*(\d{10}z)/i);
  const actualModel = text.match(/预报模型\s*(GFS|EC)/i)?.[1]?.toUpperCase();
  if (!event || !quality) throw new Error(`页面结果解析失败 (${model})`);
  if (actualModel && actualModel !== model) throw new Error(`模型切换失败：期望 ${model}，实际 ${actualModel}`);
  const q = Number(quality[1]);
  return {
    quality: q,
    level: level(q),
    aod: aod ? Number(aod[1]) : null,
    event_time: event[2],
    model_time: modelTime?.[1] ?? null,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'zh-CN', timezoneId: TZ, viewport: { width: 1440, height: 1100 } });
  const jsonResponses = [];
  page.on('response', async response => {
    if (!response.ok()) return;
    if (!response.headers()['content-type']?.includes('json')) return;
    try { jsonResponses.push({ url: response.url(), body: await response.json() }); } catch {}
  });

  const output = {
    updated_at: new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(' ', 'T') + '+08:00',
    city: '杭州', source: BASE_URL,
  };

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await chooseHangzhou(page);
    for (const [key, label] of eventDefs) {
      output[key] = {};
      await chooseByText(page, label);
      for (const [model, labelText] of [['GFS', /数据源:\s*GFS/], ['EC', /数据源:\s*EC/]]) {
        await page.getByText(labelText).last().click();
        await wait(page);
        output[key][model] = parseText(await page.locator('body').innerText(), model);
      }
    }
    output.meta = { captured_json_responses: jsonResponses.length };
    await mkdir(OUT.substring(0, OUT.lastIndexOf('/')), { recursive: true });
    await writeFile(`${OUT}.tmp`, JSON.stringify(output, null, 2) + '\n');
    await rename(`${OUT}.tmp`, OUT);
  } catch (error) {
    await mkdir('debug', { recursive: true });
    await page.screenshot({ path: 'debug/failure.png', fullPage: true }).catch(() => {});
    await writeFile('debug/page.html', await page.content()).catch(() => {});
    await writeFile('debug/responses.json', JSON.stringify(jsonResponses, null, 2)).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

await main();
