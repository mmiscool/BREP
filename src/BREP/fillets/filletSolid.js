// filletSolid facade — routes to separate inset/outset implementations.
// This split keeps inset/outset generation code in distinct files without
// changing the feature UI elsewhere in the app.

export { insetFilletSolid, InsetFilletSolid } from './insetFilletSolid.js';
export { outsetFilletSolid, OutsetFilletSolid } from './outsetFilletSolid.js';

// Backward-compat wrappers retaining the old names of this module.
export function filletSolid(targetSolid, edgeName, radius, inflate = 0.1, options = {}) {
  // Default legacy behavior uses INSET generation.
  return insetFilletSolid(targetSolid, edgeName, radius, inflate, options);
}

// Lightweight alias class for legacy import paths.
export class FilletSolid extends (await import('./insetFilletSolid.js')).InsetFilletSolid {}

