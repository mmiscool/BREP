import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { LineGeometry } from "three/examples/jsm/Addons.js";
import {
  DEFAULT_RESOLUTION,
  normalizeSplineData,
  buildHermitePolyline,
  cloneSplineData,
} from "./splineUtils.js";

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the spline feature",
  },
  editSpline: {
    type: "button",
    label: "Edit Spline",
    default_value: null,
    hint: "Launch the spline editor",
    actionFunction: (ctx) => {
      try {
        if (ctx && ctx.viewer && typeof ctx.viewer.startSplineMode === "function") {
          ctx.viewer.startSplineMode(ctx.featureID);
        } else {
          throw new Error("viewer.startSplineMode unavailable");
        }
      } catch (e) {
        console.warn("[SplineFeature] Failed to start spline mode:", e?.message || e);
      }
    },
  },
  curveResolution: {
    type: "number",
    default_value: DEFAULT_RESOLUTION,
    hint: "Samples per segment used to visualize the spline",
  },
};

export class SplineFeature {
  static featureShortName = "SP";
  static featureName = "Spline";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = this.persistentData || {};
  }

  _ensureSplineData() {
    const source = this.persistentData?.spline || null;
    const normalized = normalizeSplineData(source);
    this.persistentData = this.persistentData || {};
    this.persistentData.spline = normalized;
    return normalized;
  }

  async run(partHistory) {
    const spline = this._ensureSplineData();
    const featureId = this.inputParams?.featureID
      ? String(this.inputParams.featureID)
      : "Spline";

    const sceneGroup = new THREE.Group();
    sceneGroup.name = featureId;
    sceneGroup.type = "SKETCH";
    sceneGroup.onClick = () => {};

    const resolution = Number.isFinite(Number(this.inputParams?.curveResolution))
      ? Math.max(4, Number(this.inputParams.curveResolution))
      : DEFAULT_RESOLUTION;

    const { positions, polyline } = buildHermitePolyline(spline, resolution);

    if (positions.length >= 6) {
      const geometry = new LineGeometry();
      geometry.setPositions(positions);

      const edge = new BREP.Edge(geometry);
      edge.name = `${featureId}:SplineEdge`;
      edge.userData = {
        polylineLocal: polyline.map((p) => [p[0], p[1], p[2]]),
        polylineWorld: true,
        splineFeatureId: featureId,
      };
      sceneGroup.add(edge);
    }

    try {
      const vertices = spline.points.map((pt, idx) => {
        const vertex = new BREP.Vertex(pt.position, {
          name: `${featureId}:P${idx}`,
        });
        vertex.userData = vertex.userData || {};
        vertex.userData.splineFeatureId = featureId;
        vertex.userData.splinePointId = pt.id;
        return vertex;
      });
      for (const v of vertices) {
        sceneGroup.add(v);
      }
    } catch {
      // optional vertices failed; ignore
    }

    try {
      const startVertex = new BREP.Vertex(spline.startWeight.position, {
        name: `${featureId}:WStart`,
      });
      startVertex.userData = {
        splineFeatureId: featureId,
        splineWeightType: "start",
      };
      const endVertex = new BREP.Vertex(spline.endWeight.position, {
        name: `${featureId}:WEnd`,
      });
      endVertex.userData = {
        splineFeatureId: featureId,
        splineWeightType: "end",
      };
      sceneGroup.add(startVertex);
      sceneGroup.add(endVertex);
    } catch {
      /* ignore weight vertex creation failure */
    }

    this.persistentData = this.persistentData || {};
    this.persistentData.spline = cloneSplineData(spline);

    return { added: [sceneGroup], removed: [] };
  }
}
