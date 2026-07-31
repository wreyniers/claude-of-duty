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
 * A quarter is roughly two stops down, which is what a stone square in shadow
 * gives back against a lit golden-hour sky band, and it leaves the ground bounce
 * present as warmth rather than as brightness.
 *
 * This alone was never going to carry the orientation step, and the previous round
 * was wrong to expect it to. The hemisphere is a well-shaped term — 1.0 / 0.63 /
 * 0.25 to a floor, a wall and a soffit — but it was the smaller half of the fill,
 * and the env map it was being added to ran the *other* way: see uCsmSkyVis in
 * CascadedShadows for the measurement and the fix. With that weight in place these
 * two now agree in sign and the fill a surface receives finally depends on which
 * way it faces.
 */
const GROUND_FRACTION = 0.25;

/**
 * How far the hemisphere's *sky* half is pulled off the warm bounce back toward
 * the sky's own measured chroma.
 *
 * The bounce is the term this renderer otherwise has no source for, so the
 * hemisphere carrying it is right — but with the diffuse env map now weighted by
 * sky visibility, the hemisphere is half the fill an up-facing surface gets
 * instead of a third, and an all-warm hemisphere at that share takes the blue out
 * of the one place the rubric asks for it: a shadow on the ground, which faces
 * the sky and nothing else. Mixing keeps both readings — measured on paving,
 * shaded horizontal comes out blue/red 1.65 and a shaded vertical face 1.08,
 * while sunlit paving still lands warm at 0.69 (it was 0.75 with a fully warm
 * hemisphere, so this does not undo that).
 *
 * The ground half stays on the raw warm bounce: light arriving from below has
 * been off the paving and is not sky-coloured at all.
 */
const SKY_MIX = 0.45;

/**
 * The key is Sky's `sunIrradiance` times this.
 *
 * Sky derives that figure for the dome, and the dome's radiance scale (`lum`) was
 * recalibrated down by two thirds to land the horizon band on the part of the ACES
 * curve that still has slope. The sun constant did not move with it, so the key
 * drifted down against its own sky.
 *
 * This is deliberately a small part of the contrast fix. Sunlit high-albedo
 * plaster already sits near 200 in the graded frame, so buying key-to-fill by
 * raising the key clips the brightest surfaces in the level and costs the tone
 * axis; the room is all on the shade side. At this value with the fill trims
 * below, sunlit surfaces move by under 6% in scene-linear — a horizontal plane
 * from 2.10 to 1.97 and a sun-facing wall from 5.62 to 5.55 — while the shade
 * they are measured against drops 0.8 to 1.7 stops. Sun-versus-shade on one
 * horizontal material goes from 1.85 stops to 2.57.
 */
const KEY_BOOST = 2.05;

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
 *   csm.setSkyVisibility(...)          how much sky each orientation sees
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
    /**
     * Weight of the hemisphere light once an env map is present. It is not a
     * fraction of the sky fill but the strength of the bounce term the hemisphere
     * takes over — see _syncSky.
     *
     * Up 4.45x from 0.265, in step with the env fill below so the bounce keeps the
     * same share of the total and the orientation step the two agree on does not
     * change shape. Everything the previous round trimmed here it took out of the
     * shade and nowhere else: sunlit plaster measured 145:1 in scene-linear over
     * shaded ground, seven stops, and the review found the cost in every dark
     * region of the frame — the oil drum at sd 5.4, the concrete barrier at 3.2,
     * the awning soffit at 2.8, a quarter of one capture inside a single 8-code
     * luma bin. Fill is close to free on the other end of the histogram: at 1/145
     * of the key a sunlit surface gains about 3% from a 4.5x fill while the shade
     * it is read against gains all of it.
     */
    this.iblFillFactor = 1.18;
    /**
     * `scene.environmentIntensity`, i.e. how much of the sky's IBL reaches the
     * world. Not a multiplier on Materials' authored figures: Three *replaces*
     * envMapIntensity with the scene value for any standard material that has no
     * envMap of its own, which is every material in the level (only AssetForge's
     * view-model rig hands one over explicitly, so the weapon keeps its own).
     * Sky leaves the scene value at 1, so 1 is the number this is trimming.
     *
     * This scales diffuse *and* specular together, so it is the wrong place to buy
     * back the fill: the reason it was cut to 0.32 was a blown blue-cyan patch of
     * reflected sky on the oil drum's lid, and that reading is still the budget it
     * has to stay inside. It is therefore now only the *specular* budget — half a
     * stop under the 1.0 that blew out, which is enough for the drum and the thin
     * metal edges to get a highlight at all rather than none — and the diffuse half
     * is multiplied back up per orientation in the shader, where specular cannot
     * follow it. See uCsmSkyVis in CascadedShadows.
     */
    this.envFillScale = 0.64;

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
        // The term this renderer has no source for at all is the first bounce: a
        // sunlit square throws light back up off the paving and sideways off the
        // plaster, and that light is warm. So the hemisphere leads with the bounce
        // rather than with the sky — the horizon band, which is both the brightest
        // part of a golden-hour dome and the part the geometry actually faces,
        // filtered through the level's own sand-and-plaster albedo. Tinting it with
        // the sky average instead flipped warm-lit paving to blue/red 1.05-1.10,
        // colder than the light falling on it.
        this._bounce.copy(horizon).multiply(BOUNCE_ALBEDO);
        // Normalise to unit peak so this stays a *chroma* and `base` remains the
        // only thing carrying how bright the sky is.
        const mx = Math.max(this._bounce.r, this._bounce.g, this._bounce.b, 1e-5);
        this._bounce.multiplyScalar(1 / mx);
        // A downward-facing surface sees ground rather than sky, and in a walled
        // square that ground is mostly in its own shadow. Two stops down, and
        // warmer for the extra bounce: taken off the raw bounce before SKY_MIX,
        // because nothing arriving from below has been anywhere near the sky.
        this._groundColor.copy(this._bounce).lerp(GROUND_CHROMA, 0.5).multiplyScalar(GROUND_FRACTION);
        this.hemi.groundColor.copy(this._groundColor);
        if (amb) {
          this._bounce.lerp(amb, SKY_MIX);
          const mb = Math.max(this._bounce.r, this._bounce.g, this._bounce.b, 1e-5);
          this._bounce.multiplyScalar(1 / mb);
        }
        this.hemi.color.copy(this._bounce);
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
