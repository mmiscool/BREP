import { FeatureRegistry } from '../FeatureRegistry.js';
import { SchemaForm } from '../UI/featureDialogs.js';
import { domNodeToPng } from '../utils/domToImage.js';
import { renderSchemaMock } from './renderSchemaMock.js';
import JSZip from 'jszip';

const registry = new FeatureRegistry();
const featureClasses = registry.features.slice();
let currentZipUrl = null;

injectPageStyles();

const appRoot = document.getElementById('app') || document.body;
appRoot.classList.add('capture-page');

const header = document.createElement('header');
header.className = 'capture-header';
header.innerHTML = `
  <h1>Feature Dialog Screenshot Helper</h1>
  <p>Generate up-to-date PNGs of every feature dialog. Edit inputs if needed, then capture individually or build a full ZIP.</p>
`;

const globalActions = document.createElement('div');
globalActions.className = 'capture-actions';

const captureAllBtn = makeActionButton('Capture All Dialogs');
const buildZipBtn = makeActionButton('Download ZIP');
buildZipBtn.disabled = true;

globalActions.append(captureAllBtn, buildZipBtn);

const statusLine = document.createElement('div');
statusLine.className = 'capture-status';
statusLine.textContent = 'Idle';

globalActions.appendChild(statusLine);

const cardsWrap = document.createElement('section');
cardsWrap.className = 'capture-grid';

const items = featureClasses.map((FeatureClass) => createCaptureItem(FeatureClass, cardsWrap));

captureAllBtn.addEventListener('click', async () => {
  captureAllBtn.disabled = true;
  buildZipBtn.disabled = true;
  statusLine.textContent = 'Capturing dialogs…';
  try {
    for (const item of items) {
      await item.capture(true);
    }
    statusLine.textContent = 'All dialogs captured. You can download individual PNGs or build a ZIP.';
    buildZipBtn.disabled = false;
  } catch (err) {
    console.error(err);
    statusLine.textContent = `Capture failed: ${err?.message || err}`;
  } finally {
    captureAllBtn.disabled = false;
  }
});

buildZipBtn.addEventListener('click', async () => {
  buildZipBtn.disabled = true;
  statusLine.textContent = 'Creating ZIP…';
  try {
    const blob = await buildZip(items);
    if (currentZipUrl) {
      URL.revokeObjectURL(currentZipUrl);
      currentZipUrl = null;
    }
    currentZipUrl = URL.createObjectURL(blob);
    triggerDownload(currentZipUrl, 'feature-dialogs.zip');
    statusLine.textContent = 'ZIP ready and download triggered.';
    buildZipBtn.disabled = false;
  } catch (err) {
    console.error(err);
    statusLine.textContent = `ZIP creation failed: ${err?.message || err}`;
    buildZipBtn.disabled = false;
  }
});

appRoot.append(header, globalActions, cardsWrap);

function createCaptureItem(FeatureClass, container) {
  const featureName = FeatureClass.featureName || FeatureClass.name || 'Feature';
  const slug = slugify(featureName);
  const params = { featureID: `${FeatureClass.featureShortName || slug}-capture` };
  const schema = FeatureClass.inputParamsSchema || {};
  const form = new SchemaForm(schema, params, { useShadowDOM: false });
  try { form.refreshFromParams(); } catch (_) { /* noop */ }

  const card = document.createElement('section');
  card.className = 'capture-card';

  const title = document.createElement('h2');
  title.textContent = featureName;

  const liveWrap = document.createElement('div');
  liveWrap.className = 'dialog-live';
  liveWrap.appendChild(form.uiElement);

  const previewWrap = document.createElement('div');
  previewWrap.className = 'dialog-preview';
  const previewImg = document.createElement('img');
  previewImg.alt = `${featureName} dialog preview`;
  previewImg.loading = 'lazy';
  previewImg.hidden = true;
  previewWrap.appendChild(previewImg);

  const infoLine = document.createElement('div');
  infoLine.className = 'card-info';
  infoLine.textContent = 'Not captured yet';

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const captureBtn = makeActionButton('Capture PNG');
  const downloadLink = document.createElement('a');
  downloadLink.className = 'action-btn secondary disabled';
  downloadLink.textContent = 'Download PNG';
  downloadLink.href = '#';
  downloadLink.setAttribute('download', `${slug}.png`);
  downloadLink.addEventListener('click', (ev) => {
    if (!downloadLink.dataset.ready) {
      ev.preventDefault();
    }
  });

  actions.append(captureBtn, downloadLink);

  card.append(title, liveWrap, infoLine, actions, previewWrap);
  container.appendChild(card);

  let dataUrl = null;

  const capture = async (force = false) => {
    if (!force && dataUrl) return dataUrl;
    captureBtn.disabled = true;
    infoLine.textContent = 'Capturing…';
    try {
      console.log('[FeatureCapture] Capturing dialog', featureName, form.uiElement);
      const result = await domNodeToPng(form.uiElement, {
        padding: 32,
        scale: 2,
        bgColor: '#0b0f16',
      });
      dataUrl = result.dataUrl;
      infoLine.textContent = `Captured ${Math.round(result.width)}×${Math.round(result.height)}px`;
      previewImg.src = dataUrl;
      previewImg.hidden = false;
      downloadLink.href = dataUrl;
      downloadLink.dataset.ready = 'true';
      downloadLink.textContent = 'Download PNG';
      downloadLink.classList.remove('disabled');
      return dataUrl;
    } catch (err) {
      console.warn('[FeatureCapture] DOM capture failed, using mock renderer', err);
      try {
        const mock = renderSchemaMock(featureName, schema, {
          scale: 2,
          showHints: false,
          showTypes: false,
          showSubtitle: false,
        });
        dataUrl = mock.dataUrl;
        infoLine.textContent = `Mock rendered ${Math.round(mock.width)}×${Math.round(mock.height)}px`;
        previewImg.src = dataUrl;
        previewImg.hidden = false;
        downloadLink.href = dataUrl;
        downloadLink.dataset.ready = 'true';
        downloadLink.textContent = 'Download Mock PNG';
        downloadLink.classList.remove('disabled');
        return dataUrl;
      } catch (fallbackErr) {
        infoLine.textContent = `Capture failed: ${fallbackErr?.message || fallbackErr}`;
        throw fallbackErr;
      }
    } finally {
      captureBtn.disabled = false;
    }
  };

  captureBtn.addEventListener('click', () => {
    capture().catch((err) => console.error('Capture failed', err));
  });

  return {
    featureName,
    slug,
    form,
    card,
    captureBtn,
    downloadLink,
    infoLine,
    previewImg,
    get dataUrl() { return dataUrl; },
    capture,
  };
}

