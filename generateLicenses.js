// generateLicenses.js (ES6, no deps, dark mode)
// Usage: node generateLicenses.js
// - Runs: pnpm licenses list --prod --long --json
// - Produces: about.html (one <div> per license, with repo/homepage + author)

import { execSync } from "child_process";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "fs";
import path from "path";

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

const rootDir = process.cwd();
const docsSourceDir = path.join(rootDir, "docs");
const docsOutputDir = path.join(rootDir, "public", "docs");

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
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;margin:0 0 18px}
.readme{padding:0}
.readme .header{padding:16px 18px;border-bottom:1px solid var(--border)}
.readme .content{padding:18px}
.doc-card{padding:18px}
.doc-nav{margin:0 0 18px;display:flex;gap:12px;flex-wrap:wrap;color:var(--muted)}
.doc-nav a{color:var(--accent);font-weight:600}
.doc-list{list-style:none;margin:18px 0;padding:0}
.doc-list li{margin:6px 0}
.doc-list a{color:var(--accent)}
.prose h1{font-size:24px;margin:0 0 12px}
.prose h2{font-size:18px;margin:18px 0 8px}
.prose h3{font-size:16px;margin:14px 0 6px}
.prose p{margin:0 0 10px}
.prose ul{margin:0 0 10px 18px}
.prose li{margin:4px 0}
.prose code{background:#0d1520;border:1px solid var(--border);padding:1px 5px;border-radius:6px;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:12px}
.prose pre{background:#0d1520;border:1px solid var(--border);padding:12px;border-radius:12px;overflow:auto}
.prose a{color:var(--accent)}
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

// read README and render markdown to HTML (lightweight renderer, no deps)
const readmeText = readFileSync("README.md", "utf-8");

const escape = (s = "") => String(s)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function renderMarkdown(md) {
  // Extract fenced code blocks first and replace with placeholders
  const codeBlocks = [];
  let tmp = md;
  tmp = tmp.replace(/```([\s\S]*?)```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escape(code.trim())}</code></pre>`);
    return `§§CODE${idx}§§`;
  });

  const lines = tmp.split(/\r?\n/);
  let html = "";
  let inList = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      const line = para.join(" ").trim();
      if (line) html += `<p>${inline(line)}</p>`;
      para = [];
    }
  };

  const inline = (s) => {
    // escape first; we keep markdown specials (*_`[]()#) unescaped
    let out = escape(s);
    // images ![alt](src "title")
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_m, alt = "", src = "", title = "") => {
      const altAttr = alt.trim();
      const srcAttr = src.trim();
      const titleAttr = title ? ` title="${title.trim()}"` : "";
      return `<img src="${srcAttr}" alt="${altAttr}"${titleAttr} loading="lazy" />`;
    });
    // links [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`);
    // code `x`
    out = out.replace(/`([^`]+)`/g, (_m, t) => `<code>${t}</code>`);
    // bold **x**
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`);
    // italic *x*
    out = out.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, (m, pre, t) => `${pre}<em>${t}</em>`);
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (inList) { html += `</ul>`; inList = false; }
      flushPara();
      continue;
    }

    // headings #..######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inList) { html += `</ul>`; inList = false; }
      flushPara();
      const level = h[1].length;
      html += `<h${level}>${inline(h[2].trim())}</h${level}>`;
      continue;
    }

    // bullet list items
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!inList) { html += `<ul>`; inList = true; }
      html += `<li>${inline(li[1].trim())}</li>`;
      continue;
    }

    // normal paragraph line (accumulate)
    para.push(line.trim());
  }
  if (inList) html += `</ul>`;
  flushPara();

  // restore fenced code blocks
  html = html.replace(/§§CODE(\d+)§§/g, (_m, i) => codeBlocks[Number(i)] ?? "");
  return html;
}

const toPosix = (p) => p.split(path.sep).join("/");

