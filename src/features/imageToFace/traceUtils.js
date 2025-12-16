// Shared clean-room trace + smoothing utilities for ImageToFace

export function traceImageDataToPolylines(imageData, options = {}) {
  const opt = {
    threshold: 128,
    mode: "luma", // "alpha" | "luma" | "luma+alpha"
    invert: false,
    minArea: 0,
    mergeCollinear: true,
    simplify: 0,
    includeOrientation: false,
    ...options,
  };

  const w = imageData?.width | 0;
  const h = imageData?.height | 0;
  if (!w || !h) return [];

  const mask = binarize(imageData, w, h, opt);
  const edges = buildBoundaryEdges(mask, w, h);
  const loops = stitchEdgesToLoops(edges);

  const out = [];
  for (const loop of loops) {
    let poly = loop;

    if (opt.mergeCollinear) poly = removeCollinear(poly);
    const area = polygonArea(poly);

    if (Math.abs(area) < opt.minArea) continue;

    if (opt.simplify > 0 && poly.length >= 4) {
      poly = rdpClosed(poly, opt.simplify);
      if (opt.mergeCollinear) poly = removeCollinear(poly);
    }

    if (poly.length >= 3) {
      out.push(opt.includeOrientation ? { polyline: poly, area } : poly);
    }
  }

  return out;
}

function binarize(imageData, w, h, opt) {
  const src = imageData.data;
  const mask = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const r = src[i + 0];
    const g = src[i + 1];
    const b = src[i + 2];
    const a = src[i + 3];

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    let fg;
    if (opt.mode === "alpha") {
      fg = a >= opt.threshold;
    } else if (opt.mode === "luma+alpha") {
      fg = a > 0 && luma < opt.threshold;
    } else {
      fg = luma < opt.threshold;
    }

    if (opt.invert) fg = !fg;
    mask[p] = fg ? 1 : 0;
  }

  return mask;
}

function at(mask, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return mask[y * w + x];
}

function buildBoundaryEdges(mask, w, h) {
  const edges = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(mask, w, h, x, y)) continue;

      if (!at(mask, w, h, x, y - 1)) edges.push({ sx: x, sy: y, ex: x + 1, ey: y, dir: 0 });
      if (!at(mask, w, h, x + 1, y)) edges.push({ sx: x + 1, sy: y, ex: x + 1, ey: y + 1, dir: 1 });
      if (!at(mask, w, h, x, y + 1)) edges.push({ sx: x + 1, sy: y + 1, ex: x, ey: y + 1, dir: 2 });
      if (!at(mask, w, h, x - 1, y)) edges.push({ sx: x, sy: y + 1, ex: x, ey: y, dir: 3 });
    }
  }

  return edges;
}

function stitchEdgesToLoops(edges) {
  const startMap = new Map();
  const visited = new Uint8Array(edges.length);

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const k = vkey(e.sx, e.sy);
    let arr = startMap.get(k);
    if (!arr) startMap.set(k, (arr = []));
    arr.push(i);
  }

  const loops = [];

  for (let i = 0; i < edges.length; i++) {
    if (visited[i]) continue;

    const loop = [];
    let currEdge = edges[i];
    visited[i] = 1;

    const startX = currEdge.sx;
    const startY = currEdge.sy;

    loop.push({ x: startX, y: startY });

    let cx = currEdge.ex;
    let cy = currEdge.ey;
    let dir = currEdge.dir;
    const maxSteps = edges.length + 10;

    for (let steps = 0; steps < maxSteps; steps++) {
      if (cx === startX && cy === startY) break;

      loop.push({ x: cx, y: cy });

      const nextIndex = pickNextEdge(startMap, edges, visited, cx, cy, dir);
      if (nextIndex < 0) {
        loop.length = 0;
        break;
      }

      const ne = edges[nextIndex];
      visited[nextIndex] = 1;

      cx = ne.ex;
      cy = ne.ey;
      dir = ne.dir;
    }

    if (loop.length >= 3 && (loop[0].x !== loop[loop.length - 1].x || loop[0].y !== loop[loop.length - 1].y)) {
      loops.push(loop);
    }
  }

  return loops;
}

function pickNextEdge(startMap, edges, visited, vx, vy, prevDir) {
  const k = vkey(vx, vy);
  const candidates = startMap.get(k);
  if (!candidates || candidates.length === 0) return -1;

  const preferred = [
    (prevDir + 1) & 3,
    prevDir,
    (prevDir + 3) & 3,
    (prevDir + 2) & 3,
  ];

  let bestIdx = -1;
  let bestRank = 999;

  for (const ei of candidates) {
    if (visited[ei]) continue;
    const d = edges[ei].dir;
    const rank = preferred.indexOf(d);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      bestIdx = ei;
      if (bestRank === 0) break;
    }
  }

  return bestIdx;
}

function vkey(x, y) {
  return `${x},${y}`;
}

function removeCollinear(poly) {
  if (poly.length < 4) return poly;

  const out = [];
  const n = poly.length;

  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n];
    const b = poly[i];
    const c = poly[(i + 1) % n];

    const abx = b.x - a.x, aby = b.y - a.y;
    const bcx = c.x - b.x, bcy = c.y - b.y;

    const cross = abx * bcy - aby * bcx;
    if (cross !== 0) {
      out.push(b);
      continue;
    }

    if ((abx === 0 && aby === 0) || (bcx === 0 && bcy === 0)) out.push(b);
  }

  return out.length >= 3 ? out : poly;
}

