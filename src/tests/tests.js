import path from '../path.proxy.js';
import fs from '../fs.proxy.js';
import { PartHistory } from "../PartHistory.js";
import { test_primitiveCube } from './test_primitiveCube.js';
import { test_solidMetrics, afterRun_solidMetrics } from './test_solidMetrics.js';
import { test_primitiveCylinder } from './test_primitiveCylinder.js';
import { test_plane } from './test_plane.js';
import { test_primitiveCone } from './test_primitiveCone.js';
import { test_primitiveTorus } from './test_primitiveTorus.js';
import { test_boolean_subtract } from './test_boolean_subtract.js';
import { test_primitiveSphere } from './test_primitiveSphere.js';
import { test_primitivePyramid } from './test_primitivePyramid.js';
import { test_stlLoader } from './test_stlLoader.js';
import { test_SweepFace } from './test_sweepFace.js';
import { test_ExtrudeFace } from './test_extrudeFace.js';
import { test_Fillet } from './test_fillet.js';
import { test_Chamfer } from './test_chamfer.js';
import { test_mirror } from './test_mirror.js';
import { test_fillets_more_dificult } from './test_filletsMoreDifficult.js';
import { test_tube } from './test_tube.js';
import { test_tube_closedLoop } from './test_tube_closedLoop.js';


export const testFunctions = [
    { test: test_plane, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveCube, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitivePyramid, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveCylinder, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveCone, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveTorus, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_primitiveSphere, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_boolean_subtract, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_stlLoader, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_SweepFace, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_tube, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_tube_closedLoop, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_ExtrudeFace, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_Fillet, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_fillets_more_dificult, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_Chamfer, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_mirror, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_solidMetrics, afterRun: afterRun_solidMetrics, printArtifacts: true, exportFaces: true, exportSolids: true, resetHistory: true },

];

testFunctions.push();
testFunctions.push();
testFunctions.push();
testFunctions.push();
testFunctions.push();

// Dynamically register tests to import part files from src/tests/partFiles (Node only)
async function registerPartFileTests() {
    if (!(typeof process !== 'undefined' && process.versions && process.versions.node)) return;
    try {
        const partsDir = 'src/tests/partFiles';
        // Use async API to avoid ESM sync-fs readiness issues
        try {
            const entries = await fs.promises.readdir(partsDir);
            const files = entries.filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(partsDir, file);
                const baseName = String(file).replace(/\.[^.]+$/, '');
                const safeName = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').substring(0, 100);
                const testName = `import_part_${safeName}`;

                const importTest = async function (partHistory) {
                    // Read file and load into PartHistory
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    let payload = content;
                    try {
                        const obj = JSON.parse(content);
                        if (obj && typeof obj === 'object') {
                            if (Array.isArray(obj.features)) {
                                payload = JSON.stringify(obj);
                            } else if (obj.data) {
                                payload = (typeof obj.data === 'string') ? obj.data : JSON.stringify(obj.data);
                            }
                        }
                    } catch (_) {
                        // invalid JSON; let runSingleTest catch and report when fromJSON or runHistory runs
                    }
                    await partHistory.reset();
                    await partHistory.fromJSON(payload);
                    // runHistory will be called by runSingleTest()
                };
                try { Object.defineProperty(importTest, 'name', { value: testName, configurable: true }); } catch {}
                testFunctions.push({
                    test: importTest,
                    printArtifacts: false,
                    exportFaces: false,
                    exportSolids: false,
                    resetHistory: true,
                    allowErrors: true,
                    _sourceFile: filePath,
                });
            }
        } catch (e) {
            // Directory may not exist; ignore silently in CI
        }
    } catch (e) {
        console.warn('Failed to register part file import tests:', e?.message || e);
    }
}



// call runTests if we are in the nodejs environment
if (typeof process !== "undefined" && process.versions && process.versions.node) runTests();




