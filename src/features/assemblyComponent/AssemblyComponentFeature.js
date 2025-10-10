import JSZip from 'jszip';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BREP } from '../../BREP/BREP.js';
import { base64ToUint8Array, getComponentRecord } from '../../services/componentLibrary.js';

const THREE = BREP.THREE;

function handleComponentSelection(ctx, record) {
  if (!ctx || !ctx.feature) return;
  const feature = ctx.feature;
  feature.inputParams = feature.inputParams || {};
  feature.persistentData = feature.persistentData || {};

  if (!record || !record.data3mf) {
    feature.inputParams.componentName = '';
    delete feature.persistentData.componentData;
    return;
  }

  feature.inputParams.componentName = record.name || '';
  feature.persistentData.componentData = {
    name: record.name || '',
    savedAt: record.savedAt || null,
    data3mf: record.data3mf,
    featureInfo: null,
  };
}

const DEFAULT_TRANSFORM = {
  position: [0, 0, 0],
  rotationEuler: [0, 0, 0],
  scale: [1, 1, 1],
};

const inputParamsSchema = {
  featureID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the assembly component feature.',
  },
  componentName: {
    type: 'component_selector',
    label: 'Component',
    buttonLabel: 'Select…',
    hint: 'Pick a saved 3MF component to insert into this assembly.',
    dialogTitle: 'Select Component',
    onSelect: handleComponentSelection,
  },
  isFixed: {
    type: 'boolean',
    default_value: false,
    label: 'Fixed in place',
    hint: 'Lock this component so assembly constraints cannot move it.',
  },
  transform: {
    type: 'transform',
    default_value: DEFAULT_TRANSFORM,
    label: 'Placement',
    hint: 'Use the transform gizmo to position the component.',
  },
};

export class AssemblyComponentFeature {
  static featureShortName = 'ACOMP';
  static featureName = 'Assembly Component';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const componentData = await this._resolveComponentData();
    if (!componentData || !componentData.bytes || componentData.bytes.length === 0) {
      const hasSelectionIntent = Boolean((this.inputParams && this.inputParams.componentName) || (this.persistentData && this.persistentData.componentData));
      if (hasSelectionIntent) {
        console.warn('[AssemblyComponentFeature] Component payload missing or failed to load.');
      }
      return { added: [], removed: [] };
    }

    const featureId = this._sanitizeFeatureId(this.inputParams?.featureID);
    const group = await this._loadThreeMF(componentData.bytes);
    if (!group) {
      console.warn('[AssemblyComponentFeature] Failed to parse 3MF component.');
      return { added: [], removed: [] };
    }

    const solids = await this._buildSolidsFromGroup(group, componentData);
    if (!solids.length) {
      console.warn('[AssemblyComponentFeature] No solids recovered from component.');
      return { added: [], removed: [] };
    }

    //const componentName = this.inputParams.componentName || componentData.name ;
    const componentName = `${this.inputParams.componentName || componentData.name}_${featureId}`;
    const component = new BREP.AssemblyComponent({
      name: componentName,
      fixed: !!this.inputParams.isFixed,
    });


    for (const solid of solids) {
      if (featureId) {
        if (solid?.type === 'SOLID') {
          this._applyFeaturePrefixToSolid(solid, featureId);
        } else {
          this._applyFeaturePrefixToObject3D(solid, featureId);
        }
      }

      try {
        if (typeof solid?.visualize === 'function') {
          solid.visualize();
        }
      } catch { /* ignore */ }

      if (featureId) {
        this._applyFeaturePrefixToObject3D(solid, featureId);
      }

      component.addBody(solid);
    }

    if (featureId) {
      this._applyFeaturePrefixToObject3D(component, featureId);
    }

    const transformMatrix = this._composeTransformMatrix(this.inputParams.transform || DEFAULT_TRANSFORM);
    if (transformMatrix) {
      this._applyMatrixToComponent(component, transformMatrix);
    }

    component.userData = component.userData || {};
    component.userData.componentSource = {
      name: componentData.name || componentName,
      savedAt: componentData.savedAt || null,
    };
    if (componentData.featureInfo) {
      component.userData.featureInfo = componentData.featureInfo;
    }

    // Persist canonical payload so reruns do not depend on local storage state.
    this.persistentData.componentData = {
      name: componentData.name || componentName,
      savedAt: componentData.savedAt || null,
      data3mf: componentData.base64,
      featureInfo: componentData.featureInfo || null,
    };

