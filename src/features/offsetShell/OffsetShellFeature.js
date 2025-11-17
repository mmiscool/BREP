import { OffsetShellSolid } from '../../BREP/OffsetShellSolid.js';

const inputParamsSchema = {
  featureID: {
    type: 'string',
    default_value: null,
    hint: 'Optional identifier used when naming the generated solid and faces',
  },
  distance: {
    type: 'number',
    default_value: 1,
    hint: 'Positive grows the shell, negative shrinks it',
  },
  faces: {
    type: 'reference_selection',
    selectionFilter: ['FACE'],
    multiple: true,
    default_value: [],
    hint: 'Pick one or more faces on the solid to shell (used to find the solid)',
  },
};

export class OffsetShellFeature {
  static shortName = 'O.S';
  static longName = 'Offset Shell';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const faceEntries = Array.isArray(this.inputParams.faces) ? this.inputParams.faces.filter(Boolean) : [];
    if (!faceEntries.length) {
      console.warn('[OffsetShellFeature] No faces selected.');
      return { added: [], removed: [] };
    }

    const solids = new Set();
    for (const entry of faceEntries) {
      if (!entry || entry.type !== 'FACE') continue;
      const solid = entry.parentSolid || (entry.parent && entry.parent.type === 'SOLID' ? entry.parent : null);
      if (solid) solids.add(solid);
    }

    if (!solids.size) {
      console.warn('[OffsetShellFeature] Selected faces are not attached to a solid.');
      return { added: [], removed: [] };
    }
    if (solids.size > 1) {
      console.warn('[OffsetShellFeature] Faces from multiple solids selected; aborting offset shell.');
      return { added: [], removed: [] };
    }

    const targetSolid = solids.values().next().value;

    const dist = Number(this.inputParams.distance);
    if (!Number.isFinite(dist) || dist === 0) {
      console.warn('[OffsetShellFeature] Distance must be a non-zero finite number.');
      return { added: [], removed: [] };
    }

    const fallbackId = OffsetShellFeature.shortName || OffsetShellFeature.longName || 'OffsetShell';
    const featureId = (this.inputParams.featureID || fallbackId).trim();
    const newSolidName = `${targetSolid.name || 'Solid'}_${featureId}`;

    let resultSolid = null;
    try {
      resultSolid = OffsetShellSolid.generate(targetSolid, dist, {
        featureId,
        newSolidName,
      });
    } catch (err) {
      console.error('[OffsetShellFeature] Solid.offsetShell failed:', err);
      return { added: [], removed: [] };
    }

    if (!resultSolid) {
      console.warn('[OffsetShellFeature] offsetShell returned no result.');
      return { added: [], removed: [] };
    }

    try { resultSolid.name = newSolidName; } catch {}
    try { resultSolid.visualize(); } catch {}

    return { added: [resultSolid], removed: [] };
  }
}
