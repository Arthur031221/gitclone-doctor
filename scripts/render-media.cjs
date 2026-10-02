const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function render() {
  const root = path.resolve(__dirname, '..');
  const htmlPath = path.join(root, 'assets', 'social-card.html');
  const outputPath = path.join(root, 'assets', 'social-card.png');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 675 },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    const dimensions = await page.locator('#canvas').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    if (dimensions.width !== 1200 || dimensions.height !== 675) throw new Error('dimensions');
    await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 1200, height: 675 } });
  } finally {
    await browser.close();
  }
}

render().catch(() => {
  process.stderr.write('Share card render failed.\n');
  process.exitCode = 1;
});
