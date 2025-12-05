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
const docsOutputDir = path.join(rootDir, "public", "help");

const css = `
:root{
  --bg:#0b0f14; --panel:#0f141b; --text:#d7dde6; --muted:#9aa7b2;
  --border:#1b2430; --accent:#5cc8ff; --chip:#121823;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace}
main{max-width:1100px;margin:0 auto;padding:28px}
h1{margin:0 0 18px;font-size:22px;color:var(--accent);font-weight:700}
.summary{color:var(--muted);margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;margin:0 0 18px}
.readme{padding:0}
.readme .header{padding:16px 18px;border-bottom:1px solid var(--border)}
.readme .content{padding:18px}
.doc-card{padding:18px}
.doc-nav{margin:0 0 18px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;color:var(--muted)}
.doc-nav-links{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.doc-nav a{color:var(--accent);font-weight:600}
.doc-list{list-style:none;margin:18px 0;padding:0}
.doc-list li{margin:6px 0}
.doc-list a{color:var(--accent)}
.nav-search{margin-left:auto;position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;min-width:240px;max-width:520px}
.search-title{font-weight:700;font-size:14px;margin-bottom:4px}
.search-hint{color:var(--muted);font-size:12px;margin:0}
.search-input-row{display:flex;gap:8px;align-items:center;width:100%}
.search-input{flex:1;border:1px solid var(--border);border-radius:10px;background:var(--chip);color:var(--text);padding:10px 12px}
.search-input:focus{outline:1px solid var(--accent);box-shadow:0 0 0 3px rgba(92,200,255,0.15)}
.search-clear{border:1px solid var(--border);background:var(--panel);color:var(--muted);border-radius:10px;padding:9px 12px;cursor:pointer;font-weight:600}
.search-clear:hover{border-color:var(--accent);color:var(--accent)}
.search-status{color:var(--muted);font-size:12px;margin-top:4px;width:100%;text-align:right}
.search-results{position:absolute;top:100%;right:0;margin-top:10px;border:1px solid var(--border);border-radius:12px;background:var(--panel);max-height:360px;overflow:auto;min-width:320px;max-width:520px;box-shadow:0 12px 30px rgba(0,0,0,0.35);z-index:25}
.search-results ul{list-style:none;margin:0;padding:0}
.search-item{padding:10px 12px;border-bottom:1px solid var(--border)}
.search-item:last-child{border-bottom:none}
.search-item a{display:block;color:var(--accent);font-weight:600}
.search-snippet{color:var(--muted);font-size:13px;margin-top:4px}
.search-results mark{background:rgba(92,200,255,0.2);color:var(--text);border-radius:4px;padding:0 2px}
.prose h1{font-size:24px;margin:0 0 12px}
.prose h2{font-size:18px;margin:18px 0 8px}
.prose h3{font-size:16px;margin:14px 0 6px}
.prose p{margin:0 0 10px}
.prose ul,.prose ol{margin:0 0 10px 18px}
.prose li{margin:4px 0}
.prose code{background:#0d1520;border:1px solid var(--border);padding:1px 5px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace;font-size:12px}
.prose pre{background:#0d1520;border:1px solid var(--border);padding:12px;border-radius:12px;overflow:auto}
.prose a{color:var(--accent)}
.prose img{max-width:100%;height:auto;}
.prose table{border-collapse:collapse;width:100%;margin:16px 0;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.prose th,.prose td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
.prose th{background:var(--chip);color:var(--text);font-weight:600;font-size:13px}
.prose tr:last-child td{border-bottom:none}
.prose tbody tr:hover{background:rgba(92,200,255,0.05)}
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

// Helper function to parse markdown tables
function parseTable(tableLines) {
  if (tableLines.length < 2) return null;

  // Parse header row
  const headerLine = tableLines[0].trim();
  if (!headerLine.includes('|')) return null;

  // Parse separator row (must be second line)
  const separatorLine = tableLines[1].trim();
  if (!separatorLine.match(/^\|?[\s\-\|:]+\|?$/)) return null;

  // Extract headers
  const headers = headerLine.split('|')
    .map(h => h.trim())
    .filter(h => h !== '');

  // Extract alignment from separator
  const alignments = separatorLine.split('|')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(s => {
      if (s.startsWith(':') && s.endsWith(':')) return 'center';
      if (s.endsWith(':')) return 'right';
      return 'left';
    });

  // Parse data rows
  const dataRows = tableLines.slice(2).map(line => {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) return null;
    return trimmed.split('|')
      .map(cell => cell.trim())
      .filter((cell, idx, arr) => {
        // Remove empty first/last cells if they're from leading/trailing |
        return !(cell === '' && (idx === 0 || idx === arr.length - 1));
      });
  }).filter(row => row !== null);

  return { headers, alignments, dataRows };
}

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
  let listType = null; // 'ul' for unordered, 'ol' for ordered
  let inTable = false;
  let tableLines = [];
  let para = [];

  const flushPara = () => {
    if (para.length) {
      const line = para.join(" ").trim();
      if (line) html += `<p>${inline(line)}</p>`;
      para = [];
    }
  };

  const flushTable = () => {
    if (tableLines.length >= 2) {
      const table = parseTable(tableLines);
      if (table) {
        html += renderTableHTML(table);
      } else {
        // If table parsing failed, treat as regular paragraphs
        for (const line of tableLines) {
          para.push(line.trim());
        }
        flushPara();
      }
    } else {
      // Not enough lines for a table, treat as paragraphs
      for (const line of tableLines) {
        para.push(line.trim());
      }
      flushPara();
    }
    tableLines = [];
    inTable = false;
  };

  const renderTableHTML = (table) => {
    let tableHTML = '<table>';

    // Header
    if (table.headers.length > 0) {
      tableHTML += '<thead><tr>';
      for (let i = 0; i < table.headers.length; i++) {
        const align = table.alignments[i] || 'left';
        const style = align !== 'left' ? ` style="text-align: ${align}"` : '';
        tableHTML += `<th${style}>${inline(table.headers[i])}</th>`;
      }
      tableHTML += '</tr></thead>';
    }

    // Body
    if (table.dataRows.length > 0) {
      tableHTML += '<tbody>';
      for (const row of table.dataRows) {
        tableHTML += '<tr>';
        for (let i = 0; i < row.length; i++) {
          const align = table.alignments[i] || 'left';
          const style = align !== 'left' ? ` style="text-align: ${align}"` : '';
          tableHTML += `<td${style}>${inline(row[i] || '')}</td>`;
        }
        tableHTML += '</tr>';
      }
      tableHTML += '</tbody>';
    }

    tableHTML += '</table>';
    return tableHTML;
  };

  const inline = (s) => {
    // escape first; we keep markdown specials (*_`[]()#) unescaped
    let out = escape(s);
    // images ![alt](src "title")
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_m, alt = "", src = "", title = "") => {
      const altAttr = alt.trim();
      const srcAttr = src.trim();
      const titleAttr = title ? ` title="${title.trim()}"` : "";
      const normalizedSrc = srcAttr.split(/[?#]/)[0];
      const isDialogScreenshot = normalizedSrc.toLowerCase().endsWith('_dialog.png');
      const widthAttr = isDialogScreenshot ? ' width="280"' : '';
      return `<img src="${srcAttr}" alt="${altAttr}"${titleAttr}${widthAttr} loading="lazy" />`;
    });
    // links [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`);
    // auto-link naked URLs (https:// and http://)
    out = out.replace(/(^|[^">=\])])((https?:\/\/[^\s<>"'`\])\}]+))/g, (match, prefix, url) => {
      return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
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
      if (inTable) {
        flushTable();
      }
      if (inList) { html += `</${listType}>`; inList = false; listType = null; }
      flushPara();
      continue;
    }

    // Check for potential table line (contains |)
    const isTableLine = line.includes('|');

    if (isTableLine && !inTable) {
      // Start of potential table
      if (inList) { html += `</${listType}>`; inList = false; listType = null; }
      flushPara();
      inTable = true;
      tableLines = [line];
      continue;
    } else if (isTableLine && inTable) {
      // Continue table
      tableLines.push(line);
      continue;
    } else if (inTable && !isTableLine) {
      // End of table
      flushTable();
    }

    // headings #..######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inList) { html += `</${listType}>`; inList = false; listType = null; }
      if (inTable) { flushTable(); }
      flushPara();
      const level = h[1].length;
      html += `<h${level}>${inline(h[2].trim())}</h${level}>`;
      continue;
    }

    // numbered list items
    const numberedLi = line.match(/^(\d+)\.\s+(.*)$/);
    if (numberedLi) {
      if (inTable) { flushTable(); }
      flushPara();
      if (!inList || listType !== 'ol') {
        if (inList) { html += `</${listType}>`; }
        html += `<ol>`;
        inList = true;
        listType = 'ol';
      }
      html += `<li>${inline(numberedLi[2].trim())}</li>`;
      continue;
    }

    // bullet list items
    const bulletLi = line.match(/^[-*]\s+(.*)$/);
    if (bulletLi) {
      if (inTable) { flushTable(); }
      flushPara();
      if (!inList || listType !== 'ul') {
        if (inList) { html += `</${listType}>`; }
        html += `<ul>`;
        inList = true;
        listType = 'ul';
      }
      html += `<li>${inline(bulletLi[1].trim())}</li>`;
      continue;
    }

    // normal paragraph line (accumulate)
    para.push(line.trim());
  }
  if (inTable) flushTable();
  if (inList) html += `</${listType}>`;
  flushPara();

  // restore fenced code blocks
  html = html.replace(/§§CODE(\d+)§§/g, (_m, i) => codeBlocks[Number(i)] ?? "");
  return html;
}

