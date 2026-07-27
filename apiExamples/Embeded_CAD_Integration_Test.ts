import { CadEmbed } from '../dist-kernel/CAD.js';

const btnRun = document.getElementById('btn-run');
const btnDestroy = document.getElementById('btn-destroy');
const viewerOnlyInput = document.getElementById('viewer-only');
const sidebarExpandedInput = document.getElementById('sidebar-expanded');
const modelPathInput = document.getElementById('model-path');
const modelSourceInput = document.getElementById('model-source');
const modelRepoInput = document.getElementById('model-repo');
const modelBranchInput = document.getElementById('model-branch');
const cssInput = document.getElementById('css-input');
const runStatusEl = document.getElementById('run-status');
const hostEl = document.getElementById('cad-host');
const resultsEl = document.getElementById('results');
const logOutput = document.getElementById('log-output');

let cad = null;
let runInFlight = false;

const sampleCubeHistory = {
  features: [
    {
      type: 'Primitive Cube',
      inputParams: {
        id: 'integration_sample_cube_1',
        sizeX: 16,
        sizeY: 12,
        sizeZ: 10,
        transform: {
          position: [0, 0, 0],
          rotationEuler: [0, 0, 0],
          scale: [1, 1, 1],
        },
        boolean: {
          targets: [],
          operation: 'NONE',
        },
      },
      persistentData: {},
      timestamp: null,
    },
  ],
  idCounter: 1,
  expressions: '//Examples:\nx = 10 + 6;\ny = x * 2;',
  pmiViews: [],
  metadata: {},
  assemblyConstraints: [],
  assemblyConstraintIdCounter: 0,
};

