import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { ImageEditorUI } from '../imageToFace/imageEditor.js';

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the heightmap solid feature",
  },
  fileToImport: {
    type: "file",
    default_value: "",
    accept: ".png,image/png",
    hint: "Grayscale or RGB PNG heightmap (click to choose a file)",
  },
  editImage: {
    type: "button",
    label: "Edit Image",
    default_value: null,
    hint: "Launch the paint like image editor",
    actionFunction: (ctx) => {
      let { fileToImport } = ctx.feature.inputParams;
      if (!fileToImport) {
        try {
          const c = document.createElement('canvas');
          c.width = 300; c.height = 300;
          const ctx2d = c.getContext('2d');
          ctx2d.fillStyle = '#ffffff';
          ctx2d.fillRect(0, 0, c.width, c.height);
          fileToImport = c.toDataURL('image/png');
        } catch (_) { fileToImport = null; }
      }
      const imageEditor = new ImageEditorUI(fileToImport, {
        onSave: (editedImage) => {
          try { ctx.feature.inputParams.fileToImport = editedImage; } catch (_) { }
          try { if (ctx.params) ctx.params.fileToImport = editedImage; } catch (_) { }
          try {
            if (ctx.partHistory) {
              ctx.partHistory.currentHistoryStepId = ctx.feature.inputParams.featureID;
              if (typeof ctx.partHistory.runHistory === 'function') ctx.partHistory.runHistory();
            }
          } catch (_) { }
        },
        onCancel: () => { /* no-op */ }
      });
      imageEditor.open();
    }
  },
  heightScale: {
    type: "number",
    default_value: 1,
    hint: "World units of elevation per full-intensity pixel (0-255)",
  },
  baseHeight: {
    type: "number",
    default_value: 0,
    hint: "Base plane height used as the minimum elevation",
  },
  invertHeights: {
    type: "boolean",
    default_value: false,
    hint: "Invert grayscale so dark pixels become tall regions",
  },
  pixelScale: {
    type: "number",
    default_value: 1,
    hint: "World units per pixel in X/Y directions",
  },
  center: {
    type: "boolean",
    default_value: true,
    hint: "Center the heightmap around the origin before placement",
  },
  sampleStride: {
    type: "number",
    default_value: 1,
    hint: "Sample every Nth pixel (higher stride reduces triangles)",
  },
  placementPlane: {
    type: "reference_selection",
    selectionFilter: ["PLANE", "FACE"],
    multiple: false,
    default_value: null,
    hint: "Select a plane or face where the heightmap will be placed",
  },
  simplifyTolerance: {
    type: "number",
    default_value: 0,
    hint: "Simplify tolerance (>0 enables Manifold simplify)",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class ImageHeightmapSolidFeature {
  static shortName = "HEIGHTMAP";
  static longName = "Image Heightmap Solid";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const {
      fileToImport,
      heightScale,
      baseHeight,
      invertHeights,
      pixelScale,
      center,
      sampleStride,
      simplifyTolerance,
    } = this.inputParams;

    const imageData = await decodeToImageData(fileToImport);
    if (!imageData) {
      console.warn('[HEIGHTMAP] No image data decoded');
      return { added: [], removed: [] };
    }

    const width = imageData.width | 0;
    const height = imageData.height | 0;
    if (!(width >= 2 && height >= 2)) {
      console.warn('[HEIGHTMAP] Heightmap requires an image at least 2x2 pixels');
      return { added: [], removed: [] };
    }

    const src = imageData.data;
    const scaleXY = Number.isFinite(Number(pixelScale)) && Number(pixelScale) !== 0 ? Number(pixelScale) : 1;
    const scaleZ = Number.isFinite(Number(heightScale)) ? Number(heightScale) : 1;
    const base = Number.isFinite(Number(baseHeight)) ? Number(baseHeight) : 0;
    const invert = !!invertHeights;
    const centerXY = center !== false;
    const strideRaw = Number(sampleStride);
    const stride = Number.isFinite(strideRaw) && strideRaw >= 1 ? Math.floor(strideRaw) : 1;

    const offsetX = centerXY ? (width - 1) * 0.5 : 0;
    const offsetY = centerXY ? (height - 1) * 0.5 : 0;

    const sampleXs = buildSampleIndices(width, stride);
    const sampleYs = buildSampleIndices(height, stride);
    const gridWidth = sampleXs.length;
    const gridHeight = sampleYs.length;
    if (!(gridWidth >= 2 && gridHeight >= 2)) {
      console.warn('[HEIGHTMAP] Sampling produced insufficient grid resolution');
      return { added: [], removed: [] };
    }
    const idx = (x, y) => y * gridWidth + x;
    const topVerts = new Array(gridWidth * gridHeight);
    const bottomVerts = new Array(gridWidth * gridHeight);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const updateBounds = (p) => {
      if (!p) return;
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    };

    for (let gy = 0; gy < gridHeight; gy++) {
      const sy = sampleYs[gy];
      for (let gx = 0; gx < gridWidth; gx++) {
        const sx = sampleXs[gx];
        const i = idx(gx, gy);
        const si = (sy * width + sx) * 4;
        const r = src[si] | 0;
        const g = src[si + 1] | 0;
        const b = src[si + 2] | 0;
        const a = src[si + 3] | 0;
        const gray = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
        const alphaMask = (a >= 16) ? 1 : 0;
        let value = invert ? (1 - gray) : gray;
        if (alphaMask === 0) value = 0;
        value = Math.max(0, Math.min(1, value));
        const h = base + value * scaleZ;
        const px = (sx - offsetX) * scaleXY;
        const py = ((centerXY ? (offsetY - sy) : -sy)) * scaleXY;
        const top = [px, py, h];
        const bottom = [px, py, base];
        topVerts[i] = top;
        bottomVerts[i] = bottom;
        updateBounds(top);
        updateBounds(bottom);
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
      console.warn('[HEIGHTMAP] Failed to compute geometry bounds');
      return { added: [], removed: [] };
    }

    if (!((maxZ - minZ) > 1e-9)) {
      console.warn('[HEIGHTMAP] Heightmap has zero thickness; increase heightScale or height variation');
      return { added: [], removed: [] };
    }

    const centerVec = [
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5,
      (minZ + maxZ) * 0.5,
    ];

    const solid = new BREP.Solid();
    const featureName = this.inputParams.featureID || 'HEIGHTMAP_SOLID';
    solid.name = featureName;

    const addTriangleFacingOutward = (faceName, p0, p1, p2) => {
      if (!p0 || !p1 || !p2) return;
      const ax = p1[0] - p0[0];
      const ay = p1[1] - p0[1];
      const az = p1[2] - p0[2];
      const bx = p2[0] - p0[0];
      const by = p2[1] - p0[1];
      const bz = p2[2] - p0[2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const lenSq = nx * nx + ny * ny + nz * nz;
      if (!(lenSq > 1e-24)) return;
      const cx = (p0[0] + p1[0] + p2[0]) / 3;
      const cy = (p0[1] + p1[1] + p2[1]) / 3;
      const cz = (p0[2] + p1[2] + p2[2]) / 3;
      const vx = centerVec[0] - cx;
      const vy = centerVec[1] - cy;
      const vz = centerVec[2] - cz;
      const dot = nx * vx + ny * vy + nz * vz;
      if (dot > 0) {
        solid.addTriangle(faceName, p0, p2, p1);
      } else {
        solid.addTriangle(faceName, p0, p1, p2);
      }
    };

    const faceBase = featureName ? `${featureName}` : 'HEIGHTMAP';
    const topFace = `${faceBase}:TOP`;
    const bottomFace = `${faceBase}:BOTTOM`;
    const sidePosY = `${faceBase}:SIDE_POS_Y`;
    const sideNegY = `${faceBase}:SIDE_NEG_Y`;
    const sideNegX = `${faceBase}:SIDE_NEG_X`;
    const sidePosX = `${faceBase}:SIDE_POS_X`;

    for (let y = 0; y < gridHeight - 1; y++) {
      for (let x = 0; x < gridWidth - 1; x++) {
        const i00 = idx(x, y);
        const i10 = idx(x + 1, y);
        const i01 = idx(x, y + 1);
        const i11 = idx(x + 1, y + 1);
        const v00 = topVerts[i00];
        const v10 = topVerts[i10];
        const v01 = topVerts[i01];
        const v11 = topVerts[i11];
        addTriangleFacingOutward(topFace, v00, v11, v10);
        addTriangleFacingOutward(topFace, v00, v01, v11);

        const b00 = bottomVerts[i00];
        const b10 = bottomVerts[i10];
        const b01 = bottomVerts[i01];
        const b11 = bottomVerts[i11];
        addTriangleFacingOutward(bottomFace, b00, b10, b11);
        addTriangleFacingOutward(bottomFace, b00, b11, b01);
      }
    }

    const addSideQuad = (faceName, topA, topB, bottomB, bottomA) => {
      addTriangleFacingOutward(faceName, topA, topB, bottomB);
      addTriangleFacingOutward(faceName, topA, bottomB, bottomA);
    };

    for (let x = 0; x < gridWidth - 1; x++) {
      const iA = idx(x, 0);
      const iB = idx(x + 1, 0);
      addSideQuad(sidePosY, topVerts[iA], topVerts[iB], bottomVerts[iB], bottomVerts[iA]);
    }

    for (let x = 0; x < gridWidth - 1; x++) {
      const row = gridHeight - 1;
      const iA = idx(x, row);
      const iB = idx(x + 1, row);
      addSideQuad(sideNegY, topVerts[iA], topVerts[iB], bottomVerts[iB], bottomVerts[iA]);
    }

    for (let y = 0; y < gridHeight - 1; y++) {
      const iA = idx(0, y);
      const iB = idx(0, y + 1);
      addSideQuad(sideNegX, topVerts[iA], topVerts[iB], bottomVerts[iB], bottomVerts[iA]);
    }

    for (let y = 0; y < gridHeight - 1; y++) {
      const col = gridWidth - 1;
      const iA = idx(col, y);
      const iB = idx(col, y + 1);
      addSideQuad(sidePosX, topVerts[iA], topVerts[iB], bottomVerts[iB], bottomVerts[iA]);
    }

    const basis = getPlacementBasis(this.inputParams?.placementPlane, partHistory);
    const origin = new THREE.Vector3().fromArray(basis.origin);
    const xAxis = new THREE.Vector3().fromArray(basis.x);
    const yAxis = new THREE.Vector3().fromArray(basis.y);
    const zAxis = new THREE.Vector3().fromArray(basis.z);
    const placement = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(origin);
    solid.bakeTransform(placement);

    solid.userData = solid.userData || {};
    solid.userData.heightmap = {
      width,
      height,
      pixelScale: scaleXY,
      heightScale: scaleZ,
      baseHeight: base,
      invert: invert,
      sampleStride: stride,
      gridWidth,
      gridHeight,
    };
    let finalSolid = solid;
    const tol = Number(simplifyTolerance);
    if (Number.isFinite(tol) && tol > 0) {
      try {
        const simplified = solid.simplify(tol);
        if (simplified && simplified instanceof BREP.Solid) finalSolid = simplified;
      } catch (e) {
        console.warn('[HEIGHTMAP] Simplify failed, using original solid:', e);
      }
    }
    if (finalSolid !== solid) {
      finalSolid.name = featureName;
      finalSolid.userData = { ...solid.userData };
    }
    finalSolid.visualize();

    const effects = await BREP.applyBooleanOperation(partHistory || {}, finalSolid, this.inputParams.boolean, this.inputParams.featureID);
    return effects;
  }
}

async function decodeToImageData(raw) {
  try {
    if (!raw) return null;
    if (raw instanceof ImageData) return raw;
    if (raw instanceof ArrayBuffer) {
      try {
        const blob = new Blob([raw], { type: 'image/png' });
        const img = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, img.width, img.height);
        try { img.close && img.close(); } catch { }
        return id;
      } catch { }
      return null;
    }
    if (typeof raw === 'string') {
      if (raw.startsWith('data:')) {
        const img = await createImageBitmap(await (await fetch(raw)).blob());
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, img.width, img.height);
        try { img.close && img.close(); } catch { }
        return id;
      }
      try {
        const b64 = raw;
        const binaryStr = (typeof atob === 'function') ? atob(b64) : (typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('binary') : '');
        const len = binaryStr.length | 0;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i) & 0xff;
        const blob = new Blob([bytes], { type: 'image/png' });
        const img = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, img.width, img.height);
        try { img.close && img.close(); } catch { }
        return id;
      } catch { }
      return null;
    }
  } catch (e) {
    console.warn('[HEIGHTMAP] Failed to decode input as image data', e);
  }
  return null;
}

