// primitives.js
// Primitive solids built on top of BetterSolid.Solid
// All classes extend Solid and author triangles via addTriangle(faceName, p1, p2, p3).

import manifold from './setupManifold.js';
import { Solid } from './BetterSolid.js';

const { Manifold, CrossSection } = manifold;

// Utilities
function rotateZupToYupMesh(mesh) {
  const stride = mesh.numProp || 3;
  const vpIn = mesh.vertProperties;
  const vp = new Float32Array(vpIn.length);
  for (let i = 0; i < vpIn.length; i += stride) {
    const x = vpIn[i + 0], y = vpIn[i + 1], z = vpIn[i + 2];
    vp[i + 0] = x;
    vp[i + 1] = z;
    vp[i + 2] = -y;
  }
  return { numProp: 3, vertProperties: vp, triVerts: mesh.triVerts };
}

function addMeshToSolid(solid, mesh, faceNameOfTriangle) {
  const { vertProperties: vp, triVerts: tv } = mesh;
  const triCount = (tv.length / 3) | 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = tv[3 * t + 0] >>> 0;
    const i1 = tv[3 * t + 1] >>> 0;
    const i2 = tv[3 * t + 2] >>> 0;
    const p0 = [vp[i0 * 3 + 0], vp[i0 * 3 + 1], vp[i0 * 3 + 2]];
    const p1 = [vp[i1 * 3 + 0], vp[i1 * 3 + 1], vp[i1 * 3 + 2]];
    const p2 = [vp[i2 * 3 + 0], vp[i2 * 3 + 1], vp[i2 * 3 + 2]];
    const name = faceNameOfTriangle(t, i0, i1, i2, p0, p1, p2);
    solid.addTriangle(name, p0, p1, p2);
  }
}

class PrimitiveBase extends Solid {
  constructor(defaults, name) {
    super();
    this.params = { ...defaults, name: name ?? defaults?.name ?? 'Solid' };
    this.name = this.params.name;
    this.generate();
  }
}

// Pyramid (regular base)
export class Pyramid extends PrimitiveBase {
  constructor({ bL = 1, s = 4, h = 1, name = 'Pyramid' } = {}) {
    super({ bL, s, h, name }, name);
  }
  generate() {
    const s = Math.max(3, (this.params.s | 0));
    const { bL, h } = this.params;
    const R = bL / (2 * Math.sin(Math.PI / s));
    const apex = [0, h, 0];
    const ring = [];
    for (let i = 0; i < s; i++) {
      const a = (i / s) * Math.PI * 2;
      ring.push([R * Math.cos(a), 0, R * Math.sin(a)]);
    }
    // Sides
    for (let i = 0; i < s; i++) {
      const j = (i + 1) % s;
      this.addTriangle(`${this.params.name}_S[${i}]`, apex, ring[i], ring[j]);
    }
    // Base (fan)
    for (let i = 1; i < s - 1; i++) {
      this.addTriangle(`${this.params.name}_Base`, ring[0], ring[i], ring[i + 1]);
    }
  }
}

export class Sphere extends PrimitiveBase {
  constructor({ r = 1, resolution = 24, name = 'Sphere' } = {}) {
    super({ r, resolution, name }, name);
  }
  generate() {
    const segs = Math.max(8, (this.params.resolution | 0));
    const m = Manifold.sphere(this.params.r, segs);
    try {
      const mg = m.getMesh();
      try {
        const mesh = rotateZupToYupMesh(mg);
        addMeshToSolid(this, mesh, () => this.params.name);
      } finally { try { if (mg && typeof mg.delete === 'function') mg.delete(); } catch {} }
    } finally { try { if (m && typeof m.delete === 'function') m.delete(); } catch {} }
  }
}

export class Torus extends PrimitiveBase {
  constructor({ mR = 2, tR = 0.5, resolution = 48, arcDegrees = 360, name = 'Torus' } = {}) {
    super({ mR, tR, resolution, arcDegrees, name }, name);
  }
  generate() {
    const { mR, tR, arcDegrees } = this.params;
    const seg = Math.max(8, (this.params.resolution | 0));
    const cs = CrossSection.circle(tR, seg / 2).translate(mR, 0);
    const m = cs.revolve(seg, arcDegrees);
    const use = (() => {
      const mg = m.getMesh();
      try { return rotateZupToYupMesh(mg); } finally { try { if (mg && typeof mg.delete === 'function') mg.delete(); } catch {} }
    })();
    try { if (m && typeof m.delete === 'function') m.delete(); } catch {}

    // classify caps if open arc
    const FULL = arcDegrees >= 360 - 1e-6;
    const vp = use.vertProperties;
    const tv = use.triVerts;
    const triCount = (tv.length / 3) | 0;
    const TAU = Math.PI * 2; const norm = (a)=>{let x=a%TAU; if(x<0)x+=TAU; return x;};
    const V = (vp.length / 3) | 0;
    const uOfV = new Float32Array(V);
    for (let i=0;i<V;i++){ const x=vp[3*i+0], z=vp[3*i+2]; let u=Math.atan2(-z,x); if(u<0)u+=TAU; uOfV[i]=u; }
    const uniq = Array.from(new Set(Array.from(uOfV).map(u=>+u.toFixed(9)))).sort((a,b)=>a-b);
    let duEst=0; for(let i=1;i<uniq.length;i++){ const d=uniq[i]-uniq[i-1]; if(d>1e-6 && (!duEst || d<duEst)) duEst=d; }
    if(!duEst) duEst = (arcDegrees*Math.PI/180)/Math.max(8,seg);
    const sweep = (arcDegrees/360)*TAU;
    const circDist = (a,b)=>{const d=Math.abs(norm(a)-norm(b)); return Math.min(d, TAU-d);} ;
    const CAP_THR = Math.max(1e-6, Math.min(duEst*0.49, 0.25));

    addMeshToSolid(this, use, (t,i0,i1,i2)=>{
      if (FULL) return `${this.params.name}_Side`;
      const near0 = [i0,i1,i2].every(i=>circDist(uOfV[i],0)<=CAP_THR);
      if (near0) return `${this.params.name}_Cap0`;
      const nearS = [i0,i1,i2].every(i=>circDist(uOfV[i],sweep)<=CAP_THR);
      return nearS ? `${this.params.name}_Cap1` : `${this.params.name}_Side`;
    });
  }
}

