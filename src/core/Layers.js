/**
 * Render layer assignments.
 *
 * The view model (arms + weapon) lives on its own layer and is drawn by a second
 * camera with a very short near plane after the world pass clears depth. This is
 * how shipped shooters stop the gun from clipping through geometry when you push
 * up against a wall, and it lets the weapon keep a tight FOV while the world
 * runs wide.
 */
export const LAYER_WORLD = 0;
export const LAYER_VIEWMODEL = 1;
export const LAYER_NO_SHADOW_CASTER = 2;