function buildSampleIndices(count, stride) {
  const out = [];
  if (count <= 0) return out;
  for (let i = 0; i < count; i += stride) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function getPlacementBasis(ref, partHistory) {
  const x = new THREE.Vector3(1, 0, 0);
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3(0, 0, 1);
  const origin = new THREE.Vector3(0, 0, 0);

  let refObj = null;
  try {
    if (Array.isArray(ref)) refObj = ref[0] || null;
    else if (ref && typeof ref === 'object') refObj = ref;
    else if (ref) refObj = partHistory?.scene?.getObjectByName(ref);
  } catch { }

  if (refObj) {
    try { refObj.updateWorldMatrix(true, true); } catch { }
    try {
      const g = refObj.geometry;
      if (g) {
        const bs = g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
        if (bs) origin.copy(refObj.localToWorld(bs.center.clone()));
        else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
      } else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
    } catch { origin.copy(refObj.getWorldPosition(new THREE.Vector3())); }

    let n = null;
    try {
      if (refObj.type === 'FACE' && typeof refObj.getAverageNormal === 'function') {
        n = refObj.getAverageNormal().clone();
      } else {
        n = new THREE.Vector3(0, 0, 1).applyQuaternion(refObj.getWorldQuaternion(new THREE.Quaternion()));
      }
    } catch { n = null; }
    if (!n || n.lengthSq() < 1e-16) n = new THREE.Vector3(0, 0, 1);
    n.normalize();

    const worldX = new THREE.Vector3(1, 0, 0).applyQuaternion(refObj.getWorldQuaternion(new THREE.Quaternion()));
    const worldY = new THREE.Vector3().crossVectors(n, worldX);
    if (worldY.lengthSq() < 1e-20) {
      worldX.set(1, 0, 0);
      worldY.set(0, 1, 0);
    } else {
      worldY.normalize();
      worldX.crossVectors(worldY, n).normalize();
    }
    x.copy(worldX);
    y.copy(worldY);
    z.copy(n);
  }

  return {
    origin: [origin.x, origin.y, origin.z],
    x: [x.x, x.y, x.z],
    y: [y.x, y.y, y.z],
    z: [z.x, z.y, z.z],
  };
}
