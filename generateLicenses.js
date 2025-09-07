// generateLicenses.js (ES6, no deps, dark mode)
// Usage: node generateLicenses.js
// - Runs: pnpm licenses list --prod --long --json
// - Produces: licenses.html (one <div> per license, with repo/homepage + author)

import { execSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";

const run = (cmd) => execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

const escapeHTML = (s = "") =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

let raw;
try {
  raw = run("pnpm licenses list --prod --long --json");
} catch (e) {
  console.error("Failed to run pnpm. Is pnpm installed and did you run `pnpm install`?", e.message);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error("Could not parse pnpm JSON. Here is the first 200 chars for debugging:\n", raw.slice(0, 200));
  process.exit(1);
}

// data shape: { "<LICENSE>": [ { name, versions, paths, license, author?, homepage?, description? }, ... ], ... }
const licenseKeys = Object.keys(data).sort((a, b) => a.localeCompare(b));

const css = `
:root{
  --bg:#0b0f14; --panel:#0f141b; --text:#d7dde6; --muted:#9aa7b2;
  --border:#1b2430; --accent:#5cc8ff; --chip:#121823;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial}
main{max-width:1100px;margin:0 auto;padding:28px}
h1{margin:0 0 18px;font-size:22px;color:var(--accent);font-weight:700}
.summary{color:var(--muted);margin-bottom:22px}
.license{
  background:var(--panel);border:1px solid var(--border);border-radius:14px;
  padding:16px 16px 8px;margin:0 0 18px;
}
.license > h2{margin:0 0 10px;font-size:16px;font-weight:700}
.pkg{
  border-top:1px solid var(--border);padding:10px 0;
  display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;
}
.pkg:first-of-type{border-top:none}
.pkg .meta{display:flex;gap:10px;flex-wrap:wrap}
.pkg .name{font-weight:600}
.pkg .desc{color:var(--muted);margin-top:2px}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
.chip{background:var(--chip);border:1px solid var(--border);border-radius:999px;padding:2px 8px;font-size:12px;color:var(--muted)}
.footer{margin-top:26px;color:var(--muted);font-size:12px}
`;

const countPackages = licenseKeys.reduce((n, k) => n + (Array.isArray(data[k]) ? data[k].length : 0), 0);




// read in the actual licence for this product located in LICENSE.md
const licenseText = readFileSync("LICENSE.md", "utf-8");







let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Licenses Report</title>
<style>${css}</style>
</head>
<body>
<main>
<h1>This projects licence</h1>
<div style="white-space: pre-wrap;">${licenseText}</div><br><br><br><hr>
  <h1>Licenses Report of libraries used in this package</h1>
  <div class="summary">${countPackages} packages • ${licenseKeys.length} license types</div>
`;

for (const lic of licenseKeys) {
  const list = Array.isArray(data[lic]) ? data[lic] : [];
  // sort packages by name for stable output
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  html += `<section class="license">
    <h2>${escapeHTML(lic)} <span class="chip">${list.length} package${list.length === 1 ? "" : "s"}</span></h2>
  `;

  for (const p of list) {
    const name = escapeHTML(p.name ?? "");
    const author =
      p.author && typeof p.author === "object"
        ? escapeHTML(p.author.name ?? "")
        : escapeHTML(p.author ?? "");
    const homepage = p.homepage ? String(p.homepage) : "";
    const desc = escapeHTML(p.description ?? "");
    // versions can be very long; show unique versions count as a chip
    const versionsCount = Array.isArray(p.versions) ? new Set(p.versions).size : 0;

    html += `<div class="pkg">
      <div>
        <div class="name">${name}${versionsCount ? ` <span class="chip">${versionsCount} version${versionsCount===1?"":"s"}</span>` : ""}</div>
        ${desc ? `<div class="desc">${desc}</div>` : ""}
        ${author ? `<div class="desc">Author: ${escapeHTML(author)}</div>` : ""}
      </div>
      <div class="meta">
        ${homepage ? `<a class="chip" href="${escapeHTML(homepage)}" target="_blank" rel="noopener noreferrer">Repo / Homepage</a>` : ""}
      </div>
    </div>`;
  }

  html += `</section>`;
}

html += `
  <div class="footer">Generated from <code>pnpm licenses list --prod --long --json</code></div>
</main>
</body>
</html>`;

writeFileSync("licenses.html", html, "utf-8");
console.log("✔ licenses.html generated");
