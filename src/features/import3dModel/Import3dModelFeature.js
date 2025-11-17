import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BREP } from "../../BREP/BREP.js";



const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the import feature",
    },
    fileToImport: {
        type: "file",
        default_value: "",
        accept: ".stl,.STL,.3mf,.3MF,model/stl,model/3mf,application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        hint: "Contents of an STL or 3MF file (click to choose a file)",
    },
    deflectionAngle: {
        type: "number",
        default_value: 15,
        hint: "The angle (in degrees) between face normals at which to split faces when constructing the BREP solid",
    },
    meshRepairLevel: {
        type: "options",
        options: ["NONE", "BASIC", "AGGRESSIVE"],
        default_value: "NONE",
        hint: "Mesh repair level to apply before BREP conversion",
    },
    centerMesh: {
        type: "boolean",
        default_value: true,
        hint: "Center the mesh by its bounding box",
    }

};

export class Import3dModelFeature {
    static shortName = "IMPORT3D";
    static longName = "Import 3D Model";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
        
    }

    async run(partHistory) {
        // Import STL or 3MF data (ASCII string, base64 data URL, or ArrayBuffer) and create a THREE.BufferGeometry
        const stlLoader = new STLLoader();
        const threeMFLoader = new ThreeMFLoader();
        const raw = this.inputParams.fileToImport;
        if (!raw || (typeof raw !== 'string' && !(raw instanceof ArrayBuffer))) {
            console.warn('[Import3D] No model data provided');
            return { added: [], removed: [] };
        }

        // Accept either:
        // - ASCII STL text
        // - data URL with base64 (e.g., 'data:application/octet-stream;base64,...')
        // - ArrayBuffer (rare: programmatic use)
        let dataForLoader = raw;
        if (typeof raw === 'string' && raw.startsWith('data:') && raw.includes(';base64,')) {
            const b64 = raw.split(',')[1] || '';
            try {
                const binaryStr = (typeof atob === 'function') ? atob(b64) : (typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('binary') : '');
                const len = binaryStr.length | 0;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i) & 0xff;
                dataForLoader = bytes.buffer; // ArrayBuffer
            } catch (e) {
                console.warn('[Import3D] Failed to decode base64 data URL:', e);
                dataForLoader = raw; // fallback to string
            }
        }

        // Detect type and parse accordingly
        let geometry;
        try {
            if (typeof dataForLoader === 'string') {
                // Treat plain strings as ASCII STL text
                geometry = await stlLoader.parse(dataForLoader);
            } else if (dataForLoader instanceof ArrayBuffer) {
                const u8 = new Uint8Array(dataForLoader);
                const isZip = u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b; // 'PK' -> 3MF zip
                if (isZip) {
                    // 3MF: parse into a Group, then merge meshes into a single BufferGeometry
                    const group = await threeMFLoader.parse(dataForLoader);
                    group.updateMatrixWorld(true);
                    const geometries = [];
                    group.traverse(obj => {
                        if (obj.isMesh && obj.geometry && obj.geometry.isBufferGeometry) {
                            const g = obj.geometry.clone();
                            if (obj.matrixWorld) g.applyMatrix4(obj.matrixWorld);
                            geometries.push(g);
                        }
                    });
                    if (geometries.length === 0) {
                        console.warn('[Import3D] 3MF file contained no meshes');
                        return { added: [], removed: [] };
                    }
                    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
                    geometry = merged || geometries[0];
                } else {
                    // Assume binary STL
                    geometry = await stlLoader.parse(dataForLoader);
                }
            } else {
                console.warn('[Import3D] Unsupported input type for fileToImport');
                return { added: [], removed: [] };
            }
        } catch (e) {
            console.warn('[Import3D] Failed to parse input as STL/3MF:', e);
            return { added: [], removed: [] };
        }
        
        // Optionally center the geometry by its bounding box center
        if (this.inputParams.centerMesh) {
            geometry.computeBoundingBox();
            const bb = geometry.boundingBox;
            if (bb) {
                const cx = (bb.min.x + bb.max.x) * 0.5;
                const cy = (bb.min.y + bb.max.y) * 0.5;
                const cz = (bb.min.z + bb.max.z) * 0.5;
                geometry.translate(-cx, -cy, -cz);
            }
        }

        // (Optional) normalize indexing; MeshRepairer ensures indexing as needed
        // if (!geometry.index) geometry = MeshRepairer._ensureIndexed(geometry);

        // Run mesh repair pipeline per selected level to produce a BufferGeometry
        const repairer = new BREP.MeshRepairer();
        let repairedGeometry = geometry;
        if (this.inputParams.meshRepairLevel === "BASIC") {
            repairedGeometry = repairer.repairAll(repairedGeometry);
        } else if (this.inputParams.meshRepairLevel === "AGGRESSIVE") {
            for (let i = 0; i < 5; i++) {
                repairedGeometry = repairer.repairAll(repairedGeometry);
            }
        }

        // Build a BREP solid by grouping triangles into faces via deflection angle
        const solid = new BREP.MeshToBrep(repairedGeometry, this.inputParams.deflectionAngle);
        solid.name = this.inputParams.featureID;
        solid.visualize();

        return { added: [solid], removed: [] };
    }
}