function log(message) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${message}`;
  const existing = logOutput.textContent === '(No logs yet)'
    ? []
    : logOutput.textContent.split('\n').filter(Boolean);
  existing.unshift(line);
  logOutput.textContent = existing.slice(0, 120).join('\n');
}

function setRunStatus(text) {
  runStatusEl.textContent = text;
}

function clearResults() {
  const rows = Array.from(resultsEl.querySelectorAll('.results-row'));
  for (const row of rows) {
    if (row.classList.contains('header')) continue;
    row.remove();
  }
}

function addResultRow(testName, status, details = '') {
  const row = document.createElement('div');
  row.className = 'results-row';

  const nameCell = document.createElement('div');
  nameCell.textContent = testName;

  const statusCell = document.createElement('div');
  const badge = document.createElement('span');
  badge.className = `badge ${String(status || '').toLowerCase()}`;
  badge.textContent = String(status || '').toUpperCase();
  statusCell.appendChild(badge);

  const detailsCell = document.createElement('div');
  detailsCell.textContent = details || '';

  row.appendChild(nameCell);
  row.appendChild(statusCell);
  row.appendChild(detailsCell);
  resultsEl.appendChild(row);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 2500, intervalMs = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try {
      if (predicate()) return true;
    } catch {
      // continue polling
    }
    await sleep(intervalMs);
  }
  return false;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function expectReject(fn, messageIncludes = '') {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = true;
    if (messageIncludes) {
      const text = String(error?.message || error || '');
      assert(text.includes(messageIncludes), `Expected rejection containing "${messageIncludes}", got: ${text}`);
    }
  }
  assert(rejected, 'Expected promise rejection');
}

function currentModelRequest() {
  const modelPath = String(modelPathInput.value || '').trim();
  if (!modelPath) return null;
  const source = String(modelSourceInput.value || 'local').trim() || 'local';
  const repoFull = String(modelRepoInput.value || '').trim();
  const branch = String(modelBranchInput.value || '').trim();
  const request: any = { modelPath, source };
  if (repoFull) request.repoFull = repoFull;
  if (branch) request.branch = branch;
  return request;
}

async function destroyCad() {
  if (!cad) return;
  try {
    await cad.destroy();
    log('Destroyed CadEmbed instance');
  } catch (error) {
    log(`Destroy failed: ${error?.message || String(error)}`);
  } finally {
    cad = null;
    btnDestroy.disabled = true;
  }
}

async function runIntegrationSuite() {
  if (runInFlight) return;
  runInFlight = true;
  btnRun.disabled = true;
  btnDestroy.disabled = true;
  clearResults();
  setRunStatus('Running integration suite...');
  logOutput.textContent = '(No logs yet)';

  const counters = { pass: 0, fail: 0, skip: 0 };
  const historyEvents = [];
  let saveTargetDialogCalls = 0;
  let confirmCalls = 0;

  const runTest = async (name, fn) => {
    addResultRow(name, 'RUN', 'Running...');
    const row = resultsEl.lastElementChild;
    try {
      const detail = await fn();
      counters.pass += 1;
      row.children[1].innerHTML = '<span class="badge pass">PASS</span>';
      row.children[2].textContent = detail || '';
      log(`PASS: ${name}${detail ? ` (${detail})` : ''}`);
    } catch (error) {
      counters.fail += 1;
      const detail = error?.message || String(error || 'Unknown error');
      row.children[1].innerHTML = '<span class="badge fail">FAIL</span>';
      row.children[2].textContent = detail;
      log(`FAIL: ${name} (${detail})`);
    }
  };

  const skipTest = (name, detail) => {
    counters.skip += 1;
    addResultRow(name, 'SKIP', detail || 'Skipped');
    log(`SKIP: ${name}${detail ? ` (${detail})` : ''}`);
  };

  await destroyCad();

  const requestedViewerOnly = !!viewerOnlyInput.checked;
  const requestedSidebarExpanded = !!sidebarExpandedInput.checked;

  cad = new CadEmbed({
    mountTo: hostEl,
    viewerOnlyMode: requestedViewerOnly,
    sidebarExpanded: requestedSidebarExpanded,
    cssText: cssInput.value,
    onHistoryChanged: (payload) => {
      historyEvents.push(payload || {});
      log(`historyChanged: ${payload?.reason || 'update'}`);
    },
  });

  await runTest('mount()', async () => {
    const frame = await cad.mount();
    assert(frame instanceof HTMLIFrameElement, 'mount() did not return an iframe');
    assert(frame.isConnected, 'Mounted iframe is not connected');
    btnDestroy.disabled = false;
    return 'iframe mounted';
  });

  await runTest('waitUntilReady()', async () => {
    await cad.waitUntilReady();
    return 'ready acknowledged';
  });

  await runTest('mount() idempotent', async () => {
    const first = cad.iframe;
    const second = await cad.mount();
    assert(first === second, 'Second mount() did not return the same iframe');
    return 'same iframe returned';
  });

  await runTest('getState()', async () => {
    const state = await cad.getState();
    assert(typeof state === 'object' && state !== null, 'State is not an object');
    assert(state.viewerOnlyMode === requestedViewerOnly, `viewerOnlyMode mismatch: ${state.viewerOnlyMode}`);
    return `viewerOnlyMode=${state.viewerOnlyMode}, features=${state.featureCount}`;
  });

  await runTest('setCss()', async () => {
    await cad.setCss(cssInput.value);
    return 'setCss completed without error';
  });

  await runTest('setSidebarExpanded(false)', async () => {
    await cad.setSidebarExpanded(false);
    const state = await cad.getState();
    assert(state.sidebarExpanded === false, `Expected sidebarExpanded=false, got ${state.sidebarExpanded}`);
    return 'sidebar collapsed';
  });

  await runTest('setSidebarExpanded(true)', async () => {
    await cad.setSidebarExpanded(true);
    const state = await cad.getState();
    assert(state.sidebarExpanded === true, `Expected sidebarExpanded=true, got ${state.sidebarExpanded}`);
    return 'sidebar expanded';
  });

  await runTest('setPartHistoryJSON(string)', async () => {
    const payload = JSON.stringify(sampleCubeHistory, null, 2);
    const state = await cad.setPartHistoryJSON(payload);
    assert(Number(state?.featureCount) === 1, `Expected featureCount=1, got ${state?.featureCount}`);
    return 'featureCount=1 after setPartHistoryJSON';
  });

  await runTest('getPartHistoryJSON()', async () => {
    const json = await cad.getPartHistoryJSON();
    assert(typeof json === 'string' && json.length > 0, 'JSON payload is empty');
    const parsed = JSON.parse(json);
    assert(Array.isArray(parsed.features), 'Parsed JSON missing features array');
    assert(parsed.features.length === 1, `Expected 1 feature, got ${parsed.features.length}`);
    return `${json.length} chars`; 
  });

  await runTest('getPartHistoryJSON({ preferCached: true })', async () => {
    const json = await cad.getPartHistoryJSON({ preferCached: true });
    assert(typeof json === 'string' && json.length > 0, 'Cached JSON payload is empty');
    return 'cached JSON returned';
  });

  await runTest('getPartHistory()', async () => {
    const history = await cad.getPartHistory();
    assert(history && Array.isArray(history.features), 'History object missing features');
    assert(history.features.length === 1, `Expected 1 feature, got ${history.features.length}`);
    return 'history object parsed';
  });

  await runTest('setPartHistory(object alias)', async () => {
    const state = await cad.setPartHistory(sampleCubeHistory);
    assert(Number(state?.featureCount) === 1, `Expected featureCount=1, got ${state?.featureCount}`);
    return 'alias method succeeded';
  });

  await runTest('runHistory()', async () => {
    const state = await cad.runHistory();
    assert(Number(state?.featureCount) === 1, `Expected featureCount=1, got ${state?.featureCount}`);
    return 'history rerun';
  });

  const savePath = `cad-embed-tests/non-interactive-${Date.now()}`;
  const canceledSavePath = `${savePath}-canceled`;

  await runTest('saveCurrentTo() installs no interactive fallback', async () => {
    const frameWindow: any = cad.iframe?.contentWindow;
    const fileManager = frameWindow?.viewer?.fileManagerWidget;
    assert(fileManager, 'CadEmbed frame FileManagerWidget is unavailable');
    const openSaveTargetDialog = fileManager._openSaveTargetDialog.bind(fileManager);
    fileManager._openSaveTargetDialog = (...args) => {
      saveTargetDialogCalls += 1;
      return openSaveTargetDialog(...args);
    };
    frameWindow.confirm = () => {
      confirmCalls += 1;
      return false;
    };
    return 'dialog and confirm calls instrumented';
  });

  await runTest('saveCurrentTo() requires modelPath without UI', async () => {
    await expectReject(() => cad.saveCurrentTo({ source: 'local' }), 'requires a model path');
    assert(saveTargetDialogCalls === 0, 'Missing modelPath opened the Save Target dialog');
    assert(confirmCalls === 0, 'Missing modelPath opened a confirmation dialog');
    assert(cad._pending.size === 0, 'CadEmbed retained a pending missing-path request');
    return 'rejected before frame request';
  });

  await runTest('saveCurrentTo() creates and verifies an explicit target', async () => {
    await cad.removeFile(savePath, { source: 'local' });
    const result = await cad.saveCurrentTo({
      modelPath: savePath,
      source: 'local',
      overwrite: false,
    });
    assert(result?.saved === true, `Expected saved=true, got ${JSON.stringify(result)}`);
    assert(result?.modelPath === savePath, `Unexpected saved modelPath: ${result?.modelPath}`);
    assert(result?.source === 'local', `Unexpected saved source: ${result?.source}`);
    assert(typeof result?.savedAt === 'string' && result.savedAt.length > 0, 'Missing savedAt evidence');
    assert(Number(result?.artifactByteSize) > 0, 'Missing nonzero artifactByteSize evidence');
    const persisted = await cad.readFile(savePath, { source: 'local' });
    assert(persisted?.exists === true, 'Saved target does not exist');
    assert(
      typeof persisted?.record?.data3mf === 'string' && persisted.record.data3mf.length > 0,
      'Saved target has no 3MF payload',
    );
    assert(saveTargetDialogCalls === 0, 'Explicit save opened the Save Target dialog');
    assert(confirmCalls === 0, 'Explicit save opened a confirmation dialog');
    assert(cad._pending.size === 0, 'CadEmbed retained a pending successful save');
    return `${result.artifactByteSize} bytes`;
  });

  await runTest('saveCurrentTo() reports conflict without confirm', async () => {
    const result = await cad.saveCurrentTo({
      modelPath: savePath,
      source: 'local',
      overwrite: false,
    });
    assert(result?.saved === false, 'Conflict unexpectedly reported saved=true');
    assert(result?.reason === 'conflict', `Expected conflict reason, got ${result?.reason}`);
    assert(confirmCalls === 0, 'Conflict opened a confirmation dialog');
    assert(saveTargetDialogCalls === 0, 'Conflict opened the Save Target dialog');
    assert(cad._pending.size === 0, 'CadEmbed retained a pending conflict request');
    return 'structured conflict returned';
  });

  await runTest('saveCurrentTo() overwrites without UI', async () => {
    const result = await cad.saveCurrentTo({
      modelPath: savePath,
      source: 'local',
      overwrite: true,
    });
    assert(result?.saved === true, 'Explicit overwrite did not save');
    assert(Number(result?.artifactByteSize) > 0, 'Overwrite returned no byte-size evidence');
    assert(confirmCalls === 0, 'Explicit overwrite opened a confirmation dialog');
    assert(saveTargetDialogCalls === 0, 'Explicit overwrite opened the Save Target dialog');
    assert(cad._pending.size === 0, 'CadEmbed retained a pending overwrite request');
    return 'target replaced';
  });

  await runTest('saveCurrentTo() timeout cancels without a ghost artifact', async () => {
    await cad.removeFile(canceledSavePath, { source: 'local' });
    const previousTimeoutMs = cad._requestTimeoutMs;
    cad._requestTimeoutMs = 5;
    try {
      await expectReject(
        () => cad.saveCurrentTo({
          modelPath: canceledSavePath,
          source: 'local',
          overwrite: false,
        }),
        'Request timed out: saveCurrentTo',
      );
    } finally {
      cad._requestTimeoutMs = previousTimeoutMs;
    }
    const frameWindow: any = cad.iframe?.contentWindow;
    const canceled = await waitFor(
      () => Number(frameWindow?.__BREP_CADFrameApp?._requestControllers?.size || 0) === 0,
      { timeoutMs: 10_000, intervalMs: 25 },
    );
    assert(canceled, 'Frame-side save did not settle after cancellation');
    const persisted = await cad.readFile(canceledSavePath, { source: 'local' });
    assert(persisted?.exists === false, 'Canceled save left a ghost artifact');
    assert(cad._pending.size === 0, 'CadEmbed retained a timed-out request');
    assert(saveTargetDialogCalls === 0, 'Timed-out save opened the Save Target dialog');
    assert(confirmCalls === 0, 'Timed-out save opened a confirmation dialog');
    return 'frame canceled and target absent';
  });

  await runTest('saveCurrentTo() cleanup', async () => {
    await cad.removeFile(savePath, { source: 'local' });
    await cad.removeFile(canceledSavePath, { source: 'local' });
    return 'test artifacts removed';
  });

  await runTest('loadModel(invalid args rejects)', async () => {
    await expectReject(() => cad.loadModel(null), 'requires a model path string');
    return 'rejection asserted';
  });

  const optionalModel = currentModelRequest();
  if (!optionalModel) {
    skipTest('loadModel(valid optional test)', 'No model path provided. Fill fields to run this check.');
  } else {
    await runTest('loadModel(valid optional test)', async () => {
      const state = await cad.loadModel(optionalModel);
      assert(typeof state === 'object' && state !== null, 'loadModel did not return state');
      return `loaded=${state?.loaded?.name || state?.model?.name || '(unknown)'}`;
    });
  }

  await runTest('reset()', async () => {
    const state = await cad.reset();
    assert(Number(state?.featureCount) === 0, `Expected featureCount=0, got ${state?.featureCount}`);
    return 'model reset to empty history';
  });

  await runTest('onHistoryChanged callback', async () => {
    const ok = await waitFor(() => historyEvents.length > 0, { timeoutMs: 3000 });
    assert(ok, 'Did not receive any historyChanged events');
    return `${historyEvents.length} event(s)`;
  });

  await runTest('destroy()', async () => {
    const iframeRef = cad.iframe;
    await cad.destroy();
    assert(cad.iframe === null, 'cad.iframe should be null after destroy');
    if (iframeRef) {
      assert(!iframeRef.isConnected, 'Iframe still connected after destroy');
    }
    cad = null;
    btnDestroy.disabled = true;
    return 'iframe removed and instance disposed';
  });

  await runTest('destroy() idempotent', async () => {
    if (!cad) {
      // Create a minimal instance and destroy twice to verify idempotence.
      cad = new CadEmbed({ mountTo: hostEl, viewerOnlyMode: true });
      await cad.mount();
    }
    await cad.destroy();
    await cad.destroy();
    cad = null;
    btnDestroy.disabled = true;
    return 'second destroy() did not throw';
  });

  setRunStatus(`Done. PASS=${counters.pass} FAIL=${counters.fail} SKIP=${counters.skip}`);
  btnRun.disabled = false;
  btnDestroy.disabled = !cad;
  runInFlight = false;
}

btnRun.addEventListener('click', () => {
  runIntegrationSuite().catch((error) => {
    log(`FATAL: ${error?.message || String(error)}`);
    setRunStatus(`Run aborted: ${error?.message || String(error)}`);
    btnRun.disabled = false;
    runInFlight = false;
  });
});

btnDestroy.addEventListener('click', () => {
  destroyCad().catch((error) => {
    log(`Destroy action failed: ${error?.message || String(error)}`);
  });
});
