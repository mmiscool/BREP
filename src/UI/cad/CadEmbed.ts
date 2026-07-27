import { deepClone } from "../../utils/deepClone.js";
import { createAbortError } from "./nonInteractiveSave.js";
export { bootCadFrame, bootCADFrame } from "./CadFrameApp.js";

const DEFAULT_CHANNEL = "brep:cad";
const DEFAULT_TIMEOUT_MS = 20000;

function createDeferred(): any {
  let resolve: any;
  let reject: any;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise: any, timeoutMs: any, message: string): Promise<any> {
  const ms = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function resolveHost(target: any): any {
  if (!target) return null;
  if (typeof target === "string") return document.querySelector(target);
  if (typeof target.appendChild === "function") return target;
  return null;
}

function makeInstanceId() {
  return `cad_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeBoolean(value: any, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const next = value.trim().toLowerCase();
    if (next === "false" || next === "0" || next === "off" || next === "no") return false;
    if (next === "true" || next === "1" || next === "on" || next === "yes") return true;
  }
  return value !== false && value !== 0;
}

function toPartHistoryJSON(input: any) {
  if (typeof input === "string") return input;
  if (input == null) return "";
  return JSON.stringify(input, null, 2);
}

function toFilePath(input: any) {
  return String(input || "").trim();
}

function normalizePathRequest(pathOrRequest: any, options: any = {}) {
  if (typeof pathOrRequest === "string") {
    const modelPath = toFilePath(pathOrRequest);
    return {
      ...(options && typeof options === "object" ? options : {}),
      modelPath,
    };
  }
  if (pathOrRequest && typeof pathOrRequest === "object") {
    return deepClone(pathOrRequest);
  }
  return {
    ...(options && typeof options === "object" ? options : {}),
  };
}

export class CadEmbed {
  [key: string]: any;

  constructor(options: any = {}) {
    this._options = options || {};
    this._channel = this._options.channel || DEFAULT_CHANNEL;
    this._instanceId = this._options.instanceId || makeInstanceId();
    this._requestTimeoutMs = Number.isFinite(Number(this._options.requestTimeoutMs))
      ? Number(this._options.requestTimeoutMs)
      : DEFAULT_TIMEOUT_MS;
    this._targetOrigin = this._options.targetOrigin || "*";
    this._frameModuleUrl = this._options.frameModuleUrl || import.meta.url;
    this._viewerOnlyMode = normalizeBoolean(this._options.viewerOnlyMode, false);
    this._sidebarExpanded = normalizeBoolean(this._options.sidebarExpanded, true);
    this._initialCss = typeof this._options.cssText === "string" ? this._options.cssText : "";
    this._initialPartHistoryJSON = toPartHistoryJSON(
      this._options.initialPartHistoryJSON ?? this._options.initialPartHistory,
    );
    this._initialModel = this._options.initialModel
      ? deepClone(this._options.initialModel)
      : null;

    this._onReady = typeof this._options.onReady === "function" ? this._options.onReady : null;
    this._onHistoryChanged = typeof this._options.onHistoryChanged === "function"
      ? this._options.onHistoryChanged
      : (typeof this._options.onChange === "function" ? this._options.onChange : null);
    this._onFilesChanged = typeof this._options.onFilesChanged === "function"
      ? this._options.onFilesChanged
      : (typeof this._options.onFileChange === "function" ? this._options.onFileChange : null);
    this._onSave = typeof this._options.onSave === "function"
      ? this._options.onSave
      : (typeof this._options.onSaved === "function" ? this._options.onSaved : null);

    this._ready = createDeferred();
    this._initialized = createDeferred();
    this._initStarted = false;
    this._destroyed = false;
    this._pending = new Map();
    this._requestSeq = 0;
    this._latestPartHistoryJSON = "";

    this._iframe = null;
    this._host = null;
    this._boundMessage = (event) => this.#onMessage(event);
  }

  get iframe() {
    return this._iframe;
  }

  get instanceId() {
    return this._instanceId;
  }

  async mount(target = this._options.mountTo || this._options.container) {
    if (this._destroyed) throw new Error("CadEmbed is already destroyed");
    if (this._iframe) {
      await this.waitUntilReady();
      return this._iframe;
    }

    const host = resolveHost(target);
    if (!host) throw new Error("CadEmbed.mount requires a valid host element");

    this._host = host;
    window.addEventListener("message", this._boundMessage);

    const iframe = document.createElement("iframe");
    iframe.title = this._options.title || "BREP CAD";
    iframe.className = this._options.iframeClassName || "";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.background = String(this._options.backgroundColor || "#0b0f16");
    iframe.style.borderRadius = "10px";
    iframe.style.overflow = "hidden";

    if (this._options.iframeStyle && typeof this._options.iframeStyle === "object") {
      Object.assign(iframe.style, this._options.iframeStyle);
    }

    const attrs = (this._options.iframeAttributes && typeof this._options.iframeAttributes === "object")
      ? this._options.iframeAttributes
      : null;
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null) continue;
        iframe.setAttribute(key, String(value));
      }
    }

    iframe.srcdoc = this.#buildSrcDoc();
    host.appendChild(iframe);
    this._iframe = iframe;

    try {
      await this.waitUntilReady();
      return iframe;
    } catch (error) {
      try { window.removeEventListener("message", this._boundMessage); } catch { /* ignore listener cleanup failure */ }
      try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch { /* ignore iframe cleanup failure */ }
      this._iframe = null;
      this._host = null;
      throw error;
    }
  }

  async waitUntilReady() {
    await withTimeout(
      this._initialized.promise,
      this._requestTimeoutMs,
      "CadEmbed initialization timed out",
    );
  }

  async getState() {
    return this.#request("getState", {});
  }

  async getPartHistoryJSON(options: any = {}) {
    if (options?.preferCached === true && this._latestPartHistoryJSON) {
      return this._latestPartHistoryJSON;
    }
    const result = await this.#request("getPartHistoryJSON", {});
    const json = String(result?.json || "");
    this._latestPartHistoryJSON = json;
    return json;
  }

  async getPartHistory(options = {}) {
    const json = await this.getPartHistoryJSON(options);
    if (!json) return null;
    return JSON.parse(json);
  }

  async setPartHistoryJSON(jsonText) {
    const json = toPartHistoryJSON(jsonText);
    if (!json) throw new Error("setPartHistoryJSON requires JSON text or object payload");
    const result = await this.#request("setPartHistoryJSON", { json });
    this._latestPartHistoryJSON = json;
    return result;
  }

  async setPartHistory(partHistoryObject) {
    return this.setPartHistoryJSON(partHistoryObject);
  }

  async runHistory() {
    this._latestPartHistoryJSON = "";
    return this.#request("runHistory", {});
  }

  async reset() {
    this._latestPartHistoryJSON = "";
    return this.#request("reset", {});
  }

  async loadModel(model: any, options: any = {}) {
    this._latestPartHistoryJSON = "";
    let payload = null;

    if (typeof model === "string") {
      payload = {
        modelPath: model,
        ...(options && typeof options === "object" ? options : {}),
      };
    } else if (model && typeof model === "object") {
      payload = deepClone(model);
    }

    if (!payload) throw new Error("loadModel requires a model path string or request object");
    return this.#request("loadModel", payload);
  }

  async loadFile(path: any, options: any = {}) {
    const modelPath = toFilePath(path);
    if (!modelPath) throw new Error("loadFile requires a model path");
    this._latestPartHistoryJSON = "";
    return this.#request("loadFile", {
      ...(options && typeof options === "object" ? options : {}),
      modelPath,
    });
  }

  async listFiles(options: any = {}) {
    return this.#request("listFiles", {
      ...(options && typeof options === "object" ? deepClone(options) : {}),
    });
  }

  async readFile(path: any, options: any = {}) {
    const modelPath = toFilePath(path);
    if (!modelPath) throw new Error("readFile requires a path");
    return this.#request("readFile", {
      ...(options && typeof options === "object" ? options : {}),
      modelPath,
    });
  }

  async writeFile(path: any, record: any, options: any = {}) {
    const modelPath = toFilePath(path);
    if (!modelPath) throw new Error("writeFile requires a path");
    return this.#request("writeFile", {
      ...(options && typeof options === "object" ? options : {}),
      modelPath,
      record: record == null ? null : deepClone(record),
    });
  }

  async createFile(path: any, record: any, options: any = {}) {
    const modelPath = toFilePath(path);
    if (!modelPath) throw new Error("createFile requires a path");
    return this.#request("createFile", {
      ...(options && typeof options === "object" ? options : {}),
      modelPath,
      record: record == null ? null : deepClone(record),
    });
  }

  async addFile(path: any, record: any, options: any = {}) {
    return this.createFile(path, record, options);
  }

  async removeFile(pathOrRequest: any, options: any = {}) {
    const payload = normalizePathRequest(pathOrRequest, options);
    const modelPath = toFilePath(payload?.modelPath ?? payload?.path ?? payload?.name);
    if (!modelPath) throw new Error("removeFile requires a path");
    return this.#request("removeFile", {
      ...payload,
      modelPath,
    });
  }

  async deleteFile(pathOrRequest: any, options: any = {}) {
    return this.removeFile(pathOrRequest, options);
  }

  async setCurrentFile(pathOrRequest: any, options: any = {}) {
    const payload = normalizePathRequest(pathOrRequest, options);
    const modelPath = toFilePath(payload?.modelPath ?? payload?.path ?? payload?.name);
    if (!modelPath) throw new Error("setCurrentFile requires a path");
    return this.#request("setCurrentFile", {
      ...payload,
      modelPath,
    });
  }

  async setCurrentFileName(name: any, options: any = {}) {
    return this.setCurrentFile(name, options);
  }

  async saveCurrent(options: any = {}) {
    const payload = (options && typeof options === "object") ? deepClone(options) : {};
    return this.#request("saveCurrent", payload);
  }

  async saveCurrentTo(options: any = {}) {
    const request = (options && typeof options === "object") ? options : {};
    const modelPath = toFilePath(request.modelPath ?? request.path ?? request.name);
    if (!modelPath) throw new Error("saveCurrentTo requires a model path");
    const { signal, ...payload } = request;
    return this.#request("saveCurrentTo", deepClone({
      ...payload,
      modelPath,
    }), { signal });
  }

  async saveModel(options: any = {}) {
    return this.saveCurrent(options);
  }

  async setCss(cssText) {
    await this.#request("setCss", { cssText: typeof cssText === "string" ? cssText : "" });
  }

  async setSidebarExpanded(sidebarExpanded) {
    this._sidebarExpanded = normalizeBoolean(sidebarExpanded, this._sidebarExpanded);
    await this.#request("setSidebarExpanded", { sidebarExpanded: this._sidebarExpanded });
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    try {
      if (this._iframe?.contentWindow) {
        this._iframe.contentWindow.postMessage(
          {
            channel: this._channel,
            instanceId: this._instanceId,
            type: "dispose",
            requestId: null,
            payload: {},
          },
          this._targetOrigin,
        );
      }
    } catch { /* ignore frame dispose post failure */ }

    for (const [requestId, pending] of this._pending.entries()) {
      clearTimeout(pending.timer);
      try { pending.abortCleanup?.(); } catch { /* ignore abort-listener cleanup failure */ }
      pending.reject(new Error(`Request aborted: ${requestId}`));
    }
    this._pending.clear();

    try { window.removeEventListener("message", this._boundMessage); } catch { /* ignore listener cleanup failure */ }
    try {
      if (this._iframe?.parentNode) this._iframe.parentNode.removeChild(this._iframe);
    } catch { /* ignore iframe cleanup failure */ }

    this._iframe = null;
    this._host = null;
    this._latestPartHistoryJSON = "";
  }

  #buildSrcDoc() {
    const configJSON = JSON.stringify({
      channel: this._channel,
      instanceId: this._instanceId,
      frameModuleUrl: this._frameModuleUrl,
      backgroundColor: this._options.backgroundColor || null,
    });
    const inlineBodyBackground = this._options.backgroundColor
      ? `body { background: ${JSON.stringify(String(this._options.backgroundColor))}; }`
      : "";

    return `<!doctype html>
<html lang="en" data-brep-cad-frame="true">
  <head>
    <meta charset="UTF-8" />
    <title>BREP CAD</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <style>
      html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
      ${inlineBodyBackground}
    </style>
  </head>
  <body>
    <div id="sidebar" class="app-sidebar" aria-label="CAD sidebar"></div>
    <div id="viewport"></div>
    <script type="module">
      const config = ${configJSON};
      try {
        const mod = await import(config.frameModuleUrl);
        const boot = mod?.bootCadFrame || mod?.bootCADFrame || mod?.boot || window.__BREP_bootCadFrame;
        if (typeof boot !== "function") {
          throw new Error("CAD frame bootstrap missing boot function");
        }
        boot({ channel: config.channel, instanceId: config.instanceId });
      } catch (error) {
        window.parent.postMessage(
          {
            channel: config.channel,
            instanceId: config.instanceId,
            type: "frameError",
            payload: { message: error?.message || String(error) },
          },
          "*",
        );
      }
    </script>
  </body>
</html>`;
  }

  #cancelFrameRequest(requestId, type, message) {
    const win = this._iframe?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          channel: this._channel,
          instanceId: this._instanceId,
          type: "cancel",
          requestId,
          payload: {
            requestType: type,
            message,
          },
        },
        this._targetOrigin,
      );
    } catch { /* ignore best-effort cancellation post failure */ }
  }

  async #request(type: any, payload: any, options: any = {}): Promise<any> {
    await this.waitUntilReady();
    return this.#requestRaw(type, payload, options);
  }

  async #requestRaw(type: any, payload: any, options: any = {}): Promise<any> {
    if (this._destroyed) throw new Error("CadEmbed is destroyed");
    const win = this._iframe?.contentWindow;
    if (!win) throw new Error("CadEmbed iframe is unavailable");
    const signal = options?.signal || null;
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : createAbortError();
    }

    const requestId = `${this._instanceId}:${++this._requestSeq}`;
    const request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(requestId);
        if (!pending) return;
        this._pending.delete(requestId);
        try { pending.abortCleanup?.(); } catch { /* ignore abort-listener cleanup failure */ }
        const message = `Request timed out: ${type}`;
        this.#cancelFrameRequest(requestId, type, message);
        reject(new Error(message));
      }, this._requestTimeoutMs);

      let abortCleanup = null;
      if (signal && typeof signal.addEventListener === "function") {
        const onAbort = () => {
          const pending = this._pending.get(requestId);
          if (!pending) return;
          this._pending.delete(requestId);
          clearTimeout(pending.timer);
          try { pending.abortCleanup?.(); } catch { /* ignore abort-listener cleanup failure */ }
          const error = signal.reason instanceof Error
            ? signal.reason
            : createAbortError();
          this.#cancelFrameRequest(requestId, type, error.message);
          reject(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this._pending.set(requestId, { resolve, reject, timer, abortCleanup });
    });

    win.postMessage(
      {
        channel: this._channel,
        instanceId: this._instanceId,
        type,
        requestId,
        payload,
      },
      this._targetOrigin,
    );

    return request;
  }

  #initializeAfterReady() {
    if (this._initStarted) return;
    this._initStarted = true;

    this.#requestRaw("init", {
      viewerOnlyMode: this._viewerOnlyMode,
      sidebarExpanded: this._sidebarExpanded,
      cssText: this._initialCss,
      partHistoryJSON: this._initialPartHistoryJSON || null,
      model: this._initialModel,
    })
      .then((payload) => {
        this._initialized.resolve(true);
        try { this._onReady && this._onReady(deepClone(payload || {})); } catch { /* ignore consumer ready callback failure */ }
      })
      .catch((error) => this._initialized.reject(error));
  }

  #onMessage(event: any) {
    if (this._destroyed) return;
    if (!this._iframe?.contentWindow || event.source !== this._iframe.contentWindow) return;

    const msg = event.data;
    if (!msg || msg.channel !== this._channel || msg.instanceId !== this._instanceId) return;

    if (msg.type === "ready") {
      this._ready.resolve(true);
      this.#initializeAfterReady();
      return;
    }

    if (msg.type === "frameError") {
      const message = msg?.payload?.message || "CAD frame boot failed";
      this._initialized.reject(new Error(message));
      return;
    }

    if (msg.type === "response") {
      const requestId = msg.requestId;
      if (!requestId || !this._pending.has(requestId)) return;

      const pending = this._pending.get(requestId);
      this._pending.delete(requestId);
      clearTimeout(pending.timer);
      try { pending.abortCleanup?.(); } catch { /* ignore abort-listener cleanup failure */ }

      if (msg.ok === false || msg.error) {
        pending.reject(new Error(msg?.error?.message || "CAD request failed"));
      } else {
        pending.resolve(deepClone(msg.payload || null));
      }
      return;
    }

    if (msg.type === "historyChanged") {
      this._latestPartHistoryJSON = "";
      try {
        this._onHistoryChanged && this._onHistoryChanged(deepClone(msg.payload || {}));
      } catch { /* ignore consumer history callback failure */ }
      return;
    }

    if (msg.type === "filesChanged") {
      try {
        this._onFilesChanged && this._onFilesChanged(deepClone(msg.payload || {}));
      } catch { /* ignore consumer files callback failure */ }
      return;
    }

    if (msg.type === "saved") {
      try {
        this._onSave && this._onSave(deepClone(msg.payload || {}));
      } catch { /* ignore consumer save callback failure */ }
    }
  }
}

export { CadEmbed as CADEmbed };
