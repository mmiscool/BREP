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
import { stlImport } from './features/stlImport/stlImport.js';
import { SweepFeature } from './features/sweep/SweepFeature.js';
import { RemeshFeature } from './features/remesh/RemeshFeature.js';
import { PngToFaceFeature } from './features/pngToFace/PngToFaceFeature.js';

/* ========================================================================
   FeatureRegistry
   Maps feature type strings → constructors.
   (Renamed local var to FeatureClass to avoid confusion; it’s the constructor.)
   ======================================================================== */

export class FeatureRegistry {
  constructor() {
    this.features = [];
    this.register(DatiumFeature);
    this.register(PlaneFeature);
    this.register(PrimitiveCubeFeature);
    this.register(PrimitiveCylinderFeature);
    this.register(PrimitiveConeFeature);
    this.register(PrimitiveSphereFeature);
    this.register(PrimitiveTorusFeature);
    this.register(PrimitivePyramidFeature);
    this.register(stlImport);
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
    this.register(PngToFaceFeature);
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
}
