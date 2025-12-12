import { BREP } from "../../BREP/BREP.js";
import { LineGeometry } from "three/examples/jsm/Addons.js";

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the helix feature",
  },
  placementMode: {
    type: "options",
    options: ["transform", "axis"],
    default_value: "transform",
    label: "Placement",
    hint: "Use transform or align to an existing axis and start point",
  },
  transform: {
    type: "transform",
    default_value: {
      position: [0, 0, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    },
    hint: "Position, rotation, and scale to place the helix",
  },
  axis: {
    type: "reference_selection",
    selectionFilter: ["EDGE"],
    multiple: false,
    default_value: null,
    label: "Axis",
    hint: "Select an edge to use as the helix axis",
  },
  startPoint: {
    type: "reference_selection",
    selectionFilter: ["VERTEX"],
    multiple: false,
    default_value: null,
    label: "Start point",
    hint: "Optional start point; defaults to the axis start",
  },
  radius: {
    type: "number",
    default_value: 5,
    hint: "Base radius of the helix",
  },
  endRadius: {
    type: "number",
    default_value: 5,
    hint: "Optional end radius to taper the helix",
  },
    handedness: {
    type: "options",
    options: ["right", "left"],
    default_value: "right",
    hint: "Choose right- or left-handed helix winding",
  },
  resolution: {
    type: "number",
    default_value: 64,
    hint: "Segments per turn for the helix polyline",
  },
  mode: {
    type: "options",
    options: ["turns", "pitch"],
    default_value: "turns",
    label: "Mode",
    hint: "Control helix using turn count or pitch; height is always applied",
  },
  height: {
    type: "number",
    default_value: 15,
    hint: "Total height along the axis",
  },
  turns: {
    type: "number",
    default_value: 3,
    hint: "Number of turns (used in mode 'turns'; derived in mode 'pitch')",
  },
  pitch: {
    type: "number",
    default_value: 5,
    step: 1,
    min: 0.001,
    hint: "Distance advanced per turn along the helix axis (editable in mode 'pitch'; derived otherwise)",
  },
  startAngle: {
    type: "number",
    default_value: 0,
    hint: "Starting angle in degrees",
  },
};

const THREE = BREP.THREE;

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toVec3 = (value) => {
  if (!value) return null;
  if (value.isVector3) return value.clone();
  if (typeof value.getWorldPosition === "function") {
    const v = new THREE.Vector3();
    try {
      value.getWorldPosition(v);
      return v;
    } catch { /* ignore */ }
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(
      toNumber(value[0], 0),
      toNumber(value[1], 0),
      toNumber(value[2], 0)
    );
  }
  if (value.position && typeof value.position === "object") {
    const p = value.position;
    return new THREE.Vector3(
      toNumber(p.x, 0),
      toNumber(p.y, 0),
      toNumber(p.z, 0)
    );
  }
  return null;
};

function extractEdgePolylineWorld(edgeObj) {
  const pts = [];
  if (!edgeObj) return pts;
  const cached = edgeObj?.userData?.polylineLocal;
  const isWorld = !!(edgeObj?.userData?.polylineWorld);
  const v = new THREE.Vector3();
  if (Array.isArray(cached) && cached.length >= 2) {
    if (isWorld) return cached.map((p) => [p[0], p[1], p[2]]);
    for (const p of cached) {
      v.set(p[0], p[1], p[2]).applyMatrix4(edgeObj.matrixWorld);
      pts.push([v.x, v.y, v.z]);
    }
    return pts;
  }
  const posAttr = edgeObj?.geometry?.getAttribute?.("position");
  if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
    for (let i = 0; i < posAttr.count; i++) {
      v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edgeObj.matrixWorld);
      pts.push([v.x, v.y, v.z]);
    }
    return pts;
  }
  const aStart = edgeObj?.geometry?.attributes?.instanceStart;
  const aEnd = edgeObj?.geometry?.attributes?.instanceEnd;
  if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
    v.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edgeObj.matrixWorld);
    pts.push([v.x, v.y, v.z]);
    for (let i = 0; i < aEnd.count; i++) {
      v.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edgeObj.matrixWorld);
      pts.push([v.x, v.y, v.z]);
    }
  }
  return pts;
}