export class Cube extends PrimitiveBase {
  constructor({ x = 1, y = 1, z = 1, name = 'Cube' } = {}) {
    super({ x, y, z, name }, name);
  }
  generate() {
    const { x, y, z } = this.params;
    const p000 = [0, 0, 0], p100 = [x, 0, 0], p010 = [0, y, 0], p110 = [x, y, 0];
    const p001 = [0, 0, z], p101 = [x, 0, z], p011 = [0, y, z], p111 = [x, y, z];
    // NX (x=0)
    this.addTriangle(`${this.params.name}_NX`, p000, p001, p011);
    this.addTriangle(`${this.params.name}_NX`, p000, p011, p010);
    // PX (x=x)
    this.addTriangle(`${this.params.name}_PX`, p100, p110, p111);
    this.addTriangle(`${this.params.name}_PX`, p100, p111, p101);
    // NY (y=0)
    this.addTriangle(`${this.params.name}_NY`, p000, p100, p101);
    this.addTriangle(`${this.params.name}_NY`, p000, p101, p001);
    // PY (y=y)
    this.addTriangle(`${this.params.name}_PY`, p010, p011, p111);
    this.addTriangle(`${this.params.name}_PY`, p010, p111, p110);
    // NZ (z=0)
    this.addTriangle(`${this.params.name}_NZ`, p000, p010, p110);
    this.addTriangle(`${this.params.name}_NZ`, p000, p110, p100);
    // PZ (z=z)
    this.addTriangle(`${this.params.name}_PZ`, p001, p101, p111);
    this.addTriangle(`${this.params.name}_PZ`, p001, p111, p011);
  }
}

export class Cylinder extends PrimitiveBase {
  constructor({ radius = 1, height = 1, resolution = 32, name = 'Cylinder' } = {}) {
    super({ radius, height, resolution, name }, name);
  }
  generate() {
    const { radius: r, height: h } = this.params;
    const n = Math.max(3, (this.params.resolution | 0));
    const step = (Math.PI * 2) / n;
    const ring0 = [], ring1 = [];
    for (let i = 0; i < n; i++) {
      const a = i * step; const x = Math.cos(a) * r; const z = Math.sin(a) * r;
      ring0[i] = [x, 0, z]; ring1[i] = [x, h, z];
    }
    // caps
    for (let i = 0; i < n; i++) { const j = (i + 1) % n;
      this.addTriangle(`${this.params.name}_B`, [0,0,0], ring0[j], ring0[i]);
      this.addTriangle(`${this.params.name}_T`, [0,h,0], ring1[i], ring1[j]);
    }
    // sides
    for (let i = 0; i < n; i++) { const j = (i + 1) % n;
      this.addTriangle(`${this.params.name}_S`, ring0[i], ring0[j], ring1[j]);
      this.addTriangle(`${this.params.name}_S`, ring0[i], ring1[j], ring1[i]);
    }
    
    // Store cylindrical face metadata with radius information
    this.setFaceMetadata(`${this.params.name}_S`, {
      type: 'cylindrical',
      radius: r,
      height: h,
      axis: [0, 1, 0], // Y-axis is the cylinder axis
      center: [0, h/2, 0] // Center point of the cylinder axis
    });
  }
}

export class Cone extends PrimitiveBase {
  constructor({ r1 = 0.5, r2 = 1, h = 1, resolution = 32, name = 'Cone' } = {}) {
    super({ r1, r2, h, resolution, name }, name);
  }
  generate() {
    const { r1, r2, h } = this.params;
    const n = Math.max(3, (this.params.resolution | 0));
    const step = (Math.PI * 2) / n;
    const ringB = [], ringT = [];
    for (let i = 0; i < n; i++) {
      const a = i * step; const c = Math.cos(a), s = Math.sin(a);
      ringB[i] = [r2 * c, 0, r2 * s];
      ringT[i] = [r1 * c, h, r1 * s];
    }
    // caps if non-zero radii
    if (r2 > 0) {
      for (let i = 0; i < n; i++) { const j = (i + 1) % n;
        this.addTriangle(`${this.params.name}_B`, [0,0,0], ringB[j], ringB[i]);
      }
    }
    if (r1 > 0) {
      for (let i = 0; i < n; i++) { const j = (i + 1) % n;
        this.addTriangle(`${this.params.name}_T`, [0,h,0], ringT[i], ringT[j]);
      }
    }
    // sides
    for (let i = 0; i < n; i++) { const j = (i + 1) % n;
      this.addTriangle(`${this.params.name}_S`, ringB[i], ringB[j], ringT[j]);
      this.addTriangle(`${this.params.name}_S`, ringB[i], ringT[j], ringT[i]);
    }
    
    // Store conical face metadata with radius information
    this.setFaceMetadata(`${this.params.name}_S`, {
      type: 'conical',
      radiusBottom: r2,
      radiusTop: r1,
      height: h,
      axis: [0, 1, 0], // Y-axis is the cone axis
      center: [0, h/2, 0] // Center point of the cone axis
    });
  }
}
