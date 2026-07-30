import * as THREE from 'three';
import { CascadedShadows } from './CascadedShadows.js';

/**
 * Reflectance of the sand, paving and lime plaster this level is built out of.
 * The first bounce is sky and sun light filtered through it, so it is the spectrum
 * the hemisphere fill is tinted with rather than a hand-picked warm colour.
 */
const BOUNCE_ALBEDO = new THREE.Color(1.0, 0.8, 0.58);

/**
 * Spectrum of light arriving from *below*: the same paving, one more bounce down
 * the line and so further off the sun's own colour toward the dust it came off.
 */
const GROUND_CHROMA = new THREE.Color(1.0, 0.66, 0.4);

/**
 * Luminance of the hemisphere's lower half as a fraction of its upper half.
 *
 * A hemisphere light is the only fill term in this renderer whose strength varies
 * with which way a surface faces, so it is the only one that can put a value step
 * between a horizontal plane and a vertical one. It was being wasted: the ground
 * half was 0.74 of the sky half, and the env map — which was the larger of the two
 * fill terms, and whose below-horizon band is far brighter than a real sunlit
 * street would be — is close to isotropic. The two together delivered the same
 * fill to a floor, a wall and a soffit to within 2%, which is why every surface in
 * the frame landed in one narrow band whatever its orientation.
 *
 * A quarter is roughly two stops down, which is what a stone square in shadow
 * gives back against a lit golden-hour sky band, and it leaves the ground bounce
 * present as warmth rather than as brightness.
 */
const GROUND_FRACTION = 0.25;

/**
 * The key is Sky's `sunIrradiance` times this.
 *
 * Sky derives that figure for the dome, and the dome's radiance scale (`lum`) was
 * recalibrated down by two thirds to land the horizon band on the part of the ACES
 * curve that still has slope. The sun constant did not move with it, so the key
 * drifted down against its own sky. Measured on one paving material before this:
 * sunlit and shaded read 2.0x apart in scene-linear — one stop of key-to-fill
 * where golden hour wants three to four, and the reason the frame read flat-lit
 * rather than fogged. With the fill trims below this puts a sun-facing wall about
 * 17x over its shaded side and a horizontal plane about 5x.
 */
const KEY_BOOST = 1.9;

/**
 * Sun, cascaded shadow maps, and the local light budget.
 *
 * CONTRACT:
 *   addPointLight(pos, color, intensity, radius) -> light
 *   flash(pos, color, intensity, ms)   one-shot muzzle/explosion light
 *   update(dt)   re-fits shadow cascades to the camera each frame
 *
 * ADDITIONS (safe to rely on):
 *   addSpotLight(pos, target, color, intensity, radius, angle, penumbra) -> light
 *   release(light)                     hand a slot back early
 *   csm                                the CascadedShadows instance
 *   sun / hemi                         the sun light and the ambient fill
 *   sunIntensityScale / fillScale      artistic trims, applied every frame
 *   iblFillFactor / envFillScale       the two halves of the fill balance
 *   setShadowDistance(m) / debugCascades(bool)
 *   stats                              { pointActive, spotActive, requests, flashes }
 *
 * THE LIGHT BUDGET
 * Every light in a Three scene is a uniform slot and a per-fragment cost, and
 * changing how many there are recompiles every material in the level. So the
 * scene never sees more than a fixed pool: `addPointLight` hands back a real
 * PointLight that acts as a *request* — unparented, free to move and animate —
 * and each frame the pool is filled with the highest-scoring requests near the
 * camera. A firefight can ask for forty lights; the GPU always sees the same
 * eight, and the shader never recompiles.
 *
 * Everything the sun does is read from `game.sky` every frame rather than
 * snapshotted, so a time-of-day change moves the sun, the shadow direction, the
 * sky fill and the shadow tint together.
 */
