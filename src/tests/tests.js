import '../monitor.js';
import path from '../path.proxy.js';
import fs from '../fs.proxy.js';
import { PartHistory } from "../PartHistory.js";
import { test_primitiveCube } from './test_primitiveCube.js';
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
    { test: test_ExtrudeFace, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_Fillet, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },
    { test: test_Chamfer, printArtifacts: false, exportFaces: true, exportSolids: true, resetHistory: true },

];

testFunctions.push();
testFunctions.push();
testFunctions.push();
testFunctions.push();
testFunctions.push();



// call runTests if we are in the nodejs environment
if (typeof process !== "undefined" && process.versions && process.versions.node) runTests();




export async function runTests(partHistory = new PartHistory(), callbackToRunBetweenTests = null) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
        //await console.clear();
    }

    // delete the ./tests/results directory in an asynchronous way
    await fs.promises.rm('./tests/results', { recursive: true, force: true });

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

    await testFunction.test(partHistory);
    await partHistory.runHistory();
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
