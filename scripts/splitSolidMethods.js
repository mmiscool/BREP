#!/usr/bin/env node
/**
 * Mechanical refactor for `src/BREP/BetterSolid.js` to split the Solid class
 * into per-method modules while keeping public APIs intact.
 *
 * The script performs:
 *  - Moves shared helpers (debugMode, Edge, Vertex, Face, etc.) into SolidShared.js.
 *  - Generates SolidMethods/<method>.js files (one per method, default export).
 *  - Rewrites BetterSolid.js so Solid methods delegate to the generated modules.
 *
 * Usage:
 *   node scripts/splitSolidMethods.js [path/to/BetterSolid.js]
 *
 * If no path is provided it defaults to src/BREP/BetterSolid.js.
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_RELATIVE_PATH = "src/BREP/BetterSolid.js";
const METHOD_DIR_NAME = "SolidMethods";
const SHARED_FILENAME = "SolidShared.js";

function main() {
    const targetArg = process.argv[2] || DEFAULT_RELATIVE_PATH;
    const targetPath = path.resolve(process.cwd(), targetArg);
    const projectRoot = process.cwd();

    if (!fs.existsSync(targetPath)) {
        console.error(`Target file not found: ${targetPath}`);
        process.exitCode = 1;
        return;
    }

    const source = fs.readFileSync(targetPath, "utf8");
    const analysis = analyzeSource(source);

    const sharedPath = path.join(path.dirname(targetPath), SHARED_FILENAME);
    const methodDir = path.join(path.dirname(targetPath), METHOD_DIR_NAME);
    const methodsIndexPath = path.join(methodDir, "index.js");

    writeSharedModule(sharedPath, analysis);
    writeMethodModules(methodDir, methodsIndexPath, analysis.methods);
    const rewritten = rewriteBetterSolid(source, analysis);

    fs.writeFileSync(targetPath, rewritten, "utf8");

    console.log("Refactor complete.");
    console.log(` - Shared helpers: ${path.relative(projectRoot, sharedPath)}`);
    console.log(` - Method modules: ${path.relative(projectRoot, methodDir)}`);
    console.log(` - Updated class: ${path.relative(projectRoot, targetPath)}`);
}

/**
 * Analyze the source file to extract structural information.
 * @param {string} source
 * @returns {object}
 */
function analyzeSource(source) {
    const docImportIdx = findFirstImportIndex(source);

    const debugIdx = source.indexOf("const debugMode", docImportIdx);
    if (debugIdx === -1) {
        throw new Error("Unable to locate debugMode declaration.");
    }

    const classIdx = source.indexOf("export class Solid extends", debugIdx);
    if (classIdx === -1) {
        throw new Error("Unable to locate Solid class declaration.");
    }

    const manifoldConstIdx = source.indexOf("const { Manifold", docImportIdx);
    if (manifoldConstIdx === -1 || manifoldConstIdx > debugIdx) {
        throw new Error("Unable to locate Manifold destructuring.");
    }
    const manifoldConstEnd = findStatementEnd(source, manifoldConstIdx);

    const importBlock = source.slice(docImportIdx, manifoldConstEnd);

    let helpersBlock = source.slice(debugIdx, classIdx);
    let solidDocComment = "";
    const docCommentIdx = helpersBlock.lastIndexOf("/**");
    if (docCommentIdx !== -1) {
        solidDocComment = helpersBlock.slice(docCommentIdx);
        helpersBlock = helpersBlock.slice(0, docCommentIdx);
    }
    helpersBlock = helpersBlock.trimEnd();

    const classBodyInfo = extractClassBody(source, classIdx);
    const methods = extractMethods(source, classBodyInfo.bodyStart, classBodyInfo.bodyEnd);

    return {
        docPrefix: source.slice(0, docImportIdx),
        importBlock,
        helpersBlock,
        solidDocComment,
        classIdx,
        classBodyInfo,
        methods,
    };
}

