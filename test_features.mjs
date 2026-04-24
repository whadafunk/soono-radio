import { chromium } from './node_modules/playwright/index.mjs';

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  // Navigate to dashboard
  console.log('Navigating to dashboard...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  
  // Check for restart button
  const restartButton = await page.$('button:has-text("Restart Icecast")');
  if (restartButton) {
    console.log('✓ Restart button found on dashboard');
    await page.screenshot({ path: '/tmp/dashboard.png', fullPage: true });
    console.log('✓ Dashboard screenshot saved');
  } else {
    console.log('✗ Restart button not found');
  }
  
  // Navigate to settings
  console.log('\nNavigating to settings...');
  const settingsLink = await page.$('a[href*="settings"]');
  if (settingsLink) {
    await settingsLink.click();
    await page.waitForLoadState('networkidle');
  }
  
  // Check for password inputs
  const passwordInputs = await page.$$('input[type="password"]');
  console.log(`Found ${passwordInputs.length} password inputs`);
  
  if (passwordInputs.length > 0) {
    console.log('✓ Password fields found in settings');
  }
  
  await page.screenshot({ path: '/tmp/settings.png', fullPage: true });
  console.log('✓ Settings screenshot saved');
  
} catch (error) {
  console.error('Error:', error);
} finally {
  await browser.close();
}