async function buildZip(items) {
  const zip = new JSZip();
  for (const item of items) {
    const dataUrl = await item.capture(true);
    const bytes = dataUrlToUint8(dataUrl);
    zip.file(`${item.slug}.png`, bytes);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function makeActionButton(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-btn';
  btn.textContent = label;
  return btn;
}

function dataUrlToUint8(dataUrl) {
  const parts = String(dataUrl || '').split(',');
  if (parts.length < 2) {
    throw new Error('Invalid data URL');
  }
  const binary = atob(parts[1]);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'feature';
}

function injectPageStyles() {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
      background: #05070d;
      color: #e5ecff;
    }
    body {
      margin: 0;
      padding: 32px;
      background: linear-gradient(180deg, rgba(10,12,20,1) 0%, rgba(5,7,13,1) 100%);
      min-height: 100vh;
    }
    .capture-header {
      max-width: 960px;
      margin: 0 auto 24px auto;
      text-align: center;
    }
    .capture-header h1 {
      margin: 0 0 12px 0;
      font-size: clamp(24px, 3vw, 36px);
      font-weight: 600;
    }
    .capture-header p {
      margin: 0;
      color: #94a3b8;
      font-size: 14px;
    }
    .capture-actions {
      max-width: 960px;
      margin: 0 auto 24px auto;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: center;
    }
    .capture-status {
      flex: 1 1 100%;
      font-size: 13px;
      color: #cbd5f5;
      text-align: center;
    }
    .capture-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
      max-width: 1200px;
      margin: 0 auto 80px auto;
    }
    .capture-card {
      background: rgba(15,18,28,0.92);
      border: 1px solid rgba(74,85,104,0.35);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      box-shadow: 0 18px 40px rgba(0,0,0,0.35);
      backdrop-filter: blur(6px);
    }
    .capture-card h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: #f8fafc;
    }
    .dialog-live {
      background: #0b0f16;
      border-radius: 12px;
      padding: 16px;
      border: 1px solid rgba(59,77,109,0.4);
      overflow: auto;
      max-height: 420px;
    }
    .dialog-preview {
      border-top: 1px solid rgba(59,77,109,0.4);
      padding-top: 12px;
    }
    .dialog-preview img {
      max-width: 100%;
      border-radius: 10px;
      border: 1px solid rgba(59,77,109,0.4);
      display: block;
    }
    .card-info {
      font-size: 13px;
      color: #9aa4b2;
      min-height: 18px;
    }
    .card-actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .action-btn {
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid rgba(148,163,184,0.35);
      background: linear-gradient(180deg, rgba(100,116,139,0.25), rgba(71,85,105,0.05));
      color: #e2e8f0;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: border-color .15s ease, box-shadow .15s ease, transform .1s ease;
    }
    .action-btn:hover:not(:disabled) {
      border-color: rgba(96,165,250,0.9);
      box-shadow: 0 0 0 3px rgba(96,165,250,0.25);
    }
    .action-btn:active:not(:disabled) {
      transform: translateY(1px);
    }
    .action-btn:disabled,
    .action-btn.disabled {
      opacity: 0.45;
      cursor: not-allowed;
      box-shadow: none;
    }
    a.action-btn {
      text-decoration: none;
      text-align: center;
    }
    a.action-btn.disabled {
      pointer-events: none;
    }
    .action-btn.secondary {
      background: linear-gradient(180deg, rgba(30,41,59,0.45), rgba(15,23,42,0.35));
    }
  `;
  document.head.appendChild(style);
}