function findFirstImportIndex(str) {
    let i = 0;
    while (i < str.length) {
        if (/\s/.test(str[i])) {
            i++;
            continue;
        }
        if (str.startsWith("//", i)) {
            const end = str.indexOf("\n", i);
            i = end === -1 ? str.length : end + 1;
            continue;
        }
        if (str.startsWith("/*", i)) {
            const end = str.indexOf("*/", i);
            if (end === -1) throw new Error("Unterminated comment while scanning for imports.");
            i = end + 2;
            continue;
        }
        if (str.startsWith("import", i)) {
            return i;
        }
        throw new Error("Unexpected content before first import statement.");
    }
    throw new Error("Unable to locate import block.");
}

/**
 * Find the end index (exclusive) of a statement terminated by ';'.
 */
function findStatementEnd(str, startIdx) {
    let i = startIdx;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let templateDepth = 0;
    while (i < str.length) {
        const ch = str[i];
        const prev = str[i - 1];
        if (inSingle) {
            if (ch === "'" && prev !== "\\") inSingle = false;
            i++;
            continue;
        }
        if (inDouble) {
            if (ch === '"' && prev !== "\\") inDouble = false;
            i++;
            continue;
        }
        if (inTemplate) {
            if (ch === "`" && prev !== "\\") {
                if (templateDepth === 0) {
                    inTemplate = false;
                }
            } else if (ch === "{" && prev === "$") {
                templateDepth++;
            } else if (ch === "}" && templateDepth > 0) {
                templateDepth--;
            }
            i++;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            i++;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            i++;
            continue;
        }
        if (ch === "`") {
            inTemplate = true;
            templateDepth = 0;
            i++;
            continue;
        }
        if (ch === ";") {
            return i + 1;
        }
        if (ch === "/" && str[i + 1] === "/") {
            i += 2;
            while (i < str.length && str[i] !== "\n") i++;
            continue;
        }
        if (ch === "/" && str[i + 1] === "*") {
            i += 2;
            while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        i++;
    }
    return str.length;
}

/**
 * Locate the Solid class body boundaries.
 */
function extractClassBody(source, classIdx) {
    const braceStart = source.indexOf("{", classIdx);
    if (braceStart === -1) throw new Error("Failed to find class body start.");
    const bodyEnd = findMatchingBrace(source, braceStart);
    if (bodyEnd === -1) throw new Error("Failed to locate Solid class closing brace.");
    return { braceStart, bodyStart: braceStart + 1, bodyEnd, classEnd: bodyEnd + 1 };
}

function findMatchingBrace(str, startIdx) {
    let depth = 0;
    for (let i = startIdx; i < str.length; i++) {
        const ch = str[i];
        if (ch === "'" || ch === '"' || ch === "`") {
            i = skipString(str, i);
            continue;
        }
        if (ch === "/" && str[i + 1] === "/") {
            i += 2;
            while (i < str.length && str[i] !== "\n") i++;
            continue;
        }
        if (ch === "/" && str[i + 1] === "*") {
            i += 2;
            while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function skipString(str, startIdx) {
    const quote = str[startIdx];
    let i = startIdx + 1;
    while (i < str.length) {
        const ch = str[i];
        if (ch === "\\" && i + 1 < str.length) {
            i += 2;
            continue;
        }
        if (ch === quote) return i;
        if (quote === "`" && ch === "$" && str[i + 1] === "{") {
            i = findMatchingBrace(str, i + 1);
            if (i === -1) return str.length;
            continue;
        }
        i++;
    }
    return str.length;
}

/**
 * Extract all methods defined directly on the Solid class.
 */
function extractMethods(source, bodyStart, bodyEnd) {
    const methods = [];
    let i = bodyStart;

    while (i < bodyEnd) {
        const lead = collectWhitespace(source, i, bodyEnd);
        i += lead.length;
        if (i >= bodyEnd) break;

        if (source[i] === "}") break;

        const leadingComments = collectLeadingComments(source, i, bodyEnd);
        i += leadingComments.length;

        const methodStart = i;
        const headerInfo = parseMethodHeader(source, i, bodyEnd);
        if (!headerInfo) break;

        const { headerEnd, name, header, isStatic } = headerInfo;
        i = headerEnd;
        while (i < bodyEnd && /\s/.test(source[i])) i++;
        if (source[i] !== "{") {
            throw new Error(`Expected '{' after method header for ${name}.`);
        }
        const bodyClose = findMatchingBrace(source, i);
        if (bodyClose === -1 || bodyClose > bodyEnd) {
            throw new Error(`Failed to locate method body for ${name}.`);
        }

        const methodEnd = bodyClose + 1;
        const methodText = source.slice(methodStart, methodEnd);
        const bodyText = source.slice(i, methodEnd);

        methods.push({
            name,
            isStatic,
            header: header.trim(),
            headerRaw: source.slice(methodStart, headerEnd),
            body: bodyText,
            fullText: leadingComments + methodText,
            leading: leadingComments,
            start: methodStart,
            end: methodEnd,
        });

        i = methodEnd;
    }
    return methods;
}

function collectWhitespace(str, start, limit) {
    let i = start;
    while (i < limit && /\s/.test(str[i])) i++;
    return str.slice(start, i);
}

function collectLeadingComments(str, start, limit) {
    let i = start;
    let out = "";
    while (i < limit) {
        if (str.startsWith("//", i)) {
            const end = str.indexOf("\n", i);
            const lineEnd = end === -1 ? limit : end + 1;
            out += str.slice(i, lineEnd);
            i = lineEnd;
            continue;
        }
        if (str.startsWith("/*", i)) {
            const end = str.indexOf("*/", i);
            if (end === -1) throw new Error("Unterminated block comment.");
            const blockEnd = end + 2;
            out += str.slice(i, blockEnd);
            i = blockEnd;
            if (str[i] === "\n") {
                out += "\n";
                i++;
            }
            continue;
        }
        if (/\s/.test(str[i])) {
            out += str[i];
            i++;
            continue;
        }
        break;
    }
    return out;
}

function parseMethodHeader(str, start, limit) {
    let i = start;
    const tokens = [];
    const skipWhitespace = () => {
        while (i < limit && /\s/.test(str[i])) i++;
    };

    skipWhitespace();
    const headerStart = i;
    while (i < limit) {
        const ch = str[i];
        if (ch === "(") break;
        if (ch === "'" || ch === '"' || ch === "`") {
            throw new Error("Unexpected string literal in method header.");
        }
        if (ch === "/" && str[i + 1] === "/") {
            throw new Error("Unexpected comment in method header.");
        }
        i++;
    }
    if (i >= limit) return null;

    const parenStart = i;
    const parenEnd = findMatchingParen(str, parenStart);
    if (parenEnd === -1) {
        throw new Error("Failed to match method parameter parentheses.");
    }
    const headerEnd = parenEnd + 1;
    const header = str.slice(headerStart, headerEnd);
    const nameMatch = header.match(/([A-Za-z0-9_$]+)\s*\(/);
    if (!nameMatch) {
        throw new Error(`Unable to parse method name from header: ${header}`);
    }
    const isStatic = /\bstatic\b/.test(header);
    return {
        name: nameMatch[1],
        header,
        headerEnd,
        isStatic,
    };
}

function findMatchingParen(str, startIdx) {
    let depth = 0;
    for (let i = startIdx; i < str.length; i++) {
        const ch = str[i];
        if (ch === "'" || ch === '"' || ch === "`") {
            i = skipString(str, i);
            continue;
        }
        if (ch === "/" && str[i + 1] === "/") {
            i += 2;
            while (i < str.length && str[i] !== "\n") i++;
            continue;
        }
        if (ch === "/" && str[i + 1] === "*") {
            i += 2;
            while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function writeSharedModule(sharedPath, analysis) {
    const header = `import manifold from "./setupManifold.js";\n\nimport * as THREE from "three";\nimport { CADmaterials } from '../UI/CADmaterials.js';\nimport { Line2, LineGeometry } from "three/examples/jsm/Addons.js";\n\nconst { Manifold, Mesh: ManifoldMesh } = manifold;\n\n`;
    const exportsBlock = `\nexport {\n    manifold,\n    Manifold,\n    ManifoldMesh,\n    THREE,\n    CADmaterials,\n    Line2,\n    LineGeometry,\n    debugMode,\n};\n`;
    const reexports = `\nexport { Edge, Vertex, Face };\n`;
    const helpers = analysis.helpersBlock.trim();
    const content = `${header}${helpers}\n${exportsBlock}${reexports}`;
    fs.writeFileSync(sharedPath, `${content}\n`, "utf8");
}

function writeMethodModules(methodDir, methodsIndexPath, methods) {
    if (!fs.existsSync(methodDir)) {
        fs.mkdirSync(methodDir, { recursive: true });
    } else {
        for (const name of fs.readdirSync(methodDir)) {
            if (name.endsWith(".js")) {
                fs.unlinkSync(path.join(methodDir, name));
            }
        }
    }

    const importBlock = `import {\n    manifold,\n    Manifold,\n    ManifoldMesh,\n    THREE,\n    CADmaterials,\n    Line2,\n    LineGeometry,\n    debugMode,\n    Edge,\n    Vertex,\n    Face\n} from "../SolidShared.js";\n\n`;

    const indexLines = [];
    const usedExportNames = new Set();

    methods.forEach((method, idx) => {
        const exportName = makeExportName(method, usedExportNames);
        const fileBase = makeFileBase(method, idx);
        const filePath = path.join(methodDir, `${fileBase}.js`);

        const replacements = adjustMethodBody(method);
        let leading = dedent(method.leading || "");
        leading = leading.replace(/\n {2,}\*/g, "\n *").trim();
        const leadingSection = leading ? `${leading}\n` : "";
        const functionDecl = generateFunctionDecl(method, replacements).trimStart();
        const fileContent = `${importBlock}${leadingSection}${functionDecl}`;
        fs.writeFileSync(filePath, `${fileContent.trimEnd()}\n`, "utf8");

        indexLines.push(`export { default as ${exportName} } from "./${fileBase}.js";`);
        method.exportName = exportName;
    });

    fs.writeFileSync(methodsIndexPath, `${indexLines.join("\n")}\n`, "utf8");
}

function makeExportName(method, used) {
    let base = method.name;
    if (base === "constructor") base = "constructorImpl";
    if (method.isStatic && base === method.name) {
        base = `${base}Static`;
    }
    base = base.replace(/[^A-Za-z0-9_$]/g, "_");
    let name = base;
    let counter = 1;
    while (used.has(name) || name === "") {
        name = `${base}_${counter++}`;
    }
    used.add(name);
    return name;
}

function makeFileBase(method, idx) {
    const prefix = method.isStatic ? "static_" : "";
    const base = method.name.replace(/[^A-Za-z0-9_$]/g, "_") || `method_${idx}`;
    return `${prefix}${base}`;
}

function adjustMethodBody(method) {
    let body = method.body;
    if (method.name === "constructor") {
        body = stripSuperCall(body);
    }
    const inner = extractInnerBody(body);
    const needsSolidAlias = /\bnew\s+Solid\b|\bSolid\./.test(inner);
    const solidAlias = needsSolidAlias
        ? (method.isStatic ? "const Solid = this;" : "const Solid = this.constructor;")
        : null;
    return { body, inner, solidAlias };
}

function stripSuperCall(bodyWithBraces) {
    const inner = bodyWithBraces.slice(1, -1);
    const updated = inner.replace(/^\s*super\s*\([^;]*\);\s*/m, "");
    return `{${updated}}`;
}

function extractInnerBody(body) {
    if (!body.startsWith("{") || !body.endsWith("}")) return body;
    let inner = body.slice(1, -1);
    return inner;
}

function generateFunctionDecl(method, replacements) {
    const params = method.header.slice(method.header.indexOf("("));
    const headerPrefix = method.header.slice(0, method.header.indexOf("(")).trim();
    const isAsync = /\basync\b/.test(headerPrefix);
    const isGenerator = headerPrefix.includes("*");
    const declName = method.name === "constructor" ? "constructorBody" : method.name;
    const fnKeyword = `${isAsync ? "async " : ""}function${isGenerator ? "*" : ""}`;
    const header = `export default ${fnKeyword} ${declName}${params}`;

    let lines = [];
    lines.push(`${header} {`);
    if (replacements.solidAlias) {
        lines.push(`        ${replacements.solidAlias}`);
    }
    const innerContent = normalizeInnerBody(replacements.inner);
    if (innerContent.trim()) {
        lines.push(innerContent);
    }
    lines.push("}");
    return `${lines.join("\n")}\n`;
}

function normalizeInnerBody(inner) {
    let content = inner;
    if (content.startsWith("\n")) content = content.slice(1);
    if (content.endsWith("\n")) content = content.slice(0, -1);
    return content.replace(/\n/g, "\n");
}

function dedent(str) {
    const lines = str.split("\n");
    let minIndent = Infinity;
    for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(/^(\s+)/);
        if (match) {
            minIndent = Math.min(minIndent, match[1].length);
        } else {
            minIndent = 0;
            break;
        }
    }
    if (!isFinite(minIndent) || minIndent === 0) return str;
    const trimmed = lines.map(line => line.startsWith(" ".repeat(minIndent)) ? line.slice(minIndent) : line);
    return trimmed.join("\n");
}

function rewriteBetterSolid(source, analysis) {
    const sharedImport = [
        'import {',
        '    manifold,',
        '    Manifold,',
        '    ManifoldMesh,',
        '    THREE,',
        '    CADmaterials,',
        '    Line2,',
        '    LineGeometry,',
        '    debugMode,',
        '    Edge,',
        '    Vertex,',
        '    Face',
        '} from "./SolidShared.js";',
        'import * as SolidMethods from "./SolidMethods/index.js";',
        'export { Edge, Vertex, Face } from "./SolidShared.js";',
        ''
    ].join("\n");

    const classBody = buildClassBody(analysis.methods);
    const beforeClass = analysis.docPrefix + sharedImport;
    const classHead = `${analysis.solidDocComment || ""}${source.slice(analysis.classIdx, analysis.classBodyInfo.bodyStart)}`;
    const afterClass = source.slice(analysis.classBodyInfo.bodyEnd);

    return `${beforeClass}${classHead}\n${classBody}${afterClass}`;
}

function buildClassBody(methods) {
    const indent = "    ";
    const innerIndent = indent + indent;
    const blocks = methods.map(method => {
        const header = method.header.trim();
        const exportName = method.exportName;
        if (method.name === "constructor") {
            return [
                `${indent}${header} {`,
                `${innerIndent}super(...arguments);`,
                `${innerIndent}SolidMethods.${exportName}.apply(this, arguments);`,
                `${indent}}`
            ].join("\n");
        }
        const callTarget = `SolidMethods.${exportName}`;
        const bodyLines = method.isStatic
            ? [`${innerIndent}return ${callTarget}.apply(this, arguments);`]
            : [`${innerIndent}return ${callTarget}.apply(this, arguments);`];
        return [`${indent}${header} {`, ...bodyLines, `${indent}}`].join("\n");
    });
    return `${blocks.join("\n\n")}\n`;
}

main();
