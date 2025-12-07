import * as THREE from 'three';

export class AssemblyComponent extends THREE.Group {
  /**
   * @param {object} [options]
   * @param {string} [options.name='Component'] Component name
   * @param {boolean} [options.fixed=false] Whether the component is fixed in assemblies
   */
  constructor({ name = 'Component', fixed = false } = {}) {
    super();
    this.type = 'COMPONENT';
    this.name = name;
    this.fixed = !!fixed;
    this.isAssemblyComponent = true;
  }

  addBody(body) {
    if (!body) return;
    try {
      if (!body.type) body.type = 'SOLID';
      this.add(body);
    } catch {
      this.add(body);
    }
  }

  async visualize() {
    for (const child of this.children) {
      if (child && typeof child.visualize === 'function') {
        try { await child.visualize(); } catch { /* ignore */ }
      }
    }
  }

  async free() {
    for (const child of this.children) {
      if (child && typeof child.free === 'function') {
        try { await child.free(); } catch { /* ignore */ }
      }
    }
  }
}
