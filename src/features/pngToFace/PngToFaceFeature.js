import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { LineGeometry } from 'three/examples/jsm/Addons.js';

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the PNG trace feature",
  },
  fileToImport: {
    type: "file",
    default_value: "",
    accept: ".png,image/png",
    hint: "Monochrome PNG data (click to choose a file)",
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
  simplifyCollinear: {
    type: "boolean",
    default_value: true,
    hint: "Remove intermediate points on straight segments",
  },
  rdpTolerance: {
    type: "number",
    default_value: 0,
    hint: "Optional Ramer–Douglas–Peucker tolerance in world units (0 to disable)",
  },
  placementPlane: {
    type: "reference_selection",
    selectionFilter: ["PLANE", "FACE"],
    multiple: false,
    default_value: null,
    hint: "Select a plane or face where the traced image will be placed",
  },
};

export class PngToFaceFeature {
  static featureShortName = "PNG";
  static featureName = "PNG to Face";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = extractDefaultValues(inputParamsSchema);
    this.persistentData = {};
  }

  async run(partHistory) {
    const { fileToImport, threshold, invert, pixelScale, center, simplifyCollinear, rdpTolerance } = this.inputParams;

    const imageData = await decodeToImageData(fileToImport);
    if (!imageData) {
      console.warn('[PNG] No image data decoded');
      return [];
    }

    const mask = rasterToMask(imageData, Number(threshold) || 0, !!invert);
    const loopsGrid = extractLoopsFromMask(mask.width, mask.height, mask.data);
    if (!loopsGrid.length) {
      console.warn('[PNG] No contours found in image');
      return [];
    }

    // Convert grid loops (integer node coords in image space, y-down) to world 2D loops (x, y-up)
    const scale = Number(pixelScale) || 1;
    const loops2D = loopsGrid.map((pts) => gridToWorld2D(pts, scale));

    // Optional simplifications
    let simpLoops = loops2D.map((l) => simplifyLoop(l, { simplifyCollinear, rdpTolerance }));

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
    sceneGroup.name = this.inputParams.featureID || 'PNG_Sketch';
    sceneGroup.type = 'SKETCH';
    sceneGroup.onClick = () => {};

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
      const contourClosed = (contour.length && (contour[0][0]===contour[contour.length-1][0] && contour[0][1]===contour[contour.length-1][1])) ? contour : contour.concat([contour[0]]);
      const contourClosedW = contourClosed.map(([x,y]) => toW(x,y));
      boundaryLoopsWorld.push({ pts: contourClosedW, isHole: false });
      const holesClosed = holes.map((h) => (h.length && (h[0][0]===h[h.length-1][0] && h[0][1]===h[h.length-1][1])) ? h : h.concat([h[0]]));
      const holesClosedW = holesClosed.map((h)=> h.map(([x,y]) => toW(x,y)));
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
      console.warn('[PNG] Triangulation produced no area');
      return [];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(triPositions, 3));
    // Transform triangles from local plane to world placement
    geom.applyMatrix4(m);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    const face = new BREP.Face(geom);
    face.name = `${sceneGroup.name}:PROFILE`;
    face.userData.faceName = face.name;
    face.userData.boundaryLoopsWorld = boundaryLoopsWorld;
    face.userData.profileGroups = profileGroups;

    // Edges from loops
    const edges = [];
    let edgeIdx = 0;

    // 1) Closed-loop edges per boundary (outer + holes) to guarantee closed connectivity
    const addClosedLoopEdge = (closedLoop, isHole) => {
      if (!closedLoop || closedLoop.length < 2) return;
      // Ensure closed by duplicating the first if needed
      let ring = closedLoop;
      const f = ring[0], l = ring[ring.length - 1];
      if (!(f[0] === l[0] && f[1] === l[1])) ring = ring.concat([f]);
      // Build world positions
      const positions = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const w = toW(p[0], p[1]);
        positions.push(w[0], w[1], w[2]);
      }
      const lg = new LineGeometry();
      lg.setPositions(positions);
      try { lg.computeBoundingSphere(); } catch {}
      const e = new BREP.Edge(lg);
      e.name = `${sceneGroup.name}:L${edgeIdx++}`;
      e.closedLoop = true;
      e.userData = { polylineLocal: positionsToTriples(positions), polylineWorld: true, isHole: !!isHole };
      edges.push(e);
    };
    const addEdgeSegment = (segPts, isHole) => {
      if (!segPts || segPts.length < 2) return;
      const positions = [];
      for (let i = 0; i < segPts.length; i++) {
        const p = segPts[i];
        const w = toW(p[0], p[1]);
        positions.push(w[0], w[1], w[2]);
      }
      const lg = new LineGeometry();
      lg.setPositions(positions);
      try { lg.computeBoundingSphere(); } catch {}
      const e = new BREP.Edge(lg);
      e.name = `${sceneGroup.name}:E${edgeIdx++}`;
      e.closedLoop = false;
      e.userData = { polylineLocal: positionsToTriples(positions), polylineWorld: true, isHole: !!isHole };
      edges.push(e);
    };

    const makeSegments = (closedLoop) => {
      const eps = 1e-12;
      if (!Array.isArray(closedLoop) || closedLoop.length < 2) return [];
      const ring = (closedLoop[0][0] === closedLoop[closedLoop.length - 1][0] && closedLoop[0][1] === closedLoop[closedLoop.length - 1][1])
        ? closedLoop.slice()
        : closedLoop.concat([closedLoop[0]]);
      const n = ring.length - 1;
      if (n < 2) return [];
      const dir = (a, b) => [b[0] - a[0], b[1] - a[1]];
      const collinear = (u, v) => Math.abs(u[0] * v[1] - u[1] * v[0]) <= eps;
      const segs = [];
      let cur = [ring[0]];
      let prevDir = dir(ring[0], ring[1]);
      for (let i = 1; i < n; i++) {
        const b = ring[i];
        const c = ring[i + 1];
        const d = dir(b, c);
        if (collinear(prevDir, d)) {
          cur.push(b);
          prevDir = d;
        } else {
          cur.push(b);
          if (cur.length >= 2) segs.push(cur.slice());
          cur = [b];
          prevDir = d;
        }
      }
      cur.push(ring[n]);
      if (cur.length >= 2) segs.push(cur);
      if (segs.length >= 2) {
        const first = segs[0];
        const last = segs[segs.length - 1];
        const u = dir(last[last.length - 2], last[last.length - 1]);
        const v = dir(first[0], first[1]);
        if (collinear(u, v)) {
          const merged = last.slice();
          for (let i = 1; i < first.length; i++) merged.push(first[i]);
          segs[0] = merged;
          segs.pop();
        }
      }
      const cleaned = [];
      for (const s of segs) {
        const out = [];
        for (let i = 0; i < s.length; i++) {
          const p = s[i];
          if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p);
        }
        if (out.length >= 2) cleaned.push(out);
      }
      return cleaned;
    };

    // Emit one closed edge for outer, and one for each hole
    for (const grp of groups) {
      const outerClosed = grp.outer[0] && grp.outer[grp.outer.length-1] && (grp.outer[0][0]===grp.outer[grp.outer.length-1][0] && grp.outer[0][1]===grp.outer[grp.outer.length-1][1]) ? grp.outer : grp.outer.concat([grp.outer[0]]);
      addClosedLoopEdge(outerClosed, false);
      for (const h of grp.holes) {
        const hClosed = h[0] && h[h.length-1] && (h[0][0]===h[h.length-1][0] && h[0][1]===h[h.length-1][1]) ? h : h.concat([h[0]]);
        addClosedLoopEdge(hClosed, true);
      }
    }

    for (const grp of groups) {
      const outerClosed = grp.outer[0] && grp.outer[grp.outer.length-1] && (grp.outer[0][0]===grp.outer[grp.outer.length-1][0] && grp.outer[0][1]===grp.outer[grp.outer.length-1][1]) ? grp.outer : grp.outer.concat([grp.outer[0]]);
      for (const seg of makeSegments(outerClosed)) addEdgeSegment(seg, false);
      for (const h of grp.holes) {
        const hClosed = h[0] && h[h.length-1] && (h[0][0]===h[h.length-1][0] && h[0][1]===h[h.length-1][1]) ? h : h.concat([h[0]]);
        for (const seg of makeSegments(hClosed)) addEdgeSegment(seg, true);
      }
    }

    // Attach edge references to face for convenience
    try { face.edges = edges.slice(); } catch {}

    sceneGroup.add(face);
    for (const e of edges) sceneGroup.add(e);

    return [sceneGroup];
  }
}

