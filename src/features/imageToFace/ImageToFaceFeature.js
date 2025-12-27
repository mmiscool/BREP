import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { LineGeometry } from 'three/examples/jsm/Addons.js';
import { ImageEditorUI } from './imageEditor.js';
import { traceImageDataToPolylines, applyCurveFit, rdp } from './traceUtils.js';

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the image trace feature",
  },
  fileToImport: {
    type: "file",
    default_value: "",
    accept: ".png,image/png",
    hint: "Monochrome PNG data (click to choose a file)",
  },
  editImage: {
    type: "button",
    label: "Edit Image",
    default_value: null,
    hint: "Launch the paint like image editor",
    actionFunction: (ctx) => {
      let { fileToImport } = ctx.feature.inputParams;
      // If no image, start with a blank 300x300 transparent canvas
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
          // Update both live feature params and dialog params
          try { ctx.feature.inputParams.fileToImport = editedImage; } catch (_) {}
          try { if (ctx.params) ctx.params.fileToImport = editedImage; } catch (_) {}
          // Trigger recompute akin to onChange
          try {
            if (ctx.partHistory) {
              ctx.partHistory.currentHistoryStepId = ctx.feature.inputParams.featureID;
              if (typeof ctx.partHistory.runHistory === 'function') ctx.partHistory.runHistory();
            }
          } catch (_) {}
        },
        onCancel: () => { /* no-op */ }
      }, {
        featureSchema: inputParamsSchema,
        featureParams: ctx && ctx.feature && ctx.feature.inputParams ? ctx.feature.inputParams : (ctx?.params || {}),
        partHistory: ctx && ctx.partHistory ? ctx.partHistory : null,
        viewer: ctx && ctx.viewer ? ctx.viewer : (ctx && ctx.partHistory && ctx.partHistory.viewer ? ctx.partHistory.viewer : null),
        onParamsChange: () => {
          try {
            if (ctx && ctx.partHistory) {
              ctx.partHistory.currentHistoryStepId = ctx.feature?.inputParams?.featureID;
              if (typeof ctx.partHistory.runHistory === 'function') ctx.partHistory.runHistory();
            }
          } catch (_) { /* ignore */ }
        }
      });
      imageEditor.open();
    }
  },

  threshold: {
    type: "number",
    default_value: 128,
    hint: "Pixel threshold (0-255) to classify foreground vs background",
  },
  invert: {
    type: "boolean",
    default_value: false,
    hint: "Invert classification (swap foreground/background)",
  },
  pixelScale: {
    type: "number",
    default_value: 1,
    hint: "World units per pixel (scale for the traced face)",
  },
  center: {
    type: "boolean",
    default_value: true,
    hint: "Center the traced result around the origin",
  },
  smoothCurves: {
    type: "boolean",
    default_value: true,
    hint: "Fit curved segments (Potrace-like) to smooth the traced outlines",
  },
  curveTolerance: {
    type: "number",
    default_value: 0.75,
    step:0.1,
    hint: "Max deviation (world units) for curve smoothing/flattening; larger = smoother",
  },
  speckleArea: {
    type: "number",
    default_value: 2,
    hint: "Discard tiny traced loops below this pixel-area (turd size)",
  },
  simplifyCollinear: {
    type: "boolean",
    default_value: false,
    hint: "Remove intermediate points on straight segments",
  },
  rdpTolerance: {
    type: "number",
    default_value: 1,
    hint: "Optional Ramer–Douglas–Peucker tolerance in world units (0 to disable)",
  },
  edgeSplitAngle: {
    type: "number",
    default_value: 70,
    step: 1,
    hint: "Corner angle (deg) for splitting traced loops into edge segments",
  },
  placementPlane: {
    type: "reference_selection",
    selectionFilter: ["PLANE", "FACE"],
    multiple: false,
    default_value: null,
    hint: "Select a plane or face where the traced image will be placed",
  },
};

export class ImageToFaceFeature {
  static shortName = "IMAGE";
  static longName = "Image to Face";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { fileToImport, threshold, invert, pixelScale, center, smoothCurves, curveTolerance, speckleArea, simplifyCollinear, rdpTolerance, edgeSplitAngle } = this.inputParams;

