import * as THREE from 'three';

export const LeaderAnnotation = {
  type: 'leader',
  title: 'Leader',
  create(pmimode) {
    const defaults = pmimode?._opts || {};
    return {
      type: 'leader',
      anchorRefName: '',
      planeRefName: '',
      textPosition: null,
      text: typeof defaults.leaderText === 'string' ? defaults.leaderText : 'TEXT HERE',
      anchorSide: 'right',
      __open: true,
    };
  },
  getSchema(pmimode, ann) {
    const schema = {
      anchor: { type: 'reference_selection', label: 'Target Point', selectionFilter: ['VERTEX'], default_value: ann.anchorRefName || '' },
      planeRef: { type: 'reference_selection', label: 'Plane/Face', selectionFilter: ['FACE', 'PLANE'], default_value: ann.planeRefName || '' },
      text: { type: 'textarea', label: 'Text', default_value: ann.text || pmimode?._opts?.leaderText || 'TEXT HERE', rows: 3 },
      anchorSide: { type: 'options', label: 'Anchor Side', options: ['left', 'right'], default_value: ann.anchorSide || 'right' }
    };
    const params = { anchor: schema.anchor.default_value, planeRef: schema.planeRef.default_value, text: schema.text.default_value, anchorSide: schema.anchorSide.default_value };
    return { schema, params };
  },

  applyParams(pmimode, ann, params) {
    const oldAnchor = String(ann.anchorRefName || '');
    ann.anchorRefName = String(params.anchor || '');
    ann.planeRefName = String(params.planeRef || '');
    ann.text = String(params.text || '');
    ann.anchorSide = String(params.anchorSide || 'right');
    if (ann.anchorRefName && ann.anchorRefName !== oldAnchor) {
      delete ann.textPosition; delete ann._useDraggedPosition;
    }
    return { statusText: (ann.text || '').slice(0, 24) };
  },

  statusText(pmimode, ann) {
    return (ann.text || '').slice(0, 24);
  },

  render3D(pmimode, group, ann, idx, ctx) {
    const fallback = (ann.start ? new THREE.Vector3(ann.start.x || 0, ann.start.y || 0, ann.start.z || 0) : null);
    const anchorPoint = (ctx.resolveRefNameToWorld ? ctx.resolveRefNameToWorld(ann.anchorRefName, fallback) : null) || fallback || new THREE.Vector3();

    const txt = String(ann.text || '');
    if (!txt) return;

    const textPos = ann.textPosition ? new THREE.Vector3(ann.textPosition.x, ann.textPosition.y, ann.textPosition.z) : null;

    if (textPos) {
      ann._useDraggedPosition = true;
      ctx.updateLabel(idx, txt, textPos, ann);
      // Draw leader line to dragged text
      this._createLeaderLineToDraggedText(pmimode, group, anchorPoint, textPos, idx, ctx);
    } else {
      ann._useDraggedPosition = false;
      ctx.updateLabel(idx, txt, anchorPoint, ann);
      this._createLeaderLineToText(pmimode, group, anchorPoint, idx, ann, ctx);
    }
  },

  _createLeaderLineToText(pmimode, group, anchorPoint, labelIdx, ann, ctx) {
    try {
      // Remove previous for this label
      const existing = group.children.filter(ch => ch.userData && ch.userData.isLeaderLine && ch.userData.labelIdx === labelIdx);
      existing.forEach(ch => group.remove(ch));

      const pixelOffset = ctx?.screenSizeWorld ? ctx.screenSizeWorld(20) : 0.1;
      const textOffset = ctx?.screenSizeWorld ? ctx.screenSizeWorld(40) : 0.2;
      const side = ann.anchorSide || 'right';

      const camera = pmimode?.viewer?.camera;
      const horizontal = new THREE.Vector3();
      if (camera) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const up = new THREE.Vector3(0, 1, 0);
        horizontal.crossVectors(up, dir).normalize();
        if (side === 'left') horizontal.multiplyScalar(-1);
      } else {
        horizontal.set(side === 'left' ? -1 : 1, 0, 0);
      }

      const textStart = anchorPoint.clone().add(horizontal.clone().multiplyScalar(textOffset));
      const bendPoint = anchorPoint.clone().add(horizontal.clone().multiplyScalar(textOffset + pixelOffset));

      const addLine = (a, b) => {
        const g = new THREE.BufferGeometry().setFromPoints([a, b]);
        const m = new THREE.LineBasicMaterial({ color: 0x93c5fd, depthTest: false, depthWrite: false, transparent: true });
        const l = new THREE.Line(g, m); l.userData = { isLeaderLine: true, labelIdx }; group.add(l);
      };
      addLine(textStart, bendPoint);
      addLine(bendPoint, anchorPoint);

      // Arrowhead
      const arrow = this._makeArrowhead(anchorPoint, bendPoint, 0x93c5fd);
      arrow.userData = { isLeaderLine: true, labelIdx };
      group.add(arrow);
    } catch (e) { console.warn('Leader: error drawing to text', e); }
  },

  _createLeaderLineToDraggedText(pmimode, group, anchorPoint, textPosition, labelIdx, ctx) {
    try {
      const existing = group.children.filter(ch => ch.userData && ch.userData.isLeaderLine && ch.userData.labelIdx === labelIdx);
      existing.forEach(ch => group.remove(ch));

      const pixelOffset = ctx?.screenSizeWorld ? ctx.screenSizeWorld(20) : 0.1;
      const camera = pmimode?.viewer?.camera;
      const horizontal = new THREE.Vector3();
      if (camera) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const up = new THREE.Vector3(0, 1, 0);
        horizontal.crossVectors(up, dir).normalize();
        const toAnchor = new THREE.Vector3().subVectors(anchorPoint, textPosition);
        const rightDot = horizontal.dot(toAnchor);
        horizontal.multiplyScalar(rightDot > 0 ? pixelOffset : -pixelOffset);
      } else {
        const toAnchor = new THREE.Vector3().subVectors(anchorPoint, textPosition);
        horizontal.set(toAnchor.x > 0 ? pixelOffset : -pixelOffset, 0, 0);
      }

      const bendPoint = new THREE.Vector3().addVectors(textPosition, horizontal);
      const addLine = (a, b) => {
        const g = new THREE.BufferGeometry().setFromPoints([a, b]);
        const m = new THREE.LineBasicMaterial({ color: 0x93c5fd, depthTest: false, depthWrite: false, transparent: true });
        const l = new THREE.Line(g, m); l.userData = { isLeaderLine: true, labelIdx }; group.add(l);
      };
      addLine(textPosition, bendPoint);
      addLine(bendPoint, anchorPoint);

      const arrow = this._makeArrowhead(anchorPoint, bendPoint, 0x93c5fd);
      arrow.userData = { isLeaderLine: true, labelIdx };
      group.add(arrow);
    } catch (e) { console.warn('Leader: error drawing to dragged text', e); }
  },

  _makeArrowhead(toPos, fromPos, color = 0x93c5fd) {
    try {
      const dir = new THREE.Vector3().subVectors(toPos, fromPos).normalize();
      const len = 0.25; // nominal
      const width = 0.12;
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(up, dir).normalize();
      const back = dir.clone().multiplyScalar(-len);
      const p0 = toPos.clone();
      const p1 = toPos.clone().add(back).add(right.clone().multiplyScalar(width * 0.5));
      const p2 = toPos.clone().add(back).add(right.clone().multiplyScalar(-width * 0.5));
      const geom = new THREE.BufferGeometry().setFromPoints([p0, p1, p2, p0]);
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
      return new THREE.Line(geom, mat);
    } catch { return new THREE.Group(); }
  },

  // Compute label world for overlay refresh (anchor-relative if not dragged)
  getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann._useDraggedPosition && ann.textPosition) {
        return new THREE.Vector3(ann.textPosition.x, ann.textPosition.y, ann.textPosition.z);
      }
      const fallback = (ann.start ? new THREE.Vector3(ann.start.x || 0, ann.start.y || 0, ann.start.z || 0) : null);
      const anchorPoint = (ctx.resolveRefNameToWorld ? ctx.resolveRefNameToWorld(ann.anchorRefName, fallback) : null) || fallback || new THREE.Vector3();
      // Offset in world approx. 60px to side
      const side = ann.anchorSide || 'right';
      const offset = (ctx.screenSizeWorld ? (ctx.screenSizeWorld(60)) : 0.3);
      const cam = pmimode?.viewer?.camera;
      const horizontal = new THREE.Vector3();
      if (cam) {
        const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
        const up = new THREE.Vector3(0,1,0); horizontal.crossVectors(up, dir).normalize();
        if (side === 'left') horizontal.multiplyScalar(-1);
      } else { horizontal.set(side === 'left' ? -1 : 1, 0, 0); }
      return anchorPoint.clone().add(horizontal.multiplyScalar(offset));
    } catch { return null; }
  },

  // Drag leader text (updates textPosition)
  onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : new THREE.Vector3(0,0,1);
      const planePoint = ann.textPosition ? new THREE.Vector3(ann.textPosition.x, ann.textPosition.y, ann.textPosition.z) : (this.getLabelWorld(pmimode, ann, ctx) || new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);
      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          ann.textPosition = { x: out.x, y: out.y, z: out.z };
          ann._useDraggedPosition = true;
          try { ctx.updateLabel(idx, null, out, ann); } catch {}
          try { pmimode.refreshAnnotationsUI?.(); } catch {}
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
  },
};
