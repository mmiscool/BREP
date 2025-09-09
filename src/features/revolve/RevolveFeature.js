import { extractDefaultValues } from "../../PartHistory.js";
import * as THREE from 'three';
import { FacesSolid } from "../../BREP/Sweep.js";
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the revolve feature",
    },
    profile: {
        type: "reference_selection",
        selectionFilter: ["SKETCH", "FACE"],
        multiple: false,
        default_value: null,
        hint: "Select the profile (face) to revolve",
    },
    axis: {
        type: "reference_selection",
        selectionFilter: ["EDGE"],
        multiple: false,
        default_value: null,
        hint: "Select the axis to revolve about",
    },
    angle: {
        type: "number",
        default_value: 360,
        hint: "Revolve angle",
    },
    boolean: {
        type: "boolean_operation",
        default_value: { targets: [], operation: 'NONE', opperation: 'NONE' },
        hint: "Optional boolean operation with selected solids"
    }
};

export class RevolveFeature {
    static featureShortName = "REVOLVE";
    static featureName = "Revolve";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        this.persistentData = {};
    }

    async run() {
        const partHistory = this.partHistory;
        const { profile, axis, angle } = this.inputParams;

        // Resolve profile: accept FACE or SKETCH group name
        const obj = partHistory.scene.getObjectByName(profile);
        let faceObj = obj;
        if (obj && obj.type === 'SKETCH') {
            faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
        }
        if (!faceObj || !faceObj.geometry) return [];
        // if the face is a child of a sketch we need to remove the sketch from the scene

        if (!axis) {
            console.warn("RevolveFeature: no axis selected");
            return [];
        }
        if (!faceObj) {
            console.warn("RevolveFeature: no profile face found");
            return [];
        }
        
        if (faceObj && faceObj.type === 'FACE' && faceObj.parent && faceObj.parent.type === 'SKETCH') faceObj.parent.remove = true;

        // Resolve axis edge → world-space origin+direction
        const axisObj = partHistory.scene.getObjectByName(axis);
        let A = new THREE.Vector3(0, 0, 0), B = new THREE.Vector3(0, 1, 0);
        if (axisObj) {
            const mat = axisObj.matrixWorld;
            const aStart = axisObj?.geometry?.attributes?.instanceStart;
            const aEnd = axisObj?.geometry?.attributes?.instanceEnd;
            if (aStart && aEnd && aStart.count >= 1) {
                const s = new THREE.Vector3(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(mat);
                const e = new THREE.Vector3(aEnd.getX(0), aEnd.getY(0), aEnd.getZ(0)).applyMatrix4(mat);
                A.copy(s); B.copy(e);
            } else {
                const pos = axisObj?.geometry?.getAttribute?.('position');
                if (pos && pos.count >= 2) {
                    const s = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(mat);
                    const e = new THREE.Vector3(pos.getX(pos.count - 1), pos.getY(pos.count - 1), pos.getZ(pos.count - 1)).applyMatrix4(mat);
                    A.copy(s); B.copy(e);
                }
            }
        }
        const axisDir = B.clone().sub(A); if (axisDir.lengthSq() < 1e-12) axisDir.set(0, 1, 0); axisDir.normalize();

        const deg = Number.isFinite(angle) ? angle : 360;
        const sweepRad = deg * Math.PI / 180;
        const steps = Math.max(3, Math.ceil(Math.abs(deg) / 10)); // ~10° per step
        const dA = sweepRad / steps;

        // Helper: rotate world point around axis by angle
        const rotQ = new THREE.Quaternion();
        const tmp = new THREE.Vector3();
        const rotateP = (p, a) => {
            rotQ.setFromAxisAngle(axisDir, a);
            tmp.set(p.x, p.y, p.z).sub(A).applyQuaternion(rotQ).add(A);
            return [tmp.x, tmp.y, tmp.z];
        };

        // New solid
        const solid = new FacesSolid({ name: this.inputParams.featureID || 'Revolve' });

        // Caps: use sketch profile triangulation if available, else face geometry
        const groups = Array.isArray(faceObj?.userData?.profileGroups) ? faceObj.userData.profileGroups : null;
        if (Math.abs(deg) < 360 - 1e-6) {
            if (groups && groups.length) {
                for (const g of groups) {
                    const contour2D = g.contour2D || [];
                    const holes2D = g.holes2D || [];
                    const contourW = g.contourW || [];
                    const holesW = g.holesW || [];
                    if (contour2D.length < 3 || contourW.length !== contour2D.length) continue;
                    const contourV2 = contour2D.map(p => new THREE.Vector2(p[0], p[1]));
                    const holesV2 = holes2D.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
                    const tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
                    const allW = contourW.concat(...holesW);
                    for (const t of tris) {
                        const p0 = allW[t[0]], p1 = allW[t[1]], p2 = allW[t[2]];
                        const v0 = new THREE.Vector3(p0[0], p0[1], p0[2]);
                        const v1 = new THREE.Vector3(p1[0], p1[1], p1[2]);
                        const v2 = new THREE.Vector3(p2[0], p2[1], p2[2]);
                        // Start cap reversed
                        solid.addTriangle(`${faceObj.name || 'Face'}_START`, [v0.x, v0.y, v0.z], [v2.x, v2.y, v2.z], [v1.x, v1.y, v1.z]);
                        // End cap rotated
                        const q0 = rotateP(v0, sweepRad);
                        const q1 = rotateP(v1, sweepRad);
                        const q2 = rotateP(v2, sweepRad);
                        solid.addTriangle(`${faceObj.name || 'Face'}_END`, q0, q1, q2);
                    }
                }
            } else {
                // Fallback: face geometry
                const baseGeom = faceObj.geometry;
                const posAttr = baseGeom.getAttribute('position');
                if (posAttr) {
                    const idx = baseGeom.getIndex();
                    const hasIndex = !!idx;
                    const v = new THREE.Vector3();
                    const world = new Array(posAttr.count);
                    for (let i = 0; i < posAttr.count; i++) {
                        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(faceObj.matrixWorld);
                        world[i] = [v.x, v.y, v.z];
                    }
                    const addTri = (i0, i1, i2) => {
                        const p0 = world[i0], p1 = world[i1], p2 = world[i2];
                        solid.addTriangle(`${faceObj.name || 'Face'}_START`, p0, p2, p1);
                        const q0 = rotateP(new THREE.Vector3(...p0), sweepRad);
                        const q1 = rotateP(new THREE.Vector3(...p1), sweepRad);
                        const q2 = rotateP(new THREE.Vector3(...p2), sweepRad);
                        solid.addTriangle(`${faceObj.name || 'Face'}_END`, q0, q1, q2);
                    };
                    if (hasIndex) {
                        for (let i = 0; i < idx.count; i += 3) addTri(idx.getX(i+0)>>>0, idx.getX(i+1)>>>0, idx.getX(i+2)>>>0);
                    } else {
                        for (let t = 0; t < (posAttr.count/3|0); t++) addTri(3*t+0, 3*t+1, 3*t+2);
                    }
                }
            }
        }

        // Side walls using boundary loops
        const boundaryLoops = Array.isArray(faceObj?.userData?.boundaryLoopsWorld) ? faceObj.userData.boundaryLoopsWorld : null;
        if (boundaryLoops && boundaryLoops.length) {
            const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
            const edges = Array.isArray(faceObj?.edges) ? faceObj.edges : [];
            const pointToEdgeNames = new Map();
            for (const e of edges) {
                const name = `${e?.name || 'EDGE'}_RV`;
                const poly = e?.userData?.polylineLocal;
                const isWorld = !!(e?.userData?.polylineWorld);
                if (Array.isArray(poly) && poly.length >= 2) {
                    for (const p of poly) {
                        const w = isWorld ? p : new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(e.matrixWorld);
                        const arr = Array.isArray(w) ? w : [w.x, w.y, w.z];
                        const k = key(arr);
                        let set = pointToEdgeNames.get(k);
                        if (!set) { set = new Set(); pointToEdgeNames.set(k, set); }
                        set.add(name);
                    }
                }
            }

            for (const loop of boundaryLoops) {
                const pts = Array.isArray(loop?.pts) ? loop.pts : loop;
                const isHole = !!(loop && loop.isHole);
                const pA = pts.slice();
                if (pA.length >= 2) {
                    const first = pA[0], last = pA[pA.length-1];
                    if (!(first[0]===last[0] && first[1]===last[1] && first[2]===last[2])) pA.push([first[0],first[1],first[2]]);
                }
                for (let i = pA.length - 2; i >= 0; i--) {
                    const a = pA[i], b = pA[i+1];
                    if (a[0]===b[0] && a[1]===b[1] && a[2]===b[2]) pA.splice(i+1,1);
                }

                for (let i = 0; i < pA.length - 1; i++) {
                    const a = pA[i];
                    const b = pA[i+1];
                    const setA = pointToEdgeNames.get(key(a));
                    const setB = pointToEdgeNames.get(key(b));
                    let fname = `${faceObj.name || 'FACE'}_RV`;
                    if (setA && setB) { for (const n of setA) { if (setB.has(n)) { fname = n; break; } } }

                    // sweep along angular steps
                    let ang0 = 0;
                    for (let s = 0; s < steps; s++, ang0 += dA) {
                        const ang1 = (s === steps-1) ? sweepRad : ang0 + dA;
                        const a0 = rotateP(new THREE.Vector3(a[0], a[1], a[2]), ang0);
                        const a1 = rotateP(new THREE.Vector3(a[0], a[1], a[2]), ang1);
                        const b0 = rotateP(new THREE.Vector3(b[0], b[1], b[2]), ang0);
                        const b1 = rotateP(new THREE.Vector3(b[0], b[1], b[2]), ang1);
                        if (isHole) {
                            solid.addTriangle(fname, a0, b1, b0);
                            solid.addTriangle(fname, a0, a1, b1);
                        } else {
                            solid.addTriangle(fname, a0, b0, b1);
                            solid.addTriangle(fname, a0, b1, a1);
                        }
                    }
                }
            }
        }

        // Weld slight numerical seams and build mesh
        try { solid.setEpsilon(1e-6); } catch {}
        solid.visualize();
        return await applyBooleanOperation(partHistory || {}, solid, this.inputParams.boolean, this.inputParams.featureID);
    }
}
