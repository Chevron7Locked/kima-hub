import * as THREE from "three";

/** World-to-pixel size factor, smallest and largest point in device pixels, and the crisp disc's edge as a share of the point's radius. */
export const STAR_SIZE_SCALE = 118;
export const STAR_MIN_PX = 2.2;
export const STAR_MAX_PX = 40;
export const DISC_EDGE = 0.36;

/** How much a star's emphasis (aEmph) scales its size: receding stars shrink a little, emphasised ones grow. */
export function emphasisScale(emphasis: number) {
    return THREE.MathUtils.lerp(0.8, 1, THREE.MathUtils.clamp(emphasis, 0, 1)) * Math.max(1, emphasis);
}

/** How much the legend's mood preview grows a star of that mood (aMood; -1 has none). */
export function focusScale(mood: number, u: StarUniforms) {
    return mood >= 0 && Math.abs(mood - u.uFocusMood.value) < 0.5 ? 1 + u.uFocusMix.value * 0.25 : 1;
}

/** CSS-pixel radius of a star's crisp disc at this view depth, given its whole size scale, as the shaders below draw it. */
export function starDiscRadius(size: number, scale: number, depth: number, pixelRatio: number) {
    const ps = (size * STAR_SIZE_SCALE * pixelRatio * scale) / Math.max(depth, 0.001);
    return (THREE.MathUtils.clamp(ps, STAR_MIN_PX, STAR_MAX_PX) / pixelRatio / 2) * DISC_EDGE;
}

/**
 * One point shader for every star, tracks and sky: a crisp disc in a faint halo,
 * sized by distance, twinkling. Each star ignites at its aReveal second of the
 * load-in as a white flash; while uFocusMix > 0, stars of uFocusMood take uFocusColor.
 */
const VERT = /* glsl */ `
uniform float uSizeScale;
uniform float uPixelRatio;
uniform float uTime;
uniform float uMinPx;
uniform float uReveal;
uniform float uRevealFade;
uniform float uFocusMood;
uniform float uFocusMix;
uniform vec3 uFocusColor;
attribute vec3 aColor;   // linear RGB
attribute float aSize;   // world-space size
attribute float aPhase;  // twinkle phase, radians
attribute float aTwAmp;  // twinkle depth, 0 = steady
attribute float aSpark;  // 1 on the few stars that flare
attribute float aEmph;   // 1 normal, <1 recedes, >1 stands forward
attribute float aMood;   // dominant mood index, -1 = none
attribute float aReveal; // load-in second this star ignites
varying vec3 vColor;
varying float vTw;
varying float vEmph;
varying float vShow;
varying float vPx;
void main() {
  float focus = uFocusMix * step(abs(aMood - uFocusMood), 0.5) * step(-0.5, aMood);
  float lum = max(max(aColor.r, aColor.g), aColor.b);
  vec3 color = mix(aColor, uFocusColor * (0.55 + lum * 0.6), focus * 0.85);
  float settle = clamp((uReveal - aReveal) / (uRevealFade * 2.0), 0.0, 1.0);
  vColor = mix(vec3(1.0, 0.98, 0.94) * 1.4, color, settle);
  vShow = clamp((uReveal - aReveal) / uRevealFade, 0.0, 1.0);
  vEmph = aEmph;
  float sp = 0.35 + fract(aPhase * 0.1591) * 1.1;
  vTw = 1.0 - aTwAmp * (0.5 + 0.5 * sin(uTime * sp + aPhase));
  float spark = pow(max(0.0, sin(uTime * (0.25 + sp * 0.3) + aPhase * 4.0)), 60.0);
  vTw += spark * aSpark * 2.2;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.001);
  float ps = aSize * uSizeScale * uPixelRatio / depth;
  ps *= mix(0.8, 1.0, clamp(aEmph, 0.0, 1.0)) * max(1.0, aEmph) * (1.0 + focus * 0.25);
  gl_PointSize = clamp(ps, uMinPx, ${STAR_MAX_PX.toFixed(1)});
  vPx = gl_PointSize;
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vTw;
varying float vEmph;
varying float vShow;
varying float vPx;
void main() {
  if (vShow <= 0.0) discard;
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float edge = 2.0 / vPx;
  float core = 1.0 - smoothstep(${DISC_EDGE} - edge, ${DISC_EDGE} + edge, r);
  float halo = pow(max(0.0, 1.0 - r), 3.0) * 0.22;
  float a = min(1.0, core * 0.95 + halo);
  gl_FragColor = vec4(vColor * max(1.0, vEmph), a * uOpacity * clamp(vTw, 0.0, 3.0) * min(1.0, vEmph) * vShow);
}`;

export interface StarUniforms {
    [key: string]: THREE.IUniform;
    uSizeScale: THREE.IUniform<number>;
    uPixelRatio: THREE.IUniform<number>;
    uOpacity: THREE.IUniform<number>;
    uTime: THREE.IUniform<number>;
    uMinPx: THREE.IUniform<number>;
    uReveal: THREE.IUniform<number>;
    uRevealFade: THREE.IUniform<number>;
    uFocusMood: THREE.IUniform<number>;
    uFocusMix: THREE.IUniform<number>;
    uFocusColor: THREE.IUniform<THREE.Color>;
}

/** A see-through shader drawn over the scene without writing depth, as the stars and the queue chart are. */
export function overlayMaterial<U extends Record<string, THREE.IUniform>>(uniforms: U, vertexShader: string, fragmentShader: string) {
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false });
    return { material, uniforms };
}

export function createStarMaterial(opts: { sizeScale: number; opacity: number; minPx: number; revealFade?: number }) {
    const uniforms: StarUniforms = {
        uSizeScale: { value: opts.sizeScale },
        uPixelRatio: { value: typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2) },
        uOpacity: { value: opts.opacity },
        uTime: { value: 0 },
        uMinPx: { value: opts.minPx },
        uReveal: { value: 0 },
        uRevealFade: { value: opts.revealFade ?? 0.3 },
        uFocusMood: { value: -1 },
        uFocusMix: { value: 0 },
        uFocusColor: { value: new THREE.Color(1, 1, 1) },
    };
    return overlayMaterial(uniforms, VERT, FRAG);
}

/** Per-frame update: twinkle clock, load-in clock, eased mood focus, and the canvas's live pixel ratio. */
export function tickStars(u: StarUniforms, time: number | null, reveal: number, focusMix: number, pixelRatio: number) {
    if (time !== null) u.uTime.value = time;
    u.uPixelRatio.value = pixelRatio;
    u.uReveal.value = reveal;
    u.uFocusMix.value = focusMix;
}

/** Which mood the legend is previewing, and its colour (0–255 RGB). */
export function setStarFocus(u: StarUniforms, moodIdx: number, rgb: [number, number, number]) {
    u.uFocusMood.value = moodIdx;
    u.uFocusColor.value.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
}

