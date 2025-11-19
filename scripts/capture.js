import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const DEFAULT_BASE_URL = process.env.CAPTURE_BASE_URL || 'http://localhost:5173';
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 4;
const OUTPUT_SCALE_MODE = 4;
const DEFAULT_TARGETS = [
  {
    id: 'features',
    label: 'Feature dialogs',
    path: '/feature-dialog-capture.html',
    outputParts: ['docs', 'features'],
  },
  {
    id: 'pmi',
    label: 'PMI annotations',
    path: '/pmi-dialog-capture.html',
    outputParts: ['docs', 'pmi-annotations'],
  },
  {
    id: 'assembly',
    label: 'Assembly constraints',
    path: '/assembly-constraint-capture.html',
    outputParts: ['docs', 'assembly-constraints'],
  },
];

async function run() {
  // sleep 4 seconds
  await new Promise(resolve => setTimeout(resolve, 4000));


  const targets = resolveTargets();
  if (!targets.length) {
    console.warn('⚠️  No capture targets selected. Use CAPTURE_SCOPE or CAPTURE_URL to configure targets.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await context.newPage();
  let totalCaptured = 0;

  for (const target of targets) {
    const count = await captureDialogsForTarget(page, target);
    totalCaptured += count;
  }

  await context.close();
  await browser.close();
  console.log(`✅ Saved ${totalCaptured} dialog screenshots across ${targets.length} target(s).`);
}

function resolveTargets() {
  if (process.env.CAPTURE_URL) {
    const output = process.env.CAPTURE_OUTPUT
      ? resolve(process.cwd(), process.env.CAPTURE_OUTPUT)
      : resolve(process.cwd(), 'docs', 'features');
    return [{
      id: 'custom',
      label: 'Custom capture',
      targetUrl: process.env.CAPTURE_URL,
      outputDir: output,
    }];
  }

  const scope = parseScope(process.env.CAPTURE_SCOPE);
  return DEFAULT_TARGETS
    .filter((target) => !scope || scope.has(target.id))
    .map((target) => ({
      ...target,
      targetUrl: resolveUrl(DEFAULT_BASE_URL, target.path),
      outputDir: resolve(process.cwd(), ...target.outputParts),
    }));
}

function parseScope(scopeValue) {
  if (!scopeValue) return null;
  const parts = scopeValue.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  return parts.length ? new Set(parts) : null;
}

async function captureDialogsForTarget(page, target) {
  console.log(`▶️  Capturing ${target.label} from ${target.targetUrl}`);
  await page.goto(target.targetUrl, { waitUntil: 'networkidle' });
  await waitForFonts(page);

  const cardLocator = page.locator('.dialog-card');
  await cardLocator.first().waitFor({ state: 'visible', timeout: 15000 });
  await mkdir(target.outputDir, { recursive: true });

  const cards = await cardLocator.all();
  if (!cards.length) {
    throw new Error(`No dialog cards found at ${target.targetUrl}`);
  }

  let capturedCount = 0;
  for (const card of cards) {
    const captureName = await pickCaptureName(card);
    const fileSafe = captureName.replace(/[^a-z0-9._-]+/gi, '_') || 'Dialog';
    const dialog = card.locator('.dialog-form');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.scrollIntoViewIfNeeded();
    const targetPath = join(target.outputDir, `${fileSafe}_dialog.png`);
    const buffer = await dialog.screenshot({
      path: targetPath,
      scale: 'device',
      animations: 'disabled',
    });
    await maybeNormalizeScreenshot(page, buffer, targetPath);
    console.log(`  • ${captureName} → ${targetPath}`);
    capturedCount += 1;
  }

  console.log(`✅ Saved ${capturedCount} dialog screenshots to ${target.outputDir}`);
  return capturedCount;
}

async function waitForFonts(page) {
  try {
    await page.evaluate(async () => {
      if (document.fonts && typeof document.fonts.ready === 'object') {
        try {
          await document.fonts.ready;
        } catch {
          // ignore font readiness errors
        }
      }
    });
  } catch {
    // ignore evaluation errors
  }
}

async function pickCaptureName(card) {
  const displayNameRaw = await card.getAttribute('data-feature-name');
  const shortNameRaw = await card.getAttribute('data-feature-short-name');
  const displayNameTrimmed = displayNameRaw ? displayNameRaw.trim() : '';
  const shortNameTrimmed = shortNameRaw ? shortNameRaw.trim() : '';
  return displayNameTrimmed || shortNameTrimmed || 'Dialog';
}

function resolveUrl(base, path) {
  try {
    return new URL(path, base).toString();
  } catch {
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }
}

async function maybeNormalizeScreenshot(page, buffer, targetPath) {
  if (OUTPUT_SCALE_MODE !== 'css') return;
  if (DEVICE_SCALE_FACTOR <= 1) return;
  if (!buffer?.length) return;
  const normalized = await downscaleScreenshot(page, buffer, DEVICE_SCALE_FACTOR);
  if (!normalized) return;
  await writeFile(targetPath, normalized);
}

async function downscaleScreenshot(page, buffer, scale) {
  try {
    const base64Data = buffer.toString('base64');
    const normalizedBase64 = await page.evaluate(async ({ data, factor }) => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const targetWidth = Math.max(1, Math.round(bitmap.width / factor));
      const targetHeight = Math.max(1, Math.round(bitmap.height / factor));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      const result = canvas.toDataURL('image/png');
      return result.slice(result.indexOf(',') + 1);
    }, { data: base64Data, factor: scale /2});
    return Buffer.from(normalizedBase64, 'base64');
  } catch (error) {
    console.warn('⚠️  Failed to downscale screenshot:', error);
    return null;
  }
}

function resolveDeviceScaleFactor(value) {
  const fallback = 2;
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(`⚠️  Invalid device scale factor "${value}". Falling back to ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function resolveOutputScale(value, deviceScale) {
  if (!value) {
    return deviceScale > 1 ? 'css' : 'device';
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'device' ? 'device' : 'css';
}

run().catch((err) => {
  console.error('❌ Capture failed:', err);
  process.exitCode = 1;
});
