import { FeatureRegistry } from '../FeatureRegistry.js';
import { SchemaForm } from '../UI/featureDialogs.js';

const registry = new FeatureRegistry();
const featureClasses = registry.features.slice();

injectPageStyles();

const appRoot = document.getElementById('app') || document.body;
appRoot.classList.add('dialog-capture-page');

const header = document.createElement('header');
header.className = 'dialog-capture-header';
header.innerHTML = `
  <h1>Feature Dialog Reference</h1>
  <p>Dialogs are rendered live using SchemaForm. Use the automated capture script to export PNGs.</p>
`;

const grid = document.createElement('section');
grid.className = 'dialog-capture-grid';

for (const FeatureClass of featureClasses) {
  if (!FeatureClass) continue;
  const featureName = String(FeatureClass.longName || FeatureClass.featureName || FeatureClass.name || 'Feature').trim() || 'Feature';
  const shortNameRaw = FeatureClass.shortName || FeatureClass.featureShortName || featureName;
  const shortName = String(shortNameRaw || featureName).trim() || 'Feature';
  const captureName = featureName || shortName;
  const params = { featureID: `${shortName}-capture` };
  const schema = FeatureClass.inputParamsSchema || {};
  const form = new SchemaForm(schema, params);
  try { form.refreshFromParams(); } catch (_) { /* ignore */ }
  try {
    const host = form.uiElement;
    if (host) {
      host.style.width = '100%';
      host.style.maxWidth = '100%';
    }
  } catch (_) { /* ignore width styling errors */ }

  const card = document.createElement('article');
  card.className = 'dialog-card';
  card.dataset.featureName = captureName;
  card.dataset.featureShortName = shortName;

  const head = document.createElement('div');
  head.className = 'dialog-card-head';

  const badge = document.createElement('span');
  badge.className = 'dialog-short';
  badge.textContent = shortName;

  const title = document.createElement('h2');
  title.className = 'dialog-title';
  title.textContent = featureName;

  head.append(badge, title);

  const formWrap = document.createElement('div');
  formWrap.className = 'dialog-form';
  formWrap.appendChild(form.uiElement);

  card.append(head, formWrap);
  grid.appendChild(card);
}

appRoot.append(header, grid);

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
      min-height: 100vh;
      background: radial-gradient(circle at top, rgba(19,27,47,0.75), rgba(8,11,20,1) 55%);
      display: flex;
      justify-content: center;
    }
    .dialog-capture-page {
      width: min(1040px, 100%);
    }
    .dialog-capture-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .dialog-capture-header h1 {
      margin: 0 0 12px 0;
      font-size: clamp(26px, 4vw, 38px);
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .dialog-capture-header p {
      margin: 0;
      color: #94a3b8;
      font-size: 14px;
    }
    .dialog-capture-grid {
      display: flex;
      flex-direction: column;
      gap: 32px;
      padding-bottom: 80px;
    }
    .dialog-card {
      background: rgba(13,17,27,0.92);
      border-radius: 18px;
      border: 1px solid rgba(71,85,105,0.42);
      padding: 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.45);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .dialog-card-head {
      display: flex;
      align-items: baseline;
      gap: 14px;
    }
    .dialog-short {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      padding: 4px 14px;
      border-radius: 999px;
      border: 1px solid rgba(96, 165, 250, 0.45);
      background: rgba(51, 65, 85, 0.45);
      color: #cbd5ff;
      font-weight: 600;
      letter-spacing: 0.08em;
      font-size: 13px;
      text-transform: uppercase;
    }
    .dialog-title {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: #f8fafc;
    }
    .dialog-form {
      background: #0b0f16;
      width: 300px;
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(59,77,109,0.45);
      box-shadow: inset 0 0 0 1px rgba(71,85,105,0.18);
      box-sizing: border-box;
    }
  `;
  document.head.appendChild(style);
}