    return { added: [component], removed: [] };
  }

  async _resolveComponentData() {
    const persisted = this.persistentData && this.persistentData.componentData;
    if (persisted && persisted.data3mf) {
      const bytes = base64ToUint8Array(persisted.data3mf);
      let featureInfo = persisted.featureInfo;
      if (!featureInfo || !featureInfo.history) {
        featureInfo = await this._extractFeatureInfo(bytes);
      }
      if (featureInfo) {
        this.persistentData.componentData.featureInfo = featureInfo;
      }
      return {
        name: persisted.name || '',
        savedAt: persisted.savedAt || null,
        base64: persisted.data3mf,
        bytes,
        featureInfo,
      };
    }

    const selectedName = this.inputParams && this.inputParams.componentName;
    if (!selectedName) return null;

    const record = getComponentRecord(selectedName);
    if (!record || !record.data3mf) return null;

    const bytes = base64ToUint8Array(record.data3mf);
    const featureInfo = await this._extractFeatureInfo(bytes);

    this.persistentData = this.persistentData || {};
    this.persistentData.componentData = {
      name: record.name || selectedName,
      savedAt: record.savedAt || null,
      data3mf: record.data3mf,
      featureInfo,
    };

    return {
      name: record.name || selectedName,
      savedAt: record.savedAt || null,
      base64: record.data3mf,
      bytes,
      featureInfo,
    };
  }

  async _loadThreeMF(bytes) {
    try {
      const loader = new ThreeMFLoader();
      const buffer = this._toArrayBuffer(bytes);
      if (!buffer) return null;
      return await loader.parse(buffer);
    } catch (err) {
      console.warn('[AssemblyComponentFeature] ThreeMFLoader.parse failed:', err);
      return null;
    }
  }

  async _buildSolidsFromGroup(group, componentData) {
    const solids = [];
    const componentName = this.inputParams.componentName || componentData.name || 'Component';
    const facetInfo = componentData.featureInfo?.facets || null;
    const metadataMap = componentData.featureInfo?.metadata || null;

    group.updateMatrixWorld(true);

    const faceNameCounts = new Map();
    const meshes = [];
    group.traverse((obj) => {
      const geom = obj && obj.isMesh ? obj.geometry : null;
      if (!geom || !geom.isBufferGeometry) return;
      const posAttr = geom.getAttribute('position');
      if (posAttr && posAttr.count >= 3) meshes.push(obj);
    });

    if (!meshes.length) {
      console.warn(`[AssemblyComponentFeature] Component "${componentName}" contained no mesh primitives.`);
      return await this._rebuildSolidsFromHistory(componentData, componentName);
    }

    let index = 0;
    for (const mesh of meshes) {
      const solidName = this._resolveSolidName(mesh.name, componentName, ++index);
      const solid = this._buildSolidFromMesh(mesh, faceNameCounts) || this._fallbackSolidFromMesh(mesh);
      if (!solid || !solid._triVerts || solid._triVerts.length === 0) {
        const meshName = mesh?.name ? `"${mesh.name}"` : '(unnamed mesh)';
        console.warn(`[AssemblyComponentFeature] Failed to recover triangles for ${meshName}; skipping.`);
        index--; // keep numbering tight if conversion failed
        continue;
      }

      solid.name = solidName;

      const faceMeta = facetInfo && facetInfo[solidName];
      if (faceMeta && typeof solid.setFaceMetadata === 'function') {
        for (const key of Object.keys(faceMeta)) {
          try { solid.setFaceMetadata(key, faceMeta[key]); } catch { /* ignore */ }
        }
      }

      if (metadataMap && metadataMap[solidName]) {
        solid.userData = solid.userData || {};
        solid.userData.metadata = metadataMap[solidName];
      }

      solids.push(solid);
    }

    if (!solids.length && meshes.length) {
      try {
        const worldGeometries = [];
        for (const mesh of meshes) {
          const geom = mesh?.geometry;
          if (!geom || typeof geom.clone !== 'function') continue;
          try { mesh.updateWorldMatrix(true, false); }
          catch { }
          const cloned = geom.clone();
          try { cloned.applyMatrix4(mesh.matrixWorld); }
          catch { /* ignore transform issues */ }
          worldGeometries.push(cloned);
        }
        if (worldGeometries.length) {
          const merged = mergeGeometries(worldGeometries, false);
          if (merged) {
            try {
              const fallbackSolid = new BREP.MeshToBrep(merged, 30, 1e-5);
              const fallbackKey = metadataMap && Object.keys(metadataMap).length === 1
                ? Object.keys(metadataMap)[0]
                : (facetInfo && Object.keys(facetInfo).length === 1 ? Object.keys(facetInfo)[0] : null);
              const solidName = fallbackKey || this._resolveSolidName('', componentName, 1);
              fallbackSolid.name = solidName;
              console.warn(`[AssemblyComponentFeature] Using merged-geometry fallback for component "${componentName}" (mesh count: ${meshes.length}).`);

              if (facetInfo && facetInfo[solidName] && typeof fallbackSolid.setFaceMetadata === 'function') {
                for (const key of Object.keys(facetInfo[solidName])) {
                  try { fallbackSolid.setFaceMetadata(key, facetInfo[solidName][key]); }
                  catch { /* ignore */ }
                }
              }

              if (metadataMap && metadataMap[solidName]) {
                fallbackSolid.userData = fallbackSolid.userData || {};
                fallbackSolid.userData.metadata = metadataMap[solidName];
              }

              solids.push(fallbackSolid);
            } catch (err) {
              console.warn('[AssemblyComponentFeature] Merged-geometry fallback failed:', err);
            } finally {
              try { merged.dispose(); } catch { }
            }
          }
        }
        for (const g of worldGeometries) {
          try { g.dispose(); } catch { }
        }
      } catch (err) {
        console.warn('[AssemblyComponentFeature] Unable to merge component meshes for fallback:', err);
      }
    }

    if (!solids.length) {
      const historyFallback = await this._rebuildSolidsFromHistory(componentData, componentName);
      if (historyFallback && historyFallback.length) {
        solids.push(...historyFallback);
      }
    }

    return solids;
  }

  _buildSolidFromMesh(mesh, faceNameCounts) {
    try {
      const geometry = mesh?.geometry;
      const posAttr = geometry?.getAttribute?.('position');
      if (!geometry || !posAttr || posAttr.count < 3) return null;

      try { mesh.updateWorldMatrix(true, false); }
      catch { /* matrix update best-effort */ }

      const solid = new BREP.Solid();
      const matrixWorld = mesh.matrixWorld;
      const indexAttr = typeof geometry.getIndex === 'function' ? geometry.getIndex() : null;

      const baseFaceName = this._safeName(mesh.material?.name || mesh.name || `FACE_${faceNameCounts.size + 1}`);
      const faceName = this._uniqueName(faceNameCounts, baseFaceName);

      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();

      const writeTriangle = (ia, ib, ic) => {
        if (!Number.isFinite(ia) || !Number.isFinite(ib) || !Number.isFinite(ic)) return;
        if (ia < 0 || ib < 0 || ic < 0) return;
        if (ia >= posAttr.count || ib >= posAttr.count || ic >= posAttr.count) return;
        a.fromBufferAttribute(posAttr, ia).applyMatrix4(matrixWorld);
        b.fromBufferAttribute(posAttr, ib).applyMatrix4(matrixWorld);
        c.fromBufferAttribute(posAttr, ic).applyMatrix4(matrixWorld);
        solid.addTriangle(faceName, [a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z]);
      };

      if (indexAttr && indexAttr.count >= 3) {
        const triCount = Math.floor(indexAttr.count / 3);
        for (let i = 0; i < triCount; i++) {
          const base = i * 3;
          writeTriangle(indexAttr.getX(base + 0), indexAttr.getX(base + 1), indexAttr.getX(base + 2));
        }
      } else {
        const triCount = Math.floor(posAttr.count / 3);
        for (let i = 0; i < triCount; i++) {
          const base = i * 3;
          writeTriangle(base + 0, base + 1, base + 2);
        }
      }

      if (!solid._triVerts || solid._triVerts.length === 0) return null;
      return solid;
    } catch (err) {
      console.warn('[AssemblyComponentFeature] Failed to construct solid from mesh:', err);
      return null;
    }
  }

  _fallbackSolidFromMesh(mesh) {
    try {
      const geometry = mesh?.geometry;
      const posAttr = geometry?.getAttribute?.('position');
      if (!geometry || !posAttr || posAttr.count < 3) return null;
      const cloned = geometry.clone();
      cloned.applyMatrix4(mesh.matrixWorld);
      return new BREP.MeshToBrep(cloned, 30, 1e-5);
    } catch (err) {
      console.warn('[AssemblyComponentFeature] Fallback MeshToBrep conversion failed:', err);
      return null;
    }
  }

  async _rebuildSolidsFromHistory(componentData, componentName) {
    try {
      const featureInfo = componentData?.featureInfo;
      const historyPayload = featureInfo?.history;
      const historyString = typeof historyPayload === 'string'
        ? historyPayload
        : (historyPayload ? JSON.stringify(historyPayload) : (featureInfo?.historyString || featureInfo?.rawJSON || null));
      if (!historyString) return [];

      const { PartHistory } = await import('../../PartHistory.js');
      const sandbox = new PartHistory();
      await sandbox.fromJSON(historyString);
      await sandbox.runHistory();

      const solids = [];
      const nameCounts = new Map();
      const facetInfo = featureInfo?.facets || null;
      const metadataMap = featureInfo?.metadata || null;

      const children = sandbox.scene.children.slice();
      for (const child of children) {
        if (!child || (child.type !== 'SOLID' && child.type !== 'COMPONENT')) continue;
        if (child.__removeFlag) continue;
        try { sandbox.scene.remove(child); } catch { }
        child.parent = null;

        const fallbackBase = child.type === 'COMPONENT' ? `${componentName || 'Component'}_Subassembly${solids.length + 1}` : `${componentName || 'Component'}_Body${solids.length + 1}`;
        const baseName = child.name && child.name.trim().length ? child.name : fallbackBase;
        const finalName = this._uniqueName(nameCounts, this._safeName(baseName));
        child.name = finalName;

        if (child.type !== 'COMPONENT') {
          const faceMeta = facetInfo && facetInfo[finalName];
          if (faceMeta && typeof child.setFaceMetadata === 'function') {
            for (const key of Object.keys(faceMeta)) {
              try { child.setFaceMetadata(key, faceMeta[key]); } catch { }
            }
          }

          if (metadataMap && metadataMap[finalName]) {
            child.userData = child.userData || {};
            child.userData.metadata = metadataMap[finalName];
          }
        }

        solids.push(child);
      }

      if (solids.length) {
        console.warn(`[AssemblyComponentFeature] Rebuilt component "${componentName}" from feature history (${solids.length} solid${solids.length === 1 ? '' : 's'}).`);
      }

      return solids;
    } catch (err) {
      console.warn('[AssemblyComponentFeature] Failed to rebuild component from feature history:', err);
      return [];
    }
  }

  _composeTransformMatrix(trs) {
    if (!trs) return null;
    try {
      const pos = Array.isArray(trs.position) ? trs.position : [0, 0, 0];
      const rot = Array.isArray(trs.rotationEuler) ? trs.rotationEuler : [0, 0, 0];
      const scl = Array.isArray(trs.scale) ? trs.scale : [1, 1, 1];
      const translation = new THREE.Vector3(pos[0] || 0, pos[1] || 0, pos[2] || 0);
      const rotation = new THREE.Euler(
        THREE.MathUtils.degToRad(rot[0] || 0),
        THREE.MathUtils.degToRad(rot[1] || 0),
        THREE.MathUtils.degToRad(rot[2] || 0),
        'XYZ'
      );
      const scale = new THREE.Vector3(scl[0] || 1, scl[1] || 1, scl[2] || 1);
      const matrix = new THREE.Matrix4();
      matrix.compose(translation, new THREE.Quaternion().setFromEuler(rotation), scale);
      return matrix;
    } catch {
      return null;
    }
  }

  _applyMatrixToComponent(component, matrix) {
    if (!component || !matrix) return;
    try {
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      matrix.decompose(position, quaternion, scale);
      component.position.copy(position);
      component.quaternion.copy(quaternion);
      component.scale.copy(scale);
      component.updateMatrix();
      component.updateMatrixWorld(true);
    } catch {
      /* noop */
    }
  }

  _uniqueName(map, base) {
    const key = base || 'FACE';
    const count = map.get(key) || 0;
    map.set(key, count + 1);
    return count === 0 ? key : `${key}_${count}`;
  }

  _safeName(name) {
    const str = String(name || '').trim();
    return str.length ? str : 'FACE';
  }

  _resolveSolidName(original, componentName, index) {
    const clean = String(original || '').trim();
    if (clean.length) return clean;
    return `${componentName}_Body${index}`;
  }

  _sanitizeFeatureId(rawId) {
    if (typeof rawId !== 'string') return null;
    const trimmed = rawId.trim();
    return trimmed.length ? trimmed : null;
  }

  _withFeaturePrefix(featureId, name, fallback = '') {
    const id = this._sanitizeFeatureId(featureId);
    const base = this._safeName(name || fallback);
    if (!id || base === id) return base;
    const prefix = `${id}_`;
    return base.startsWith(prefix) ? base : `${prefix}${base}`;
  }

  _applyFeaturePrefixToSolid(solid, featureId) {
    const id = this._sanitizeFeatureId(featureId);
    if (!id || !solid) return;

    solid.name = this._withFeaturePrefix(id, solid.name, solid.type || 'SOLID');

    const idToFace = solid._idToFaceName instanceof Map ? solid._idToFaceName : null;
    if (idToFace && idToFace.size) {
      const renamedIdToFace = new Map();
      const renamedFaceToId = new Map();
      for (const [faceId, faceName] of idToFace.entries()) {
        const renamed = this._withFeaturePrefix(id, faceName, `FACE_${faceId}`);
        renamedIdToFace.set(faceId, renamed);
        renamedFaceToId.set(renamed, faceId);
      }
      solid._idToFaceName = renamedIdToFace;
      solid._faceNameToID = renamedFaceToId;
    }

    const faceMetadata = solid._faceMetadata instanceof Map ? solid._faceMetadata : null;
    if (faceMetadata && faceMetadata.size) {
      const renamedMetadata = new Map();
      for (const [faceName, metadata] of faceMetadata.entries()) {
        const renamed = this._withFeaturePrefix(id, faceName, faceName || 'FACE');
        renamedMetadata.set(renamed, metadata);
      }
      solid._faceMetadata = renamedMetadata;
    }

    if (Array.isArray(solid._auxEdges) && solid._auxEdges.length) {
      for (const aux of solid._auxEdges) {
        if (!aux) continue;
        aux.name = this._withFeaturePrefix(id, aux.name, 'EDGE');
        if (typeof aux.faceA === 'string') {
          aux.faceA = this._withFeaturePrefix(id, aux.faceA, aux.faceA);
        }
        if (typeof aux.faceB === 'string') {
          aux.faceB = this._withFeaturePrefix(id, aux.faceB, aux.faceB);
        }
      }
    }
  }

  _applyFeaturePrefixToObject3D(object3D, featureId) {
    const id = this._sanitizeFeatureId(featureId);
    if (!id || !object3D) return;

    const renamed = this._withFeaturePrefix(id, object3D.name, object3D.type || 'Object');
    if (renamed !== object3D.name) {
      object3D.name = renamed;
    }

    if (object3D.userData && typeof object3D.userData === 'object') {
      if (typeof object3D.userData.faceName === 'string') {
        object3D.userData.faceName = this._withFeaturePrefix(id, object3D.userData.faceName, object3D.userData.faceName);
      }
      if (typeof object3D.userData.faceA === 'string') {
        object3D.userData.faceA = this._withFeaturePrefix(id, object3D.userData.faceA, object3D.userData.faceA);
      }
      if (typeof object3D.userData.faceB === 'string') {
        object3D.userData.faceB = this._withFeaturePrefix(id, object3D.userData.faceB, object3D.userData.faceB);
      }
    }

    if (Array.isArray(object3D.children) && object3D.children.length) {
      for (const child of object3D.children) {
        this._applyFeaturePrefixToObject3D(child, id);
      }
    }
  }

  async _extractFeatureInfo(bytes) {
    try {
      const buffer = this._toArrayBuffer(bytes);
      if (!buffer) return null;
      const zip = await JSZip.loadAsync(buffer);
      const candidates = ['Metadata/featureHistory.json', 'metadata/featurehistory.json'];
      for (const path of candidates) {
        const file = zip.file(path);
        if (!file) continue;
        const text = await file.async('string');
        try {
          const parsed = JSON.parse(text);
          return {
            metadata: parsed?.metadata || {},
            facets: parsed?.facets || null,
            history: parsed || null,
            historyString: text,
          };
        } catch {
          return null;
        }
      }
    } catch (err) {
      console.warn('[AssemblyComponentFeature] Failed to extract feature history from component:', err);
    }
    return null;
  }

  _toArrayBuffer(uint8) {
    if (!(uint8 instanceof Uint8Array)) return null;
    if (uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength) {
      return uint8.buffer;
    }
    return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
  }
}
