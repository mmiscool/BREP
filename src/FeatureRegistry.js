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
import { ImageHeightmapSolidFeature } from './features/imageHeightSolid/ImageHeightmapSolidFeature.js';
import { TransformFeature } from './features/transform/TransformFeature.js';
import { OverlapCleanupFeature } from './features/overlapCleanup/OverlapCleanupFeature.js';
import { HelixFeature } from './features/helix/HelixFeature.js';
import { HoleFeature } from './features/hole/HoleFeature.js';
import { PatternFeature } from './features/pattern/PatternFeature.js';
import { PatternLinearFeature } from './features/patternLinear/PatternLinearFeature.js';
import { PatternRadialFeature } from './features/patternRadial/PatternRadialFeature.js';
import { TubeFeature } from './features/tube/TubeFeature.js';
import { AssemblyComponentFeature } from './features/assemblyComponent/AssemblyComponentFeature.js';
import { OffsetShellFeature } from './features/offsetShell/OffsetShellFeature.js';
import { SplineFeature } from './features/spline/SplineFeature.js';
import { SheetMetalTabFeature } from './features/sheetMetal/SheetMetalTabFeature.js';
import { SheetMetalContourFlangeFeature } from './features/sheetMetal/SheetMetalContourFlangeFeature.js';
import { SheetMetalFlangeFeature } from './features/sheetMetal/SheetMetalFlangeFeature.js';
import { SheetMetalCutoutFeature } from './features/sheetMetal/SheetMetalCutoutFeature.js';

/* ========================================================================
   FeatureRegistry
   Maps feature type strings → constructors.
   (Renamed local var to FeatureClass to avoid confusion; it’s the constructor.)
   ======================================================================== */

const normalizeName = (value) => {
  if (value == null && value !== 0) return '';
  try {
    return String(value).trim();
  } catch {
    return '';
  }
};

const normalizeKey = (value) => normalizeName(value).toUpperCase();

const getShortName = (FeatureClass) => normalizeName(
  FeatureClass?.shortName
  ?? FeatureClass?.featureShortName
  ?? FeatureClass?.name,
);

const getLongName = (FeatureClass) => normalizeName(
  FeatureClass?.longName
  ?? FeatureClass?.featureName
  ?? FeatureClass?.name,
);

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
    this.register(SplineFeature);
    this.register(HelixFeature);
    this.register(ExtrudeFeature);
    this.register(BooleanFeature);
    this.register(FilletFeature);
    this.register(ChamferFeature);
    this.register(OffsetShellFeature);
    this.register(SheetMetalTabFeature);
    this.register(SheetMetalContourFlangeFeature);
    this.register(SheetMetalFlangeFeature);
    this.register(SheetMetalCutoutFeature);
    this.register(LoftFeature);
    this.register(MirrorFeature);
    this.register(RevolveFeature);
    this.register(SweepFeature);
    this.register(HoleFeature);
    this.register(TubeFeature);
    this.register(RemeshFeature);
    this.register(ImageToFaceFeature);
    this.register(ImageHeightmapSolidFeature);
    this.register(TransformFeature);
    this.register(OverlapCleanupFeature);
    this.register(PatternLinearFeature);
    this.register(PatternRadialFeature);
    this.register(AssemblyComponentFeature);
    // Keep legacy combined Pattern for backward compatibility
    this.register(PatternFeature);

    // Backward-compat aliases for renamed features
    // Image-to-Face (formerly PNG to Face)
    this.aliases.set('PNG', ImageToFaceFeature);
    this.aliases.set('PNG TO FACE', ImageToFaceFeature);
    this.aliases.set('PNGTOFACEFEATURE', ImageToFaceFeature);
    // Heightmap solid variations
    this.aliases.set('HEIGHTMAP', ImageHeightmapSolidFeature);
    this.aliases.set('HEIGHT MAP', ImageHeightmapSolidFeature);
    this.aliases.set('IMAGE HEIGHTMAP', ImageHeightmapSolidFeature);
    // Import 3D Model (formerly STL Import)
    this.aliases.set('STL', Import3dModelFeature);
    this.aliases.set('STL IMPORT', Import3dModelFeature);
    this.aliases.set('STLIMPORT', Import3dModelFeature);
    this.aliases.set('STLIMPORTFEATURE', Import3dModelFeature);
  }

  register(FeatureClass) {
    if (!FeatureClass) return;
    if (!FeatureClass.shortName) {
      FeatureClass.shortName = FeatureClass.featureShortName || FeatureClass.name || 'FEATURE';
    }
    if (!FeatureClass.longName) {
      FeatureClass.longName = FeatureClass.featureName || FeatureClass.name || FeatureClass.shortName || 'Feature';
    }
    this.features.push(FeatureClass);
  }

  get(featureName) {
    const searchKey = normalizeKey(featureName);
    if (!searchKey) throw new Error('Feature type must be a non-empty string');
    const FeatureClass = this.features.find((fc) => {
      if (!fc) return false;
      const shortName = normalizeKey(getShortName(fc));
      const longName = normalizeKey(getLongName(fc));
      const className = normalizeKey(fc.name);
      return shortName === searchKey || longName === searchKey || className === searchKey;
    }) || this.aliases.get(searchKey);

    if (!FeatureClass) {
      throw new Error(`Feature type "${featureName}" is not registered.`);
    }
    return FeatureClass;
  }

  // Tolerant lookup: returns null instead of throwing, and also
  // accepts the class constructor name as an alias.
  getSafe(featureName) {
    const searchName = normalizeKey(featureName);
    for (const fc of this.features) {
      if (!fc) continue;
      const shortName = normalizeKey(getShortName(fc));
      const longName = normalizeKey(getLongName(fc));
      const className = normalizeKey(fc.name);
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

  // list all registered feature names
  listFeatureNames(shortNames = false) {
    return this.features.map((fc) => (shortNames ? getShortName(fc) : getLongName(fc)));
  }
}
