import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`));
page.on('requestfailed', request => {
  console.log(`[REQUEST FAILED] ${request.method()} ${request.url()}`);
});

console.log('Navigating to http://localhost:5173...');
try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 10000 });
} catch (e) {
  console.log(`[NAV ERROR] ${e.message}`);
}

console.log('\n=== Testing API ===');
const result = await page.evaluate(async () => {
  try {
    const res = await fetch('/api/icecast/config');
    const data = await res.json();
    return { status: res.status, ok: res.ok, hasData: !!data };
  } catch (e) {
    return { error: e.message };
  }
});
console.log('API result:', JSON.stringify(result, null, 2));

await page.screenshot({ path: '/tmp/dashboard.png' });
console.log('Screenshot saved');

await browser.close();
