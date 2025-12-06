// NoteAnnotation.js
// Note annotation following feature pattern with full implementation from old PMI code

import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { getPMIStyle } from '../pmiStyle.js';

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the note",
  },
  text: {
    type: "string",
    default_value: "",
    defaultResolver: ({ pmimode }) => {
      const txt = pmimode?._opts?.noteText;
      return (typeof txt === 'string') ? txt : undefined;
    },
    hint: "Note text content"
  },
  position: {
    type: "object",
    default_value: null,
    hint: "3D position of the note marker"
  }
};

export class NoteAnnotation extends BaseAnnotation {
  static entityType = 'note';
  static type = 'note';
  static shortName = 'NOTE';
  static longName = 'Note';
  static title = 'Note';
  static inputParamsSchema = inputParamsSchema;

  constructor(opts = {}) {
    super(opts);
  }

  async run(renderingContext) {
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams;
    const style = getPMIStyle();
    const p = new THREE.Vector3(ann.position?.x || 0, ann.position?.y || 0, ann.position?.z || 0);
    const g = new THREE.SphereGeometry(style.noteDotRadius ?? 0.08, 16, 12);
    const m = new THREE.MeshBasicMaterial({ color: style.noteDotColor ?? style.dotColor ?? 0x93c5fd, depthTest: false, depthWrite: false, transparent: true });
    const dot = new THREE.Mesh(g, m);
    dot.position.copy(p);
    group.add(dot);

    const txt = String(ann.text || '');
    if (!txt) return [];

    let labelPos = null;
    if (ann.labelWorld) {
      labelPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
    } else {
      const n = ctx.alignNormal('view', ann);
      const camRight = new THREE.Vector3();
      const camUp = new THREE.Vector3(0, 1, 0);
      try { pmimode.viewer?.camera?.getWorldDirection?.(camRight); camRight.crossVectors(n, camUp).normalize(); } catch { camRight.set(1, 0, 0); }
      const offset = ctx.screenSizeWorld(16);
      labelPos = p.clone().addScaledVector(camRight, offset).addScaledVector(n, offset * 0.25);
    }
    ctx.updateLabel(idx, txt, labelPos, ann);
    return [];
  }

  static getSchema(pmimode, ann) {
    const schema = {
      text: { type: 'string', label: 'Text', default_value: ann.text || '' },
    };
    const params = { text: schema.text.default_value };
    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    super.applyParams(pmimode, ann, params);
    ann.text = sanitizeText(ann.text);
    return { paramsPatch: {} };
  }

  // Drag note label on view plane
  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : new THREE.Vector3(0,0,1);
      const planePoint = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : new THREE.Vector3(ann.position?.x||0, ann.position?.y||0, ann.position?.z||0);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);
      NoteAnnotation.dragLabelOnPlane(pmimode, ctx, {
        makePlane: () => plane,
        onDrag: (hit) => {
          ann.labelWorld = { x: hit.x, y: hit.y, z: hit.z };
          try { ctx.updateLabel(idx, null, hit, ann); } catch {}
        },
        onEnd: () => {
          try { if (pmimode?.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch {}
        },
      });
    } catch {}
  }
}

function sanitizeText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}