const toPosix = (p) => p.split(path.sep).join("/");

const isExternalLink = (href = "") =>
  /^[a-z]+:/i.test(href) || href.startsWith("//");

const flattenPath = (p = "") => {
  const normalized = toPosix(p).replace(/^(\.\/)+/, "");
  return normalized.split("/").filter(Boolean).join("__");
};

const resolveRelativePath = (href = "", baseDir = "") => {
  const base = toPosix(baseDir || "");
  const cleanHref = toPosix(href || "");
  if (!base) return cleanHref.replace(/^(\.\/)+/, "");
  return path.posix.normalize(path.posix.join(base, cleanHref)).replace(/^(\.\/)+/, "");
};

const flattenHrefWithBase = (href = "", baseDir = "") => {
  if (!href) return href;
  if (isExternalLink(href)) return href;
  if (href.startsWith("#")) return href;
  if (href.startsWith("/")) return href;
  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const preHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = preHash.indexOf("?");
  const query = queryIndex >= 0 ? preHash.slice(queryIndex) : "";
  const pathOnly = queryIndex >= 0 ? preHash.slice(0, queryIndex) : preHash;
  const resolved = resolveRelativePath(pathOnly, baseDir);
  const flatPath = flattenPath(resolved);
  return `${flatPath}${query}${hash}`;
};

