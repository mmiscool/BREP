// setupManifold.js (ESM)
// Universal loader that works in both Node.js and the browser (Vite)

import Module from 'manifold-3d';

const isNode =
  typeof window === 'undefined' ||
  (typeof process !== 'undefined' && process.versions?.node);

export const manifold = await (async () => {
  if (isNode) {
    // Node.js: no locateFile needed
    const wasm = await Module();
    if (typeof wasm.setup === 'function') await wasm.setup();
    return wasm;
  } else {
    // Browser (Vite): use ?url to get the WASM asset URL
    const { default: wasmUrl } = await import('manifold-3d/manifold.wasm?url');
    const wasm = await Module({
      locateFile: () => wasmUrl,
    });
    if (typeof wasm.setup === 'function') await wasm.setup();
    window.manifold = wasm; // for debugging in browser console
    return wasm;
  }
})();

export default manifold;