function deriveAxisFromEdge(edgeObj) {
  const poly = extractEdgePolylineWorld(edgeObj);
  if (!Array.isArray(poly) || poly.length < 2) return null;
  const start = new THREE.Vector3(poly[0][0], poly[0][1], poly[0][2]);
  // Pick the farthest point from start to establish direction
  let far = null;
  let maxD2 = -1;
  for (const p of poly) {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    const d2 = v.distanceToSquared(start);
    if (d2 > maxD2) {
      maxD2 = d2;
      far = v;
    }
  }
  if (!far || maxD2 < 1e-12) return null;
  const dir = far.clone().sub(start).normalize();
  // Pick a stable perpendicular for xDirection
  const up = new THREE.Vector3(0, 1, 0);
  let xDir = new THREE.Vector3().crossVectors(up, dir);
  if (xDir.lengthSq() < 1e-12) xDir = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), dir);
  if (xDir.lengthSq() < 1e-12) xDir.set(1, 0, 0);
  xDir.normalize();
  return {
    origin: start,
    direction: dir,
    xDirection: xDir,
    polyline: poly,
  };
}

export class HelixFeature {
  static shortName = "HX";
  static longName = "Helix";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = this.persistentData || {};
  }

  uiFieldsTest() {
    const placementMode = String(this.inputParams?.placementMode || "transform").toLowerCase();
    const modeRaw = this.inputParams?.mode ?? this.inputParams?.lengthMode;
    const modeNormalized = String(modeRaw || "turns").toLowerCase();
    const mode = modeNormalized === "pitch" || modeNormalized === "height" ? "pitch" : "turns";
    if (!this.inputParams?.mode && this.inputParams?.lengthMode) {
      this.inputParams.mode = mode;
    }

    const include = ["placementMode","radius", "endRadius", "mode","height","startAngle", "handedness", "resolution"];
    if (placementMode.startsWith("axis")) {
      include.push("axis", "startPoint");
    }
    if (mode === "pitch") {
      include.push("pitch");
    } else {
      include.push("turns");
    }
    if (!placementMode.startsWith("axis")) {
      include.push("transform");
    }

    return { include };
  }

  async run(partHistory) { // partHistory reserved for future downstream needs
    const resolveRef = (val) => {
      if (Array.isArray(val)) {
        const obj = val.find(Boolean);
        if (obj) return obj;
      }
      if (val && typeof val === "object") return val;
      if (typeof val === "string" && partHistory?.scene) {
        const found = partHistory.scene.getObjectByName(val);
        if (found) return found;
      }
      return null;
    };

    const featureId = this.inputParams?.featureID
      ? String(this.inputParams.featureID)
      : "Helix";

    const radius = Math.max(1e-6, Math.abs(toNumber(this.inputParams.radius, 5)));
    const endRadiusRaw = toNumber(this.inputParams.endRadius, radius);
    const endRadius = Math.max(1e-6, Math.abs(endRadiusRaw));
    const pitchDefault = inputParamsSchema.pitch?.default_value ?? 5;
    const rawPitch = toNumber(this.inputParams.pitch, pitchDefault);
    const pitch = Math.abs(rawPitch);
    const minPitch = 1e-6;
    if (!Number.isFinite(pitch) || pitch < minPitch) {
      throw new Error(`HelixFeature: pitch must be a non-zero number (received ${this.inputParams.pitch}).`);
    }
    const modeRaw = this.inputParams.mode ?? this.inputParams.lengthMode;
    const normalizedMode = String(modeRaw || "turns").toLowerCase();
    const mode = normalizedMode === "pitch" || normalizedMode === "height" ? "pitch" : "turns";
    if (!this.inputParams.mode && this.inputParams.lengthMode) {
      this.inputParams.mode = mode;
    }
    const turns = toNumber(this.inputParams.turns, 3);
    const height = toNumber(
      this.inputParams.height,
      pitch * Math.max(1, toNumber(this.inputParams.turns, 3))
    );
    const startAngleDeg = toNumber(this.inputParams.startAngle, 0);
    const resolution = Math.max(8, Math.floor(toNumber(this.inputParams.resolution, 64)));
    const handedRaw = this.inputParams.handedness || (this.inputParams.clockwise ? "left" : "right");
    const handedness = String(handedRaw || "right").toLowerCase() === "left" ? "left" : "right";
    const placementMode = String(this.inputParams.placementMode || "transform").toLowerCase();

    let placementOpts = { transform: this.inputParams.transform };
    if (placementMode.startsWith("axis")) {
      const axisSel = resolveRef(this.inputParams.axis);
      const axisInfo = deriveAxisFromEdge(axisSel);
      if (!axisInfo) {
        console.warn("HelixFeature: axis placement selected but no valid edge provided.");
        return { added: [], removed: [] };
      }
      // Flip the derived axis direction so the helix advances opposite the edge's forward direction
      const axisDir = axisInfo.direction.clone().multiplyScalar(-1);
      const startSel = resolveRef(this.inputParams.startPoint);
      const startVec = toVec3(startSel) || axisInfo.origin;
      placementOpts = {
        origin: [startVec.x, startVec.y, startVec.z],
        axis: [axisDir.x, axisDir.y, axisDir.z],
        xDirection: [axisInfo.xDirection.x, axisInfo.xDirection.y, axisInfo.xDirection.z],
      };
    }

    const helixData = BREP.buildHelixPolyline({
      radius,
      endRadius,
      pitch,
      turns,
      height,
      mode,
      lengthMode: mode, // support legacy naming
      startAngleDeg,
      handedness,
      segmentsPerTurn: resolution,
      ...placementOpts,
    });

    if (!helixData || !Array.isArray(helixData.polyline) || helixData.polyline.length < 2) {
      return { added: [], removed: [] };
    }

    const sceneGroup = new THREE.Group();
    sceneGroup.name = featureId;
    sceneGroup.type = "HELIX";
    sceneGroup.onClick = () => {};

    const positions = [];
    for (const p of helixData.polyline) {
      positions.push(p[0], p[1], p[2]);
    }

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const edge = new BREP.Edge(geometry);
    edge.name = `${featureId}:Helix`;
    edge.userData = {
      polylineLocal: helixData.polyline.map((p) => [p[0], p[1], p[2]]),
      polylineWorld: true,
      helixParams: {
        radius,
        endRadius,
        pitch: helixData.pitch,
        turns: helixData.turns,
        height: helixData.height,
        handedness,
        clockwise: helixData.clockwise,
        startAngleDeg,
        mode,
        lengthMode: mode,
        resolution,
        placementMode,
      },
    };
    sceneGroup.add(edge);

    try {
      if (Array.isArray(helixData.axisLine) && helixData.axisLine.length === 2) {
        const axisPositions = [
          helixData.axisLine[0][0],
          helixData.axisLine[0][1],
          helixData.axisLine[0][2],
          helixData.axisLine[1][0],
          helixData.axisLine[1][1],
          helixData.axisLine[1][2],
        ];
        const axisGeometry = new LineGeometry();
        axisGeometry.setPositions(axisPositions);
        const axisEdge = new BREP.Edge(axisGeometry);
        axisEdge.name = `${featureId}:Axis`;
        axisEdge.userData = {
          polylineLocal: helixData.axisLine.map((p) => [p[0], p[1], p[2]]),
          polylineWorld: true,
          helixAxis: true,
          sourceAxisName: (Array.isArray(this.inputParams.axis) ? this.inputParams.axis.find(Boolean)?.name : this.inputParams.axis?.name) || null,
        };
        sceneGroup.add(axisEdge);

        // Add centerline endpoints for the helix axis
        try {
          const vAxisStart = new BREP.Vertex(helixData.axisLine[0], { name: `${featureId}:AxisStart` });
          vAxisStart.userData = { helixFeatureId: featureId, centerline: true, endpoint: "start" };
          const vAxisEnd = new BREP.Vertex(helixData.axisLine[1], { name: `${featureId}:AxisEnd` });
          vAxisEnd.userData = { helixFeatureId: featureId, centerline: true, endpoint: "end" };
          sceneGroup.add(vAxisStart);
          sceneGroup.add(vAxisEnd);
        } catch {
          // centerline endpoints are optional; ignore failures
        }
      }
    } catch {
      // axis visualization is optional; ignore failures
    }

    try {
      const first = helixData.polyline[0];
      const last = helixData.polyline[helixData.polyline.length - 1];
      const vStart = new BREP.Vertex(first, { name: `${featureId}:Start` });
      const vEnd = new BREP.Vertex(last, { name: `${featureId}:End` });
      vStart.userData = { helixFeatureId: featureId, endpoint: "start" };
      vEnd.userData = { helixFeatureId: featureId, endpoint: "end" };
      sceneGroup.add(vStart);
      sceneGroup.add(vEnd);
    } catch {
      // vertices are just helpers; ignore failures
    }

    this.persistentData = this.persistentData || {};
    this.persistentData.helix = helixData;

    return { added: [sceneGroup], removed: [] };
  }
}
