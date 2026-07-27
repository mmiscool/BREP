import { Viewer } from "../viewer.js";
import {
  localStorage as LS,
  STORAGE_BACKEND_EVENT,
} from "../../idbStorage.js";
import {
  listComponentRecords,
  getComponentRecord,
  setComponentRecord,
  removeComponentRecord,
  MODEL_STORAGE_PREFIX,
  uint8ArrayToBase64,
} from "../../services/componentLibrary.js";
import { createAbortError } from "./nonInteractiveSave.js";
import "../../styles/cad.css";

declare global {
  interface Window {
    __BREP_CADFrameApp?: any;
    __BREP_bootCadFrame?: any;
    env?: any;
    viewer?: any;
  }
}

const DEFAULT_CHANNEL = "brep:cad";
const DEFAULT_SIDEBAR_EXPANDED = true;

function normalizeBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const next = value.trim().toLowerCase();
    if (next === "false" || next === "0" || next === "off" || next === "no") return false;
    if (next === "true" || next === "1" || next === "on" || next === "yes") return true;
  }
  return value !== false && value !== 0;
}

function normalizeSidebarExpanded(value, fallback = DEFAULT_SIDEBAR_EXPANDED) {
  return normalizeBoolean(value, fallback);
}

function normalizeModelPath(input) {
  const raw = String(input || "").replace(/\\/g, "/");
  const out = [];
  for (const part of raw.split("/")) {
    const token = String(part || "").trim();
    if (!token || token === "." || token === "..") continue;
    out.push(token);
  }
  return out.join("/");
}

function stripModelFileExtension(pathValue) {
  const clean = normalizeModelPath(pathValue);
  if (!clean) return "";
  const lower = clean.toLowerCase();
  if (lower.endsWith(".3mf")) return clean.slice(0, -4);
  return clean;
}

function toJSONText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}

function normalizeSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "github") return "github";
  if (source === "mounted") return "mounted";
  return "local";
}

function resolveStorageSource(sourceValue, repoFullValue = "") {
  const explicit = String(sourceValue || "").trim().toLowerCase();
  if (explicit === "github" || explicit === "mounted" || explicit === "local") return explicit;
  const repoFull = String(repoFullValue || "").trim();
  if (!repoFull) return "local";
  return repoFull.includes("/") ? "github" : "mounted";
}

function normalizeFilePath(input) {
  return stripModelFileExtension(input);
}

