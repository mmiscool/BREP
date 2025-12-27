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

function pointToSegmentDist2XY(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;

  const abLen2 = abx * abx + aby * aby;
  if (abLen2 === 0) return apx * apx + apy * apy;

  let t = (apx * abx + apy * aby) / abLen2;
  t = Math.max(0, Math.min(1, t));

  const cx = ax + t * abx;
  const cy = ay + t * aby;

  const dx = px - cx;
  const dy = py - cy;
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

export function assignBreaksToLoops(loops, breaks, { snapDist = Infinity } = {}) {
  const out = Array.isArray(loops) ? loops.map(() => []) : [];
  if (!Array.isArray(loops) || !Array.isArray(breaks) || !breaks.length) return out;
  const snap2 = Number.isFinite(snapDist) ? snapDist * snapDist : Infinity;

  for (const bp of breaks) {
    const px = Array.isArray(bp) ? Number(bp[0]) : NaN;
    const py = Array.isArray(bp) ? Number(bp[1]) : NaN;
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

    let bestLoop = -1;
    let bestDist2 = Infinity;

    for (let li = 0; li < loops.length; li++) {
      const loop = loops[li];
      if (!Array.isArray(loop) || loop.length < 2) continue;
      const ring = loop.length > 1
        && loop[0][0] === loop[loop.length - 1][0]
        && loop[0][1] === loop[loop.length - 1][1]
        ? loop.slice(0, -1)
        : loop;
      const n = ring.length;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const d2 = pointToSegmentDist2XY(px, py, a[0], a[1], b[0], b[1]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestLoop = li;
        }
      }
    }

    if (bestLoop >= 0 && bestDist2 <= snap2) {
      out[bestLoop].push([px, py]);
    }
  }

  return out;
}