const convertMarkdownLinks = (html) =>
  html.replace(/href="([^"#]+?)\.md(#[^"]*)?"/g, (match, base, hash = "") => {
    const fullPath = `${base}.md`;
    if (/^[a-z]+:/i.test(fullPath)) return match;
    const next = `${base}.html${hash}`;
    return `href="${next}"`;
  });

const extractTitle = (mdText, fallback) => {
  const heading = mdText.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
};

const docTemplate = (title, content, { relativeRoot = ".", showTitle = false } = {}) => {
  const normalizedRoot = !relativeRoot || relativeRoot === "" ? "." : relativeRoot;
  const navRoot = normalizedRoot.replace(/\\+/g, "/");
  const indexHref = navRoot === "." ? "index.html" : `${navRoot}/index.html`;
  const header = showTitle ? `<h1>${escapeHTML(title)}</h1>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHTML(title)} - BREP Docs</title>
<style>${css}</style>
</head>
<body>
<main>
  <nav class="doc-nav"><a href="${indexHref}">Docs Index</a><span>&middot;</span><a href="/about.html">About</a></nav>
  <section class="card doc-card">
    ${header}
    <div class="prose">
${content}
    </div>
  </section>
</main>
</body>
</html>`;
};

function generateDocsSite() {
  if (!existsSync(docsSourceDir)) {
    console.warn("docs directory not found; skipping docs HTML generation");
    return;
  }

  mkdirSync(path.join(rootDir, "public"), { recursive: true });
  rmSync(docsOutputDir, { recursive: true, force: true });
  mkdirSync(docsOutputDir, { recursive: true });

  const pages = [];

  const walk = (srcDir, destDir) => {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        const nextDest = path.join(destDir, entry.name);
        mkdirSync(nextDest, { recursive: true });
        walk(srcPath, nextDest);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".md") {
        const baseName = path.basename(entry.name, ext);
        const destPath = path.join(destDir, `${baseName}.html`);
        const md = readFileSync(srcPath, "utf-8");
        const pageTitle = extractTitle(md, baseName);
        let body = renderMarkdown(md);
        body = convertMarkdownLinks(body);
        const relRoot = path.relative(path.dirname(destPath), docsOutputDir) || ".";
        const htmlPage = docTemplate(pageTitle, body, { relativeRoot: relRoot, showTitle: false });
        writeFileSync(destPath, htmlPage, "utf-8");
        const relativeHref = toPosix(path.relative(docsOutputDir, destPath));
        pages.push({ title: pageTitle, href: relativeHref });
        continue;
      }

      const destAsset = path.join(destDir, entry.name);
      copyFileSync(srcPath, destAsset);
    }
  };

  walk(docsSourceDir, docsOutputDir);

  const sortedPages = pages.sort((a, b) => a.href.localeCompare(b.href));
  const listItems = sortedPages
    .map((page) => `<li><a href="./${escapeHTML(page.href)}">${escapeHTML(page.title)}</a></li>`)
    .join("\n");

  const indexContent = sortedPages.length
    ? `<p>Select a document below.</p>\n<ul class="doc-list">${listItems}</ul>`
    : `<p>No documentation pages were found.</p>`;

  const indexHtml = docTemplate("BREP Documentation", indexContent, { relativeRoot: ".", showTitle: true });
  writeFileSync(path.join(docsOutputDir, "index.html"), indexHtml, "utf-8");

  console.log(`✔ Generated ${sortedPages.length} documentation page${sortedPages.length === 1 ? "" : "s"} in public/docs`);
}

const readmeHTML = convertMarkdownLinks(renderMarkdown(readmeText));

generateDocsSite();







let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>About BREP</title>
<style>${css}</style>
</head>
<body>
<main>
  <section class="card readme">
    <div class="header"><h1>Project Overview</h1></div>
    <div class="content prose">${readmeHTML}</div>
  </section>

  <section class="card">
    <h1>This project's license</h1>
    <div style="white-space: pre-wrap;">${escapeHTML(licenseText)}</div>
  </section>

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

writeFileSync("about.html", html, "utf-8");
console.log("✔ about.html generated");
