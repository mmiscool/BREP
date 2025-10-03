// NoteAnnotation.js
// Note annotation following feature pattern with full implementation from old PMI code

import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';

const inputParamsSchema = {
  annotationID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the note",
  },
  text: {
    type: "string",
    default_value: "",
    hint: "Note text content"
  },
  position: {
    type: "object",
    default_value: null,
    hint: "3D position of the note marker"
  }
};

export class NoteAnnotation extends BaseAnnotation {
  static type = 'note';
  static title = 'Note';
  static featureShortName = "note";
  static featureName = "Note";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(renderingContext) {
    const { pmimode, group, idx, ctx } = renderingContext;
    return this.constructor.render3D(pmimode, group, this.inputParams, idx, ctx);
  }

  // Static methods for PMI system compatibility (preserving old PMI interface)
  static create(pmimode) {
    const defaults = pmimode?._opts || {};
    return {
      type: 'note',
      text: typeof defaults.noteText === 'string' ? defaults.noteText : '',
      __open: true,
    };
  }

  static getSchema(pmimode, ann) {
    const schema = {
      text: { type: 'string', label: 'Text', default_value: ann.text || '' },
    };
    const params = { text: schema.text.default_value };
    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    ann.text = String(params.text || '');
    return { statusText: (ann.text || '').slice(0, 24) };
  }

  static statusText(pmimode, ann) {
    return (ann.text || '').slice(0, 24);
  }

  // Draw marker + overlay label
  static render3D(pmimode, group, ann, idx, ctx) {
    const p = new THREE.Vector3(ann.position?.x || 0, ann.position?.y || 0, ann.position?.z || 0);
    const g = new THREE.SphereGeometry(0.08, 16, 12);
    const m = new THREE.MeshBasicMaterial({ color: 0x93c5fd, depthTest: false, depthWrite: false, transparent: true });
    const dot = new THREE.Mesh(g, m);
    dot.position.copy(p);
    group.add(dot);

    const txt = String(ann.text || '');
    if (!txt) return;

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
  }

  // Provide world position for overlay refresh without full rebuild
  static getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann.labelWorld) return new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
      const p = new THREE.Vector3(ann.position?.x || 0, ann.position?.y || 0, ann.position?.z || 0);
      const n = ctx.alignNormal ? ctx.alignNormal('view', ann) : new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      try { pmimode.viewer?.camera?.getWorldDirection?.(right); right.crossVectors(n, up).normalize(); } catch { right.set(1, 0, 0); }
      const off = ctx.screenSizeWorld ? ctx.screenSizeWorld(16) : 0.05;
      return p.clone().addScaledVector(right, off).addScaledVector(n, off * 0.25);
    } catch { return null; }
  }

  // Drag note label on view plane
  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : new THREE.Vector3(0,0,1);
      const planePoint = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : new THREE.Vector3(ann.position?.x||0, ann.position?.y||0, ann.position?.z||0);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);
      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          ann.labelWorld = { x: out.x, y: out.y, z: out.z };
          try { ctx.updateLabel(idx, null, out, ann); } catch {}
        }
      };
      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch {}
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = (pmimode._tool === 'select'); } catch {}
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch {}
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } catch {}
  }
}