function findCorners(ring, angThresh) {
  const n = ring.length;
  if (n < 3) return [];
  const window = Math.max(2, Math.min(8, Math.floor(n / 40) || 2));
  const straightThresh = 0.85;
  const minSpan = window * 0.75;
  const corners = [];

  const sampleDir = (startIdx, step) => {
    let sx = 0;
    let sy = 0;
    let total = 0;
    for (let k = 0; k < window; k++) {
      const i0 = (startIdx + k * step + n) % n;
      const i1 = (i0 + step + n) % n;
      const dx = ring[i1][0] - ring[i0][0];
      const dy = ring[i1][1] - ring[i0][1];
      const len = Math.hypot(dx, dy);
      if (!len) continue;
      sx += dx;
      sy += dy;
      total += len;
    }
    const mag = Math.hypot(sx, sy);
    return {
      dir: mag > 1e-9 ? [sx / mag, sy / mag] : [0, 0],
      straightness: total > 0 ? mag / total : 0,
      span: total
    };
  };

  for (let i = 0; i < n; i++) {
    const prev = sampleDir(i - window, 1);
    const next = sampleDir(i, 1);
    if (prev.span < minSpan || next.span < minSpan) continue;
    if (prev.straightness < straightThresh || next.straightness < straightThresh) continue;
    const dot = prev.dir[0] * next.dir[0] + prev.dir[1] * next.dir[1];
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang > angThresh) corners.push(i);
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

export function splitLoopIntoEdges(loop2D, {
  angleDeg = 70,
  minSegLen = 1e-6,
  cornerSpacing = 0,
  manualBreaks = [],
  suppressedBreaks = [],
  returnDebug = false,
} = {}) {
  if (!Array.isArray(loop2D) || loop2D.length < 2) return returnDebug ? { segments: [] } : [];
  let ring = loop2D.slice();
  if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
    ring.pop();
  }
  let n = ring.length;
  if (n < 2) return returnDebug ? { segments: [] } : [];

  const manualPts = Array.isArray(manualBreaks) ? manualBreaks : [];
  const manualCornerIndices = [];
  if (manualPts.length) {
    const perSeg = new Map();
    const vertexBreaks = new Set();
    const endpointEps = Math.max(minSegLen * 0.25, 1e-6);
    const closestOnRing = (pt) => {
      const px = pt[0];
      const py = pt[1];
      let best = { dist2: Infinity, segIndex: -1, t: 0, point: null };
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 <= 0) continue;
        let t = ((px - a[0]) * abx + (py - a[1]) * aby) / abLen2;
        t = Math.max(0, Math.min(1, t));
        const cx = a[0] + t * abx;
        const cy = a[1] + t * aby;
        const dx = px - cx;
        const dy = py - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < best.dist2) {
          best = { dist2: d2, segIndex: i, t, point: [cx, cy] };
        }
      }
      return best;
    };

    for (const pt of manualPts) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const px = Number(pt[0]);
      const py = Number(pt[1]);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const res = closestOnRing([px, py]);
      if (res.segIndex < 0 || !res.point) continue;
      const a = ring[res.segIndex];
      const b = ring[(res.segIndex + 1) % n];
      const da = Math.hypot(res.point[0] - a[0], res.point[1] - a[1]);
      const db = Math.hypot(res.point[0] - b[0], res.point[1] - b[1]);
      if (da <= endpointEps) {
        vertexBreaks.add(res.segIndex);
        continue;
      }
      if (db <= endpointEps) {
        vertexBreaks.add((res.segIndex + 1) % n);
        continue;
      }
      let arr = perSeg.get(res.segIndex);
      if (!arr) { arr = []; perSeg.set(res.segIndex, arr); }
      arr.push({ t: res.t, point: res.point });
    }

    if (vertexBreaks.size || perSeg.size) {
      const expanded = [];
      const markManualIndex = (idx) => {
        if (!manualCornerIndices.length || manualCornerIndices[manualCornerIndices.length - 1] !== idx) {
          manualCornerIndices.push(idx);
        }
      };
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const startIndex = expanded.length;
        expanded.push(a);
        if (vertexBreaks.has(i)) markManualIndex(startIndex);
        const inserts = perSeg.get(i);
        if (inserts && inserts.length) {
          inserts.sort((u, v) => u.t - v.t);
          for (const ins of inserts) {
            const p = ins.point;
            const last = expanded[expanded.length - 1];
            if (!last || last[0] !== p[0] || last[1] !== p[1]) {
              expanded.push(p);
              markManualIndex(expanded.length - 1);
            }
          }
        }
      }
      ring = expanded;
      n = ring.length;
    }
  }

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
  const minCornerSpacing = Math.max(spanLen * 1.5, totalLen * 0.015, minSegLen * 2, cornerSpacing || 0);

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
  if (corners.length < 2 && candidates.length) {
    corners.length = 0;
    corners.push(...candidates.sort((a, b) => a.idx - b.idx));
  }

  const suppressedIdx = new Set();
  const suppressedPts = Array.isArray(suppressedBreaks) ? suppressedBreaks : [];
  if (suppressedPts.length) {
    const snapDist = Math.max(minSegLen * 0.5, 1e-6);
    const snapDist2 = snapDist * snapDist;
    for (const pt of suppressedPts) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const px = Number(pt[0]);
      const py = Number(pt[1]);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      let bestIdx = -1;
      let bestD2 = Infinity;
      for (let i = 0; i < n; i++) {
        const p = ring[i];
        const dx = p[0] - px;
        const dy = p[1] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestD2 <= snapDist2) {
        suppressedIdx.add(bestIdx);
      }
    }
  }

  if (suppressedIdx.size) {
    for (let i = corners.length - 1; i >= 0; i--) {
      if (suppressedIdx.has(corners[i].idx)) corners.splice(i, 1);
    }
  }

  const cornerIdx = [];
  for (const c of corners) cornerIdx.push(c.idx);
  for (const idx of manualCornerIndices) cornerIdx.push(idx);
  if (cornerIdx.length < 2) {
    const loopOut = ring.concat([ring[0]]);
    return returnDebug
      ? { segments: [loopOut], corners: [], manualCorners: manualCornerIndices.slice(), ring: ring.slice() }
      : [loopOut];
  }
  cornerIdx.sort((a, b) => a - b);
  const uniq = [];
  for (const idx of cornerIdx) {
    if (!uniq.length || uniq[uniq.length - 1] !== idx) uniq.push(idx);
  }
  if (uniq.length < 2) {
    const loopOut = ring.concat([ring[0]]);
    return returnDebug
      ? { segments: [loopOut], corners: [], manualCorners: manualCornerIndices.slice(), ring: ring.slice() }
      : [loopOut];
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
  if (!segments.length) {
    const loopOut = ring.concat([ring[0]]);
    return returnDebug
      ? { segments: [loopOut], corners: [], manualCorners: manualCornerIndices.slice(), ring: ring.slice() }
      : [loopOut];
  }

  if (!returnDebug) return segments;
  const manualSet = new Set(manualCornerIndices);
  const autoCorners = uniq.filter((idx) => !manualSet.has(idx));
  return {
    segments,
    corners: autoCorners,
    manualCorners: Array.from(new Set(manualCornerIndices)).sort((a, b) => a - b),
    ring: ring.slice(),
  };
}
