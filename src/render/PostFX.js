import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

/**
 * The post-processing chain. Owns HDR render targets and all screen-space effects.
 *
 * CONTRACT:
 *   enabled : boolean
 *   render()
 *   setSize(w, h)
 *   hurtFlash(amount) / grade(name)  -- gameplay-driven grade hooks
 */
export class PostFX {
  constructor(game) {
    this.game = game;
    this.enabled = true;
    this.composer = null;
  }

  async init() {
    const { renderer, scene, camera } = this.game;
    const size = this.game.engine.drawingSize;

    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        colorSpace: THREE.LinearSRGBColorSpace,
        samples: 0,
      })
    );
    this.composer.addPass(new RenderPass(scene, camera));
    this.game.engine.attachPostFX(this);
  }

  hurtFlash() {}

  grade() {}

  setSize(w, h) {
    this.composer?.setSize(w, h);
  }

  render() {
    this.composer.render(this.game.time.dt);
  }

  dispose() {
    this.composer?.dispose();
  }
}