// --- Helpers -----------------------------------------------------------------

async function decodeToImageData(raw) {
  try {
    if (!raw) return null;
    let src = null;
    if (typeof raw === 'string') {
      if (raw.startsWith('data:')) {
        src = raw;
      } else {
        // Try to detect base64 without data URL header, fallback to as-is
        const looksB64 = /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 256;
        if (looksB64 && typeof window !== 'undefined' && window.atob) {
          const bin = atob(raw);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
          const blob = new Blob([bytes], { type: 'image/png' });
          src = URL.createObjectURL(blob);
        } else {
          // Hope it's a URL or path resolved by the app
          src = raw;
        }
      }
    } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const buf = raw instanceof ArrayBuffer ? raw : raw.buffer;
      const blob = new Blob([buf], { type: 'image/png' });
      src = URL.createObjectURL(blob);
    } else {
      return null;
    }

    // Browser path: draw to canvas to get ImageData
    if (typeof document !== 'undefined') {
      const img = await loadImage(src);
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      try { if (src.startsWith('blob:')) URL.revokeObjectURL(src); } catch {}
      return id;
    }
  } catch (e) {
    console.warn('[PNG] Failed to decode image:', e);
    return null;
  }
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function rasterToMask(imageData, threshold = 128, invert = false) {
  const { width, height, data } = imageData; // RGBA Uint8ClampedArray
  const out = new Uint8Array(width * height);
  const thr = Math.max(0, Math.min(255, threshold | 0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i + 0], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      // Treat mostly-transparent as background
      const alphaMask = (a >= 10) ? 1 : 0;
      const lum = ((r * 299 + g * 587 + b * 114) / 1000) | 0; // integer luma
      let fg = (lum >= thr ? 1 : 0);
      if (invert) fg = 1 - fg;
      out[y * width + x] = (fg & alphaMask);
    }
  }
  return { width, height, data: out };
}