    const imageData = await decodeToImageData(fileToImport);
    if (!imageData) {
      console.warn('[IMAGE] No image data decoded');
      return { added: [], removed: [] };
    }

    const scale = Number(pixelScale) || 1;
    const traceLoops = traceImageDataToPolylines(imageData, {
      threshold: Number.isFinite(Number(threshold)) ? Number(threshold) : 128,
      mode: "luma+alpha",
      invert: !!invert,
      mergeCollinear: !!simplifyCollinear,
      simplify: (rdpTolerance && Number(rdpTolerance) > 0) ? (Number(rdpTolerance) / Math.max(Math.abs(scale) || 1, 1e-9)) : 0,
      minArea: Number.isFinite(Number(speckleArea)) ? Math.max(0, Number(speckleArea)) : 0,
    });
    const loopsGrid = traceLoops.map((loop) => loop.map((p) => [p.x, p.y]));
    if (!loopsGrid.length) {
      console.warn('[IMAGE] No contours found in image');
      return { added: [], removed: [] };
    }

    // Convert grid loops (integer node coords in image space, y-down) to world 2D loops (x, y-up)
    const loops2D = loopsGrid.map((pts) => gridToWorld2D(pts, scale));

    // Optional curve fitting (Potrace-like) then simplification/cleanup
    let workingLoops = loops2D;
    if (smoothCurves !== false) {
      workingLoops = applyCurveFit(workingLoops, {
        tolerance: Number.isFinite(Number(curveTolerance)) ? Math.max(0.01, Number(curveTolerance)) : Math.max(0.05, Math.abs(scale) * 0.75),
        cornerThresholdDeg: 70,
        iterations: 3,
      });
    }
    let simpLoops = workingLoops.map((l) => simplifyLoop(l, { simplifyCollinear: false, rdpTolerance: 0 }));

    // Optionally center (only if there are any points)
    if (center) {
      const allPts = simpLoops.flat();
      if (allPts.length) {
        const bb = bounds2D(allPts);
        const cx = 0.5 * (bb.minX + bb.maxX);
        const cy = 0.5 * (bb.minY + bb.maxY);
        simpLoops = simpLoops.map((loop) => loop.map(([x, y]) => [x - cx, y - cy]));
      }
    }

    // Group into outer + holes by nesting parity
    const groups = groupLoopsOuterHoles(simpLoops);

    // Determine placement transform from selected plane/face
    const basis = getPlacementBasis(this.inputParams?.placementPlane, partHistory);
    const bO = new THREE.Vector3().fromArray(basis.origin);
    const bX = new THREE.Vector3().fromArray(basis.x);
    const bY = new THREE.Vector3().fromArray(basis.y);
    const bZ = new THREE.Vector3().fromArray(basis.z);
    const m = new THREE.Matrix4().makeBasis(bX, bY, bZ).setPosition(bO);
    // Quantize world coordinates to reduce FP drift and guarantee identical
    // vertices between caps and walls. Use a small absolute grid (~1e-6).
    const Q = 1e-6;
    const q = (n) => Math.abs(n) < Q ? 0 : Math.round(n / Q) * Q;
    const toW = (x, y) => {
      const v = new THREE.Vector3(x, y, 0).applyMatrix4(m);
      return [q(v.x), q(v.y), q(v.z)];
    };

    // Build triangulated Face and boundary Edges
    const sceneGroup = new THREE.Group();
    const featureId = (this.inputParams?.featureID != null && String(this.inputParams.featureID).length)
      ? String(this.inputParams.featureID)
      : 'IMAGE_Sketch';
    const edgeNamePrefix = featureId ? `${featureId}:` : '';
    sceneGroup.name = featureId;
    sceneGroup.type = 'SKETCH';
    sceneGroup.onClick = () => { };
    sceneGroup.userData = sceneGroup.userData || {};
    sceneGroup.userData.sketchBasis = {
      origin: Array.isArray(basis.origin) ? basis.origin.slice() : [0, 0, 0],
      x: Array.isArray(basis.x) ? basis.x.slice() : [1, 0, 0],
      y: Array.isArray(basis.y) ? basis.y.slice() : [0, 1, 0],
      z: Array.isArray(basis.z) ? basis.z.slice() : [0, 0, 1],
    };

