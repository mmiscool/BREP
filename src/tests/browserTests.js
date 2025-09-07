// browserTests.js — BrowserTesting with UI widget (dark mode, top-right)

import { Viewer } from '../UI/viewer.js';
import { runTests, testFunctions, runSingleTest } from './tests.js';
import { ConsoleCapture } from './ConsoleCapture.js'





export class BrowserTesting {
  constructor({
    containerEl = document.getElementById('viewport'),
    sidebarEl = document.getElementById('sidebar'),
    exposeEnvOnWindow = true,
  } = {}) {
    // URL flag to auto-progress (kept from previous behavior)
    this.autoProgress = window.location.href.includes("autoNext=true");

    // Initialize Viewer env
    this.env = new Viewer({ container: containerEl, sidebar: sidebarEl });
    if (exposeEnvOnWindow) window.env = this.env;

    // Test registry (names in stable order)
    this.testNames = testFunctions.map(func => func.test.name);
    //console.log(testFunctions, this.testNames);

    this.currentIndex = 0;

    // Per-test runtime state
    this.enabled = new Map(this.testNames.map(n => [n, true]));
    this.status = new Map(this.testNames.map(n => [n, ""]));   // "", "pass", "fail"
    this.errors = new Map(); // name -> { message, stack } captured on failure

    // Popup container for screenshots between tests (kept from previous behavior)
    this.popupDiv = document.createElement("div");
    this.popupDiv.style.padding = "10px";
    this.popupDiv.style.background = "#0b0b0e";
    this.popupDiv.style.color = "#e5e7eb";
    this.popupDiv.style.border = "1px solid #2a2a33";
    this.popupDiv.style.borderRadius = "12px";
    this.popupDiv.style.maxWidth = "90vw";
    this.popupDiv.style.maxHeight = "100%";
    this.popupDiv.style.overflow = "auto";

    // Build the UI widget
    this.ui = this._buildUI();

    // Optional global for debugging
    window.browserTesting = this;
    if (this.autoProgress) {


      this.loggingTool = new ConsoleCapture({ captureStack: false });
      this.loggingTool.install();

    }
  }

  // ====== Small helpers ======
  sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  // ====== Screenshot dump (unchanged behavior) ======
  async dumpScreenshot() {
    await this.sleep(2000);
    const image = this.env.renderer.domElement.toDataURL();
    return image;
  }

  // ====== Hook invoked between tests (kept & extended) ======
  async callBetweenTestsToRender(featureHistory, isLastTest) {
    // Keep parity with original assignments
    this.env.partHistory.features = featureHistory.features;
    this.env.scene = featureHistory.scene;

    try {
      if (this.autoProgress) await this.sleep(1000);
      await this.sleep(1000);
      await this.env.renderer.render(this.env.scene, this.env.camera);

      // capture screenshot to the popupDiv
      const image = this.env.renderer.domElement.toDataURL();
      const img = document.createElement("img");
      img.src = image;
      img.style.maxWidth = "360px";
      img.style.height = "auto";
      img.style.display = "block";
      img.style.margin = "8px 0";
      this.popupDiv.appendChild(img);
    } catch (error) {
      console.log("Error occurred while writing to popup:", error);
    }

    if (this.autoProgress, !isLastTest) {
      const popup = window.open("", "_blank");
      if (popup && popup.document && popup.document.body) {
        popup.document.body.style.background = "#0b0b0e";
        popup.document.body.style.color = "#e5e7eb";
        popup.document.body.appendChild(this.popupDiv);

      }
    }
  }

  // ====== PUBLIC: run all tests via external test harness (legacy entry) ======
  async run() {
    // Preserve old entry point, now wired through the UI "Run All" anyway
    await runTests(this.env.partHistory, this.callBetweenTestsToRender.bind(this));
  }

