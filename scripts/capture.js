import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const DEFAULT_TARGET_URL = 'http://localhost:5173/feature-dialog-capture.html';
const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'docs', 'features');

const TARGET_URL = process.env.CAPTURE_URL || DEFAULT_TARGET_URL;
const OUTPUT_DIR = process.env.CAPTURE_OUTPUT || DEFAULT_OUTPUT_DIR;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
  try {
    await page.evaluate(async () => {
      if (document.fonts && typeof document.fonts.ready === 'object') {
        try { await document.fonts.ready; } catch { /* ignore font readiness errors */ }
      }
    });
  } catch (_) { /* ignore font readiness errors */ }

  const cardLocator = page.locator('.dialog-card');
  await cardLocator.first().waitFor({ state: 'visible', timeout: 15000 });

  await mkdir(OUTPUT_DIR, { recursive: true });

  const cards = await cardLocator.all();
  let capturedCount = 0;
  for (const card of cards) {
    const displayNameRaw = await card.getAttribute('data-feature-name');
    const shortNameRaw = await card.getAttribute('data-feature-short-name');
    const displayNameTrimmed = displayNameRaw ? displayNameRaw.trim() : '';
    const shortNameTrimmed = shortNameRaw ? shortNameRaw.trim() : '';
    const captureName = displayNameTrimmed || shortNameTrimmed || 'Feature';
    const fileSafe = captureName.replace(/[^a-z0-9._-]+/gi, '_');
    const dialog = card.locator('.dialog-form');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.scrollIntoViewIfNeeded();
    const targetPath = join(OUTPUT_DIR, `${fileSafe}.png`);
    await dialog.screenshot({ path: targetPath });
    console.log(`Captured ${captureName} → ${targetPath}`);
    capturedCount += 1;
  }

  await browser.close();
  console.log(`✅ Saved ${capturedCount} dialog screenshots to ${OUTPUT_DIR}`);
}

run().catch((err) => {
  console.error('❌ Capture failed:', err);
  process.exitCode = 1;
});