    // Build triangulation using THREE.ShapeUtils
    const triPositions = [];
    const boundaryLoopsWorld = [];
    const profileGroups = [];

    for (const grp of groups) {
      let contour = grp.outer.slice();
      // Drop duplicate last point if present for triangulation API
      if (contour.length >= 2) {
        const f = contour[0], l = contour[contour.length - 1];
        if (f[0] === l[0] && f[1] === l[1]) contour.pop();
      }
      if (signedArea([...contour, contour[0]]) > 0) contour = contour.reverse(); // ensure CW for outer
      const holes = grp.holes.map((h) => {
        let hh = h.slice();
        if (hh.length >= 2) {
          const f = hh[0], l = hh[hh.length - 1];
          if (f[0] === l[0] && f[1] === l[1]) hh.pop();
        }
        if (signedArea([...hh, hh[0]]) < 0) hh = hh.reverse(); // ensure CCW for holes
        return hh;
      });

      const contourV2 = contour.map((p) => new THREE.Vector2(p[0], p[1]));
      const holesV2 = holes.map((arr) => arr.map((p) => new THREE.Vector2(p[0], p[1])));
      const tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);

      const allPts = contour.concat(...holes);
      for (const t of tris) {
        const a = allPts[t[0]], b = allPts[t[1]], c = allPts[t[2]];
        triPositions.push(a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0);
      }

      // Boundary loop records for downstream Sweep side construction
      const contourClosed = (contour.length && (contour[0][0] === contour[contour.length - 1][0] && contour[0][1] === contour[contour.length - 1][1])) ? contour : contour.concat([contour[0]]);
      const contourClosedW = contourClosed.map(([x, y]) => toW(x, y));
      boundaryLoopsWorld.push({ pts: contourClosedW, isHole: false });
      const holesClosed = holes.map((h) => (h.length && (h[0][0] === h[h.length - 1][0] && h[0][1] === h[h.length - 1][1])) ? h : h.concat([h[0]]));
      const holesClosedW = holesClosed.map((h) => h.map(([x, y]) => toW(x, y)));
      for (const hw of holesClosedW) boundaryLoopsWorld.push({ pts: hw, isHole: true });