  // ====== UI: Build top-right widget ======
  _buildUI() {
    // Container
    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      top: "40px",
      right: "16px",
      zIndex: "2147483647",
      width: "420px",
      maxHeight: "100%",
      overflow: "hidden",
      background: "#0b0b0e",
      color: "#e5e7eb",
      border: "1px solid #2a2a33",
      borderRadius: "14px",
      boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
      display: "flex",
      flexDirection: "column",
    });

    // Header / title
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "12px 14px",
      borderBottom: "1px solid #23232b",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      fontWeight: "700",
      cursor: "pointer",
      letterSpacing: "0.2px",
    });
    header.textContent = "Browser Testing";

    // Controls row
    const controls = document.createElement("div");
    Object.assign(controls.style, {
      padding: "10px 12px",
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "8px",
      borderBottom: "1px solid #23232b",
    });

    const btnRunCurrent = makeButton("Run (current)");
    const btnPrev = makeButton("Previous");
    const btnNext = makeButton("Next");
    const btnRunAll = makeButton("Run All");

    controls.appendChild(btnRunCurrent);
    controls.appendChild(btnPrev);
    controls.appendChild(btnNext);
    controls.appendChild(btnRunAll);

    // Table container (scrollable)
    const tableWrap = document.createElement("div");
    Object.assign(tableWrap.style, {
      overflow: "auto",
      maxHeight: "100%",
    });

    // Table
    const table = document.createElement("table");
    Object.assign(table.style, {
      width: "100%",
      borderCollapse: "collapse",
    });

    // THEAD
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(th("Test (enable/disable)", "50%"));
    headRow.appendChild(th("Status", "20%"));
    headRow.appendChild(th("Actions", "30%"));
    thead.appendChild(headRow);
    table.appendChild(thead);

    // TBODY (rows per test)
    const tbody = document.createElement("tbody");
    this._rowRefs = new Map(); // name -> { row, checkbox, statusCell, runBtn, logBtn }
    this.testNames.forEach((name, idx) => {
      const row = document.createElement("tr");
      Object.assign(row.style, rowStyle());

      // col 1: checkbox + label
      const c1 = document.createElement("td");
      c1.style.height = "10px";
      Object.assign(c1.style, cellStyle());
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "8px";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", () => {
        this.enabled.set(name, cb.checked);
      });
      const text = document.createElement("span");
      text.textContent = name;
      label.appendChild(cb);
      label.appendChild(text);
      c1.appendChild(label);

      // col 2: status
      const c2 = document.createElement("td");
      Object.assign(c2.style, cellStyle());
      updateStatusCell(c2, this.status.get(name));

      // col 3: actions
      const c3 = document.createElement("td");
      Object.assign(c3.style, cellStyle());
      c3.style.display = "flex";
      c3.style.gap = "6px";
      const runBtn = miniButton("▷");
      const logBtn = miniButton("Show Log");
      c3.appendChild(runBtn);
      c3.appendChild(logBtn);

      // row events
      row.addEventListener("click", (e) => {
        // Don't change selection if clicking a control that handles its own action
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
        if (tag === "button" || tag === "input" || tag === "label") return;
        this._selectRow(idx);
      });

      // hook up actions
      runBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        this._selectRow(idx);
        await this._runSingleByName(name);
      });
      logBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showErrorLog(name);
      });

      // assemble row
      row.appendChild(c1);
      row.appendChild(c2);
      row.appendChild(c3);
      tbody.appendChild(row);

      this._rowRefs.set(name, { row, checkbox: cb, statusCell: c2, runBtn, logBtn });
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);

    // Footer: current selection
    const footer = document.createElement("div");
    Object.assign(footer.style, {
      padding: "10px 12px",
      borderTop: "1px solid #23232b",
      color: "#a7aab3",
      display: "flex",
      justifyContent: "space-between",
    });
    this._selectionLabel = document.createElement("span");
    this._selectionLabel.textContent = this._currentLabel();
    footer.appendChild(this._selectionLabel);

    // Assemble widget
    root.appendChild(header);
    root.appendChild(controls);
    root.appendChild(tableWrap);
    root.appendChild(footer);
    document.body.appendChild(root);

    // Wire top buttons
    btnRunCurrent.addEventListener("click", async () => {
      const name = this.testNames[this.currentIndex];
      await this._runSingleByName(name);
    });
    btnPrev.addEventListener("click", () => this._moveSelection(-1));
    btnNext.addEventListener("click", () => this._moveSelection(+1));
    btnRunAll.addEventListener("click", async () => {
      await this._runAllEnabled();
    });

    // Initial selected row styling
    this._applySelectionStyles();


    // add an event to the header that makes the window shade
    header.addEventListener("click", () => {
      this.popupDiv.style.display = this.popupDiv.style.display === "none" ? "block" : "none";
      controls.style.display = controls.style.display === "none" ? "flex" : "none";
      table.style.display = table.style.display === "none" ? "block" : "none";
      footer.style.display = footer.style.display === "none" ? "flex" : "none";
    });


    header.click();

    return { root, header, controls, table, tbody };
  }

  // ====== Selection helpers ======
  _currentLabel() {
    const name = this.testNames[this.currentIndex] || "(none)";
    return `Selected: ${name} (${this.currentIndex + 1}/${this.testNames.length})`;
  }

  _moveSelection(delta) {
    if (!this.testNames.length) return;
    this.currentIndex = (this.currentIndex + delta + this.testNames.length) % this.testNames.length;
    this._applySelectionStyles();
  }

  _selectRow(idx) {
    if (idx < 0 || idx >= this.testNames.length) return;
    this.currentIndex = idx;
    this._applySelectionStyles();
  }

  _applySelectionStyles() {
    this._selectionLabel.textContent = this._currentLabel();
    this.testNames.forEach((name, idx) => {
      const ref = this._rowRefs.get(name);
      if (!ref) return;
      if (idx === this.currentIndex) {
        ref.row.style.outline = "2px solid #4155ff88";
        ref.row.style.background = "#12131a";
      } else {
        ref.row.style.outline = "none";
        ref.row.style.background = "transparent";
      }
    });
  }

  // ====== Status + error helpers ======
  _setStatus(name, value /* "", "pass", "fail" */) {
    this.status.set(name, value);
    const ref = this._rowRefs.get(name);
    if (ref) updateStatusCell(ref.statusCell, value);
  }

  _setError(name, error) {
    if (!error) { this.errors.delete(name); return; }
    this.errors.set(name, {
      message: String(error && error.message ? error.message : error),
      stack: (error && error.stack) ? String(error.stack) : "",
    });
  }

  _showErrorLog(name) {
    const err = this.errors.get(name);
    // Modal
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0",
      background: "rgba(0,0,0,0.65)",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });

    const modal = document.createElement("div");
    Object.assign(modal.style, {
      width: "680px",
      maxWidth: "95vw",
      maxHeight: "80vh",
      overflow: "auto",
      background: "#0b0b0e",
      color: "#e5e7eb",
      border: "1px solid #2a2a33",
      borderRadius: "12px",
      boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
      padding: "3px",
    });

    const title = document.createElement("div");
    title.textContent = `Error Log — ${name}`;
    Object.assign(title.style, { fontWeight: "700", marginBottom: "8px" });

    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.lineHeight = "1.5";
    pre.style.background = "#111217";
    pre.style.border = "1px solid #1e2030";
    pre.style.padding = "3px";
    pre.style.borderRadius = "8px";
    pre.textContent = err ? `${err.message}\n\n${err.stack}` : "No error captured for this test.";

    const close = makeButton("Close");
    close.style.marginTop = "12px";
    close.addEventListener("click", () => {
      overlay.remove();
    });

    modal.appendChild(title);
    modal.appendChild(pre);
    modal.appendChild(close);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ====== Execution helpers ======
  async _runSingleByName(name) {
    // clear previous error for this test
    this._setError(name, null);
    this._setStatus(name, "");

    // Visually mark as running
    const ref = this._rowRefs.get(name);
    if (ref) {
      ref.row.style.background = "#151726";
    }

    const functionToRun = testFunctions.find(func => func.test.name === name);

    try {
      // Try a single-test runner if provided; otherwise fall back to calling the function directly.
      if (typeof runSingleTest === "function") {
        this.startLogging();
        this.env.partHistory.reset();
        await runSingleTest(functionToRun, this.env.partHistory);



        this._setError(name, await this.endLogging());
      }
    } catch (err) {
      console.error(`Error in test ${name}:`, err);
      this._setError(name, err);
      this._setStatus(name, "fail");
    } finally {
      // restore background depending on selection
      const idx = this.testNames.indexOf(name);
      if (ref) {
        if (idx === this.currentIndex) {
          ref.row.style.background = "#12131a";
        } else {
          ref.row.style.background = "transparent";
        }
      }
    }
  }

  async startLogging() {
    if (!this.loggingTool) return;
    this.loggingTool.clearLogs();

  }
  async endLogging() {
    if (!this.loggingTool) return "";
    let errorString = "";
    this.loggingTool.getLogs().forEach(log => {
      console.log(log);

      log.args.forEach(arg => {
        // test if log.args is a string and then move on to the next loop
        if (typeof arg === "string") {
          errorString += `${arg}\n`;
          return;
        }
        if (typeof arg === "object" && arg !== null) {
          errorString += `${JSON.stringify(arg, null, 2)}\n`;
        }
      });

    });
    return errorString;
  }


  async _runAllEnabled() {
    // Reset quick screenshot board
    this.popupDiv.innerHTML = "";

    for (let i = 0; i < this.testNames.length; i++) {
      const name = this.testNames[i];
      if (!this.enabled.get(name)) continue;
      this._selectRow(i);
      /* eslint-disable no-await-in-loop */
      await this._runSingleByName(name);
      /* eslint-enable no-await-in-loop */
    }
  }
}

