// Renders extension/icons/icon.svg to the PNG sizes the manifest needs.
// Usage: npm run icons   (uses the Playwright-managed Chromium)
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = await readFile(path.join(root, 'extension/icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: path.join(root, `extension/icons/icon${size}.png`), omitBackground: true });
}
await browser.close();
console.log('Icons written.');