// Extract closed loops using an oriented grid-edge tracer that keeps foreground on the left
function extractLoopsFromMask(width, height, mask) {
  // Build oriented half-edges: each boundary between 0/1 yields a directed edge with interior on the left
  const dx = [1, 0, -1, 0];  // 0=R,1=D,2=L,3=U (clockwise)
  const dy = [0, 1, 0, -1];
  const edgeSet = new Set(); // keys: "x,y,dir"
  const starts = new Map(); // node key -> array of dir ints
  const skey = (x, y) => `${x},${y}`;
  const ekey = (x, y, d) => `${x},${y},${d}`;

  // Vertical transitions
  for (let y = 0; y < height; y++) {
    for (let x = 0; x <= width; x++) {
      const L = (x > 0) ? mask[y * width + (x - 1)] : 0;
      const R = (x < width) ? mask[y * width + x] : 0;
      if ((L ^ R) === 1) {
        if (L === 1) {
          // interior on west; orient Up to keep interior on left
          const sx = x, sy = y + 1, d = 3; // start at bottom node going up
          edgeSet.add(ekey(sx, sy, d));
          const k = skey(sx, sy);
          if (!starts.has(k)) starts.set(k, []);
          starts.get(k).push(d);
        } else {
          // interior on east; orient Down
          const sx = x, sy = y, d = 1; // start at top node going down
          edgeSet.add(ekey(sx, sy, d));
          const k = skey(sx, sy);
          if (!starts.has(k)) starts.set(k, []);
          starts.get(k).push(d);
        }
      }
    }
  }

  // Horizontal transitions
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      const T = (y > 0) ? mask[(y - 1) * width + x] : 0;
      const B = (y < height) ? mask[y * width + x] : 0;
      if ((T ^ B) === 1) {
        if (T === 1) {
          // interior north; orient Right
          const sx = x, sy = y, d = 0; // start at left node going right
          edgeSet.add(ekey(sx, sy, d));
          const k = skey(sx, sy);
          if (!starts.has(k)) starts.set(k, []);
          starts.get(k).push(d);
        } else {
          // interior south; orient Left
          const sx = x + 1, sy = y, d = 2; // start at right node going left
          edgeSet.add(ekey(sx, sy, d));
          const k = skey(sx, sy);
          if (!starts.has(k)) starts.set(k, []);
          starts.get(k).push(d);
        }
      }
    }
  }

  const loops = [];
  const leftOf = (d) => (d + 3) & 3; // turn left
  const rightOf = (d) => (d + 1) & 3;
  const backOf = (d) => (d + 2) & 3;

  // Helper: find a remaining edge to seed a loop
  const nextSeed = () => {
    for (const k of edgeSet.values()) return k;
    return null;
  };

  while (edgeSet.size) {
    const seed = nextSeed();
    if (!seed) break;
    const parts = seed.split(',');
    let x = parseInt(parts[0], 10) | 0;
    let y = parseInt(parts[1], 10) | 0;
    let d = parseInt(parts[2], 10) | 0;

    const sx = x, sy = y, sd = d;
    const ring = [[x, y]];
    edgeSet.delete(ekey(x, y, d));

    while (true) {
      // Step along current edge
      const nx = x + dx[d];
      const ny = y + dy[d];
      // Append endpoint
      ring.push([nx, ny]);

      // Choose next edge with left/straight/right/back preference
      const cand = [leftOf(d), d, rightOf(d), backOf(d)];
      let nd = -1;
      for (let i = 0; i < 4; i++) {
        const cd = cand[i];
        const key = ekey(nx, ny, cd);
        if (edgeSet.has(key)) { nd = cd; edgeSet.delete(key); break; }
      }

      if (nd === -1) {
        // No continuation; ring should be closed or a degenerate open chain; accept and break
        break;
      }

      // If we returned to the seed state, close the loop
      if (nx === sx && ny === sy && nd === sd) {
        // Add seed start again to make a closed ring explicitly
        // (ring already has [sx,sy] as first entry)
        break;
      }

      // Advance
      x = nx; y = ny; d = nd;
    }

    // Deduplicate consecutive duplicates
    const cleaned = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (!cleaned.length || (cleaned[cleaned.length - 1][0] !== p[0] || cleaned[cleaned.length - 1][1] !== p[1])) {
        cleaned.push(p);
      }
    }
    // Ensure closed by removing redundant last if equal to first
    if (cleaned.length >= 2) {
      const a = cleaned[0];
      const b = cleaned[cleaned.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) cleaned.pop();
    }
    // Remove collinear grid nodes to only keep corners
    const simplified = removeCollinearGrid(cleaned);
    if (simplified.length >= 3) loops.push(simplified);
  }

  return loops;
}

