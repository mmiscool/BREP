// Public entry point for the BREP kernel package
// Expose the core BREP kernel and part history classes

export { BREP } from './BREP/BREP.js';

// Part history API
export { PartHistory, extractDefaultValues } from './PartHistory.js';

// Assembly constraints history and registry (useful when working with PartHistory)
export { AssemblyConstraintHistory } from './assemblyConstraints/AssemblyConstraintHistory.js';
export { AssemblyConstraintRegistry } from './assemblyConstraints/AssemblyConstraintRegistry.js';

