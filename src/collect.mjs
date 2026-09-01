import { chromium } from 'playwright';
import { mkdir, writeFile, rename } from 'node:fs/promises';

const BASE_URL = process.env.SUNSETBOT_URL || 'https://sunsetbot.top/';
const OUT = process.env.OUTPUT_FILE || 'public/hangzhou.json';
const HTML_OUT = process.env.HTML_OUTPUT_FILE || 'public/index.html';
const TEXT_OUT = process.env.TEXT_OUTPUT_FILE || 'public/hangzhou.txt';
const TZ = 'Asia/Shanghai';

const eventDefs = [
  ['today_sunrise', 'rise_1'], ['today_sunset', 'set_1'],
  ['tomorrow_sunrise', 'rise_2'], ['tomorrow_sunset', 'set_2'],
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

const eventLabels = {
  today_sunrise: '今日日出',
  today_sunset: '今日日落',
  tomorrow_sunrise: '明日日出',
  tomorrow_sunset: '明日日落',
};

function formatModel(model) {
  if (!model || model.status === 'unavailable' || model.quality == null) return '不可用';
  return `鲜艳度 ${model.quality}；等级 ${model.level ?? '未知'}；AOD ${model.aod ?? '未知'}；事件时间 ${model.event_time ?? '未知'}；模型时次 ${model.model_time ?? '未知'}`;
}

function renderText(output) {
  const lines = [
    '杭州朝霞晚霞预测',
    `数据更新时间：${output.updated_at}`,
    `城市：${output.city}`,
    '',
  ];
  for (const [key] of eventDefs) {
    const item = output[key] ?? {};
    lines.push(eventLabels[key]);
    lines.push(`GFS：${formatModel(item.GFS)}`);
    lines.push(`EC：${formatModel(item.EC)}`);
    lines.push('');
  }
  lines.push(`原始来源：${output.source}`);
  return lines.join('\n') + '\n';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtml(output) {
  const body = escapeHtml(renderText(output));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>杭州朝霞晚霞预测</title>
  <style>
    body { max-width: 860px; margin: 32px auto; padding: 0 20px; color: #1f2937; font: 16px/1.7 system-ui, sans-serif; }
    h1 { font-size: 28px; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 20px; background: #f6f8fa; border-radius: 12px; }
    .links { margin-top: 18px; }
  </style>
</head>
<body>
  <h1>杭州朝霞晚霞预测</h1>
  <p>这是供普通浏览器与 ChatGPT 网页读取通道使用的静态正文页。</p>
  <pre>${body}</pre>
  <p class="links"><a href="hangzhou.txt">纯文本</a> · <a href="hangzhou.json">原始 JSON</a></p>
</body>
</html>
`;
}

async function chooseHangzhou(page) {
  await page.locator('#city_input').fill('杭州');
}

function parseResponse(data, model) {
  const q = Number.parseFloat(data.tb_quality);
  const aod = Number.parseFloat(data.tb_aod);
  if (!Number.isFinite(q)) throw new Error(`响应鲜艳度解析失败 (${model})`);
  if (data.display_model?.toUpperCase() !== model) {
    throw new Error(`模型切换失败：期望 ${model}，实际 ${data.display_model}`);
  }
  return {
    quality: q,
    level: level(q),
    aod: Number.isFinite(aod) ? aod : null,
    event_time: data.tb_event_time ?? null,
    model_time: data.display_times_str ?? null,
  };
}

async function fetchSelection(page, event, model) {
  await page.evaluate(({ event, model }) => {
    document.querySelector('#event_selector').value = event;
    document.querySelector('#model_selector').value = model;
  }, { event, model });
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('intend=select_city') && response.request().resourceType() === 'xhr',
    { timeout: 30000 },
  );
  await page.locator('#srch_btn').click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`SunsetBot 查询失败：HTTP ${response.status()}`);
  const data = await response.json();
  if (data.status === 'not_found') throw new Error(`SunsetBot 暂无数据：${event}/${model}`);
  return parseResponse(data, model);
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
  let successfulSelections = 0;
  const failures = [];

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await chooseHangzhou(page);
    for (const [key, event] of eventDefs) {
      output[key] = {};
      for (const model of ['GFS', 'EC']) {
        try {
          output[key][model] = await fetchSelection(page, event, model);
          successfulSelections += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ key, model, reason });
          output[key][model] = {
            status: 'unavailable', quality: null, level: null, aod: null,
            event_time: null, model_time: null,
          };
        }
      }
    }
    if (successfulSelections === 0) throw new Error('全部 SunsetBot 查询均失败');
    output.meta = {
      successful_selections: successfulSelections,
      captured_json_responses: jsonResponses.length,
      failures,
    };
    await mkdir(OUT.substring(0, OUT.lastIndexOf('/')), { recursive: true });
    await writeFile(`${OUT}.tmp`, JSON.stringify(output, null, 2) + '\n');
    await rename(`${OUT}.tmp`, OUT);
    await writeFile(`${TEXT_OUT}.tmp`, renderText(output));
    await rename(`${TEXT_OUT}.tmp`, TEXT_OUT);
    await writeFile(`${HTML_OUT}.tmp`, renderHtml(output));
    await rename(`${HTML_OUT}.tmp`, HTML_OUT);
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
