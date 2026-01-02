// threadGeometry.js
// Unified thread geometry helper for multiple standards in a single ES6 class.
import { Solid } from "./BetterSolid.js";
import { CrossSection, Manifold, THREE } from "./SolidShared.js";

export const ThreadStandard = {
  ISO_METRIC: "ISO_METRIC",              // 60° V, ISO 68-1 style basic metric
  UNIFIED: "UNIFIED",                    // 60° V, UNC/UNF/UNEF style basic form
  ACME: "ACME",                          // 29° Acme, flat crest/root
  STUB_ACME: "STUB_ACME",                // 29° Stub Acme
  TRAPEZOIDAL_METRIC: "TRAPEZOIDAL_METRIC", // 30° metric trapezoidal (Tr)
  WHITWORTH: "WHITWORTH",                // 55° Whitworth, rounded crest/root
  NPT: "NPT",                            // 60° NPT tapered pipe thread
};

const DEG_TO_RAD = Math.PI / 180;
const EPS = 1e-9;

const computeInternalOverlap = (thread) => {
  const pitch = Math.abs(thread?.pitch || 0);
  const depth = Math.abs(thread?.effectiveThreadDepth || 0);
  const base = pitch > 0 ? pitch * 0.05 : 0.02;
  const cap = depth > 0 ? depth * 0.25 : base;
  const minVal = pitch > 0 ? pitch * 0.01 : 0.01;
  return Math.max(EPS * 10, Math.min(cap, base) || minVal);
};

const safeDelete = (obj) => {
  try {
    if (obj && typeof obj.delete === "function") obj.delete();
  } catch {
    /* ignore */
  }
};

const vecFrom = (v, fallback = [0, 0, 0]) => {
  if (v && typeof v.x === "number") return new THREE.Vector3(v.x, v.y, v.z);
  if (Array.isArray(v)) {
    return new THREE.Vector3(Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0);
  }
  return new THREE.Vector3(Number(fallback[0]) || 0, Number(fallback[1]) || 0, Number(fallback[2]) || 0);
};