export async function runTests(partHistory = new PartHistory(), callbackToRunBetweenTests = null) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
        //await console.clear();
    }

    // delete the ./tests/results directory in an asynchronous way
    await fs.promises.rm('./tests/results', { recursive: true, force: true });

    // Discover and register part-file import tests (Node only)
    await registerPartFileTests();

    for (const testFunction of testFunctions) {
        const isLastTest = testFunction === testFunctions[testFunctions.length - 1];
        await partHistory.reset();
        await partHistory.reset();

        if (testFunction.resetHistory) partHistory.features = [];

        await runSingleTest(testFunction, partHistory);

        if (typeof window !== "undefined") { await callbackToRunBetweenTests(partHistory, isLastTest); } else {
            // run each test and export the results to a folder ./tests/results/<testFunction name>/
            const testName = testFunction.test.name;
            const exportPath = `./tests/results/${testName}/`;
            // create the directory if it does not exist
            if (!fs.existsSync(exportPath)) {
                fs.mkdirSync(exportPath, { recursive: true });
            }

            // Collect SOLID nodes from the scene
            const solids = (partHistory.scene?.children || []).filter(o => o && o.type === 'SOLID' && typeof o.toSTL === 'function');

            // Export solids (triggered by either flag for convenience)
            if (testFunction.exportSolids || testFunction.printArtifacts) {
                solids.forEach((solid, idx) => {
                    const rawName = solid.name && String(solid.name).trim().length ? String(solid.name) : `solid_${idx}`;
                    const safeName = sanitizeFileName(rawName);
                    let stl = "";
                    try {
                        stl = solid.toSTL(safeName, 6);
                    } catch (e) {
                        console.warn(`[runTests] toSTL failed for solid ${rawName}:`, e?.message || e);
                        return;
                    }
                    const outPath = path.join(exportPath, `${safeName}.stl`);
                    writeFile(outPath, stl);
                });
            }

            // Export faces per solid
            if (testFunction.exportFaces) {
                solids.forEach((solid, sidx) => {
                    const rawName = solid.name && String(solid.name).trim().length ? String(solid.name) : `solid_${sidx}`;
                    const safeSolid = sanitizeFileName(rawName);
                    let faces = [];
                    try {
                        faces = typeof solid.getFaces === 'function' ? solid.getFaces(false) : [];
                    } catch {
                        faces = [];
                    }
                    faces.forEach(({ faceName, triangles }, fIdx) => {
                        if (!triangles || triangles.length === 0) return;
                        const rawFace = faceName || `face_${fIdx}`;
                        const safeFace = sanitizeFileName(rawFace);
                        const stl = trianglesToAsciiSTL(`${safeSolid}_${safeFace}`, triangles);
                        const outPath = path.join(exportPath, `${safeSolid}_${safeFace}.stl`);
                        writeFile(outPath, stl);
                    });
                });
            }

            console.log(" ");
        }
    }
}










export async function runSingleTest(testFunction, partHistory = new PartHistory()) {
    let error = null;
    try {
        await testFunction.test(partHistory);
        await partHistory.runHistory();
        // Optional per-test post-run hook for validations/metrics
        if (typeof testFunction.afterRun === 'function') {
            try { await testFunction.afterRun(partHistory); } catch (e) { console.warn('afterRun failed:', e?.message || e); }
        }
    } catch (e) {
        error = e;
        if (testFunction.allowErrors) {
            const name = (testFunction.test && testFunction.test.name) ? testFunction.test.name : 'unnamed_test';
            const exportPath = `./tests/results/${name}/`;
            try { if (!fs.existsSync(exportPath)) fs.mkdirSync(exportPath, { recursive: true }); } catch {}
            const msg = `${e?.message || e}\n\n${e?.stack || ''}`;
            try { writeFile(path.join(exportPath, 'error.txt'), msg); } catch {}
            console.error(`Error in test ${name}:`, e);
        } else {
            // rethrow to fail fast for normal tests
            throw e;
        }
    }
    console.log(partHistory);
    // sleep for 1 second to allow any async operations to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
}


// function to write a file. If the path dose not exist it should make the folders needed.  
function writeFile(filePath, content) {
    // imediatly return if running in the browser
    if (typeof window !== "undefined") {
        //console.warn(`writeFile is not supported in the browser.`);
        return;
    }

    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
        console.log(`Error writing file ${filePath}:`, error);
    }
}

// ---------------- Local helpers for artifact export (Node only) ----------------

function sanitizeFileName(name) {
    return String(name)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')      // collapse invalid chars
        .replace(/^_+|_+$/g, '')                 // trim leading/trailing underscores
        .substring(0, 100) || 'artifact';        // cap length
}

function trianglesToAsciiSTL(name, tris) {
    const fmt = (n) => Number.isFinite(n) ? (Math.abs(n) < 1e-18 ? '0' : n.toFixed(6)) : '0';
    const out = [];
    out.push(`solid ${name}`);
    for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        const p0 = t.p1, p1 = t.p2, p2 = t.p3;
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        out.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
        out.push(`    outer loop`);
        out.push(`      vertex ${fmt(p0[0])} ${fmt(p0[1])} ${fmt(p0[2])}`);
        out.push(`      vertex ${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p1[2])}`);
        out.push(`      vertex ${fmt(p2[0])} ${fmt(p2[1])} ${fmt(p2[2])}`);
        out.push(`    endloop`);
        out.push(`  endfacet`);
    }
    out.push(`endsolid ${name}`);
    return out.join('\n');
}