function toBase64FromBinary(value) {
  if (value instanceof ArrayBuffer) {
    return uint8ArrayToBase64(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return uint8ArrayToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) {
    return uint8ArrayToBase64(Uint8Array.from(value));
  }
  return "";
}

function normalizeModelRequest(input: any = {}) {
  if (typeof input === "string") {
    const modelPath = stripModelFileExtension(input);
    return {
      modelPath,
      options: { source: "local" },
    };
  }

  const payload = (input && typeof input === "object") ? input : {};
  const rawPath = payload.modelPath ?? payload.path ?? payload.name ?? payload.model;
  const modelPath = stripModelFileExtension(rawPath);
  const source = normalizeSource(payload.source);
  const options: any = { source };
  const repoFull = String(payload.repoFull || "").trim();
  const branch = String(payload.branch || "").trim();
  if (source !== "local" && repoFull) options.repoFull = repoFull;
  if (branch) options.branch = branch;

  return { modelPath, options };
}

class CadFrameApp {
  [key: string]: any;

  constructor({ channel, instanceId }: any) {
    this._channel = channel;
    this._instanceId = instanceId;
    this._viewer = null;
    this._viewerBootPromise = null;
    this._viewerOnlyMode = false;
    this._sidebarExpanded = DEFAULT_SIDEBAR_EXPANDED;
    this._historyHooksInstalled = false;
    this._saveHookInstalled = false;
    this._fileHooksInstalled = false;
    this._saveInProgress = false;
    this._requestControllers = new Map();
    this._boundStorageEvent = null;
    this._boundStorageBackendEvent = null;
    this._customCssEl = null;
    this._root = null;
    this._ownsRoot = false;
    this._sidebarEl = null;
    this._viewportEl = null;
    this._disposed = false;
    this._boundMessage = (event) => this.#onMessage(event);
  }

  boot() {
    if (this._disposed) return;
    this.#ensureBaseStyles();
    this.#mountShell();
    window.addEventListener("message", this._boundMessage);
    this.#post("ready", { version: 1 });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    window.removeEventListener("message", this._boundMessage);
    for (const controller of this._requestControllers.values()) {
      try { controller.abort(createAbortError("CAD frame disposed")); } catch { /* ignore best-effort abort */ }
    }
    this._requestControllers.clear();
    try { this._viewer?.dispose?.(); } catch { /* ignore best-effort CAD frame failure */ }
    this._viewer = null;
    this._viewerBootPromise = null;
    this._historyHooksInstalled = false;
    this._saveHookInstalled = false;
    this._fileHooksInstalled = false;
    this._saveInProgress = false;
    try {
      if (this._boundStorageEvent) {
        window.removeEventListener("storage", this._boundStorageEvent);
      }
    } catch { /* ignore best-effort CAD frame failure */ }
    try {
      if (this._boundStorageBackendEvent) {
        window.removeEventListener(STORAGE_BACKEND_EVENT, this._boundStorageBackendEvent);
      }
    } catch { /* ignore best-effort CAD frame failure */ }
    this._boundStorageEvent = null;
    this._boundStorageBackendEvent = null;
    try {
      if (this._ownsRoot && this._root?.parentNode) this._root.parentNode.removeChild(this._root);
    } catch { /* ignore best-effort CAD frame failure */ }
    this._root = null;
    this._ownsRoot = false;
    this._sidebarEl = null;
    this._viewportEl = null;
  }

  #ensureBaseStyles() {
    if (document.getElementById("cad-frame-base-styles")) return;
    const style = document.createElement("style");
    style.id = "cad-frame-base-styles";
    style.textContent = `
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none; }
      body { position: relative; }
    `;
    document.head.appendChild(style);
  }

  #mountShell() {
    let sidebar = document.getElementById("sidebar");
    let viewport = document.getElementById("viewport");

    if (!sidebar || !viewport) {
      const root = document.createElement("div");
      root.className = "cad-frame-root";
      root.style.position = "relative";
      root.style.width = "100%";
      root.style.height = "100%";
      root.style.overflow = "hidden";

      sidebar = document.createElement("div");
      sidebar.id = "sidebar";
      sidebar.className = "app-sidebar";
      sidebar.setAttribute("aria-label", "CAD sidebar");

      viewport = document.createElement("div");
      viewport.id = "viewport";

      root.appendChild(sidebar);
      root.appendChild(viewport);

      document.body.innerHTML = "";
      document.body.appendChild(root);
      this._root = root;
      this._ownsRoot = true;
    } else {
      sidebar.classList.add("app-sidebar");
      sidebar.setAttribute("aria-label", "CAD sidebar");
      this._root = document.body;
      this._ownsRoot = false;
    }

    this._sidebarEl = sidebar;
    this._viewportEl = viewport;
  }

  #post(type, payload = {}) {
    window.parent.postMessage({
      channel: this._channel,
      instanceId: this._instanceId,
      type,
      payload,
    }, "*");
  }

  #respond(requestId, ok, payload = null, error = null) {
    window.parent.postMessage({
      channel: this._channel,
      instanceId: this._instanceId,
      type: "response",
      requestId,
      ok,
      payload,
      error: error ? { message: error?.message || String(error) } : null,
    }, "*");
  }

  #collectModelState() {
    const fm = this._viewer?.fileManagerWidget;
    return {
      name: String(fm?.currentName || "").trim(),
      source: String(fm?.currentSource || "").trim() || "local",
      repoFull: String(fm?.currentRepoFull || "").trim(),
      branch: String(fm?.currentBranch || "").trim(),
    };
  }

  #collectState() {
    const features = Array.isArray(this._viewer?.partHistory?.features)
      ? this._viewer.partHistory.features
      : [];

    return {
      viewerOnlyMode: !!this._viewerOnlyMode,
      sidebarExpanded: !!this._sidebarExpanded,
      featureCount: features.length,
      currentHistoryStepId: this._viewer?.partHistory?.currentHistoryStepId || null,
      model: this.#collectModelState(),
    };
  }

  async #ensureViewer() {
    if (this._viewer) return;
    if (this._viewerBootPromise) {
      await this._viewerBootPromise;
      return;
    }

    this._viewerBootPromise = (async () => {
      try {
        try { await LS.ready(); } catch { /* ignore best-effort CAD frame failure */ }

        const viewer = new Viewer({
          container: this._viewportEl,
          sidebar: this._sidebarEl,
          autoLoadLastModel: false,
          viewerOnlyMode: this._viewerOnlyMode,
          homeBannerUrl: "https://brep.io",
          homeBannerOpenInNewTab: true,
        });

        this._viewer = viewer;
        window.env = viewer;
        window.viewer = viewer;

        await viewer.ready;
        this.#attachHistoryHooks();
        this.#attachFileHooks();
        this.#attachSaveHook();
        this.#setSidebarExpanded(this._sidebarExpanded);
      } catch (error) {
        try { this._viewer?.dispose?.(); } catch { /* ignore best-effort CAD frame failure */ }
        this._viewer = null;
        throw error;
      } finally {
        this._viewerBootPromise = null;
      }
    })();

    await this._viewerBootPromise;
  }

  #attachHistoryHooks() {
    if (this._historyHooksInstalled) return;
    const ph = this._viewer?.partHistory;
    if (!ph) return;

    ph.callbacks = ph.callbacks || {};
    const prevAfterRunHistory = ph.callbacks.afterRunHistory;
    const prevAfterReset = ph.callbacks.afterReset;

    ph.callbacks.afterRunHistory = async (...args) => {
      if (typeof prevAfterRunHistory === "function") {
        await prevAfterRunHistory(...args);
      }
      this.#emitHistoryChanged("afterRunHistory");
    };

    ph.callbacks.afterReset = async (...args) => {
      if (typeof prevAfterReset === "function") {
        await prevAfterReset(...args);
      }
      this.#emitHistoryChanged("afterReset");
    };

    this._historyHooksInstalled = true;
  }

  #emitHistoryChanged(reason = "update") {
    this.#post("historyChanged", {
      reason,
      ...this.#collectState(),
    });
  }

  #emitSaved(reason = "saveCurrent", detail = null) {
    this.#post("saved", {
      reason,
      ...this.#collectState(),
      detail: detail && typeof detail === "object" ? detail : null,
    });
  }

  #emitFilesChanged(reason = "update", detail = null) {
    this.#post("filesChanged", {
      reason,
      ...this.#collectState(),
      detail: detail && typeof detail === "object" ? detail : null,
    });
  }

  #buildStorageOptions(sourceValue, repoFullValue = "", branchValue = "") {
    const source = resolveStorageSource(sourceValue, repoFullValue);
    const repoFull = String(repoFullValue || "").trim();
    const branch = String(branchValue || "").trim();
    const options: any = { source };
    if (source !== "local" && repoFull) options.repoFull = repoFull;
    if (source === "github" && branch) options.branch = branch;
    return options;
  }

  async #readModelRecordFromState(modelState: any = {}) {
    const modelPath = normalizeFilePath(modelState?.name);
    if (!modelPath) return null;
    const source = String(modelState?.source || "").trim() || "local";
    const repoFull = String(modelState?.repoFull || "").trim();
    const branch = String(modelState?.branch || "").trim();
    const options = this.#buildStorageOptions(source, repoFull, branch);
    try {
      return await getComponentRecord(modelPath, options);
    } catch {
      return null;
    }
  }

  #attachFileHooks() {
    if (this._fileHooksInstalled) return;
    const fm = this._viewer?.fileManagerWidget;
    if (!fm) return;

    if (!fm.__cadEmbedPatchedSetModel && typeof fm._setModel === "function") {
      const setModelBase = fm._setModel.bind(fm);
      fm._setModel = async (...args) => {
        const [name, _dataObj, options] = args;
        const result = await setModelBase(...args);
        if (!this._saveInProgress) {
          try {
            const modelPath = normalizeFilePath(name);
            const source = resolveStorageSource(options?.source, options?.repoFull);
            const repoFull = String(options?.repoFull || "").trim();
            const branch = String(options?.branch || "").trim();
            const storageOptions = this.#buildStorageOptions(source, repoFull, branch);
            const persisted = await getComponentRecord(modelPath, storageOptions);
            this.#emitFilesChanged("setModel", {
              modelPath,
              source,
              repoFull,
              branch,
              savedAt: String(persisted?.savedAt || "").trim() || null,
            });
          } catch { /* ignore best-effort CAD frame failure */ }
        }
        return result;
      };
      fm.__cadEmbedPatchedSetModel = true;
    }

    if (!fm.__cadEmbedPatchedRemoveModel && typeof fm._removeModel === "function") {
      const removeModelBase = fm._removeModel.bind(fm);
      fm._removeModel = async (...args) => {
        const [name, options] = args;
        const modelPath = normalizeFilePath(name);
        const source = resolveStorageSource(options?.source, options?.repoFull);
        const repoFull = String(options?.repoFull || "").trim();
        const branch = String(options?.branch || "").trim();
        const storageOptions = this.#buildStorageOptions(source, repoFull, branch);
        const existing = await getComponentRecord(modelPath, storageOptions);
        const result = await removeModelBase(...args);
        this.#emitFilesChanged("removeModel", {
          modelPath,
          source,
          repoFull,
          branch,
          existed: !!existing,
        });
        return result;
      };
      fm.__cadEmbedPatchedRemoveModel = true;
    }

    if (!this._boundStorageEvent) {
      this._boundStorageEvent = (event) => {
        try {
          const key = String(event?.key || event?.detail?.key || "").trim();
          if (!key || !key.startsWith(MODEL_STORAGE_PREFIX)) return;
          this.#emitFilesChanged("storageEvent", { key });
        } catch { /* ignore best-effort CAD frame failure */ }
      };
    }

    if (!this._boundStorageBackendEvent) {
      this._boundStorageBackendEvent = () => {
        this.#emitFilesChanged("storageBackendChanged", {});
      };
    }

    window.addEventListener("storage", this._boundStorageEvent);
    window.addEventListener(STORAGE_BACKEND_EVENT, this._boundStorageBackendEvent);
    this._fileHooksInstalled = true;
  }

  #attachSaveHook() {
    if (this._saveHookInstalled) return;
    const fm = this._viewer?.fileManagerWidget;
    if (!fm || typeof fm.saveCurrent !== "function") return;

    const saveCurrentBase = fm.saveCurrent.bind(fm);
    fm.saveCurrent = async (...args) => {
      const before = this.#collectModelState();
      const beforeRecord = await this.#readModelRecordFromState(before);

      this._saveInProgress = true;
      let result;
      try {
        result = await saveCurrentBase(...args);
      } finally {
        this._saveInProgress = false;
      }

      const after = this.#collectModelState();
      const afterRecord = await this.#readModelRecordFromState(after);
      const beforeSavedAt = String(beforeRecord?.savedAt || "").trim();
      const afterSavedAt = String(afterRecord?.savedAt || "").trim();
      const beforeKey = [before.name, before.source, before.repoFull, before.branch].join("|");
      const afterKey = [after.name, after.source, after.repoFull, after.branch].join("|");
      const didPersist = !!afterRecord && (beforeKey !== afterKey || beforeSavedAt !== afterSavedAt);

      if (didPersist) {
        const detail = {
          modelPath: String(after.name || "").trim(),
          source: String(after.source || "").trim() || "local",
          repoFull: String(after.repoFull || "").trim(),
          branch: String(after.branch || "").trim(),
          savedAt: afterSavedAt || null,
        };
        this.#emitSaved("saveCurrent", {
          ...detail,
        });
        this.#emitFilesChanged("saveCurrent", detail);
      }

      return result;
    };

    this._saveHookInstalled = true;
  }

  #setCustomCss(cssText) {
    if (!this._customCssEl) {
      this._customCssEl = document.createElement("style");
      this._customCssEl.id = "cad-frame-custom-css";
      document.head.appendChild(this._customCssEl);
    }
    this._customCssEl.textContent = String(cssText || "");
  }

  #setSidebarExpanded(sidebarExpanded) {
    this._sidebarExpanded = normalizeSidebarExpanded(sidebarExpanded, this._sidebarExpanded);
    this._root?.classList.toggle("is-sidebar-collapsed", !this._sidebarExpanded);

    const viewer = this._viewer;
    if (!viewer) return;

    try {
      if (typeof viewer._setSidebarPinned === "function") {
        viewer._setSidebarPinned(this._sidebarExpanded);
      } else if (this._sidebarEl) {
        this._sidebarEl.style.display = this._sidebarExpanded ? "" : "none";
      }
      if (!this._sidebarExpanded && typeof viewer._setSidebarHoverVisible === "function") {
        viewer._setSidebarHoverVisible(false);
      }
    } catch { /* ignore best-effort CAD frame failure */ }
  }

  async #applyPartHistoryJSON(input) {
    await this.#ensureViewer();
    const jsonText = toJSONText(input);
    if (!jsonText) throw new Error("setPartHistoryJSON requires JSON text or object payload");

    await this._viewer.partHistory.fromJSON(jsonText);
    await this._viewer.partHistory.runHistory();
    await this._viewer.partHistory.flushHistorySnapshot?.({ force: true });
    try { this._viewer.expressionsManager?.refreshFromPartHistory?.(); } catch { /* ignore best-effort CAD frame failure */ }
  }

  async #loadModel(input) {
    await this.#ensureViewer();
    const fm = this._viewer?.fileManagerWidget;
    if (!fm || typeof fm.loadModel !== "function") {
      throw new Error("CAD frame cannot load models (FileManagerWidget unavailable)");
    }

    const { modelPath, options } = normalizeModelRequest(input);
    if (!modelPath) throw new Error("loadModel requires modelPath/path/name");

    await fm.loadModel(modelPath, options);
    return this.#collectModelState();
  }

  #normalizeStorageRequest(input: any = {}, operationName = "request") {
    const payload = (input && typeof input === "object") ? input : {};
    const rawPath = payload.modelPath ?? payload.path ?? payload.name;
    const modelPath = normalizeFilePath(rawPath);
    if (!modelPath) throw new Error(`${operationName} requires modelPath/path/name`);

    const repoFull = String(payload.repoFull || "").trim();
    const source = resolveStorageSource(payload.source, repoFull);
    const branch = String(payload.branch || "").trim();
    if (source === "mounted" && !repoFull) {
      throw new Error(`${operationName} requires repoFull for source "mounted"`);
    }

    return {
      modelPath,
      source,
      repoFull,
      branch,
      options: this.#buildStorageOptions(source, repoFull, branch),
    };
  }

  #normalizeFileRecordInput(recordInput: any, operationName = "writeFile") {
    if (!recordInput || typeof recordInput !== "object") {
      throw new Error(`${operationName} requires a record object`);
    }

    const record = { ...recordInput };
    const data3mfBinary = record.data3mfBytes ?? record.data3mfBinary ?? record.bytes ?? record.binary;
    const data3mfFromBinary = toBase64FromBinary(data3mfBinary);
    if ((!record.data3mf || typeof record.data3mf !== "string") && data3mfFromBinary) {
      record.data3mf = data3mfFromBinary;
    }
    if (typeof record.data3mf === "string") record.data3mf = record.data3mf.trim();

    const thumbnailBinary = record.thumbnailBytes ?? record.thumbnailBinary;
    const thumbnailFromBinary = toBase64FromBinary(thumbnailBinary);
    if ((!record.thumbnail || typeof record.thumbnail !== "string") && thumbnailFromBinary) {
      record.thumbnail = `data:image/png;base64,${thumbnailFromBinary}`;
    }

    if (!record.savedAt) record.savedAt = new Date().toISOString();

    delete record.data3mfBytes;
    delete record.data3mfBinary;
    delete record.bytes;
    delete record.binary;
    delete record.thumbnailBytes;
    delete record.thumbnailBinary;

    const hasData3mf = typeof record.data3mf === "string" && record.data3mf.length > 0;
    const hasData = record.data != null;
    if (!hasData3mf && !hasData) {
      throw new Error(`${operationName} record must include data3mf or data`);
    }

    return record;
  }

  async #readFile(input = {}) {
    const request = this.#normalizeStorageRequest(input, "readFile");
    const record = await getComponentRecord(request.modelPath, request.options);
    return {
      exists: !!record,
      modelPath: request.modelPath,
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
      record: record || null,
    };
  }

  #normalizeListRequest(input: any = {}) {
    const payload = (input && typeof input === "object") ? input : {};
    const repoFull = String(payload.repoFull || "").trim();
    const source = resolveStorageSource(payload.source, repoFull);
    const branch = String(payload.branch || "").trim();
    const folder = normalizeModelPath(payload.folder ?? payload.pathPrefix ?? payload.prefix ?? "");
    const includeRecord = normalizeBoolean(payload.includeRecord, false);
    return {
      source,
      repoFull,
      branch,
      folder,
      includeRecord,
      options: this.#buildStorageOptions(source, repoFull, branch),
    };
  }

  async #listFiles(input = {}) {
    const request = this.#normalizeListRequest(input);
    const list = await listComponentRecords(request.options);
    const items = Array.isArray(list) ? list : [];
    const folderPrefix = request.folder ? `${request.folder}/` : "";

    const filtered = request.folder
      ? items.filter((entry) => {
        const path = normalizeFilePath(entry?.path || entry?.name);
        return path === request.folder || path.startsWith(folderPrefix);
      })
      : items;

    const files = filtered.map((entry) => {
      const path = normalizeFilePath(entry?.path || entry?.name);
      const out: any = {
        source: String(entry?.source || request.source || "local").trim() || "local",
        repoFull: String(entry?.repoFull || request.repoFull || "").trim(),
        branch: String(entry?.branch || request.branch || "").trim(),
        path,
        browserPath: String(entry?.browserPath || path).trim(),
        folder: String(entry?.folder || "").trim(),
        displayName: String(entry?.displayName || "").trim(),
        savedAt: entry?.savedAt || null,
        has3mf: !!entry?.has3mf,
      };
      if (request.includeRecord) {
        out.record = entry?.record || null;
      }
      return out;
    });

    return {
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
      folder: request.folder,
      files,
    };
  }

  async #removeFile(input = {}) {
    const request = this.#normalizeStorageRequest(input, "removeFile");
    const existing = await getComponentRecord(request.modelPath, request.options);
    await removeComponentRecord(request.modelPath, request.options);
    const persisted = await getComponentRecord(request.modelPath, request.options);
    if (persisted) {
      throw new Error(`removeFile failed to remove "${request.modelPath}"`);
    }

    const fm = this._viewer?.fileManagerWidget;
    if (fm) {
      const currentPath = normalizeFilePath(fm.currentName || "");
      const currentSource = resolveStorageSource(fm.currentSource, fm.currentRepoFull);
      const currentRepo = String(fm.currentRepoFull || "").trim();
      if (
        currentPath === request.modelPath
        && currentSource === request.source
        && currentRepo === request.repoFull
      ) {
        fm.currentName = "";
        fm.currentRepoFull = "";
        fm.currentSource = "";
        fm.currentBranch = "";
        fm._forceSaveTargetDialog = false;
        try { if (fm.nameInput) fm.nameInput.value = ""; } catch { /* ignore best-effort CAD frame failure */ }
      }
      try { await fm.refreshList?.(); } catch { /* ignore best-effort CAD frame failure */ }
    }

    this.#emitFilesChanged("removeFile", {
      modelPath: request.modelPath,
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
      removed: !!existing,
    });

    return {
      ok: true,
      removed: !!existing,
      modelPath: request.modelPath,
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
    };
  }

  async #setCurrentFile(input: any = {}) {
    const fm = this._viewer?.fileManagerWidget;
    if (!fm) {
      throw new Error("CAD frame cannot set current file (FileManagerWidget unavailable)");
    }

    const payload = (input && typeof input === "object") ? input : {};
    const rawPath = payload.modelPath ?? payload.path ?? payload.name;
    const modelPath = normalizeFilePath(rawPath);
    if (!modelPath) throw new Error("setCurrentFile requires modelPath/path/name");

    const repoFull = String(payload.repoFull ?? fm.currentRepoFull ?? "").trim();
    const source = resolveStorageSource(payload.source ?? fm.currentSource, repoFull);
    const branch = String(payload.branch ?? fm.currentBranch ?? "").trim();

    if (source === "mounted" && !repoFull) {
      throw new Error("setCurrentFile requires repoFull for source \"mounted\"");
    }

    fm.currentName = modelPath;
    fm.currentSource = source;
    fm.currentRepoFull = source === "local" ? "" : repoFull;
    fm.currentBranch = source === "github" ? branch : "";
    fm._forceSaveTargetDialog = false;
    try {
      if (fm.nameInput) fm.nameInput.value = modelPath;
    } catch { /* ignore best-effort CAD frame failure */ }

    return this.#collectState();
  }

  async #writeFile(input: any = {}, { create = false }: any = {}) {
    const operationName = create ? "createFile" : "writeFile";
    const request = this.#normalizeStorageRequest(input, operationName);
    const record = this.#normalizeFileRecordInput(input?.record, operationName);
    const existing = await getComponentRecord(request.modelPath, request.options);
    if (create && existing) {
      throw new Error(`createFile failed: "${request.modelPath}" already exists`);
    }

    await setComponentRecord(request.modelPath, record, request.options);
    const persisted = await getComponentRecord(request.modelPath, request.options);
    if (!persisted) {
      throw new Error(`${operationName} failed to persist "${request.modelPath}"`);
    }

    const fm = this._viewer?.fileManagerWidget;
    if (fm) {
      try { await fm.refreshList?.(); } catch { /* ignore best-effort CAD frame failure */ }
    }

    this.#emitSaved(operationName, {
      modelPath: request.modelPath,
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
      savedAt: String(persisted?.savedAt || "").trim() || null,
    });
    this.#emitFilesChanged(operationName, {
      modelPath: request.modelPath,
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
      savedAt: String(persisted?.savedAt || "").trim() || null,
      created: !!create,
      overwritten: !create && !!existing,
    });

    return {
      ok: true,
      created: !!create,
      overwritten: !create && !!existing,
      modelPath: request.modelPath,
      source: request.source,
      repoFull: request.repoFull,
      branch: request.branch,
      record: persisted,
    };
  }

  async #saveCurrent(input: any = {}) {
    const fm = this._viewer?.fileManagerWidget;
    if (!fm || typeof fm.saveCurrent !== "function") {
      throw new Error("CAD frame cannot save models (FileManagerWidget unavailable)");
    }
    const payload = (input && typeof input === "object") ? input : {};
    const hasPath = payload?.modelPath != null || payload?.path != null || payload?.name != null;
    const hasScope = payload?.source != null || payload?.repoFull != null || payload?.branch != null;

    if (hasPath || hasScope) {
      await this.#setCurrentFile({
        modelPath: payload?.modelPath ?? payload?.path ?? payload?.name ?? fm.currentName,
        source: payload?.source ?? fm.currentSource,
        repoFull: payload?.repoFull ?? fm.currentRepoFull,
        branch: payload?.branch ?? fm.currentBranch,
      });
    }

    if (payload?.forceTargetDialog != null) {
      fm._forceSaveTargetDialog = !!payload.forceTargetDialog;
    }
    await fm.saveCurrent();
    return this.#collectState();
  }

  async #saveCurrentTo(input: any = {}, signal: AbortSignal | null = null) {
    const fm = this._viewer?.fileManagerWidget;
    if (!fm || typeof fm.saveCurrentTo !== "function") {
      throw new Error("CAD frame cannot save models non-interactively (FileManagerWidget unavailable)");
    }

    this._saveInProgress = true;
    let result;
    try {
      result = await fm.saveCurrentTo({
        ...((input && typeof input === "object") ? input : {}),
        signal,
      });
    } finally {
      this._saveInProgress = false;
    }

    if (result?.saved) {
      try { this.#emitSaved("saveCurrentTo", result); } catch { /* save already verified */ }
      try { this.#emitFilesChanged("saveCurrentTo", result); } catch { /* save already verified */ }
    }
    return result;
  }

  async #handleInit(payload: any = {}) {
    const requestedViewerOnly = normalizeBoolean(payload?.viewerOnlyMode, this._viewerOnlyMode);
    if (!this._viewer) {
      this._viewerOnlyMode = requestedViewerOnly;
    } else if (requestedViewerOnly !== this._viewerOnlyMode) {
      throw new Error("viewerOnlyMode cannot be changed after init");
    }

    this.#setSidebarExpanded(payload?.sidebarExpanded);
    await this.#ensureViewer();
    this.#setCustomCss(payload?.cssText || "");

    if (payload?.partHistoryJSON != null || payload?.partHistory != null) {
      const historyInput = payload?.partHistoryJSON ?? payload?.partHistory;
      await this.#applyPartHistoryJSON(historyInput);
    }

    const hasInlineModel = payload?.model != null
      || payload?.modelPath != null
      || payload?.path != null
      || payload?.name != null;

    if (hasInlineModel) {
      const request = payload?.model != null ? payload.model : payload;
      await this.#loadModel(request);
    }

    return this.#collectState();
  }

  async #handleRequest(type, payload: any, signal: AbortSignal | null = null) {
    if (type === "init") {
      return this.#handleInit(payload || {});
    }

    if (type === "dispose") {
      this.dispose();
      return { ok: true };
    }

    await this.#ensureViewer();

    if (type === "getState") {
      return this.#collectState();
    }

    if (type === "setCss") {
      this.#setCustomCss(payload?.cssText || "");
      return { ok: true };
    }

    if (type === "setSidebarExpanded") {
      this.#setSidebarExpanded(payload?.sidebarExpanded);
      return { ok: true, sidebarExpanded: this._sidebarExpanded };
    }

    if (type === "getPartHistoryJSON") {
      const json = await this._viewer.partHistory.toJSON();
      return { json };
    }

    if (type === "setPartHistoryJSON") {
      const jsonInput = payload?.json ?? payload?.partHistoryJSON ?? payload?.partHistory;
      await this.#applyPartHistoryJSON(jsonInput);
      return this.#collectState();
    }

    if (type === "runHistory") {
      await this._viewer.partHistory.runHistory();
      await this._viewer.partHistory.flushHistorySnapshot?.({ force: true });
      return this.#collectState();
    }

    if (type === "reset") {
      await this._viewer.partHistory.reset();
      await this._viewer.partHistory.runHistory();
      return this.#collectState();
    }

    if (type === "loadModel") {
      const model = payload?.model != null ? payload.model : payload;
      const loaded = await this.#loadModel(model || {});
      return {
        ...this.#collectState(),
        loaded,
      };
    }

    if (type === "loadFile") {
      const model = payload?.model != null ? payload.model : payload;
      const loaded = await this.#loadModel(model || {});
      return {
        ...this.#collectState(),
        loaded,
      };
    }

    if (type === "readFile") {
      return this.#readFile(payload || {});
    }

    if (type === "listFiles") {
      return this.#listFiles(payload || {});
    }

    if (type === "writeFile") {
      return this.#writeFile(payload || {}, { create: false });
    }

    if (type === "createFile") {
      return this.#writeFile(payload || {}, { create: true });
    }

    if (type === "removeFile") {
      return this.#removeFile(payload || {});
    }

    if (type === "setCurrentFile" || type === "setCurrentFileName") {
      return this.#setCurrentFile(payload || {});
    }

    if (type === "saveCurrent") {
      return this.#saveCurrent(payload || {});
    }

    if (type === "saveCurrentTo") {
      return this.#saveCurrentTo(payload || {}, signal);
    }

    throw new Error(`Unknown request type: ${type}`);
  }

  async #onMessage(event: any) {
    if (this._disposed) return;
    if (event.source !== window.parent) return;

    const msg = event.data;
    if (!msg || msg.channel !== this._channel || msg.instanceId !== this._instanceId) return;

    const requestId = msg.requestId;
    const type = msg.type;
    if (!type) return;

    // Allow fire-and-forget dispose from host teardown.
    if (type === "dispose" && !requestId) {
      this.dispose();
      return;
    }

    if (!requestId) return;

    if (type === "cancel") {
      const controller = this._requestControllers.get(requestId);
      if (controller && !controller.signal.aborted) {
        const message = String(msg?.payload?.message || "CAD request canceled");
        controller.abort(createAbortError(message));
      }
      return;
    }

    const controller = new AbortController();
    this._requestControllers.set(requestId, controller);
    try {
      const payload = await this.#handleRequest(type, msg.payload || {}, controller.signal);
      if (controller.signal.aborted) {
        throw controller.signal.reason || createAbortError();
      }
      this.#respond(requestId, true, payload);
    } catch (error) {
      this.#respond(requestId, false, null, error);
    } finally {
      if (this._requestControllers.get(requestId) === controller) {
        this._requestControllers.delete(requestId);
      }
    }
  }
}

export function bootCadFrame(config: any = {}) {
  try {
    if (window.__BREP_CADFrameApp && typeof window.__BREP_CADFrameApp.dispose === "function") {
      window.__BREP_CADFrameApp.dispose();
    }
  } catch { /* ignore best-effort CAD frame failure */ }

  const app = new CadFrameApp({
    channel: config.channel || DEFAULT_CHANNEL,
    instanceId: config.instanceId || `cad_${Date.now().toString(36)}`,
  });

  window.__BREP_CADFrameApp = app;
  app.boot();
  return app;
}

export const bootCADFrame = bootCadFrame;

try {
  if (typeof window !== "undefined") {
    window.__BREP_bootCadFrame = bootCadFrame;
  }
} catch { /* ignore global boot registration failure */ }