const flattenDocResources = (html = "", baseDir = "") =>
  html
    .replace(/href="([^"]+)"/g, (_m, href) => `href="${flattenHrefWithBase(href, baseDir)}"`)
    .replace(/src="([^"]+)"/g, (_m, src) => `src="${flattenHrefWithBase(src, baseDir)}"`);

const convertMarkdownLinks = (html) =>
  html.replace(/href="([^"#]+?)\.md(#[^"]*)?"/g, (match, base, hash = "") => {
    const fullPath = `${base}.md`;
    if (/^[a-z]+:/i.test(fullPath)) return match;
    const next = `${base}.html${hash}`;
    return `href="${next}"`;
  });

const convertReadmeLinks = (html) =>
  html.replace(/href="([^"#]+?)\.md(#[^"]*)?"/g, (match, base, hash = "") => {
    const fullPath = `${base}.md`;
    if (/^[a-z]+:/i.test(fullPath)) return match;
    // Remove 'docs/' prefix for README since we're now in the help root
    const cleanBase = base.startsWith('docs/') ? base.substring(5) : base;
    const next = `${cleanBase}.html${hash}`;
    return `href="${next}"`;
  }).replace(/src="docs\//g, 'src="');

const decodeEntities = (text = "") =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const htmlToSearchText = (html = "") => {
  const withoutTags = html
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
};

const summarizeText = (text = "", max = 240) => {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
};

const addSearchEntry = (entries, { title, href, html }) => {
  if (!href) return;
  const normalizedHref = toPosix(href);
  const textContent = htmlToSearchText(html ?? "");
  entries.push({
    title: title || normalizedHref,
    href: normalizedHref,
    summary: summarizeText(textContent),
    content: textContent,
  });
};

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
<title>${escapeHTML(title)} - BREP</title>
<style>${css}</style>
</head>
<body>
<main>
  <nav class="doc-nav">
    <div class="doc-nav-links">
      <a href="${indexHref}">Help Home</a><span>&middot;</span><a href="/help/table-of-contents.html">Table of Contents</a><span>&middot;</span><a href="https://github.com/mmiscool/BREP" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
    <div class="nav-search">
      <div class="search-input-row">
        <input type="search" id="doc-search" class="search-input" placeholder="Search docs... Type at least 2 characters to search" autocomplete="off" spellcheck="false" />
        <button type="button" class="search-clear" id="doc-search-clear">Clear</button>
      </div>
      <div class="search-status" id="doc-search-status"></div>
      <div class="search-results" id="doc-search-results" hidden>
        <ul id="doc-search-list"></ul>
      </div>
    </div>
  </nav>
  <section class="card doc-card">
    ${header}
    <div class="prose">
${content}
    </div>
  </section>
</main>
<script>
(() => {
  const searchInput = document.getElementById("doc-search");
  const resultsBox = document.getElementById("doc-search-results");
  const resultsList = document.getElementById("doc-search-list");
  const statusEl = document.getElementById("doc-search-status");
  const clearBtn = document.getElementById("doc-search-clear");
  if (!searchInput || !resultsBox || !resultsList || !statusEl || !clearBtn) return;
  const indexUrl = "${navRoot}/search-index.json";
  let indexPromise = null;
  let cachedEntries = null;

  const escapeHtml = (text = "") =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const escapeRegExp = (text = "") => text.replace(/[.*+?^{}()|\[\]\\$]/g, "\\$&");

  const highlight = (text, terms) => {
    if (!terms.length) return escapeHtml(text);
    const pattern = terms.map(escapeRegExp).join("|");
    const regex = new RegExp(\`(\${pattern})\`, "gi");
    return escapeHtml(text).replace(regex, "<mark>$1</mark>");
  };

  const buildSnippet = (entry, terms) => {
    const source = entry.content || entry.summary || "";
    if (!source) return { plain: "", highlighted: "" };
    let hit = source.length;
    for (const term of terms) {
      const idx = entry.contentLower.indexOf(term);
      if (idx !== -1 && idx < hit) hit = idx;
    }
    if (!Number.isFinite(hit) || hit === source.length) hit = 0;
    const start = Math.max(0, hit - 60);
    const end = Math.min(source.length, hit + 140);
    const snippet = source.slice(start, end);
    return { plain: snippet, highlighted: highlight(snippet, terms) };
  };

  const updateStatus = (message) => {
    statusEl.textContent = message;
  };

  const loadIndex = async () => {
    if (cachedEntries) return cachedEntries;
    if (!indexPromise) {
      indexPromise = fetch(indexUrl, { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error("Failed to load search index");
          return res.json();
        })
        .then((json) => {
          cachedEntries = Array.isArray(json)
            ? json.map((entry) => ({
                ...entry,
                contentLower: (entry.content || "").toLowerCase(),
                titleLower: (entry.title || "").toLowerCase(),
              }))
            : [];
          return cachedEntries;
        })
        .catch((err) => {
          console.error("Search index load failed", err);
          cachedEntries = [];
          throw err;
        });
    }
    return indexPromise;
  };

  const renderResults = (entries, terms) => {
    if (!terms.length) {
      resultsBox.hidden = true;
      return;
    }
    if (!entries.length) {
      resultsList.innerHTML = '<li class="search-item"><div class="search-snippet">No matches found.</div></li>';
      resultsBox.hidden = false;
      return;
    }
    const rendered = entries
      .slice(0, 30)
      .map((entry) => {
        const snippet = buildSnippet(entry, terms);
        const title = highlight(entry.title || entry.href, terms);
        const hasFragment = snippet.plain && snippet.plain.trim().length > 0;
        const fragment = hasFragment ? \`#:~:text=\${encodeURIComponent(snippet.plain.trim())}\` : "";
        const hrefWithFragment = hasFragment
          ? (entry.href.includes("#") ? \`\${entry.href}&:~:text=\${encodeURIComponent(snippet.plain.trim())}\` : \`\${entry.href}\${fragment}\`)
          : entry.href;
        const snippetHtml = snippet.highlighted ? \`<div class="search-snippet">\${snippet.highlighted}</div>\` : "";
        return \`<li class="search-item"><a href="\${hrefWithFragment}">\${title}</a>\${snippetHtml}</li>\`;
      })
      .join("");
    resultsList.innerHTML = rendered;
    resultsBox.hidden = false;
  };

  const performSearch = async () => {
    const rawQuery = searchInput.value.trim();
    if (rawQuery.length < 2) {
      updateStatus("Type at least 2 characters to search.");
      resultsBox.hidden = true;
      return;
    }
    const terms = rawQuery.toLowerCase().split(/\\s+/).filter(Boolean);
    updateStatus("Searching...");
    try {
      const entries = await loadIndex();
      const matches = entries.filter((entry) =>
        terms.every((term) => entry.contentLower.includes(term) || entry.titleLower.includes(term))
      );
      renderResults(matches, terms);
      updateStatus(matches.length ? \`\${matches.length} result\${matches.length === 1 ? "" : "s"} for "\${rawQuery}"\` : "No matches found.");
    } catch (err) {
      updateStatus("Search unavailable (could not load index).");
    }
  };

  searchInput.addEventListener("input", performSearch);

  searchInput.addEventListener("focus", () => {
    if (!cachedEntries) {
      loadIndex().catch(() => updateStatus("Search unavailable (could not load index)."));
    }
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    resultsBox.hidden = true;
    updateStatus("Type at least 2 characters to search.");
    searchInput.focus();
  });

  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      resultsBox.hidden = true;
      updateStatus("Type at least 2 characters to search.");
    }
  });
})();
</script>
</body>
</html>`;
};

function generateTableOfContents(pages, outputDir) {
  // Create a tree structure from the pages
  const tree = {};

  // Add root-level files first
  const rootFiles = pages.filter(p => !p.href.includes('/'));

  // Add files in subdirectories
  pages.forEach(page => {
    const parts = page.href.split('/');
    if (parts.length === 1) {
      // Root level file
      if (!tree._root) tree._root = [];
      tree._root.push(page);
    } else {
      // File in subdirectory
      const dir = parts[0];
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push({
        ...page,
        href: page.href,
        name: parts[parts.length - 1].replace('.html', '')
      });
    }
  });

  // Sort everything
  if (tree._root) {
    tree._root.sort((a, b) => a.title.localeCompare(b.title));
  }
  Object.keys(tree).forEach(key => {
    if (key !== '_root') {
      tree[key].sort((a, b) => a.title.localeCompare(b.title));
    }
  });

  // Generate HTML
  let tocContent = '<h1>Table of Contents</h1>\n<p>Complete documentation structure with all available pages.</p>\n\n';

  // Root level files
  if (tree._root && tree._root.length > 0) {
    tocContent += '<h2>Main Documentation</h2>\n<ul class="doc-list">\n';
    tree._root.forEach(page => {
      tocContent += `<li><a href="./${escapeHTML(page.href)}">${escapeHTML(page.title)}</a></li>\n`;
    });
    tocContent += '</ul>\n\n';
  }

  // Subdirectories
  const sortedDirs = Object.keys(tree).filter(k => k !== '_root').sort();
  sortedDirs.forEach(dir => {
    tocContent += `<h2>${escapeHTML(dir.charAt(0).toUpperCase() + dir.slice(1))}</h2>\n<ul class="doc-list">\n`;
    tree[dir].forEach(page => {
      tocContent += `<li><a href="./${escapeHTML(page.href)}">${escapeHTML(page.title)}</a></li>\n`;
    });
    tocContent += '</ul>\n\n';
  });

  const tocHtml = docTemplate("Table of Contents", tocContent, { relativeRoot: ".", showTitle: false });
  writeFileSync(path.join(outputDir, "table-of-contents.html"), tocHtml, "utf-8");
  return { html: tocHtml, href: "table-of-contents.html" };
}

function generateDocsSite() {
  if (!existsSync(docsSourceDir)) {
    console.warn("docs directory not found; skipping docs HTML generation");
    return;
  }

  mkdirSync(path.join(rootDir, "public"), { recursive: true });
  rmSync(docsOutputDir, { recursive: true, force: true });
  mkdirSync(docsOutputDir, { recursive: true });

  const pages = [];
  const searchEntries = [];

  const walk = (srcDir) => {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const relFromDocs = path.relative(docsSourceDir, srcPath);
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".md") {
        const baseName = path.basename(relFromDocs, ext);
        const flatName = `${flattenPath(relFromDocs.replace(/\.md$/i, ""))}.html`;
        const destPath = path.join(docsOutputDir, flatName);
        const md = readFileSync(srcPath, "utf-8");
        const pageTitle = extractTitle(md, baseName);
        let body = renderMarkdown(md);
        const baseDir = path.posix ? path.posix.dirname(relFromDocs) : path.dirname(relFromDocs);
        body = convertMarkdownLinks(body);
        body = flattenDocResources(body, baseDir);
        const relRoot = ".";
        const htmlPage = docTemplate(pageTitle, body, { relativeRoot: relRoot, showTitle: false });
        writeFileSync(destPath, htmlPage, "utf-8");
        pages.push({ title: pageTitle, href: flatName });
        addSearchEntry(searchEntries, { title: pageTitle, href: flatName, html: body });
        continue;
      }

      const destAsset = path.join(docsOutputDir, flattenPath(relFromDocs));
      copyFileSync(srcPath, destAsset);
    }
  };

  walk(docsSourceDir);

  // Also process LICENSE.md and CONTRIBUTING.md from root directory
  const rootMdFiles = ['LICENSE.md', 'CONTRIBUTING.md'];
  for (const fileName of rootMdFiles) {
    const srcPath = path.join(rootDir, fileName);
    if (existsSync(srcPath)) {
      const baseName = path.basename(fileName, '.md');
      const destPath = path.join(docsOutputDir, `${baseName}.html`);
      const md = readFileSync(srcPath, "utf-8");
      const pageTitle = extractTitle(md, baseName);
      let body = renderMarkdown(md);
      const baseDir = ".";
      body = convertMarkdownLinks(body);
      body = flattenDocResources(body, baseDir);
      const relRoot = path.relative(path.dirname(destPath), docsOutputDir) || ".";
      const htmlPage = docTemplate(pageTitle, body, { relativeRoot: relRoot, showTitle: false });
      writeFileSync(destPath, htmlPage, "utf-8");
      const relativeHref = toPosix(path.relative(docsOutputDir, destPath));
      pages.push({ title: pageTitle, href: relativeHref });
      addSearchEntry(searchEntries, { title: pageTitle, href: relativeHref, html: body });
    }
  }

  // Sort pages for consistent ordering
  const sortedPages = pages.sort((a, b) => a.href.localeCompare(b.href));

  // Create README as index.html
  const readmePath = path.join(rootDir, "README.md");
  if (existsSync(readmePath)) {
    const readmeMd = readFileSync(readmePath, "utf-8");
    const readmeTitle = extractTitle(readmeMd, "BREP");
    let readmeBody = renderMarkdown(readmeMd);
    const baseDir = ".";
    readmeBody = convertReadmeLinks(readmeBody);
    readmeBody = flattenDocResources(readmeBody, baseDir);

    // Add navigation to other docs at the end of README
    if (sortedPages.length > 0) {
      const listItems = sortedPages
        .map((page) => `<li><a href="./${escapeHTML(page.href)}">${escapeHTML(page.title)}</a></li>`)
        .join("\n");
      readmeBody += `\n\n<h2>Documentation</h2>\n<ul class="doc-list">${listItems}</ul>`;
    }

    // Add license information sections
    readmeBody += `\n\n</div>
  </section>

  <section class="card">
    <h1>This project's license</h1>
    <div style="white-space: pre-wrap;">${escapeHTML(licenseText)}</div>
  </section>

  <h1>Licenses Report of libraries used in this package</h1>
  <div class="summary">${countPackages} packages • ${licenseKeys.length} license types</div>
`;

    // Add all the license sections
    for (const lic of licenseKeys) {
      const list = Array.isArray(data[lic]) ? data[lic] : [];
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));

      readmeBody += `<section class="license">
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
        const versionsCount = Array.isArray(p.versions) ? new Set(p.versions).size : 0;

        readmeBody += `<div class="pkg">
      <div>
        <div class="name">${name}${versionsCount ? ` <span class="chip">${versionsCount} version${versionsCount === 1 ? "" : "s"}</span>` : ""}</div>
        ${desc ? `<div class="desc">${desc}</div>` : ""}
        ${author ? `<div class="desc">Author: ${escapeHTML(author)}</div>` : ""}
      </div>
      <div class="meta">
        ${homepage ? `<a class="chip" href="${escapeHTML(homepage)}" target="_blank" rel="noopener noreferrer">Repo / Homepage</a>` : ""}
      </div>
    </div>`;
      }

      readmeBody += `</section>`;
    }

    readmeBody += `<div class="footer">Generated from <code>pnpm licenses list --prod --long --json</code></div>
    <div class="prose">`;

    const indexHtml = docTemplate(readmeTitle, readmeBody, { relativeRoot: ".", showTitle: false });
    writeFileSync(path.join(docsOutputDir, "index.html"), indexHtml, "utf-8");
    addSearchEntry(searchEntries, { title: readmeTitle, href: "index.html", html: readmeBody });
  }

  // Generate table of contents
  const tocPage = generateTableOfContents(sortedPages, docsOutputDir);
  if (tocPage?.html) {
    addSearchEntry(searchEntries, { title: "Table of Contents", href: tocPage.href, html: tocPage.html });
  }

  // Build a lightweight search index for client-side search
  const searchByHref = new Map();
  for (const entry of searchEntries) {
    if (!entry?.href) continue;
    const normalizedHref = toPosix(entry.href);
    searchByHref.set(normalizedHref, {
      title: entry.title || normalizedHref,
      href: normalizedHref,
      summary: summarizeText(entry.summary || entry.content || ""),
      content: entry.content || "",
    });
  }
  const searchIndex = Array.from(searchByHref.values()).sort((a, b) => a.href.localeCompare(b.href));
  writeFileSync(path.join(docsOutputDir, "search-index.json"), JSON.stringify(searchIndex, null, 2), "utf-8");

  console.log(`✔ Generated ${sortedPages.length + 2} documentation page${sortedPages.length === -1 ? "" : "s"} in public/help`);
}

const readmeHTML = flattenDocResources(convertMarkdownLinks(renderMarkdown(readmeText)), ".");

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
        <div class="name">${name}${versionsCount ? ` <span class="chip">${versionsCount} version${versionsCount === 1 ? "" : "s"}</span>` : ""}</div>
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