function removeCollinearGrid(pts) {
  if (pts.length <= 3) return pts.slice();
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = cur[0] - prev[0];
    const v1y = cur[1] - prev[1];
    const v2x = next[0] - cur[0];
    const v2y = next[1] - cur[1];
    // Keep point if direction changes (corner)
    const collinear = (v1x === v2x && v1y === v2y) || (v1x === -v2x && v1y === -v2y) || (v1x === 0 && v2x === 0) || (v1y === 0 && v2y === 0);
    // The above condition is too permissive; prefer cross-product test for axis-aligned grid
    const cross = v1x * v2y - v1y * v2x;
    if (Math.abs(cross) > 1e-12) out.push(cur);
  }
  // Ensure closed ring (repeat first at end)
  if (out.length) out.push([out[0][0], out[0][1]]);
  return out;
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

function rdp(points, epsilon) {
  // points closed (last equals first). Work on open then reclose.
  if (points.length <= 3) return points.slice();
  const open = points.slice(0, points.length - 1);
  const simplified = rdpRecursive(open, epsilon);
  if (!simplified.length) return points.slice();
  simplified.push([simplified[0][0], simplified[0][1]]);
  return simplified;
}

function rdpRecursive(points, epsilon) {
  if (points.length < 3) return points.slice();
  // Find point with max distance from line p0->pN
  const p0 = points[0];
  const pN = points[points.length - 1];
  let index = -1; let dmax = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDist(points[i], p0, pN);
    if (d > dmax) { index = i; dmax = d; }
  }
  if (dmax > epsilon) {
    const left = rdpRecursive(points.slice(0, index + 1), epsilon);
    const right = rdpRecursive(points.slice(index), epsilon);
    return left.slice(0, left.length - 1).concat(right);
  } else {
    return [p0, pN];
  }
}

function pointLineDist(p, a, b) {
  const x = p[0], y = p[1];
  const x1 = a[0], y1 = a[1];
  const x2 = b[0], y2 = b[1];
  const A = x - x1; const B = y - y1; const C = x2 - x1; const D = y2 - y1;
  const dot = A * C + B * D;
  const len2 = C * C + D * D;
  const t = len2 > 0 ? Math.max(0, Math.min(1, dot / len2)) : 0;
  const px = x1 + t * C; const py = y1 + t * D;
  const dx = x - px; const dy = y - py;
  return Math.hypot(dx, dy);
}

function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length - 1; i++) {
    const x1 = loop[i][0], y1 = loop[i][1];
    const x2 = loop[i + 1][0], y2 = loop[i + 1][1];
    a += (x1 * y2 - x2 * y1);
  }
  return 0.5 * a;
}