export class Lighting {
  constructor(game) {
    this.game = game;
    this.settings = game.settings;

    this.sun = null;
    this.hemi = null;
    this.csm = null;

    this.sunIntensityScale = 1;
    this.fillScale = 1;
    // Weight of the hemisphere light once an env map is present. It is no longer a
    // fraction of the sky fill but the strength of the bounce term the hemisphere
    // takes over — see _syncSky. Trimmed along with envFillScale: the two of them
    // are what the key is measured against, and the hemisphere keeps the larger
    // share of what is left because it is the half that has a direction.
    this.iblFillFactor = 0.47;
    /**
     * `scene.environmentIntensity`, i.e. how much of the sky's IBL reaches the
     * world. Not a multiplier on Materials' authored figures: Three *replaces*
     * envMapIntensity with the scene value for any standard material that has no
     * envMap of its own, which is every material in the level (only AssetForge's
     * view-model rig hands one over explicitly, so the weapon keeps its own).
     * Sky leaves the scene value at 1, so 1 is the number this is trimming.
     *
     * Worth trimming because IBL was over half the fill and is the one fill term
     * with almost no orientation dependence: the map's below-horizon band is 0.4x
     * the horizon radiance, several times what a stone street reflects, so a
     * down-facing surface read *brighter* from IBL than an up-facing one. Cutting
     * it and handing the difference to the hemisphere buys the orientation step
     * back. It also costs specular reflections a stop and a third, which is where
     * the sky-coloured speckle on thin metal edges was coming from.
     */
    this.envFillScale = 0.4;

    const soft = game.forge?.softwareGL === true;
    this.maxPointLights = soft ? 4 : 8;
    this.maxSpotLights = soft ? 2 : 3;
    this.maxRequests = 48;
    // A light whose sphere of influence cannot reach the camera is not worth a
    // slot, whatever its priority.
    this.cullMargin = 6;

    this.stats = { pointActive: 0, spotActive: 0, requests: 0, flashes: 0 };

    this._requests = [];
    this._pointPool = [];
    this._spotPool = [];
    this._slotOwner = [];

    this._sunDir = new THREE.Vector3(0.3, 0.9, 0.2);
    this._tmpColor = new THREE.Color();
    this._groundColor = new THREE.Color();
    this._bounce = new THREE.Color();
    this._patchFrame = 0;
    this._visit = (obj) => this._patchObject(obj);
  }

  async init() {
    const { scene } = this.game;

    this.csm = new CascadedShadows(this.game, { shadowDistance: this.settings.shadowDistance ?? 108 });
    await this.csm.init();
    this.sun = this.csm.sun;

    // Hemisphere rather than ambient: an untinted flat ambient is the single most
    // recognisable tell in a hobby scene, because it makes every shadow neutral
    // grey. What each half carries depends on whether Sky got an env map built —
    // see _syncSky.
    this.hemi = new THREE.HemisphereLight(0x9fc0e8, 0x40382f, 0.6);
    this.hemi.name = 'sky-fill';
    scene.add(this.hemi);

    for (let i = 0; i < this.maxPointLights; i++) {
      // decay 2 is inverse-square, the only decay that reads as real; `distance`
      // is the cutoff radius Three uses to window it.
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.name = `local-point-${i}`;
      l.castShadow = false;
      scene.add(l);
      this._pointPool.push(l);
      this._slotOwner.push(null);
    }
    for (let i = 0; i < this.maxSpotLights; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 18, 0.6, 0.45, 2);
      l.name = `local-spot-${i}`;
      l.castShadow = false;
      scene.add(l, l.target);
      this._spotPool.push(l);
    }

    // Request records and their handle lights all exist up front, so neither a
    // firefight nor flash() ever allocates.
    const spotRequests = Math.max(4, this.maxSpotLights * 3);
    for (let i = 0; i < this.maxRequests; i++) {
      const kind = i < this.maxRequests - spotRequests ? 1 : 2;
      const light =
        kind === 1
          ? new THREE.PointLight(0xffffff, 0, 10, 2)
          : new THREE.SpotLight(0xffffff, 0, 18, 0.6, 0.45, 2);
      const rec = {
        light,
        kind,
        active: false,
        priority: 1,
        life: 0,
        maxLife: 0,
        envelope: 1,
        score: -Infinity,
        slot: -1,
      };
      light.userData.lightSlot = rec;
      this._requests.push(rec);
    }