// ====== Styling helpers ======
function darkButtonStyle() {
  return {
    background: "#1f2937",
    color: "#f9fafb",
    border: "1px solid #374151",
    padding: "3px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "700",
    outline: "none",
    transition: "background 120ms ease, transform 60ms ease, box-shadow 120ms ease",
    userSelect: "none",
  };
}
function decorateButtonHover(btn) {
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "#2b3545";
    btn.style.boxShadow = "0 3px 10px rgba(0,0,0,0.35)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "#1f2937";
    btn.style.transform = "none";
    btn.style.boxShadow = "none";
  });
  btn.addEventListener("mousedown", () => {
    btn.style.transform = "translateY(1px)";
  });
  btn.addEventListener("mouseup", () => {
    btn.style.transform = "none";
  });
}
function makeButton(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  Object.assign(btn.style, darkButtonStyle());
  decorateButtonHover(btn);
  return btn;
}
function miniButton(label) {
  const btn = makeButton(label);
  btn.style.padding = "3px";
  btn.style.borderRadius = "6px";
  btn.style.fontSize = "10px";
  return btn;
}
function th(text, width) {
  const th = document.createElement("th");
  th.textContent = text;
  th.style.textAlign = "left";
  th.style.padding = "10px 12px";
  th.style.borderBottom = "1px solid #23232b";
  th.style.color = "#9aa0aa";
  th.style.fontWeight = "600";
  if (width) th.style.width = width;
  return th;
}
function rowStyle() {
  return {
    borderBottom: "1px solid #1c1d25",
  };
}
function cellStyle() {
  return {
    padding: "3px 12px",
    verticalAlign: "middle",

  };
}
function updateStatusCell(cell, value) {
  // value: "", "pass", "fail"
  cell.textContent = "";
  const badge = document.createElement("span");
  badge.textContent = value === "" ? "" : value.toUpperCase();
  badge.style.fontWeight = "800";
  badge.style.letterSpacing = "0.5px";
  badge.style.padding = value ? "2px 8px" : "0";
  badge.style.borderRadius = "999px";
  if (value === "pass") {
    badge.style.background = "#093d2a";
    badge.style.color = "#86efac";
    badge.style.border = "1px solid #14532d";
  } else if (value === "fail") {
    badge.style.background = "#3a0b0f";
    badge.style.color = "#fca5a5";
    badge.style.border = "1px solid #7f1d1d";
  } else {
    badge.style.background = "transparent";
    badge.style.color = "#a7aab3";
  }
  cell.appendChild(badge);
}


// ====== Optional default instance (auto-mount widget immediately) ======
const defaultTester = new BrowserTesting({
  containerEl: document.getElementById('viewport'),
  sidebarEl: document.getElementById('sidebar'),
});
// (No automatic full run here; user can use the widget)
// If you still want auto-run like before, uncomment:
//defaultTester.run();