      // For profileGroups used by Sweep caps, store OPEN loops (no duplicate last point)
      const contourOpen = contourClosed.slice(0, -1);
      const holesOpen = holesClosed.map(h => h.slice(0, -1));
      profileGroups.push({
        contour2D: contourOpen.slice(),
        holes2D: holesOpen.map(h => h.slice()),
        contourW: contourClosedW.slice(0, -1),
        holesW: holesClosedW.map(hw => hw.slice(0, -1))
      });
    }

    if (!triPositions.length) {
      console.warn('[IMAGE] Triangulation produced no area');
      return { added: [], removed: [] };
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(triPositions, 3));
    // Transform triangles from local plane to world placement
    geom.applyMatrix4(m);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    const face = new BREP.Face(geom);
    face.type = 'FACE';
    face.name = `${edgeNamePrefix}PROFILE`;
    face.userData.faceName = face.name;
    face.userData.boundaryLoopsWorld = boundaryLoopsWorld;
    face.userData.profileGroups = profileGroups;

    // Edges from loops, split at corners to enable per-edge sidewalls
    const edges = [];
    let edgeIdx = 0;
    let loopIdx = 0;
    const cornerThresholdDeg = Number.isFinite(Number(edgeSplitAngle))
      ? Math.max(1, Math.min(179, Number(edgeSplitAngle)))
      : 70;
    const minSegLen = Math.max(0.5 * Math.abs(scale || 1), 1e-6);

    const addEdgeSegmentsFromLoop = (loop2D, isHole) => {
      if (!loop2D || loop2D.length < 2) return;
      const segments = splitLoopIntoEdges(loop2D, {
        angleDeg: cornerThresholdDeg,
        minSegLen
      });
      let segIdx = 0;
      for (const seg of segments) {
        if (!seg || seg.length < 2) continue;
        const positions = [];
        const worldPts = [];
        for (let i = 0; i < seg.length; i++) {
          const p = seg[i];
          const w = toW(p[0], p[1]);
          positions.push(w[0], w[1], w[2]);
          worldPts.push([w[0], w[1], w[2]]);
        }
        if (positions.length < 6) continue;
        const lg = new LineGeometry();
        lg.setPositions(positions);
        try { lg.computeBoundingSphere(); } catch { }
        const e = new BREP.Edge(lg);
        e.type = 'EDGE';
        e.name = `${edgeNamePrefix}L${edgeIdx++}`;
        e.closedLoop = false;
        e.userData = {
          polylineLocal: worldPts,
          polylineWorld: true,
          isHole: !!isHole,
          loopIndex: loopIdx,
          segmentIndex: segIdx++
        };
        edges.push(e);
      }
      loopIdx++;
    };
    // Emit edge segments for outer and hole loops
    for (const grp of groups) {
      const outerClosed = grp.outer[0] && grp.outer[grp.outer.length - 1] && (grp.outer[0][0] === grp.outer[grp.outer.length - 1][0] && grp.outer[0][1] === grp.outer[grp.outer.length - 1][1]) ? grp.outer : grp.outer.concat([grp.outer[0]]);
      addEdgeSegmentsFromLoop(outerClosed, false);
      for (const h of grp.holes) {
        const hClosed = h[0] && h[h.length - 1] && (h[0][0] === h[h.length - 1][0] && h[0][1] === h[h.length - 1][1]) ? h : h.concat([h[0]]);
        addEdgeSegmentsFromLoop(hClosed, true);
      }
    }

    // Attach edge references to face for convenience
    try { face.edges = edges.slice(); } catch { }

    sceneGroup.add(face);
    for (const e of edges) sceneGroup.add(e);

    return { added: [sceneGroup], removed: [] };
  }
}

// --- Helpers -----------------------------------------------------------------

