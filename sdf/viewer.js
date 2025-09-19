// Minimalist Three.js mesh viewer (ES6)
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Mount a viewer into a DOM element.
 * @param {HTMLElement} container - host element
 * @param {{ vertices:number[][]|Float32Array, indices:number[]|Uint32Array }} mesh
 * @param {{ fit?: boolean }} opts
 * @returns {{ dispose:()=>void, setMesh:(mesh)=>void }}
 */
export function mountViewer(container, mesh, opts = {}) {
    const fit = opts.fit ?? true;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x0b0f12, 1);
    container.appendChild(renderer.domElement);

    // Scene + Camera
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f12);

    const camera = new THREE.PerspectiveCamera(
        50,
        container.clientWidth / container.clientHeight,
        0.01,
        1000
    );
    camera.position.set(1.6, 1.2, 1.6);

    // Lights
    const hemi = new THREE.HemisphereLight(0x93c5fd, 0x0b0f12, 0.8);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(2.5, 3.0, 2.0);
    dir.castShadow = false;
    scene.add(dir);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.screenSpacePanning = false;

    // Grid (optional)
    const grid = new THREE.GridHelper(10, 10, 0x1f2937, 0x0f172a);
    grid.visible = false; // dark and minimal by default
    scene.add(grid);

    // Mesh state
    let meshObj = null;
    let edgesObj = null;

    function toGeometry(vertices, indices) {
        const geo = new THREE.BufferGeometry();

        // Accept both arrays of vec3 [[x,y,z],...] or a flat Float32Array
        let position;
        if (Array.isArray(vertices)) {
            const flat = new Float32Array(vertices.length * 3);
            for (let i = 0; i < vertices.length; i++) {
                flat[i * 3 + 0] = vertices[i][0];
                flat[i * 3 + 1] = vertices[i][1];
                flat[i * 3 + 2] = vertices[i][2];
            }
            position = flat;
        } else {
            position = vertices;
        }

        geo.setAttribute('position', new THREE.BufferAttribute(position, 3));

        // 32-bit indices
        const idx = (indices instanceof Uint32Array) ? indices : new Uint32Array(indices);
        geo.setIndex(new THREE.BufferAttribute(idx, 1));

        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        return geo;
    }

    function applyMesh(data) {
        // Clean old
        if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); meshObj.material.dispose(); meshObj = null; }
        if (edgesObj) { scene.remove(edgesObj); edgesObj.geometry.dispose(); edgesObj.material.dispose(); edgesObj = null; }

        const geometry = toGeometry(data.vertices, data.indices);

        const material = new THREE.MeshStandardMaterial({
            color: 0xb3c5d7,
            roughness: 0.55,
            metalness: 0.05,
            wireframe: false,
            polygonOffset: true,
            side: THREE.DoubleSide,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });

        meshObj = new THREE.Mesh(geometry, material);
        scene.add(meshObj);

        // Edges (toggle with E)
        const edgesGeo = new THREE.EdgesGeometry(geometry, 20); // thresholdAngle 20 deg
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, linewidth: 1 });
        edgesObj = new THREE.LineSegments(edgesGeo, edgesMat);
        edgesObj.visible = false;
        scene.add(edgesObj);

        if (fit && geometry.boundingSphere) {
            const bs = geometry.boundingSphere;
            const r = Math.max(bs.radius, 1e-3);
            const target = bs.center;
            controls.target.copy(target);
            const dist = r * 3.0;
            const dirVec = new THREE.Vector3(1, 0.6, 1).normalize();
            camera.position.copy(target.clone().add(dirVec.multiplyScalar(dist)));
            camera.near = Math.max(0.001, r * 0.01);
            camera.far = Math.max(1000, dist * 20);
            camera.updateProjectionMatrix();
        }
    }

    // Initial mesh (if provided)
    if (mesh && mesh.vertices && mesh.indices) {
        applyMesh(mesh);
    }

    // Resize
    function onResize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // Hotkeys: W=wireframe, E=edges, G=grid
    function onKey(e) {
        if (!meshObj) return;
        if (e.key === 'w' || e.key === 'W') {
            meshObj.material.wireframe = !meshObj.material.wireframe;
        } else if (e.key === 'e' || e.key === 'E') {
            if (edgesObj) edgesObj.visible = !edgesObj.visible;
        } else if (e.key === 'g' || e.key === 'G') {
            grid.visible = !grid.visible;
        }
    }
    window.addEventListener('keydown', onKey);

    // Render loop
    let rafId = 0;
    function tick() {
        rafId = requestAnimationFrame(tick);
        controls.update();
        renderer.render(scene, camera);
    }
    tick();

    return {
        setMesh: (data) => applyMesh(data),
        dispose: () => {
            cancelAnimationFrame(rafId);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('keydown', onKey);
            controls.dispose();
            if (meshObj) { meshObj.geometry.dispose(); meshObj.material.dispose(); }
            if (edgesObj) { edgesObj.geometry.dispose(); edgesObj.material.dispose(); }
            renderer.dispose();
            if (renderer.domElement && renderer.domElement.parentNode) {
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
        }
    };
}
