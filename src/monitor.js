// monitor-universal.js
// ES6-friendly, safe in both Node.js and browsers (no errors in either)

// ===== Utilities =====
const isNode =
  typeof process !== "undefined" &&
  process?.versions?.node &&
  typeof window === "undefined";

const nowMs = () => {
  if (isNode && typeof process.hrtime?.bigint === "function") {
    // High-res monotonic clock in Node
    const ns = process.hrtime.bigint();
    return Number(ns) / 1e6;
  }
  // High-res clock in browsers
  if (typeof performance !== "undefined" && performance?.now) {
    return performance.now();
  }
  // Fallback
  return Date.now();
};

const startMs = nowMs();

const formatMB = (bytes) =>
  typeof bytes === "number" && Number.isFinite(bytes)
    ? `${(bytes / 1024 / 1024).toFixed(5)} MB`
    : "N/A";

// ===== Report builders =====
function buildNodeReport() {
  // Guard every Node-specific API
  const mem =
    typeof process.memoryUsage === "function" ? process.memoryUsage() : null;
  const res =
    typeof process.resourceUsage === "function" ? process.resourceUsage() : null;

  // Try to estimate elapsed using hrtime where possible
  let elapsedMs;
  if (typeof process.hrtime?.bigint === "function") {
    const end = process.hrtime.bigint();
    elapsedMs = Number(end) / 1e6 - startMs; // both measured with hrtime-based nowMs()
  } else {
    elapsedMs = Date.now() - (globalThis.__monitorUniversalStartEpoch || 0);
  }

  const lines = [];
  lines.push("\n=== Process Report ===");
  lines.push(`Runtime: ${(elapsedMs / 1000).toFixed(2)} seconds`);

  // Resource usage (maxRSS is in KB per Node docs)
  if (res && typeof res.maxRSS === "number") {
    lines.push(`Max RSS: ${formatMB(res.maxRSS * 1024)}`);
  } else {
    lines.push("Max RSS: N/A");
  }

  if (mem) {
    lines.push(`RSS: ${formatMB(mem.rss)}`);
    lines.push(`Heap Total: ${formatMB(mem.heapTotal)}`);
    lines.push(`Heap Used: ${formatMB(mem.heapUsed)}`);
    // external + arrayBuffers may be undefined on some Node versions
    lines.push(
      `External: ${formatMB(
        typeof mem.external === "number" ? mem.external : NaN
      )}`
    );
    lines.push(
      `Array Buffers: ${formatMB(
        typeof mem.arrayBuffers === "number" ? mem.arrayBuffers : NaN
      )}`
    );
  } else {
    lines.push("RSS: N/A");
    lines.push("Heap Total: N/A");
    lines.push("Heap Used: N/A");
    lines.push("External: N/A");
    lines.push("Array Buffers: N/A");
  }

  return lines.join("\n");
}

function buildBrowserReport() {
  // Best-effort metrics (Chrome-only exposes performance.memory)
  const pmem =
    typeof performance !== "undefined" && performance?.memory
      ? performance.memory
      : null;

  const elapsedMs = nowMs() - startMs;

  const lines = [];
  lines.push("\n=== Page Report ===");
  lines.push(`Runtime: ${(elapsedMs / 1000).toFixed(2)} seconds`);

  // Browser does not expose RSS; show N/A
  lines.push("Max RSS: N/A");
  lines.push("RSS: N/A");

  if (pmem) {
    // performance.memory fields are in bytes
    lines.push(`Heap Total: ${formatMB(pmem.totalJSHeapSize)}`);
    lines.push(`Heap Used: ${formatMB(pmem.usedJSHeapSize)}`);
    // Map Node-ish labels for parity
    lines.push(`External: N/A`);
    // No direct array buffers metric in web perf memory
    lines.push(`Array Buffers: N/A`);
  } else {
    lines.push("Heap Total: N/A");
    lines.push("Heap Used: N/A");
    lines.push("External: N/A");
    lines.push("Array Buffers: N/A");
  }

  return lines.join("\n");
}

// ===== Reporter (shared) =====
let reported = false;
function report() {
  if (reported) return;
  reported = true;

  try {
    const output = isNode ? buildNodeReport() : buildBrowserReport();
    // eslint-disable-next-line no-console
    console.log(output);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to generate report:", err);
  }
}

// Expose a manual trigger if needed (works in both envs)
globalThis.__monitorUniversalReport = report;

// ===== Attach lifecycle hooks safely =====
if (isNode) {
  // Ensure a stable epoch to pair with Date.now fallback if ever used
  if (!globalThis.__monitorUniversalStartEpoch) {
    globalThis.__monitorUniversalStartEpoch = Date.now();
  }

  // 'exit' always fires; keep handlers minimal/synchronous
  try {
    process.on("exit", report);
  } catch {}
  // Helpful for Ctrl+C and abrupt terminations
  try {
    process.on("SIGINT", () => {
      report();
      // Ensure default behavior (terminate) after reporting
      process.exit(130);
    });
  } catch {}
  try {
    process.on("SIGTERM", () => {
      report();
      process.exit(143);
    });
  } catch {}
} else {
  // Browser-safe: use pagehide for BFCache correctness, with fallbacks
  try {
    // Fire once when the page is being unloaded or put in BFCache
    globalThis.addEventListener(
      "pagehide",
      () => {
        report();
      },
      { once: true }
    );
  } catch {}

  try {
    // Fallback for older browsers
    globalThis.addEventListener(
      "beforeunload",
      () => {
        report();
      },
      { once: true }
    );
  } catch {}

  try {
    // As a secondary safety: when the tab becomes hidden and then closes
    let hiddenOnce = false;
    const onVis = () => {
      if (document.hidden && !hiddenOnce) {
        hiddenOnce = true;
        // Defer slightly to avoid competing with other handlers
        setTimeout(report, 0);
        document.removeEventListener("visibilitychange", onVis);
      }
    };
    document.addEventListener("visibilitychange", onVis);
  } catch {}
}