function pointInPoly(p, loop) {
  // Ray casting
  let inside = false;
  const x = p[0], y = p[1];
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i][0], yi = loop[i][1];
    const xj = loop[j][0], yj = loop[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-18) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function bounds2D(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function groupLoopsOuterHoles(loops) {
  // Normalize: ensure closed (repeat first) and drop degenerate
  const norm = loops.map((l) => {
    const pts = l.slice();
    if (!pts.length) return null;
    if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push([pts[0][0], pts[0][1]]);
    if (Math.abs(signedArea(pts)) < 1e-12) return null;
    return pts;
  }).filter(Boolean);

  // Representative point per loop
  const reps = norm.map((l) => l[0]);
  const depth = new Array(norm.length).fill(0);
  for (let i = 0; i < norm.length; i++) {
    for (let j = 0; j < norm.length; j++) {
      if (i === j) continue;
      if (pointInPoly(reps[i], norm[j])) depth[i]++;
    }
}

// Fallback helper for older code paths or HMR cache: same logic as inlined makeSegments.
function splitLoopIntoLinearRegions(closedLoop, eps = 1e-12) {
  if (!Array.isArray(closedLoop) || closedLoop.length < 2) return [];
  // Ensure closed ring
  const ring = (closedLoop[0][0] === closedLoop[closedLoop.length - 1][0] && closedLoop[0][1] === closedLoop[closedLoop.length - 1][1])
    ? closedLoop.slice()
    : closedLoop.concat([closedLoop[0]]);
  const n = ring.length - 1;
  if (n < 2) return [];
  const dir = (a, b) => [b[0] - a[0], b[1] - a[1]];
  const collinear = (u, v) => Math.abs(u[0] * v[1] - u[1] * v[0]) <= eps;
  const segs = [];
  let cur = [ring[0]];
  let prevDir = dir(ring[0], ring[1]);
  for (let i = 1; i < n; i++) {
    const b = ring[i];
    const c = ring[i + 1];
    const d = dir(b, c);
    if (collinear(prevDir, d)) { cur.push(b); prevDir = d; }
    else { cur.push(b); if (cur.length >= 2) segs.push(cur.slice()); cur = [b]; prevDir = d; }
  }
  cur.push(ring[n]);
  if (cur.length >= 2) segs.push(cur);
  // Merge first/last if collinear
  if (segs.length >= 2) {
    const first = segs[0];
    const last = segs[segs.length - 1];
    const u = dir(last[last.length - 2], last[last.length - 1]);
    const v = dir(first[0], first[1]);
    if (collinear(u, v)) {
      const merged = last.slice();
      for (let i = 1; i < first.length; i++) merged.push(first[i]);
      segs[0] = merged; segs.pop();
    }
  }
  // Dedup consecutive points
  const cleaned = [];
  for (const s of segs) {
    const out = [];
    for (let i = 0; i < s.length; i++) { const p = s[i]; if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p); }
    if (out.length >= 2) cleaned.push(out);
  }
  return cleaned;
}

// Split a closed loop [ [x,y], ... , [x0,y0] ] into maximal straight-line regions.
// Returns array of segments, each an array of [x,y] with at least 2 points.
// splitLoopIntoLinearRegions was inlined into run() as makeSegments to avoid hoisting issues with HMR.

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

function positionsToTriples(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 3) out.push([arr[i], arr[i + 1], arr[i + 2]]);
  return out;
}

function getPlacementBasis(ref, partHistory) {
  // Returns { origin:[x,y,z], x:[x,y,z], y:[x,y,z], z:[x,y,z] }
  const x = new THREE.Vector3(1,0,0);
  const y = new THREE.Vector3(0,1,0);
  const z = new THREE.Vector3(0,0,1);
  const origin = new THREE.Vector3(0,0,0);

  let refObj = null;
  try {
    if (Array.isArray(ref)) refObj = ref[0] || null;
    else if (ref && typeof ref === 'object') refObj = ref;
    else if (ref) refObj = partHistory?.scene?.getObjectByName(ref);
  } catch {}

  if (refObj) {
    try { refObj.updateWorldMatrix(true, true); } catch {}
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
      try { n = new THREE.Vector3(0,0,1).applyQuaternion(refObj.getWorldQuaternion(new THREE.Quaternion())).normalize(); } catch { n = new THREE.Vector3(0,0,1); }
    }
    const worldUp = new THREE.Vector3(0,1,0);
    const tmp = new THREE.Vector3();
    const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1,0,0) : worldUp;
    x.copy(tmp.crossVectors(zx, n).normalize());
    y.copy(tmp.crossVectors(n, x).normalize());
    z.copy(n);
  }

  return { origin: [origin.x, origin.y, origin.z], x: [x.x, x.y, x.z], y: [y.x, y.y, y.z], z: [z.x, z.y, z.z] };
}
