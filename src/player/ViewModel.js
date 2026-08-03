import * as THREE from 'three';
import { LAYER_VIEWMODEL } from '../core/Layers.js';

/**
 * The first-person arms + weapon rig: idle sway, walk bob, ADS transition, recoil
 * animation, reload animation, sprint cant, weapon lowering near walls.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * The rig itself is a forge asset, not geometry built here. AssetForge authors
 * `viewmodel_rig` with its parts named and its anchors parented inside the parts
 * that move them, and hands over hip, ADS and lowered poses. This module is only
 * the animation layer over that, which is the split that lets the gun be
 * re-authored without touching a line of animation, and the reverse.
 *
 * Every motion here is a spring or a damped follow rather than a keyframe. A view
 * model has to answer to things with no fixed duration — how fast the player
 * turned, how hard they landed, how many rounds into a burst they are — and a clip
 * cannot represent that. Reload and swap are the exceptions, and they are scripted
 * curves precisely because they do have fixed lengths.
 *
 * The sway is the part worth being fussy about, because it is what gives the gun
 * mass. It is the rotation between the camera's real orientation and a damped copy
 * of it, applied inverted, so the weapon trails the view and then catches up.
 * Driving it from raw mouse delta instead produces motion that stops dead the
 * instant the mouse does, which reads as weightless.
 *
 * CONTRACT:
 *   root : THREE.Group   local space, +Z is toward the player
 *   playAnim(name)
 *
 * ADDITIONS (safe to rely on):
 *   rig    : THREE.Object3D | null   the forge asset, once built
 *   parts  : the rig's named parts and anchors
 *   sightWorld(out) : world position of the optic, for the HUD or a scope pass
 */

const SWAY_LAG = 9;
const SWAY_GAIN = 0.55;
const SWAY_MAX = 0.16;

/** Blend three authored pose channels: hip -> ads by `a`, then toward lowered by `l`. */
function blend3(hip, aim, low, a, l, i) {
  const base = hip[i] + (aim[i] - hip[i]) * a;
  return base + (low[i] - base) * l;
}

export class ViewModel {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.rig = null;
    this.parts = null;
    this.pose = null;

    this._anim = null;
    this._animT = 0;
    this._animDur = 0;

    // Springs. Position in metres, rotation in radians, both local to the rig.
    this._kickPos = new THREE.Vector3();
    this._kickVel = new THREE.Vector3();
    this._kickRot = new THREE.Vector3();
    this._kickRotVel = new THREE.Vector3();

    this._bobPhase = 0;
    this._lowered = 0;
    this._lagQuat = new THREE.Quaternion();
    this._hasLag = false;

    this._swayEuler = new THREE.Euler();
    this._deltaQuat = new THREE.Quaternion();
    this._invQuat = new THREE.Quaternion();
    this._tmp = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._probeDir = new THREE.Vector3();