const buildPlacementMatrix = ({ axis, axisDirection, xDirection, origin } = {}) => {
  const axisVec = vecFrom(axis || axisDirection || [0, 1, 0]);
  if (axisVec.lengthSq() < EPS) axisVec.set(0, 1, 0);
  axisVec.normalize();

  let xVec = xDirection ? vecFrom(xDirection) : new THREE.Vector3(1, 0, 0);
  xVec.addScaledVector(axisVec, -xVec.dot(axisVec));
  if (xVec.lengthSq() < EPS) {
    const fallback = Math.abs(axisVec.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    xVec.crossVectors(fallback, axisVec);
    if (xVec.lengthSq() < EPS) xVec.set(1, 0, 0);
  }
  xVec.normalize();
  const yVec = new THREE.Vector3().crossVectors(axisVec, xVec).normalize();
  const m = new THREE.Matrix4().makeBasis(xVec, yVec, axisVec);
  m.setPosition(vecFrom(origin || [0, 0, 0]));
  return m;
};

const manifoldToSolid = (manifold, name = "Thread", faceName = "THREAD", idToFaceName = null) => {
  if (!manifold) return null;
  const solid = new Solid();
  solid.name = name;

  const faceIdMap = (() => {
    if (idToFaceName instanceof Map) return new Map(idToFaceName);
    if (idToFaceName && typeof idToFaceName === "object") return new Map(Object.entries(idToFaceName));
    return new Map();
  })();

  const mesh = manifold.getMesh();
  let addedCount = 0;
  let failedCount = 0;
  try {
    const vp = mesh.vertProperties;
    const tv = mesh.triVerts;
    const triCount = Math.floor(tv.length / 3);
    const faceIDs = mesh.faceID && mesh.faceID.length === triCount ? mesh.faceID : null;

    if (faceIdMap.size === 0) {
      if (faceIDs) {
        const seen = new Set();
        for (let t = 0; t < triCount; t++) {
          const fid = faceIDs[t] >>> 0;
          if (seen.has(fid)) continue;
          seen.add(fid);
          faceIdMap.set(fid, faceName || `FACE_${fid}`);
        }
      } else {
        faceIdMap.set(0, faceName || "FACE_0");
      }
    }

    console.log('[ThreadGeometry] manifoldToSolid: converting', triCount, 'triangles to solid with', faceIdMap.size, 'face labels');
    for (let t = 0; t < triCount; t++) {
      const i0 = tv[3 * t + 0] >>> 0;
      const i1 = tv[3 * t + 1] >>> 0;
      const i2 = tv[3 * t + 2] >>> 0;
      const p0 = [vp[i0 * 3 + 0], vp[i0 * 3 + 1], vp[i0 * 3 + 2]];
      const p1 = [vp[i1 * 3 + 0], vp[i1 * 3 + 1], vp[i1 * 3 + 2]];
      const p2 = [vp[i2 * 3 + 0], vp[i2 * 3 + 1], vp[i2 * 3 + 2]];

      const fid = faceIDs ? (faceIDs[t] >>> 0) : 0;
      let triFaceName = faceIdMap.get(fid);
      if (!triFaceName) {
        const fallbackName = faceIdMap.size === 0 ? (faceName || `FACE_${fid}`) : `FACE_${fid}`;
        triFaceName = fallbackName;
        faceIdMap.set(fid, triFaceName);
      }

      try {
        solid.addTriangle(triFaceName, p0, p1, p2);
        addedCount++;
      } catch (err) {
        failedCount++;
        if (failedCount <= 3) {
          console.warn('[ThreadGeometry] Failed to add triangle', t, ':', err.message, { p0, p1, p2, face: triFaceName });
        }
      }
    }
    console.log('[ThreadGeometry] manifoldToSolid: added', addedCount, 'triangles, failed', failedCount);
    console.log('[ThreadGeometry] manifoldToSolid: solid internals:', {
      triVertsLength: solid._triVerts?.length,
      triIDsLength: solid._triIDs?.length,
      vertPropertiesLength: solid._vertProperties?.length,
      faceCount: solid._faceNameToID?.size,
    });
    // Force manifoldization to catch any issues early
    try {
      solid._manifoldize();
      console.log('[ThreadGeometry] manifoldToSolid: manifoldization successful');
    } catch (err) {
      console.warn('[ThreadGeometry] manifoldToSolid: manifoldization failed:', err);
    }
  } finally {
    safeDelete(mesh);
    safeDelete(manifold);
  }
  return solid;
};

const buildThreadProfilePolygon = (thread, radialOffset = 0) => {
  const external = thread.isExternal === true;
  let crestR = Math.max(EPS, (thread.crestRadius || 0) + radialOffset);
  let rootR = Math.max(EPS, (thread.rootRadius || 0) + radialOffset);
  const minGap = Math.max(Math.abs(thread.effectiveThreadDepth || EPS * 10), EPS * 10);
  if (external) {
    if (crestR <= rootR + EPS * 10) crestR = rootR + minGap;
  } else {
    if (rootR <= crestR + EPS * 10) rootR = crestR + minGap;
  }
  
  // CrossSection.extrude with twist creates a helix by:
  // 1. Taking a 2D profile in the XY plane
  // 2. Extruding it along Z while rotating it
  // The profile should be positioned at the thread radius and shaped like the tooth cross-section
  
  const pitch = thread.pitch || 1;
  const halfPitch = pitch / 2;
  
  let crestRad = crestR;
  if (!external) {
    const overlap = computeInternalOverlap(thread);
    const targetCrest = crestR - overlap;
    crestRad = Math.max(EPS, Math.min(targetCrest, rootR - EPS));
    console.log('[ThreadGeometry] Applying internal overlap:', { overlap, crestR, crestRad, rootR });
  }

  console.log('[ThreadGeometry] Profile polygon params:', {
    external,
    crestR,
    crestRad,
    rootR,
    pitch,
    halfPitch,
    effectiveThreadDepth: thread.effectiveThreadDepth,
  });
  
  // Create a trapezoidal profile representing the thread tooth cross-section
  // Profile format: [axial_position, radius]
  // This represents the shape as seen from the side (radial cross-section)
  // The procedural helix generator will sweep this profile around the cylinder
  
  // Trapezoidal profile: two parallel edges at crestRad and rootR (parallel to cylinder axis)
  // connected by sloped flanks
  const pts = [
    [-halfPitch, crestRad],         // Bottom: inner surface
    [-halfPitch * 0.3, rootR],      // Bottom flank to outer surface
    [halfPitch * 0.3, rootR],       // Top flank at outer surface  
    [halfPitch, crestRad],          // Top: inner surface
  ];
  
  console.log('[ThreadGeometry] Profile polygon points [axial, radius]:', pts);
  return pts; // Return as-is, no need for CCW check in this format
};

const applyPlacement = (solid, opts = {}) => {
  if (!solid) return solid;
  const { transform } = opts;
  if (transform && typeof transform.isMatrix4 === "boolean" && transform.isMatrix4) {
    solid.bakeTransform(transform);
    return solid;
  }
  if (transform && (transform.position || transform.rotationEuler || transform.scale || transform.t || transform.rDeg)) {
    solid.bakeTRS({
      t: transform.position || transform.t,
      rDeg: transform.rotationEuler || transform.rDeg,
      s: transform.scale || transform.s,
    });
    return solid;
  }
  const placement = buildPlacementMatrix({
    axis: opts.axis || opts.axisDirection,
    xDirection: opts.xDirection,
    origin: opts.origin,
  });
  solid.bakeTransform(placement);
  return solid;
};

/**
 * ThreadGeometry:
 *  - Handles multiple basic thread standards.
 *  - Provides diameters, radii, fundamental heights, helix angles, and simple parametric helpers.
 *
 * All results are "basic profile" only – no tolerances/allowances.
 * Units: whatever you pass in (mm for metric, inches for inch threads).
 */
export class ThreadGeometry {
  constructor(options) {
    const {
      standard = ThreadStandard.ISO_METRIC,
      nominalDiameter,         // diameter at reference plane (major for external)
      pitch,                   // thread pitch P
      tpi,                     // alternative for inch systems: threads per inch
      isExternal = true,
      starts = 1,
      // For NPT taper direction: +1 grows diameter with +z, -1 shrinks
      taperDirection = 1,
    } = options || {};

    if (!nominalDiameter || nominalDiameter <= 0) {
      throw new Error("nominalDiameter must be a positive number.");
    }

    let P = pitch;
    if (!P) {
      if ((standard === ThreadStandard.UNIFIED || standard === ThreadStandard.ACME ||
           standard === ThreadStandard.STUB_ACME || standard === ThreadStandard.NPT) &&
          tpi && tpi > 0) {
        P = 1 / tpi;
      } else {
        throw new Error("You must provide pitch (and/or tpi for inch-based standards).");
      }
    }
    if (P <= 0) {
      throw new Error("pitch (or 1/tpi) must be a positive number.");
    }

    this.standard = standard;
    this.nominalDiameter = nominalDiameter;
    this.pitch = P;
    this.isExternal = isExternal;
    this.starts = starts || 1;
    this.taperDirection = taperDirection >= 0 ? 1 : -1;

    // Derived / standard-specific profile params
    const profile = this._computeStandardProfile(standard, P);

    // Fundamental profile params
    this.flankAngleDeg = profile.flankAngleDeg;
    this.flankAngleRad = profile.flankAngleRad;
    this.halfAngleRad = profile.halfAngleRad;
    this.fundamentalTriangleHeight = profile.H;
    this.effectiveThreadDepth = profile.threadDepth;
    this.crestTruncation = profile.crestTruncation;
    this.rootTruncation = profile.rootTruncation;
    this.roundingRadius = profile.roundingRadius;
    this.roundingHeight = profile.roundingHeight;
    this.isTapered = profile.isTapered;
    this.taperPerLengthOnDiameter = profile.taperPerLengthOnDiameter; // e.g. 1/16 for NPT
    this.taperHalfAngle = profile.taperHalfAngle;

    // Units hint
    this.units = (standard === ThreadStandard.ISO_METRIC ||
                  standard === ThreadStandard.TRAPEZOIDAL_METRIC)
      ? "mm"
      : "inch";

    // Thread thickness at pitch
    // (for symmetric threads this is still P/2 at the pitch line)
    this.threadThicknessAtPitch = P / 2;

    // Lead & helix angles (base / reference at nominal diameters)
    this.lead = P * this.starts;

    // For non-tapered: major diameter is just nominal
    // For tapered: treat nominalDiameter as major diameter at z = 0 "gauge" plane
    this.majorDiameter = nominalDiameter;

    // Basic diameters at reference plane
    const threadDepth = this.effectiveThreadDepth;

    if (!profile.usesCustomDiameterFormulas) {
      // Symmetric profiles: minor = major - 2*depth, pitch = (major+minor)/2
      this.minorDiameter = this.majorDiameter - 2 * threadDepth;
      this.pitchDiameter = (this.majorDiameter + this.minorDiameter) / 2;
    } else {
      // Whitworth uses pre-derived depth; we still use the same relation
      // unless a different form is needed (here we keep it simple).
      this.minorDiameter = this.majorDiameter - 2 * threadDepth;
      this.pitchDiameter = (this.majorDiameter + this.minorDiameter) / 2;
    }

    // Radii at reference plane
    this.majorRadius = this.majorDiameter / 2;
    this.minorRadius = this.minorDiameter / 2;
    this.pitchRadius = this.pitchDiameter / 2;

    // Crest/root interpretation for internal vs external
    this.crestDiameter = isExternal ? this.majorDiameter : this.minorDiameter;
    this.rootDiameter = isExternal ? this.minorDiameter : this.majorDiameter;
    this.crestRadius = this.crestDiameter / 2;
    this.rootRadius = this.rootDiameter / 2;

    // Helix angles at reference plane
    this.helixAngleAtPitchDiameter = Math.atan(this.lead / (Math.PI * this.pitchDiameter));
    this.helixAngleAtMajorDiameter = Math.atan(this.lead / (Math.PI * this.majorDiameter));
    this.helixAngleAtMinorDiameter = Math.atan(this.lead / (Math.PI * this.minorDiameter));

    // Radial offsets useful for building 2D profiles around pitch line (cylindrical assumption)
    this.profile = {
      flankAngleRad: this.flankAngleRad,
      halfAngleRad: this.halfAngleRad,
      radialOffsetPitchToCrest: this.crestRadius - this.pitchRadius,
      radialOffsetPitchToRoot: this.rootRadius - this.pitchRadius,
      roundingRadius: this.roundingRadius,
      roundingHeight: this.roundingHeight,
    };
  }

  /**
   * Standard-specific basic profile data.
   * Returns: {
   *   flankAngleDeg, flankAngleRad, halfAngleRad,
   *   H, threadDepth,
   *   crestTruncation, rootTruncation,
   *   roundingRadius, roundingHeight,
   *   isTapered, taperPerLengthOnDiameter, taperHalfAngle,
   *   usesCustomDiameterFormulas
   * }
   */
  _computeStandardProfile(standard, P) {
    switch (standard) {
      case ThreadStandard.ISO_METRIC:
      case ThreadStandard.UNIFIED: {
        // 60° V-thread, ISO/UTS basic form with truncation:
        // H_sharp = P / (2 * tan(30°))
        const halfAngleRad = 30 * DEG_TO_RAD;
        const flankAngleDeg = 60;
        const flankAngleRad = flankAngleDeg * DEG_TO_RAD;
        const H = (P / 2) / Math.tan(halfAngleRad); // fundamental sharp V height
        const threadDepth = (5 / 8) * H;            // radial depth
        const crestTruncation = H / 8;
        const rootTruncation = H / 4;

        return {
          flankAngleDeg,
          flankAngleRad,
          halfAngleRad,
          H,
          threadDepth,
          crestTruncation,
          rootTruncation,
          roundingRadius: 0,
          roundingHeight: 0,
          isTapered: false,
          taperPerLengthOnDiameter: 0,
          taperHalfAngle: 0,
          usesCustomDiameterFormulas: false,
        };
      }

      case ThreadStandard.ACME: {
        // 29° Acme thread:
        // basic height ≈ 0.5 * P, flat crest/root.
        const flankAngleDeg = 29;
        const flankAngleRad = flankAngleDeg * DEG_TO_RAD;
        const halfAngleRad = flankAngleRad / 2;
        const H = 0.5 * P;           // basic thread height
        const threadDepth = H;       // crest to root (radial)

        return {
          flankAngleDeg,
          flankAngleRad,
          halfAngleRad,
          H,
          threadDepth,
          crestTruncation: 0,        // flats, not sharp-V truncation
          rootTruncation: 0,
          roundingRadius: 0,
          roundingHeight: 0,
          isTapered: false,
          taperPerLengthOnDiameter: 0,
          taperHalfAngle: 0,
          usesCustomDiameterFormulas: false,
        };
      }

      case ThreadStandard.STUB_ACME: {
        // Stub Acme: same 29° angle, reduced height.
        // Common basic height ≈ 0.3 * P (simplified).
        const flankAngleDeg = 29;
        const flankAngleRad = flankAngleDeg * DEG_TO_RAD;
        const halfAngleRad = flankAngleRad / 2;
        const H = 0.3 * P;
        const threadDepth = H;

        return {
          flankAngleDeg,
          flankAngleRad,
          halfAngleRad,
          H,
          threadDepth,
          crestTruncation: 0,
          rootTruncation: 0,
          roundingRadius: 0,
          roundingHeight: 0,
          isTapered: false,
          taperPerLengthOnDiameter: 0,
          taperHalfAngle: 0,
          usesCustomDiameterFormulas: false,
        };
      }

      case ThreadStandard.TRAPEZOIDAL_METRIC: {
        // Metric trapezoidal (Tr), 30° included angle.
        // Basic height often treated ~0.5 * P, similar to Acme but 30°.
        const flankAngleDeg = 30;
        const flankAngleRad = flankAngleDeg * DEG_TO_RAD;
        const halfAngleRad = flankAngleRad / 2;
        const H = 0.5 * P;
        const threadDepth = H;

        return {
          flankAngleDeg,
          flankAngleRad,
          halfAngleRad,
          H,
          threadDepth,
          crestTruncation: 0,
          rootTruncation: 0,
          roundingRadius: 0,
          roundingHeight: 0,
          isTapered: false,
          taperPerLengthOnDiameter: 0,
          taperHalfAngle: 0,
          usesCustomDiameterFormulas: false,
        };
      }

      case ThreadStandard.WHITWORTH: {
        // Whitworth:
        // included angle = 55°
        // fundamental triangle height H ≈ 0.96049106 * P
        // actual depth h ≈ 0.64032738 * P
        // crest/root rounding radius r ≈ 0.13732908 * P
        // rounding height e ≈ 0.073917569 * P
        const flankAngleDeg = 55;
        const flankAngleRad = flankAngleDeg * DEG_TO_RAD;
        const halfAngleRad = flankAngleRad / 2;

        const H = 0.96049106 * P;
        const threadDepth = 0.64032738 * P;
        const roundingRadius = 0.13732908 * P;
        const roundingHeight = 0.073917569 * P;

        return {
          flankAngleDeg,
          flankAngleRad,
          halfAngleRad,
          H,
          threadDepth,
          crestTruncation: 0,
          rootTruncation: 0,
          roundingRadius,
          roundingHeight,
          isTapered: false,
          taperPerLengthOnDiameter: 0,
          taperHalfAngle: 0,
          usesCustomDiameterFormulas: true,
        };
      }

      case ThreadStandard.NPT: {
        // NPT:
        // 60° profile, 1 in 16 taper on DIAMETER.
        // We reuse the 60° V basic form, but mark it as tapered.
        const halfAngleRad = 30 * DEG_TO_RAD;
        const flankAngleDeg = 60;
        const flankAngleRad = flankAngleDeg * DEG_TO_RAD;
        const H = (P / 2) / Math.tan(halfAngleRad);
        const threadDepth = (5 / 8) * H; // reuse V-thread truncation

        const taperPerLengthOnDiameter = 1 / 16;
        const taperHalfAngle = Math.atan((taperPerLengthOnDiameter / 2));

        return {
          flankAngleDeg,
          flankAngleRad,
          halfAngleRad,
          H,
          threadDepth,
          crestTruncation: H / 8,
          rootTruncation: H / 4,
          roundingRadius: 0,
          roundingHeight: 0,
          isTapered: true,
          taperPerLengthOnDiameter,
          taperHalfAngle,
          usesCustomDiameterFormulas: false,
        };
      }

      default:
        throw new Error(`Unsupported thread standard: ${standard}`);
    }
  }

  /**
   * Parametric helix at pitch radius, assuming a cylindrical base.
   * For tapered threads, use diametersAtZ() and sweep along a conical surface.
   *
   * x(t) = r * cos(t)
   * y(t) = r * sin(t)
   * z(t) = (lead / (2π)) * t
   */
  helixAtPitchRadius(t) {
    return {
      x: this.pitchRadius * Math.cos(t),
      y: this.pitchRadius * Math.sin(t),
      z: (this.lead / (2 * Math.PI)) * t,
    };
  }

  /**
   * Build a BREP.Solid representing this thread.
   * @param {object} [options]
   * @param {number} options.length Overall thread length (along local +Z before placement)
   * @param {'symbolic'|'modeled'} [options.mode='symbolic'] Choose simplified cylinder/cone or detailed helical form
   * @param {boolean} [options.modeled] Shortcut for mode='modeled'
   * @param {number} [options.radialOffset=0] Radial offset/clearance applied to crest/root
   * @param {number} [options.resolution=64] Circular resolution for symbolic/core geometry
   * @param {number} [options.segmentsPerTurn=12] Vertical divisions per revolution for modeled threads
   * @param {boolean} [options.includeCore=true] Include the core cylinder/cone (set false to emit ridges only)
   * @param {'crest'|'root'|'pitch'} [options.symbolicRadius='crest'] Which diameter to use for symbolic threads
   * @param {string} [options.name='Thread'] Solid name
   * @param {string} [options.faceName='THREAD'] Face label
   * @param {THREE.Matrix4|object} [options.transform] Optional transform or {position,rotationEuler,scale}
   * @param {THREE.Vector3|number[]} [options.axis=[0,1,0]] Target axis direction (placement)
   * @param {THREE.Vector3|number[]} [options.xDirection=[1,0,0]] Tangential reference direction
   * @param {THREE.Vector3|number[]} [options.origin=[0,0,0]] Placement origin
   */
  toSolid(options = {}) {
    const length = Number(options.length ?? options.height ?? options.threadLength ?? 0);
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error("ThreadGeometry.toSolid requires a positive length.");
    }
    const modeRaw = String(options.mode || "").toLowerCase();
    const modeled = options.modeled === true || modeRaw === "modeled" || modeRaw === "helical" || modeRaw === "detailed";
    const solid = modeled ? this._buildModeledSolid(length, options) : this._buildSymbolicSolid(length, options);
    const faceName = options.faceName || "THREAD";
    const baseMetadata = {
      thread: {
        standard: this.standard,
        nominalDiameter: this.nominalDiameter,
        pitch: this.pitch,
        isExternal: this.isExternal,
        starts: this.starts,
        isTapered: this.isTapered,
        modeled,
        length,
      },
    };

    const applyThreadMetadata = (target, extra = {}) => {
      try {
        solid.setFaceMetadata(target, { ...baseMetadata, ...extra });
      } catch {
        /* best-effort */
      }
    };

    try {
      applyThreadMetadata(faceName);

      const segments = Array.isArray(solid.threadFaceNames?.segments) ? solid.threadFaceNames.segments : [];
      const caps = solid.threadFaceNames?.caps || null;

      for (const seg of segments) {
        if (!seg?.name) continue;
        applyThreadMetadata(seg.name, {
          threadFaceRole: seg.role || "edge",
          profileEdgeIndex: seg.edgeIndex ?? null,
        });
      }

      if (caps?.start?.name) {
        applyThreadMetadata(caps.start.name, {
          threadFaceRole: caps.start.role || "start_cap",
        });
      }
      if (caps?.end?.name) {
        applyThreadMetadata(caps.end.name, {
          threadFaceRole: caps.end.role || "end_cap",
        });
      }
    } catch {
      /* metadata best-effort */
    }
    return solid;
  }

  _buildSymbolicSolid(length, options = {}) {
    const name = options.name || "Thread";
    const faceName = options.faceName || "THREAD";
    const radialOffset = Number(options.radialOffset ?? options.clearance ?? 0);
    const res = Math.max(8, Math.floor(Number(options.resolution) || 64));
    const radiusMode = String(options.symbolicRadius || options.symbolicMode || "crest").toLowerCase();

    const diamAt = (z) => this.diametersAtZ(z);
    const d0 = diamAt(0);
    const d1 = diamAt(length);

    // For symbolic internal threads, drill to minor diameter and show dashed major diameter rings
    const pickRadius = (diam) => {
      switch (radiusMode) {
        case "root":
          return (this.isExternal ? diam.minor : diam.major) * 0.5;
        case "pitch":
          return diam.pitch * 0.5;
        case "crest":
        default:
          return (this.isExternal ? diam.major : diam.minor) * 0.5;
      }
    };

    // Hole radius: use minor diameter for internal threads regardless of symbolicRadius
    const holeRadius = (diam) => {
      if (!this.isExternal) return (diam.minor || 0) * 0.5;
      return pickRadius(diam);
    };

    let r0 = Math.max(EPS, holeRadius(d0) + radialOffset);
    let r1 = Math.max(EPS, holeRadius(d1) + radialOffset);
    if (!this.isExternal) {
      const overlap = computeInternalOverlap(this);
      r0 = Math.max(EPS, r0 - overlap);
      r1 = Math.max(EPS, r1 - overlap);
      console.log('[ThreadGeometry] Applying internal overlap to symbolic thread:', { overlap, r0, r1, radialOffset });
    }
    const manifold = Manifold.cylinder(length, r0, r1, res, false);
    const solid = manifoldToSolid(manifold, name, faceName);

    // Add centerline through the symbolic thread (matches minor diameter cylinder axis)
    solid.addAuxEdge(`${faceName}:CENTERLINE`, [
      [0, 0, 0],
      [0, 0, length],
    ], { materialKey: 'OVERLAY' });

    if (!this.isExternal) {
      // Rings are attached to the same z planes as the minor cylinder (start/end)
      const majorR0 = Math.max(EPS, d0.major * 0.5 + radialOffset);
      const majorR1 = Math.max(EPS, d1.major * 0.5 + radialOffset);
      const edgeRes = Math.max(24, res);
      const makeCircle = (r, z) => {
        const pts = [];
        for (let i = 0; i <= edgeRes; i++) {
          const a = (i / edgeRes) * Math.PI * 2;
          pts.push([r * Math.cos(a), r * Math.sin(a), z]);
        }
        return pts;
      };
      // Use the exact start/end planes of the minor-diameter cylinder: z=0 and z=length
      solid.addAuxEdge(`${faceName}:MAJOR_RING_START`, makeCircle(majorR0, 0), { closedLoop: true, materialKey: 'THREAD_SYMBOLIC_MAJOR' });
      solid.addAuxEdge(`${faceName}:MAJOR_RING_END`, makeCircle(majorR1, length), { closedLoop: true, materialKey: 'THREAD_SYMBOLIC_MAJOR' });
    }

    applyPlacement(solid, options);
    return solid;
  }

  _buildModeledSolid(length, options = {}) {
    const name = options.name || "Thread";
    const faceName = options.faceName || "THREAD";
    const radialOffset = Number(options.radialOffset ?? options.clearance ?? 0);
    const includeCore = options.includeCore !== false;
    const res = Math.max(8, Math.floor(Number(options.resolution) || 64));
    const segmentsPerTurn = Math.max(4, Math.floor(Number(options.segmentsPerTurn ?? options.divisionsPerTurn ?? 12)));
    const turns = Math.max(EPS, length / Math.max(this.lead, EPS));
    const nDiv = Math.max(1, Math.round(turns * segmentsPerTurn));

    console.log('[ThreadGeometry] Building modeled solid procedurally with triangles:', {
      length,
      turns,
      nDiv,
      segmentsPerTurn,
      lead: this.lead,
      pitch: this.pitch,
      isExternal: this.isExternal,
      majorDiameter: this.majorDiameter,
      minorDiameter: this.minorDiameter,
      effectiveThreadDepth: this.effectiveThreadDepth,
    });

    // Get the 2D profile polygon (trapezoidal cross-section of thread tooth)
    const profilePts = buildThreadProfilePolygon(this, radialOffset);
    console.log('[ThreadGeometry] Thread profile (side view):', profilePts);
    console.log('[ThreadGeometry] Profile point 0:', profilePts[0]);
    
    // Build thread geometry procedurally by sweeping profile along helix
    const threadSolid = new Solid({ name, faceName });
    
    // Profile has points in [axial_offset, radius] format
    // We'll sweep this profile around the cylinder axis along a helical path
    const numProfilePts = profilePts.length;

    // Give each profile edge its own face label so swept surfaces stay distinct
    const segmentDescriptors = numProfilePts === 4
      ? [
          { name: `${faceName}:FLANK_A`, role: "flank", edgeIndex: 0 },
          { name: `${faceName}:ROOT`, role: "root", edgeIndex: 1 },
          { name: `${faceName}:FLANK_B`, role: "flank", edgeIndex: 2 },
          { name: `${faceName}:CREST`, role: "crest", edgeIndex: 3 },
        ]
      : profilePts.map((_, idx) => ({
          name: `${faceName}:EDGE_${idx}`,
          role: "edge",
          edgeIndex: idx,
        }));

    const capDescriptors = {
      start: { name: `${faceName}:CAP_START`, role: "start_cap" },
      end: { name: `${faceName}:CAP_END`, role: "end_cap" },
    };
    
    // Store profile vertices at each step for end capping
    const profileRings = [];
    
    for (let i = 0; i <= nDiv; i++) { // Note: <= to include final position
      const t = i / nDiv;
      const angle = t * 360 * turns; // degrees
      const z = t * length;
      const rad = angle * Math.PI / 180;
      
      // Transform all profile points to 3D at this angle
      const ring = [];
      for (let j = 0; j < numProfilePts; j++) {
        const [axial, r] = profilePts[j];
        ring.push([
          r * Math.cos(rad),
          r * Math.sin(rad),
          z + axial
        ]);
      }
      profileRings.push(ring);
      
      // Create quads between this ring and previous ring
      if (i > 0) {
        const prevRing = profileRings[i - 1];
        const currRing = profileRings[i];
        
        for (let j = 0; j < numProfilePts; j++) {
          const j_next = (j + 1) % numProfilePts;
          
          const p0 = prevRing[j];
          const p1 = prevRing[j_next];
          const p2 = currRing[j];
          const p3 = currRing[j_next];
          const quadFaceName = segmentDescriptors[j]?.name || `${faceName}:EDGE_${j}`;
          
          // Create two triangles for this quad (CCW winding)
          threadSolid.addTriangle(quadFaceName, p0, p1, p2);
          threadSolid.addTriangle(quadFaceName, p1, p3, p2);
        }
      }
    }
    
    // Add end caps to close the geometry
    // The profile is a quadrilateral, so we need to triangulate it properly
    // Start cap (at i=0) - fan triangulation from first vertex
    const startRing = profileRings[0];
    for (let j = 1; j < numProfilePts - 1; j++) {
      threadSolid.addTriangle(capDescriptors.start.name, startRing[0], startRing[j + 1], startRing[j]);
    }
    
    // End cap (at i=nDiv) - fan triangulation from first vertex (opposite winding)
    const endRing = profileRings[nDiv];
    for (let j = 1; j < numProfilePts - 1; j++) {
      threadSolid.addTriangle(capDescriptors.end.name, endRing[0], endRing[j], endRing[j + 1]);
    }
    
    const numTriangles = threadSolid._triVerts ? threadSolid._triVerts.length / 3 : 0;
    console.log('[ThreadGeometry] Generated', numTriangles, 'triangles procedurally (including end caps)');
    
    const faceIdToName = new Map(threadSolid._idToFaceName);
    const threadFaceNames = { segments: segmentDescriptors, caps: capDescriptors };

    let manifold = threadSolid._manifoldize();
    if (!manifold) {
      console.error('[ThreadGeometry] Failed to manifoldize procedurally generated thread');
      return threadSolid;
    }

    if (this.isTapered && Math.abs(this.taperPerLengthOnDiameter) > EPS) {
      const radialDeltaPerLen = 0.5 * this.taperPerLengthOnDiameter * this.taperDirection;
      const warped = manifold.warp((vert) => {
        const z = vert[2];
        const deltaR = radialDeltaPerLen * z;
        const r = Math.hypot(vert[0], vert[1]);
        if (r > EPS) {
          const s = (r + deltaR) / r;
          vert[0] *= s;
          vert[1] *= s;
        }
      });
      safeDelete(manifold);
      manifold = warped;
    }

    if (this.starts && this.starts > 1) {
      const base = manifold;
      let combined = base;
      for (let k = 1; k < this.starts; k++) {
        const angle = (360 * k) / this.starts;
        const rotated = base.rotate(0, 0, angle);
        const next = combined.add(rotated);
        safeDelete(rotated);
        if (combined !== base) safeDelete(combined);
        combined = next;
      }
      if (combined !== base) safeDelete(base);
      manifold = combined;
    }

    if (includeCore) {
      const d0 = this.diametersAtZ(0);
      const d1 = this.diametersAtZ(length);
      // For internal threads, the core needs to be slightly smaller than crest radius
      // to avoid overlapping geometry. Use 95% of the minor diameter.
      const coreR0 = Math.max(
        EPS,
        (d0.minor * 0.5 + radialOffset) * 0.95,
      );
      const coreR1 = Math.max(
        EPS,
        (d1.minor * 0.5 + radialOffset) * 0.95,
      );
      console.log('[ThreadGeometry] Adding core cylinder:', {
        isExternal: this.isExternal,
        coreR0,
        coreR1,
        minorDiameter0: d0.minor,
        majorDiameter0: d0.major,
        crestRadius: this.crestRadius,
      });
      try {
        const core = Manifold.cylinder(length, coreR0, coreR1, res, false);
        const merged = manifold.add(core);
        safeDelete(core);
        safeDelete(manifold);
        manifold = merged;
        console.log('[ThreadGeometry] Core added successfully');
      } catch (err) {
        console.warn('[ThreadGeometry] Failed to add core, continuing with thread ridges only:', err.message);
        // Continue with just the thread ridges if core addition fails
      }
    }

    const solid = manifoldToSolid(manifold, name, faceName, faceIdToName);
    applyPlacement(solid, options);
    solid.threadFaceNames = threadFaceNames;
    return solid;
  }

  /**
   * For tapered threads (e.g. NPT), get diameters at axial position z.
   * z > 0 moves in +taperDirection along axis.
   */
  diametersAtZ(z) {
    if (!this.isTapered || z === 0) {
      return {
        major: this.majorDiameter,
        pitch: this.pitchDiameter,
        minor: this.minorDiameter,
      };
    }
    const deltaD = this.taperPerLengthOnDiameter * z * this.taperDirection;
    return {
      major: this.majorDiameter + deltaD,
      pitch: this.pitchDiameter + deltaD,
      minor: this.minorDiameter + deltaD,
    };
  }

  /**
   * ISO Metric: from designation "M10x1.5"
   */
  static fromMetricDesignation(designation, opts = {}) {
    if (typeof designation !== "string") {
      throw new Error("designation must be a string like 'M10x1.5'.");
    }

    const match = designation
      .trim()
      .toUpperCase()
      .match(/^M(\d+(?:\.\d+)?)[X×](\d+(?:\.\d+)?)$/);

    if (!match) {
      throw new Error("Invalid metric designation. Expected format like 'M10x1.5'.");
    }

    const nominalDiameter = parseFloat(match[1]);
    const pitch = parseFloat(match[2]);

    return new ThreadGeometry({
      standard: ThreadStandard.ISO_METRIC,
      nominalDiameter,
      pitch,
      ...opts,
    });
  }

  /**
   * Metric trapezoidal: from designation "Tr60x9" (single start only).
   */
  static fromTrapezoidalDesignation(designation, opts = {}) {
    if (typeof designation !== "string") {
      throw new Error("designation must be a string like 'Tr60x9'.");
    }

    const match = designation
      .trim()
      .toUpperCase()
      .match(/^TR(\d+(?:\.\d+)?)[X×](\d+(?:\.\d+)?)$/);

    if (!match) {
      throw new Error("Invalid trapezoidal designation. Expected format like 'Tr60x9'.");
    }

    const nominalDiameter = parseFloat(match[1]);
    const pitch = parseFloat(match[2]);

    return new ThreadGeometry({
      standard: ThreadStandard.TRAPEZOIDAL_METRIC,
      nominalDiameter,
      pitch,
      ...opts,
    });
  }

  /**
   * Unified (UNC/UNF/UNEF) – inch, from diameter and TPI.
   */
  static fromUnified(nominalDiameterInch, tpi, opts = {}) {
    if (!nominalDiameterInch || nominalDiameterInch <= 0) {
      throw new Error("nominalDiameterInch must be a positive number.");
    }
    if (!tpi || tpi <= 0) {
      throw new Error("tpi must be a positive number.");
    }

    return new ThreadGeometry({
      standard: ThreadStandard.UNIFIED,
      nominalDiameter: nominalDiameterInch,
      tpi,
      ...opts,
    });
  }

  /**
   * General Acme: inch, from diameter and TPI.
   */
  static fromAcme(nominalDiameterInch, tpi, opts = {}) {
    if (!nominalDiameterInch || nominalDiameterInch <= 0) {
      throw new Error("nominalDiameterInch must be a positive number.");
    }
    if (!tpi || tpi <= 0) {
      throw new Error("tpi must be a positive number.");
    }

    return new ThreadGeometry({
      standard: ThreadStandard.ACME,
      nominalDiameter: nominalDiameterInch,
      tpi,
      ...opts,
    });
  }

  /**
   * Stub Acme: inch, from diameter and TPI.
   */
  static fromStubAcme(nominalDiameterInch, tpi, opts = {}) {
    if (!nominalDiameterInch || nominalDiameterInch <= 0) {
      throw new Error("nominalDiameterInch must be a positive number.");
    }
    if (!tpi || tpi <= 0) {
      throw new Error("tpi must be a positive number.");
    }

    return new ThreadGeometry({
      standard: ThreadStandard.STUB_ACME,
      nominalDiameter: nominalDiameterInch,
      tpi,
      ...opts,
    });
  }

  /**
   * Whitworth: inch, from diameter and pitch (or TPI via 1/tpi).
   */
  static fromWhitworth(nominalDiameterInch, pitchOrTpi, opts = {}) {
    if (!nominalDiameterInch || nominalDiameterInch <= 0) {
      throw new Error("nominalDiameterInch must be a positive number.");
    }
    if (!pitchOrTpi || pitchOrTpi <= 0) {
      throw new Error("pitchOrTpi must be a positive number.");
    }

    let pitch = pitchOrTpi;
    if (pitchOrTpi < 1) {
      // assume given as pitch already
      pitch = pitchOrTpi;
    } else {
      // if user gives TPI, treat as TPI
      pitch = 1 / pitchOrTpi;
    }

    return new ThreadGeometry({
      standard: ThreadStandard.WHITWORTH,
      nominalDiameter: nominalDiameterInch,
      pitch,
      ...opts,
    });
  }

  /**
   * NPT: inch, approximate basic geometry from a reference diameter + TPI.
   * nominalDiameterInch here should be the major diameter at z = 0 plane
   * that you want to treat as your modeling reference.
   */
  static fromNPT(nominalDiameterInch, tpi, opts = {}) {
    if (!nominalDiameterInch || nominalDiameterInch <= 0) {
      throw new Error("nominalDiameterInch must be a positive number.");
    }
    if (!tpi || tpi <= 0) {
      throw new Error("tpi must be a positive number.");
    }

    return new ThreadGeometry({
      standard: ThreadStandard.NPT,
      nominalDiameter: nominalDiameterInch,
      tpi,
      ...opts,
    });
  }

  /**
   * Plain JSON snapshot of all geometric data.
   */
  toObject() {
    return {
      standard: this.standard,
      nominalDiameter: this.nominalDiameter,
      pitch: this.pitch,
      isExternal: this.isExternal,
      starts: this.starts,
      units: this.units,

      flankAngleDeg: this.flankAngleDeg,
      flankAngleRad: this.flankAngleRad,
      halfAngleRad: this.halfAngleRad,

      fundamentalTriangleHeight: this.fundamentalTriangleHeight,
      effectiveThreadDepth: this.effectiveThreadDepth,
      crestTruncation: this.crestTruncation,
      rootTruncation: this.rootTruncation,
      roundingRadius: this.roundingRadius,
      roundingHeight: this.roundingHeight,

      majorDiameter: this.majorDiameter,
      pitchDiameter: this.pitchDiameter,
      minorDiameter: this.minorDiameter,

      majorRadius: this.majorRadius,
      pitchRadius: this.pitchRadius,
      minorRadius: this.minorRadius,

      crestDiameter: this.crestDiameter,
      rootDiameter: this.rootDiameter,
      crestRadius: this.crestRadius,
      rootRadius: this.rootRadius,

      lead: this.lead,
      helixAngleAtPitchDiameter: this.helixAngleAtPitchDiameter,
      helixAngleAtMajorDiameter: this.helixAngleAtMajorDiameter,
      helixAngleAtMinorDiameter: this.helixAngleAtMinorDiameter,

      isTapered: this.isTapered,
      taperPerLengthOnDiameter: this.taperPerLengthOnDiameter,
      taperHalfAngle: this.taperHalfAngle,
      taperDirection: this.taperDirection,

      profile: { ...this.profile },
    };
  }
}