async function decodeToImageData(raw) {
  try {
    if (!raw) return null;
    if (raw instanceof ImageData) return raw;
    if (raw instanceof ArrayBuffer) {
      // Attempt to decode as PNG
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
      // Try to parse as binary base64 (png)
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
    console.warn('[IMAGE] Failed to decode input as image data', e);
  }
  return null;
}

function gridToWorld2D(gridLoop, scale = 1) {
  // gridLoop: list of [xNode, yNode], y grows down; map to world with y up, z=0
  const out = [];
  for (let i = 0; i < gridLoop.length; i++) {
    const gx = gridLoop[i][0];
    const gy = gridLoop[i][1];
    out.push([gx * scale, -gy * scale]);
  }
  return out;
}

function simplifyLoop(loop, { simplifyCollinear = true, rdpTolerance = 0 } = {}) {
  let pts = loop.slice();
  // Ensure closed for area/orientation helpers
  if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) {
    pts.push([pts[0][0], pts[0][1]]);
  }
  if (simplifyCollinear) pts = removeCollinear2D(pts);
  if (rdpTolerance && rdpTolerance > 0) pts = rdp(pts, rdpTolerance);
  // Guarantee closure
  if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

function removeCollinear2D(loop) {
  if (loop.length < 4) return loop.slice();
  const out = [];
  for (let i = 0; i < loop.length - 1; i++) { // leave duplicate last for closure
    const a = loop[(i + loop.length - 2) % (loop.length - 1)];
    const b = loop[(i + loop.length - 1) % (loop.length - 1)];
    const c = loop[i];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const bcx = c[0] - b[0], bcy = c[1] - b[1];
    const cross = abx * bcy - aby * bcx;
    if (Math.abs(cross) > 1e-12) out.push(b);
  }
  if (out.length >= 1) {
    out.push([out[0][0], out[0][1]]);
    return out;
  }
  // If fully collinear or degenerate, keep original loop to avoid empty result
  return loop.slice();
}

function signedArea(loop) {
  let area = 0;
  for (let i = 0; i < loop.length - 1; i++) {
    const a = loop[i], b = loop[i + 1];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return 0.5 * area;
}

function bounds2D(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

// Point-in-polygon using winding number. Accepts closed or open polygon arrays.
function pointInPoly(pt, poly) {
  const n = Array.isArray(poly) ? poly.length : 0;
  if (n < 3) return false;
  let ring = poly;
  const first = ring[0], last = ring[ring.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) ring = ring.slice(0, ring.length - 1);
  const x = pt[0], y = pt[1];
  let wn = 0;
  const isLeft = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if ((a[1] <= y) && (b[1] > y) && isLeft(a[0], a[1], b[0], b[1], x, y) > 0) wn++;
    else if ((a[1] > y) && (b[1] <= y) && isLeft(a[0], a[1], b[0], b[1], x, y) < 0) wn--;
  }
  return wn !== 0;
}

function groupLoopsOuterHoles(loops) {
  // Normalize: ensure each loop is closed and oriented CCW for holes, CW for outers
  const closed = loops.map((l) => {
    const c = l.slice();
    if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push([c[0][0], c[0][1]]);
    return c;
  });
  const norm = closed.map((l) => {
    const A = signedArea(l);
    if (A < 0) return l.slice();
    const r = l.slice(); r.reverse(); return r;
  });

  const reps = norm.map((l) => l[0]);
  const depth = new Array(norm.length).fill(0);
  for (let i = 0; i < norm.length; i++) {
    for (let j = 0; j < norm.length; j++) {
      if (i === j) continue;
      if (pointInPoly(reps[i], norm[j])) depth[i]++;
    }
  }

  // Even depth -> outer; holes are immediate odd-depth children
  const groups = [];
  for (let i = 0; i < norm.length; i++) if ((depth[i] % 2) === 0) groups.push({ outer: i, holes: [] });
  for (let h = 0; h < norm.length; h++) if ((depth[h] % 2) === 1) {
    let best = -1, bestDepth = Infinity;
    for (let g = 0; g < groups.length; g++) {
      const oi = groups[g].outer;
      if (pointInPoly(reps[h], norm[oi])) {
        if (depth[oi] < bestDepth) { best = g; bestDepth = depth[oi]; }
      }
    }
    if (best >= 0) groups[best].holes.push(h);
  }

  return groups.map((g) => ({
    outer: norm[g.outer].slice(),
    holes: g.holes.map((h) => norm[h].slice()),
  }));
}

function splitLoopIntoEdges(loop2D, { angleDeg = 70, minSegLen = 1e-6 } = {}) {
  if (!Array.isArray(loop2D) || loop2D.length < 2) return [];
  const ring = loop2D.slice();
  if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
    ring.pop();
  }
  const n = ring.length;
  if (n < 2) return [];
  const angThresh = Math.max(0, Math.min(180, angleDeg)) * (Math.PI / 180);
  let totalLen = 0;
  const cum = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    totalLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (i + 1 < n) cum[i + 1] = totalLen;
  }
  const avgLen = totalLen > 1e-9 ? (totalLen / n) : minSegLen;
  const spanLen = Math.max(minSegLen, avgLen * 4);
  const minSpan = spanLen * 0.75;
  const straightnessThresh = 0.97;
  const minCornerSpacing = Math.max(spanLen * 1.5, totalLen * 0.015, minSegLen * 2);

  const sampleDir = (startIdx, step) => {
    let sx = 0;
    let sy = 0;
    let acc = 0;
    let idx = startIdx;
    for (let guard = 0; guard < n; guard++) {
      const next = (idx + step + n) % n;
      const dx = ring[next][0] - ring[idx][0];
      const dy = ring[next][1] - ring[idx][1];
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        sx += dx;
        sy += dy;
        acc += len;
      }
      idx = next;
      if (acc >= spanLen) break;
    }
    const mag = Math.hypot(sx, sy);
    const straightness = acc > 0 ? (mag / acc) : 0;
    return {
      dir: mag > 1e-9 ? [sx / mag, sy / mag] : [0, 0],
      span: acc,
      straightness
    };
  };

  const candidates = [];
  for (let i = 0; i < n; i++) {
    const prev = sampleDir(i, -1);
    const next = sampleDir(i, 1);
    if (prev.span < minSpan || next.span < minSpan) continue;
    if (prev.straightness < straightnessThresh || next.straightness < straightnessThresh) continue;
    const inDir = [-prev.dir[0], -prev.dir[1]];
    const dot = inDir[0] * next.dir[0] + inDir[1] * next.dir[1];
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang >= angThresh) candidates.push({ idx: i, ang });
  }

  const arcDist = (a, b) => {
    const da = Math.abs(cum[a] - cum[b]);
    return Math.min(da, totalLen - da);
  };
  const corners = [];
  candidates.sort((a, b) => b.ang - a.ang);
  for (const cand of candidates) {
    let tooClose = false;
    for (const sel of corners) {
      if (arcDist(cand.idx, sel.idx) < minCornerSpacing) { tooClose = true; break; }
    }
    if (!tooClose) corners.push(cand);
  }
  corners.sort((a, b) => a.idx - b.idx);
  const cornerIdx = corners.map(c => c.idx);
  if (cornerIdx.length < 2) {
    return [ring.concat([ring[0]])];
  }
  const uniq = [];
  for (const idx of cornerIdx) {
    if (!uniq.length || uniq[uniq.length - 1] !== idx) uniq.push(idx);
  }
  if (uniq.length < 2) {
    return [ring.concat([ring[0]])];
  }
  const segments = [];
  const dedupeSeg = (seg) => {
    const out = [];
    let prev = null;
    for (const p of seg) {
      if (!prev || p[0] !== prev[0] || p[1] !== prev[1]) out.push(p);
      prev = p;
    }
    return out;
  };
  for (let i = 0; i < uniq.length; i++) {
    const start = uniq[i];
    const end = uniq[(i + 1) % uniq.length];
    const seg = [];
    let k = start;
    for (let guard = 0; guard <= n; guard++) {
      seg.push(ring[k]);
      if (k === end) break;
      k = (k + 1) % n;
    }
    const cleaned = dedupeSeg(seg);
    if (cleaned.length >= 2) segments.push(cleaned);
  }
  return segments.length ? segments : [ring.concat([ring[0]])];
}

