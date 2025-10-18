import { Cylinder } from '../BREP/primitives.js';
import { OffsetShellSolid } from '../BREP/OffsetShellSolid.js';

/**
 * Ensure offset-shell face grouping keeps the new caps aligned with their source faces.
 * We offset a simple analytic cylinder inward and measure how far the labelled cap
 * triangles drift away from the expected offset plane. A large deviation indicates
 * that triangles from the opposite side of the solid were mis-bucketed.
 */
export async function test_offsetShellGrouping(partHistory) {
  const radius = 2;
  const height = 4;
  const resolution = 16;
  const offsetDistance = -1;

  const source = new Cylinder({ radius, height, resolution, name: 'CYL' });
  const shell = OffsetShellSolid.generate(source, offsetDistance, {
    newSolidName: 'CYL_shell',
    featureId: 'TEST',
  });

  const faces = shell.getFaces(false);
  const topFaceName = 'CYL_shell_CYL_T';
  const bottomFaceName = 'CYL_shell_CYL_B';

  const topFace = faces.find((f) => f.faceName === topFaceName);
  const bottomFace = faces.find((f) => f.faceName === bottomFaceName);

  if (!topFace) {
    throw new Error(`Offset shell test could not find expected top face "${topFaceName}".`);
  }
  if (!bottomFace) {
    throw new Error(`Offset shell test could not find expected bottom face "${bottomFaceName}".`);
  }
  if (!Array.isArray(topFace.triangles) || !topFace.triangles.length) {
    throw new Error(`Offset shell top face "${topFaceName}" has no triangles to validate.`);
  }
  if (!Array.isArray(bottomFace.triangles) || !bottomFace.triangles.length) {
    throw new Error(`Offset shell bottom face "${bottomFaceName}" has no triangles to validate.`);
  }

  const expectedDot = offsetDistance;
  const tolerance = 0.35; // allow a generous margin for marching-cubes artefacts

  const centroidY = (tri) => (tri.p1[1] + tri.p2[1] + tri.p3[1]) / 3;

  const checkFaceOffsets = (face, normal, planePoint, label) => {
    const [nx, ny, nz] = normal;
    const [px, py, pz] = planePoint;
    let worstDeviation = 0;

    for (const tri of face.triangles) {
      const cx = (tri.p1[0] + tri.p2[0] + tri.p3[0]) / 3;
      const cy = centroidY(tri);
      const cz = (tri.p1[2] + tri.p2[2] + tri.p3[2]) / 3;
      const dot = nx * (cx - px) + ny * (cy - py) + nz * (cz - pz);
      const deviation = Math.abs(dot - expectedDot);
      if (deviation > worstDeviation) worstDeviation = deviation;
    }

    if (worstDeviation > tolerance) {
      const faceRange = face.triangles.reduce(
        (acc, tri) => {
          const cy = centroidY(tri);
          if (cy < acc.min) acc.min = cy;
          if (cy > acc.max) acc.max = cy;
          return acc;
        },
        { min: Infinity, max: -Infinity },
      );
      throw new Error(
        [
          `Offset shell ${label} face deviated ${worstDeviation.toFixed(3)} (tolerance ${tolerance}).`,
          `Centroid Y range: ${faceRange.min.toFixed(3)} .. ${faceRange.max.toFixed(3)}`,
          `Triangles: ${face.triangles.length}`,
        ].join(' '),
      );
    }
  };

  checkFaceOffsets(topFace, [0, 1, 0], [0, height, 0], 'top');
  checkFaceOffsets(bottomFace, [0, -1, 0], [0, 0, 0], 'bottom');

  return partHistory;
}
