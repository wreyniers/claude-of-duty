import * as THREE from 'three';
import { LAYER_VIEWMODEL, LAYER_WORLD } from './Layers.js';

/**
 * Owns the WebGL device, the cameras, and the frame's draw order.
 *
 * Draw order per frame:
 *   1. world scene  -> HDR render target (via PostFX composer)
 *   2. post chain   -> AO, bloom, motion blur, grade, AA
 *   3. view model   -> drawn last with depth cleared, so the gun never clips
 *
 * Everything colour-critical stays linear until the grade pass; the renderer's
 * own tone mapping is disabled because PostFX owns the ACES fit.
 */
export class Engine {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // MSAA is useless with a deferred-ish post chain; SMAA handles edges
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // PostFX applies the ACES fit itself so grading happens in linear space.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

    this.renderer.info.autoReset = false;

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.viewmodelScene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.08, 900);
    this.camera.layers.enable(LAYER_WORLD);
    this.camera.layers.disable(LAYER_VIEWMODEL);

    // Short near plane keeps the barrel from being sliced by the frustum.
    this.viewmodelCamera = new THREE.PerspectiveCamera(settings.viewmodelFov, 1, 0.008, 12);
    this.viewmodelCamera.layers.set(LAYER_VIEWMODEL);

    this.postfx = null; // installed by PostFX
    this.size = new THREE.Vector2(1, 1);
    this.drawingSize = new THREE.Vector2(1, 1);
    // Split of the frame's GPU cost. Under a software rasteriser the driver calls
    // are synchronous CPU work, so wall-clock here is real and worth having: it
    // is the only way to tell a slow post chain from a slow world pass.
    this.timings = { world: 0, viewmodel: 0 };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /** PostFX registers itself so the engine can hand it resize + render duties. */
  attachPostFX(postfx) {
    this.postfx = postfx;
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.size.set(w, h);

    const scale = this.settings.renderScale ?? 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * scale);
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(this.drawingSize);

    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();

    this.postfx?.setSize(this.drawingSize.x, this.drawingSize.y);
  }

  /**
   * Horizontal FOV is what players actually set; Three wants vertical. Converting
   * keeps a 90 "FOV" identical to what a shooter would show at 16:9 and stops
   * ultrawide monitors from cropping the view.
   */
  setHorizontalFov(hFovDeg) {
    const hFov = THREE.MathUtils.degToRad(hFovDeg);
    const vFov = 2 * Math.atan(Math.tan(hFov / 2) / Math.max(this.camera.aspect, 0.0001));
    this.camera.fov = THREE.MathUtils.radToDeg(vFov);
    this.camera.updateProjectionMatrix();
  }

  setViewmodelFov(deg) {
    this.viewmodelCamera.fov = deg;
    this.viewmodelCamera.updateProjectionMatrix();
  }

  render() {
    const r = this.renderer;
    r.info.reset();

    // The view model camera always inherits the world camera's orientation; the
    // ViewModel module then applies its own local sway/recoil offsets.
    this.viewmodelCamera.position.copy(this.camera.position);
    this.viewmodelCamera.quaternion.copy(this.camera.quaternion);

    const t0 = performance.now();
    if (this.postfx?.enabled) {
      this.postfx.render();
    } else {
      r.setRenderTarget(null);
      r.clear();
      r.render(this.scene, this.camera);
    }
    const t1 = performance.now();

    // Weapon pass: keep the colour buffer, throw away depth.
    r.autoClear = false;
    r.clearDepth();
    r.render(this.viewmodelScene, this.viewmodelCamera);
    r.autoClear = true;

    this.timings.world = t1 - t0;
    this.timings.viewmodel = performance.now() - t1;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.postfx?.dispose();
    this.renderer.dispose();
  }
}
