import { BooleanFeature } from './features/boolean/BooleanFeature.js';
import { ChamferFeature } from './features/chamfer/ChamferFeature.js';
import { DatiumFeature } from './features/datium/DatiumFeature.js';
import { ExtrudeFeature } from './features/extrude/ExtrudeFeature.js';
import { FilletFeature } from './features/fillet/FilletFeature.js';
import { LoftFeature } from './features/loft/LoftFeature.js';
import { MirrorFeature } from './features/mirror/MirrorFeature.js';
import { PlaneFeature } from './features/plane/PlaneFeature.js';
import { PrimitiveConeFeature } from './features/primitiveCone/primitiveConeFeature.js';
import { PrimitiveCubeFeature } from './features/primitiveCube/primitiveCubeFeature.js';
import { PrimitiveCylinderFeature } from './features/primitiveCylinder/primitiveCylinderFeature.js';
import { PrimitivePyramidFeature } from './features/primitivePyramid/primitivePyramidFeature.js';
import { PrimitiveSphereFeature } from './features/primitiveSphere/primitiveSphereFeature.js';
import { PrimitiveTorusFeature } from './features/primitiveTorus/primitiveTorusFeature.js';
import { RevolveFeature } from './features/revolve/RevolveFeature.js';
import { SketchFeature } from './features/sketch/SketchFeature.js';
import { Import3dModelFeature } from './features/import3dModel/Import3dModelFeature.js';
import { SweepFeature } from './features/sweep/SweepFeature.js';
import { RemeshFeature } from './features/remesh/RemeshFeature.js';
import { ImageToFaceFeature } from './features/imageToFace/ImageToFaceFeature.js';
import { TransformFeature } from './features/transform/TransformFeature.js';
import { PatternFeature } from './features/pattern/PatternFeature.js';
import { PatternLinearFeature } from './features/patternLinear/PatternLinearFeature.js';
import { PatternRadialFeature } from './features/patternRadial/PatternRadialFeature.js';

/* ========================================================================
   FeatureRegistry
   Maps feature type strings → constructors.
   (Renamed local var to FeatureClass to avoid confusion; it’s the constructor.)
   ======================================================================== */

export class FeatureRegistry {
  constructor() {
    this.features = [];
    this.aliases = new Map();
    this.register(DatiumFeature);
    this.register(PlaneFeature);
    this.register(PrimitiveCubeFeature);
    this.register(PrimitiveCylinderFeature);
    this.register(PrimitiveConeFeature);
    this.register(PrimitiveSphereFeature);
    this.register(PrimitiveTorusFeature);
    this.register(PrimitivePyramidFeature);
    this.register(Import3dModelFeature);
    this.register(SketchFeature);
    this.register(ExtrudeFeature);
    this.register(BooleanFeature);
    this.register(FilletFeature);
    this.register(ChamferFeature);
    this.register(LoftFeature);
    this.register(MirrorFeature);
    this.register(RevolveFeature);
    this.register(SweepFeature);
    this.register(RemeshFeature);
    this.register(ImageToFaceFeature);
    this.register(TransformFeature);
    this.register(PatternLinearFeature);
    this.register(PatternRadialFeature);
    // Keep legacy combined Pattern for backward compatibility
    this.register(PatternFeature);

    // Backward-compat aliases for renamed features
    // Image-to-Face (formerly PNG to Face)
    this.aliases.set('PNG', ImageToFaceFeature);
    this.aliases.set('PNG TO FACE', ImageToFaceFeature);
    this.aliases.set('PNGTOFACEFEATURE', ImageToFaceFeature);
    // Import 3D Model (formerly STL Import)
    this.aliases.set('STL', Import3dModelFeature);
    this.aliases.set('STL IMPORT', Import3dModelFeature);
    this.aliases.set('STLIMPORT', Import3dModelFeature);
    this.aliases.set('STLIMPORTFEATURE', Import3dModelFeature);
  }

  register(FeatureClass) {
    this.features.push(FeatureClass);
  }

  get(featureName) {
    const searchName = featureName.toUpperCase();
    const FeatureClass = this.features.find(fc => fc.featureShortName.toUpperCase() === searchName ||
      (fc.featureName && fc.featureName.toUpperCase() === searchName)
    );

    if (!FeatureClass) {
      throw new Error(`Feature type "${featureName}" is not registered.`);
    }
    return FeatureClass;
  }

  // Tolerant lookup: returns null instead of throwing, and also
  // accepts the class constructor name as an alias.
  getSafe(featureName) {
    const searchName = String(featureName || '').trim().toUpperCase();
    for (const fc of this.features) {
      if (!fc) continue;
      let shortName = null, longName = null, className = null;
      try { shortName = fc.featureShortName != null ? String(fc.featureShortName).trim().toUpperCase() : null; } catch { shortName = null; }
      try { longName = fc.featureName != null ? String(fc.featureName).trim().toUpperCase() : null; } catch { longName = null; }
      try { className = fc.name ? String(fc.name).trim().toUpperCase() : null; } catch { className = null; }
      if (shortName === searchName || longName === searchName || className === searchName) return fc;
    }
    // Aliases for new split pattern features
    if (searchName === 'PATTERN' || searchName === 'PATTERN FEATURE') return PatternLinearFeature;
    if (searchName === 'PATTERN LINEAR') return PatternLinearFeature;
    if (searchName === 'PATTERN RADIAL') return PatternRadialFeature;
    return this.aliases.get(searchName) || null;
  }

  has(featureName) {
    return !!this.getSafe(featureName);
  }
}