function positionsToTriples(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 3) out.push([arr[i], arr[i + 1], arr[i + 2]]);
  return out;
}

function getPlacementBasis(ref, partHistory) {
  // Returns { origin:[x,y,z], x:[x,y,z], y:[x,y,z], z:[x,y,z] }
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
    // Origin: geometric center if available else world pos
    try {
      const g = refObj.geometry;
      if (g) {
        const bs = g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
        if (bs) origin.copy(refObj.localToWorld(bs.center.clone()));
        else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
      } else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
    } catch { origin.copy(refObj.getWorldPosition(new THREE.Vector3())); }

    // Orientation: FACE uses average normal; PLANE/others use object z-axis
    let n = null;
    if (refObj.type === 'FACE' && typeof refObj.getAverageNormal === 'function') {
      try { n = refObj.getAverageNormal().normalize(); } catch { n = null; }
    }
    if (!n) {
      try { n = new THREE.Vector3(0, 0, 1).applyQuaternion(refObj.getWorldQuaternion(new THREE.Quaternion())).normalize(); } catch { n = new THREE.Vector3(0, 0, 1); }
    }
    const worldUp = new THREE.Vector3(0, 1, 0);
    const tmp = new THREE.Vector3();
    const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp;
    x.copy(tmp.crossVectors(zx, n).normalize());
    y.copy(tmp.crossVectors(n, x).normalize());
    z.copy(n);
  }

  return { origin: [origin.x, origin.y, origin.z], x: [x.x, x.y, x.z], y: [y.x, y.y, y.z], z: [z.x, z.y, z.z] };
}