    this._flash = null;
    this._flashLeft = 0;
  }

  async init() {
    const { viewmodelScene, forge, bus } = this.game;

    this.root.name = 'viewmodel_root';
    viewmodelScene.add(this.root);

    this.rig = forge?.mesh?.('viewmodel_rig') ?? null;
    if (this.rig) {
      this.parts = this.rig.userData?.parts ?? null;
      this.pose = this.rig.userData?.pose ?? null;
      this.root.add(this.rig);
    } else {
      console.error('[viewmodel] forge has no viewmodel_rig; the gunplay pose will be empty');
    }
    this.root.traverse((o) => o.layers.set(LAYER_VIEWMODEL));

    // View model lighting is separate from the world so the gun always reads well.
    //
    // The environment is the part that matters, and its absence was the whole
    // reason the weapon read as one substance. Nine materials are authored for
    // this rig, but the metals among them carry `metalness: 1`, which means they
    // have no diffuse term at all — every photon they show the camera is a
    // reflection. With only a hard key and a flat ambient there is nothing for
    // them to reflect, so blued steel, anodised aluminium and polymer all collapse
    // to the same dark gloss and a review reads the lot as injection-moulded ABS.
    // Giving this scene the sky map is what lets roughness 0.2 and roughness 0.66
    // look like different substances.
    viewmodelScene.environment = this.game.scene.environment ?? null;
    viewmodelScene.environmentIntensity = 1;

    this._key = new THREE.DirectionalLight(0xffffff, 2.4);
    this._key.position.set(-0.6, 1, 0.8);
    this._key.layers.set(LAYER_VIEWMODEL);
    // A rim from behind and opposite the key. On a dark weapon against a dark
    // interior the silhouette is the only thing separating it from the wall
    // behind it, and a rim is what draws that edge.
    //
    // Near-neutral, not the cold blue it started as: the sky map already dyes a
    // metal that has no diffuse term, and a blue rim on top took the whole rig to
    // b/r 1.74 when blued steel should read close to neutral.
    this._rim = new THREE.DirectionalLight(0xdfe6f2, 1.5);
    this._rim.position.set(0.9, 0.35, -1);
    this._rim.layers.set(LAYER_VIEWMODEL);
    this._fill = new THREE.AmbientLight(0x8899aa, 0.55);
    this._fill.layers.set(LAYER_VIEWMODEL);
    viewmodelScene.add(this._key, this._rim, this._fill);
    this._baseKey = this._key.intensity;
    this._baseRim = this._rim.intensity;
    this._baseFill = this._fill.intensity;

    // The flash rides the muzzle anchor, which the forge parented inside the
    // muzzle part, so it follows the barrel through recoil instead of sitting
    // where the barrel was at rest.
    this._flash = new THREE.PointLight(0xffd9a0, 0, 2.4, 2);
    this._flash.layers.set(LAYER_VIEWMODEL);
    (this.parts?.muzzle_tip ?? this.root).add(this._flash);

    bus.on('weapon:fire', (e) => this._onFire(e));
    bus.on('weapon:reload:start', (e) => this.playAnim('reload', e.duration));
    bus.on('weapon:dryfire', () => this._kickRotVel.set(-1.2, 0, 0));
    bus.on('player:land', (e) => {
      this._kickVel.y -= Math.min(0.9, e.impact * 0.05);
    });
  }

  /**
   * Recoil at the rig is deliberately larger than the camera's. The gun visibly
   * cycles while the view barely moves, and that difference is what makes the two
   * read as separate objects rather than one rigid assembly.
   */
  _onFire(e) {
    const recoil = this.game.weapons?.recoil ?? { pitch: 0.02, yaw: 0 };
    const ads = this.game.weapons?.adsProgress ?? 0;
    // Aiming cuts the visible travel but not the rotation, so the sight picture
    // stays usable while the weapon still reads as firing.
    const travel = 1 - 0.55 * ads;
    this._kickVel.z += 2.6 * travel * (1 + recoil.pitch * 8);
    this._kickVel.y += 0.35 * travel;
    this._kickRotVel.x -= recoil.pitch * 300 * (1 - 0.3 * ads);
    this._kickRotVel.y += recoil.yaw * 40;
    this._kickRotVel.z += (Math.random() - 0.5) * 1.4 * travel;

    this._flashLeft = 0.045;
    if (this._flash) this._flash.intensity = 9;

    if (this.parts?.muzzle_tip) {
      this.parts.muzzle_tip.getWorldPosition(this._tmp);
      this.game.particles?.emit('muzzle', this._tmp, e.direction ?? this._probeDir.set(0, 0, -1));
      // The world needs its own brief light: a light on the view model layer
      // cannot illuminate anything the player is actually shooting at.
      this.game.camera.getWorldPosition(this._tmpB);
      this.game.lighting?.flash?.(this._tmpB, 0xffd0a0, 26, 55);
    }
    if (this.parts?.eject) {
      this.parts.eject.getWorldPosition(this._tmp);
      this.game.particles?.emit('shell', this._tmp, this._probeDir.set(1, 0.6, 0));
    }
  }

  playAnim(name, duration = 0.6) {
    this._anim = name;
    this._animT = 0;
    this._animDur = Math.max(0.05, duration);
  }

  sightWorld(out = new THREE.Vector3()) {
    return this.parts?.sight ? this.parts.sight.getWorldPosition(out) : out.copy(this.game.camera.position);
  }

  /**
   * How far the weapon should be dropped, 0..1. Sprinting lowers it; a wall in
   * front of the muzzle lowers it further, which is the only thing that stops the
   * barrel disappearing into geometry — no amount of near-plane tuning fixes that.
   */
  _loweredTarget() {
    const p = this.game.player;
    const w = this.game.weapons;
    if (!p) return 0;
    // A swap is a full down-and-up, so drive it from the swap's own progress.
    if (w && w.swapProgress < 1) return 1 - Math.abs(w.swapProgress * 2 - 1);
    if (p.isTacSprinting) return 1;
    if (p.isSprinting) return 0.45;

    const cam = this.game.camera;
    this._probeDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const hit = this.game.collision?.raycast(cam.position, this._probeDir, 0.9);
    if (hit) return THREE.MathUtils.clamp(1 - hit.distance / 0.9, 0, 0.85);
    return 0;
  }

  update(dt) {
    const cam = this.game.engine.viewmodelCamera;
    // Sky rebuilds the PMREM when the time of day moves, and this scene holds its
    // own reference, so re-point it rather than keeping the one that existed at
    // boot — a disposed map reflects nothing.
    const env = this.game.scene.environment;
    const vscene = this.game.viewmodelScene;
    if (env && vscene.environment !== env) vscene.environment = env;

    // Expose the weapon on the world's scale, not its own.
    //
    // A fixed rig meant the weapon carried 253-level speculars in a room whose
    // brightest wall reached 152 — a hundred levels hotter than anything it is
    // standing in, which is the pasted-on look the rubric names. Riding the same
    // sun and fill trims the world uses keeps the gun inside the frame's exposure
    // as the player walks from a sunlit square into a shaded interior, which a
    // constant can never do.
    const lit = this.game.lighting;
    if (lit && this._key) {
      // Drive from the sun's actual irradiance, not from Lighting's artistic
      // trims: `sunIntensityScale` and `fillScale` are both constant 1 and nothing
      // in the codebase ever moves them, so keying off those was a no-op dressed
      // up as a fix. `sky.sunIrradiance` is the quantity Lighting itself scales the
      // key by, and it is what changes when the time of day does.
      const irr = this.game.sky?.sunIrradiance;
      const sun = (irr ? irr / 3.0 : 1) * (lit.sunIntensityScale ?? 1);
      const fill = lit.fillScale ?? 1;
      // Damped rather than snapped: an instant relight crossing a doorway reads as
      // a bug, and the eye adapting is the effect being imitated anyway.
      const kt = this._baseKey * sun;
      const rt = this._baseRim * (0.35 + 0.65 * fill);
      const ft = this._baseFill * fill;
      this._key.intensity = THREE.MathUtils.damp(this._key.intensity, kt, 3, dt);
      this._rim.intensity = THREE.MathUtils.damp(this._rim.intensity, rt, 3, dt);
      this._fill.intensity = THREE.MathUtils.damp(this._fill.intensity, ft, 3, dt);
      vscene.environmentIntensity = THREE.MathUtils.damp(
        vscene.environmentIntensity ?? 1,
        this.game.scene.environmentIntensity ?? 1,
        3,
        dt
      );
    }
    // Keep the rig parented to the camera in world space.
    this.root.position.copy(cam.position);
    this.root.quaternion.copy(cam.quaternion);
    if (!this.rig || !this.pose) return;

    const p = this.game.player;
    const w = this.game.weapons;
    const ads = w?.adsProgress ?? 0;

    // Critically damped springs: a view model that rings reads as broken rather
    // than as heavy.
    for (const [val, vel, k] of [
      [this._kickPos, this._kickVel, 210],
      [this._kickRot, this._kickRotVel, 260],
    ]) {
      vel.addScaledVector(val, -k * dt);
      vel.multiplyScalar(Math.max(0, 1 - 2 * Math.sqrt(k) * dt));
      val.addScaledVector(vel, dt);
    }

    if (this._flashLeft > 0) {
      this._flashLeft -= dt;
      if (this._flashLeft <= 0 && this._flash) this._flash.intensity = 0;
    }

    // Ease the ADS blend: interpolating linearly between two poses sends the gun
    // along a straight line, and a weapon being shouldered does not travel that
    // way. Lowered is applied on top of whichever pose is active, so sprinting
    // out of a sight picture reads as one continuous move.
    const a = ads * ads * (3 - 2 * ads);
    this._lowered = THREE.MathUtils.damp(this._lowered, this._loweredTarget(), 11, dt);
    const l = this._lowered;
    const { hip, ads: aim, lowered: low } = this.pose;

    const poseX = blend3(hip.position, aim.position, low.position, a, l, 0);
    const poseY = blend3(hip.position, aim.position, low.position, a, l, 1);
    const poseZ = blend3(hip.position, aim.position, low.position, a, l, 2);
    const rotX = blend3(hip.rotation, aim.rotation, low.rotation, a, l, 0);
    const rotY = blend3(hip.rotation, aim.rotation, low.rotation, a, l, 1);
    const rotZ = blend3(hip.rotation, aim.rotation, low.rotation, a, l, 2);

    // Sway: the rotation between the camera and a damped copy of it, inverted.
    if (!this._hasLag) {
      this._lagQuat.copy(cam.quaternion);
      this._hasLag = true;
    }
    this._lagQuat.slerp(cam.quaternion, Math.min(1, SWAY_LAG * dt));
    this._invQuat.copy(this._lagQuat).invert();
    this._deltaQuat.copy(this._invQuat).multiply(cam.quaternion);
    this._swayEuler.setFromQuaternion(this._deltaQuat, 'YXZ');
    const gain = SWAY_GAIN * (1 - 0.7 * a);
    const swayX = THREE.MathUtils.clamp(-this._swayEuler.x * gain, -SWAY_MAX, SWAY_MAX);
    const swayY = THREE.MathUtils.clamp(-this._swayEuler.y * gain, -SWAY_MAX, SWAY_MAX);

    // Walk bob, driven by distance travelled like the footsteps, so the gun stays
    // in step with the legs at any speed.
    const speed = p?.speed ?? 0;
    const moving = !!p?.grounded && speed > 0.5;
    if (moving) this._bobPhase += (speed * dt) / 0.86;
    const bobAmp = moving ? Math.min(1, speed / 4.2) * (1 - 0.82 * a) : 0;
    const bobV = Math.sin(this._bobPhase * Math.PI * 2) * 0.014 * bobAmp;
    const bobH = Math.sin(this._bobPhase * Math.PI) * 0.019 * bobAmp;

    let animPos = 0;
    let animRot = 0;
    if (this._anim === 'reload') {
      this._animT += dt;
      const t = Math.min(1, this._animT / this._animDur);
      // Down quickly, hold while the hands work, back up smoothly.
      const dip = t < 0.22 ? t / 0.22 : t > 0.78 ? (1 - t) / 0.22 : 1;
      animPos = dip * 0.11;
      animRot = dip * 0.42;
      const mag = this.parts?.magazine;
      if (mag) {
        // Out, a beat with the well empty, then a fresh one seated around three
        // quarters through — which is where the reload's seat sound belongs.
        const outT = t < 0.45 ? t / 0.45 : t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.25);
        mag.position.y = -0.14 * outT;
        mag.rotation.z = -0.5 * outT;
      }
      if (t >= 1) {
        this._anim = null;
        if (this.parts?.magazine) {
          this.parts.magazine.position.y = 0;
          this.parts.magazine.rotation.z = 0;
        }
      }
    }

    this.rig.position.set(
      poseX + swayY * 0.09 + bobH + this._kickPos.x,
      poseY + swayX * 0.07 + bobV - animPos + this._kickPos.y,
      poseZ + this._kickPos.z * 0.045
    );
    this.rig.rotation.set(
      rotX + swayX + this._kickRot.x * 0.05 - animRot,
      rotY + swayY + this._kickRot.y * 0.05,
      rotZ + swayY * 0.5 + this._kickRot.z * 0.05 + bobH * 0.6
    );
  }
}
