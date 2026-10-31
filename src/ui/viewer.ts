import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const EDGE_LIMIT = 150_000; // triangles; edge extraction is skipped above this to keep big models responsive

/** One WebGL view of a triangle soup. Renders on demand (no animation loop), so idle views cost nothing. */
export class Viewer {
  readonly el = document.createElement("div");
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  private controls: OrbitControls;
  private home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private geometry: THREE.BufferGeometry;
  private ro: ResizeObserver;
  private frame = 0;

  constructor(positions: Float32Array) {
    this.el.className = "viewer";
    this.el.append(this.renderer.domElement);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.computeVertexNormals(); // non-indexed, so shading is flat per facet
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({ color: 0x8fa8cc, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.scene.add(new THREE.Mesh(this.geometry, mat));
    if (positions.length / 9 <= EDGE_LIMIT) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry, 28), new THREE.LineBasicMaterial({ color: 0x1f2a3a, transparent: true, opacity: 0.55 }));
      this.scene.add(edges);
    }
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(key);
    this.scene.add(this.camera);

    // CAD convention: Z is up.
    this.camera.up.set(0, 0, 1);
    const sphere = this.geometry.boundingSphere!;
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.camera.near = sphere.radius / 100;
    this.camera.far = sphere.radius * 100;
    this.camera.updateProjectionMatrix();
    this.home.target.copy(sphere.center);
    this.home.pos.copy(sphere.center).add(new THREE.Vector3(1, -1.2, 0.8).normalize().multiplyScalar(dist));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.schedule());
    this.reset();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }

  reset() {
    this.camera.position.copy(this.home.pos);
    this.controls.target.copy(this.home.target);
    this.controls.update();
    this.schedule();
  }

  private resize() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.schedule();
  }

  /** Call after the element is (re)attached to the page. */
  attached() {
    this.resize();
  }

  private schedule() {
    if (this.frame) return;
    // setTimeout, not rAF: rAF never fires in a background tab.
    this.frame = window.setTimeout(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    }, 0);
  }

  dispose() {
    this.ro.disconnect();
    this.controls.dispose();
    this.geometry.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
  }
}