    this._syncSky();
    this._patchScene();
  }

  /* ------------------------------------------------------------- public API */

  /**
   * Returns a real PointLight that is NOT in the scene: move it, recolour it,
   * animate its intensity, and Lighting mirrors it into a resident GPU slot
   * whenever it is one of the most important lights on screen.
   */
  addPointLight(pos, color = 0xffffff, intensity = 1, radius = 10, opts) {
    const rec = this._claim(1);
    if (!rec) return null;
    const l = rec.light;
    if (pos) l.position.copy(pos);
    this._setColor(l.color, color);
    l.intensity = intensity;
    l.distance = radius;
    rec.priority = opts?.priority ?? 1;
    rec.maxLife = opts?.ms ? opts.ms / 1000 : 0;
    rec.life = rec.maxLife;
    rec.envelope = 1;
    return l;
  }

  addSpotLight(pos, target, color = 0xffffff, intensity = 4, radius = 20, angle = 0.55, penumbra = 0.45, opts) {
    const rec = this._claim(2);
    if (!rec) return null;
    const l = rec.light;
    if (pos) l.position.copy(pos);
    if (target) l.target.position.copy(target);
    this._setColor(l.color, color);
    l.intensity = intensity;
    l.distance = radius;
    l.angle = angle;
    l.penumbra = penumbra;
    rec.priority = opts?.priority ?? 2;
    rec.maxLife = opts?.ms ? opts.ms / 1000 : 0;
    rec.life = rec.maxLife;
    rec.envelope = 1;
    return l;
  }

  /**
   * Muzzle flashes and explosions. Allocation-free, and it binds a resident slot
   * immediately rather than waiting for the next update, because a flash raised
   * during the weapon's update has to light the world in the frame that drew the
   * shot — one frame late reads as a lighting bug.
   */
  flash(pos, color = 0xffe2b0, intensity = 30, ms = 60) {
    const rec = this._claim(1, true);
    if (!rec) return null;
    const l = rec.light;
    l.position.copy(pos);
    this._setColor(l.color, color);
    l.intensity = intensity;
    l.distance = Math.max(4, Math.sqrt(intensity) * 2.6);
    rec.priority = 20; // outbids anything static
    rec.maxLife = Math.max(0.008, ms / 1000);
    rec.life = rec.maxLife;
    rec.envelope = 1;
    this.stats.flashes++;

    const slot = this._weakestSlot(rec);
    if (slot >= 0) this._bindPoint(slot, rec);
    return l;
  }

  release(light) {
    const rec = light?.userData?.lightSlot;
    if (!rec || !rec.active) return;
    rec.active = false;
    rec.life = 0;
    if (rec.kind === 1 && rec.slot >= 0) {
      this._pointPool[rec.slot].intensity = 0;
      this._slotOwner[rec.slot] = null;
    }
    if (rec.kind === 2 && rec.slot >= 0) this._spotPool[rec.slot].intensity = 0;
    rec.slot = -1;
  }

  setShadowDistance(m) {
    this.csm?.setShadowDistance(m);
  }

  debugCascades(on = true) {
    this.csm?.setDebug(on);
  }

  /* ------------------------------------------------------------------ update */

  update(dt) {
    const clamped = Math.min(dt || 0, 0.1);
    this._syncSky();
    this.csm?.update(this.game.camera, this._sunDir);
    this._updateLocals(clamped);

    // Materials arrive after this system boots (the level, props, enemies and
    // decals are all later in the order), so keep sweeping for unpatched ones.
    // Cheap enough at a quarter of a second apart that it never shows up.
    if (++this._patchFrame % 15 === 0) this._patchScene();
  }

  /** Sun colour, intensity and the sky fill, re-read from game.sky every frame. */
  _syncSky() {
    const sky = this.game.sky;
    if (sky?.sunDirection) this._sunDir.copy(sky.sunDirection);
    if (this._sunDir.lengthSq() < 1e-6) this._sunDir.set(0.3, 0.9, 0.2);
    this._sunDir.normalize();

    const elev = THREE.MathUtils.clamp(this._sunDir.y, -0.2, 1);
    // Below the horizon the sun is off; the ramp above it is the atmospheric
    // extinction that makes a low sun dim as well as orange.
    const daylight = THREE.MathUtils.smoothstep(elev, -0.02, 0.28);
    // sunIrradiance is Sky's own derived figure and the one the aerial term and
    // the cloud radiance are already keyed off; deriving a second one here is how
    // the key light and the sky drift apart on a preset change.
    const sunI = (sky?.sunIrradiance ?? 3.4 * daylight) * KEY_BOOST * this.sunIntensityScale;

    const lights = this.csm?.lights;
    if (lights) {
      for (let i = 0; i < lights.length; i++) {
        if (sky?.sunColor) lights[i].color.copy(sky.sunColor);
        // Only cascade 0 carries radiance; the rest are shadow-map carriers.
        lights[i].intensity = i === 0 ? sunI : 0;
      }
    }

    if (this.hemi) {
      const base = sky?.ambientIntensity ?? 0.35 + 0.5 * daylight;
      const horizon = sky?.horizonColor;
      const amb = sky?.ambientColor;

      if (this.game.scene.environment && horizon) {
        // With an env map the sky's full irradiance already reaches every surface,
        // and Materials pushes it further with envMapIntensity 1.25-1.5 — so a
        // hemisphere tinted with the sky average is a second copy of the bluest
        // term in the frame. Measured on flat ground at 17 degrees: sun plus env
        // alone lands warm at blue/red 0.88-0.98, and adding a sky-tinted
        // hemisphere on top flipped it to 1.05-1.10, which is why warm-lit paving
        // read colder than the light falling on it.
        //
        // The term this renderer has no source for at all is the first bounce: a
        // sunlit square throws light back up off the paving and sideways off the
        // plaster, and that light is warm. So the hemisphere carries the bounce
        // instead of the sky — the horizon band, which is both the brightest part
        // of a golden-hour dome and the part the geometry actually faces, filtered
        // through the level's own sand-and-plaster albedo. The blue fill is not
        // lost, it is just left to the env map, which measures it correctly; the
        // shadow side still comes out tinted.
        this._bounce.copy(horizon).multiply(BOUNCE_ALBEDO);
        // Normalise to unit peak so this stays a *chroma* and `base` remains the
        // only thing carrying how bright the sky is; at golden hour the divisor is
        // 1.015, so this is not where the up-vs-down gradient went.
        const mx = Math.max(this._bounce.r, this._bounce.g, this._bounce.b, 1e-5);
        this._bounce.multiplyScalar(1 / mx);
        this.hemi.color.copy(this._bounce);
        // A downward-facing surface sees ground rather than sky, and in a walled
        // square that ground is mostly in its own shadow. Two stops down, and
        // warmer for the extra bounce: this step is the frame's only orientation
        // cue that does not depend on the sun reaching a surface at all.
        this._groundColor.copy(this._bounce).lerp(GROUND_CHROMA, 0.5).multiplyScalar(GROUND_FRACTION);
        this.hemi.groundColor.copy(this._groundColor);
        this.hemi.intensity = base * this.iblFillFactor * this.fillScale;
        // Re-asserted every frame rather than set once: Sky rewrites this to 1
        // whenever it rebuilds the map, and Lighting updates after Sky.
        this.game.scene.environmentIntensity = this.envFillScale * this.fillScale;
      } else if (amb) {
        // No env map built: the hemisphere is the only fill in the scene, so it
        // goes back to carrying the sky — blue above, warm dirt bounce below —
        // rather than leaving shadows with no sky in them at all.
        this.hemi.color.copy(amb);
        this._groundColor.copy(amb).lerp(this._tmpColor.setRGB(0.16, 0.12, 0.09), 0.72);
        this.hemi.groundColor.copy(this._groundColor);
        this.hemi.intensity = base * this.fillScale;
      }
    }
  }

  _updateLocals(dt) {
    const camPos = this.game.camera.position;
    const reqs = this._requests;
    let active = 0;

    for (let i = 0; i < reqs.length; i++) {
      const rec = reqs[i];
      if (!rec.active) continue;

      if (rec.maxLife > 0) {
        rec.life -= dt;
        if (rec.life <= 0) {
          this.release(rec.light);
          continue;
        }
        // Quadratic falloff: a muzzle flash is mostly over in the first third of
        // its life, and a linear ramp reads as a fading lamp instead of a bang.
        const t = rec.life / rec.maxLife;
        rec.envelope = t * t;
      } else {
        rec.envelope = 1;
      }

      // A light the player cannot see the effect of scores itself out of the pool
      // rather than being deleted, so walking back into range re-lights it.
      const reach = rec.light.distance + this.cullMargin;
      const d2 = camPos.distanceToSquared(rec.light.position);
      rec.score =
        d2 > reach * reach
          ? -Infinity
          : rec.priority * 1000 + rec.light.intensity * rec.envelope * 4 - Math.sqrt(d2) * 6;

      // Slots are mirrors, not owners; a caller that parents its handle would get
      // lit twice and change the light count, which recompiles the world.
      if (rec.light.parent) rec.light.removeFromParent();
      active++;
    }
    this.stats.requests = active;

    this.stats.pointActive = this._fillPool(1, this._pointPool);
    this.stats.spotActive = this._fillPool(2, this._spotPool);
  }

  /** Highest-scoring requests win the resident slots. O(slots x requests), no allocation. */
  _fillPool(kind, pool) {
    const reqs = this._requests;
    for (let i = 0; i < reqs.length; i++) if (reqs[i].kind === kind) reqs[i].slot = -1;

    let filled = 0;
    for (let s = 0; s < pool.length; s++) {
      let best = null;
      let bestScore = -Infinity;
      for (let i = 0; i < reqs.length; i++) {
        const rec = reqs[i];
        if (!rec.active || rec.kind !== kind || rec.slot >= 0) continue;
        if (rec.score > bestScore) {
          bestScore = rec.score;
          best = rec;
        }
      }
      if (!best || bestScore === -Infinity) {
        pool[s].intensity = 0;
        if (kind === 1) this._slotOwner[s] = null;
        continue;
      }
      best.slot = s;
      if (kind === 1) this._bindPoint(s, best);
      else this._bindSpot(s, best);
      filled++;
    }
    return filled;
  }

  _bindPoint(slot, rec) {
    const l = this._pointPool[slot];
    const h = rec.light;
    l.position.copy(h.position);
    l.color.copy(h.color);
    l.distance = h.distance;
    l.decay = h.decay;
    l.intensity = h.intensity * rec.envelope;
    rec.slot = slot;
    this._slotOwner[slot] = rec;
  }

  _bindSpot(slot, rec) {
    const l = this._spotPool[slot];
    const h = rec.light;
    l.position.copy(h.position);
    l.target.position.copy(h.target.position);
    l.color.copy(h.color);
    l.distance = h.distance;
    l.angle = h.angle;
    l.penumbra = h.penumbra;
    l.decay = h.decay;
    l.intensity = h.intensity * rec.envelope;
  }

  /** The slot whose current occupant is easiest to evict for `rec`. */
  _weakestSlot(rec) {
    let worst = -1;
    let worstScore = Infinity;
    for (let s = 0; s < this._pointPool.length; s++) {
      const owner = this._slotOwner[s];
      const score = owner && owner.active && owner !== rec ? owner.priority * 1000 : -Infinity;
      if (score < worstScore) {
        worstScore = score;
        worst = s;
      }
    }
    return worst;
  }

  _claim(kind, evict = false) {
    const reqs = this._requests;
    for (let i = 0; i < reqs.length; i++) {
      const rec = reqs[i];
      if (rec.active || rec.kind !== kind) continue;
      rec.active = true;
      rec.slot = -1;
      rec.score = -Infinity;
      return rec;
    }

    if (!evict) return null;
    // Every record is taken: steal the least important one so a muzzle flash is
    // never silently dropped.
    let victim = null;
    for (let i = 0; i < reqs.length; i++) {
      const rec = reqs[i];
      if (rec.kind !== kind) continue;
      if (!victim || rec.priority < victim.priority) victim = rec;
    }
    if (!victim) return null;
    this.release(victim.light);
    victim.active = true;
    victim.slot = -1;
    return victim;
  }

  _setColor(target, color) {
    if (typeof color === 'number') target.setHex(color);
    else if (color) target.copy(color);
    else target.setRGB(1, 1, 1);
  }

  /* -------------------------------------------------- material / caster sweep */

  _patchScene() {
    this.game.scene.traverse(this._visit);
  }

  _patchObject(obj) {
    if (!obj.isMesh && !obj.isSkinnedMesh && !obj.isInstancedMesh) return;
    const mat = obj.material;
    let patched = false;
    if (Array.isArray(mat)) {
      for (let i = 0; i < mat.length; i++) patched = this.csm.patchMaterial(mat[i]) || patched;
    } else {
      patched = this.csm.patchMaterial(mat);
    }
    if (obj.userData.csmMesh) return;
    obj.userData.csmMesh = true;

    // A prop that does not receive shadows and does not cast one reads as pasted
    // onto the frame, which is the review's hard fail, so opt-in is the wrong
    // default here — every lit mesh participates unless it says otherwise.
    const lit = patched || mat?.userData?.csm || (Array.isArray(mat) ? mat.some((m) => m.userData.csm) : false);
    if (!lit || obj.userData.noShadow) return;
    obj.receiveShadow = true;
    if (obj.castShadow || obj.userData.noShadowCast) return;

    // Ground planes and sky shells are the two things that must not be forced on:
    // a 160 m quad fills every cascade with a depth value that occludes nothing,
    // and a lit sky shell would shadow the entire world.
    const geo = obj.geometry;
    if (!geo) return;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const r = geo.boundingSphere?.radius ?? 0;
    const scale = Math.max(obj.scale.x, obj.scale.y, obj.scale.z);
    if (r * scale < 45) obj.castShadow = true;
  }

  dispose() {
    this.csm?.dispose();
    this.hemi?.removeFromParent();
    for (const l of this._pointPool) l.removeFromParent();
    for (const l of this._spotPool) {
      l.removeFromParent();
      l.target.removeFromParent();
    }
  }
}