function polygonArea(poly) {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function rdpClosed(poly, eps) {
  if (poly.length < 4) return poly;

  const centroid = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  centroid.x /= poly.length;
  centroid.y /= poly.length;

  let split = 0;
  let best = -1;
  for (let i = 0; i < poly.length; i++) {
    const dx = poly[i].x - centroid.x;
    const dy = poly[i].y - centroid.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > best) {
      best = d2;
      split = i;
    }
  }

  const open = poly.slice(split).concat(poly.slice(0, split + 1));
  const simplified = rdpOpen(open, eps);

  simplified.pop();

  const rotated = simplified.slice(-split).concat(simplified.slice(0, -split));
  return rotated;
}

function rdpOpen(points, eps) {
  if (points.length <= 2) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  const eps2 = eps * eps;

  while (stack.length) {
    const [a, b] = stack.pop();
    let maxDist2 = -1;
    let idx = -1;

    const p1 = points[a];
    const p2 = points[b];

    for (let i = a + 1; i < b; i++) {
      const d2 = pointToSegmentDist2(points[i], p1, p2);
      if (d2 > maxDist2) {
        maxDist2 = d2;
        idx = i;
      }
    }

    if (maxDist2 > eps2 && idx !== -1) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function pointToSegmentDist2(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;

  const abLen2 = abx * abx + aby * aby;
  if (abLen2 === 0) return apx * apx + apy * apy;

  let t = (apx * abx + apy * aby) / abLen2;
  t = Math.max(0, Math.min(1, t));

  const cx = a.x + t * abx;
  const cy = a.y + t * aby;

  const dx = p.x - cx;
  const dy = p.y - cy;
  return dx * dx + dy * dy;
}

export function rdp(points, epsilon) {
  if (points.length <= 3) return points.slice();
  const open = points.slice(0, points.length - 1);
  const simplified = rdpRecursive(open, epsilon);
  if (!simplified.length) return points.slice();
  simplified.push([simplified[0][0], simplified[0][1]]);
  return simplified;
}

function rdpRecursive(points, epsilon) {
  if (points.length < 3) return points.slice();
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

export function applyCurveFit(loops, { tolerance = 0.75, cornerThresholdDeg = 70, iterations = 3 } = {}) {
  const tol = Math.max(1e-4, tolerance);
  const angThresh = Math.max(0, Math.min(180, cornerThresholdDeg)) * (Math.PI / 180);

  const fitLoop = (loop) => {
    if (!Array.isArray(loop) || loop.length < 3) return loop.slice();
    const ring = (loop[0][0] === loop[loop.length - 1][0] && loop[0][1] === loop[loop.length - 1][1]) ? loop.slice(0, -1) : loop.slice();
    if (ring.length < 3) return loop.slice();

    const corners = findCorners(ring, angThresh);
    let smoothed;
    if (corners.length === 0) {
      smoothed = chaikinClosed(ring, iterations);
    } else {
      smoothed = smoothWithAnchors(ring, corners, iterations);
    }

    let closed = smoothed.slice();
    if (closed[0][0] !== closed[closed.length - 1][0] || closed[0][1] !== closed[closed.length - 1][1]) {
      closed.push([closed[0][0], closed[0][1]]);
    }
    closed = rdp(closed, tol);
    if (closed[0][0] !== closed[closed.length - 1][0] || closed[0][1] !== closed[closed.length - 1][1]) {
      closed.push([closed[0][0], closed[0][1]]);
    }
    return closed;
  };

  return loops.map((l) => fitLoop(l));
}

function findCorners(ring, angThresh) {
  const n = ring.length;
  const corners = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n];
    const b = ring[i];
    const c = ring[(i + 1) % n];
    const v1x = b[0] - a[0], v1y = b[1] - a[1];
    const v2x = c[0] - b[0], v2y = c[1] - b[1];
    const l1 = Math.hypot(v1x, v1y) || 1e-9;
    const l2 = Math.hypot(v2x, v2y) || 1e-9;
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang < angThresh) corners.push(i);
  }
  return corners;
}

function chaikinClosed(points, iterations) {
  let pts = points.slice();
  for (let k = 0; k < iterations; k++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const q = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]];
      const r = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]];
      next.push(q, r);
    }
    pts = next;
  }
  if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) {
    pts.push([pts[0][0], pts[0][1]]);
  }
  return pts;
}

function chaikinOpen(points, iterations) {
  let pts = points.slice();
  for (let k = 0; k < iterations; k++) {
    const next = [];
    next.push(pts[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const q = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]];
      const r = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]];
      next.push(q, r);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

function smoothWithAnchors(ring, corners, iterations) {
  const n = ring.length;
  const out = [];
  const anchors = corners.slice();
  anchors.sort((a, b) => a - b);
  const uniq = [];
  for (const idx of anchors) {
    if (!uniq.length || uniq[uniq.length - 1] !== idx) uniq.push(idx);
  }
  anchors.length = 0; anchors.push(...uniq);

  for (let ci = 0; ci < anchors.length; ci++) {
    const aIdx = anchors[ci];
    const bIdx = anchors[(ci + 1) % anchors.length];
    const seg = [];
    seg.push(ring[aIdx]);
    let idx = (aIdx + 1) % n;
    while (idx !== bIdx) {
      seg.push(ring[idx]);
      idx = (idx + 1) % n;
    }
    seg.push(ring[bIdx]);

    const sm = chaikinOpen(seg, iterations);
    if (ci === 0) {
      for (const p of sm) out.push(p);
    } else {
      for (let i = 1; i < sm.length; i++) out.push(sm[i]);
    }
  }
  if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) {
    out.push([out[0][0], out[0][1]]);
  }
  return out;
}

