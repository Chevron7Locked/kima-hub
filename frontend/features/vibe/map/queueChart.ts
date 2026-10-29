import * as THREE from "three";
import { DISC_EDGE, STAR_MAX_PX, STAR_MIN_PX, STAR_SIZE_SCALE, overlayMaterial, type StarUniforms } from "./starShader";

/**
 * The play queue as a sky chart's constellation: a stipple from each song to the next,
 * stopping short of both stars; a long jump shows only where it leaves and lands.
 * Dot spacing stays even on screen (each dot has a level; nearer shows finer levels).
 */
const VERT = /* glsl */ `
uniform float uPixelRatio;
uniform vec2 uView;
uniform float uStep;
uniform float uSpacingPx;
uniform float uDotPx;
uniform float uTime;
uniform float uMotion;
uniform float uSizeScale;
uniform float uMinPx;
uniform float uFocusMood;
uniform float uFocusMix;
attribute float aAlpha;
attribute float aLevel;
attribute float aAlong;
attribute vec3 aEndAt;    // the nearer star
attribute vec3 aEnd;      // its size, emphasis scale, and the pixels kept clear beyond its disc
attribute float aEndMood; // its mood, which the legend's preview grows
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float pxPerUnit = projectionMatrix[1][1] * 0.5 * uView.y / max(-mv.z, 0.001);
  float need = log2(max(uSpacingPx / (uStep * pxPerUnit), 1.0));
  vec4 endView = modelViewMatrix * vec4(aEndAt, 1.0);
  vec4 endClip = projectionMatrix * endView;
  float focus = uFocusMix * step(abs(aEndMood - uFocusMood), 0.5) * step(-0.5, aEndMood);
  float endPs = clamp(aEnd.x * uSizeScale * uPixelRatio * aEnd.y * (1.0 + focus * 0.25) / max(-endView.z, 0.001), uMinPx, ${STAR_MAX_PX.toFixed(1)});
  float clearPx = endPs / uPixelRatio * 0.5 * ${DISC_EDGE} + aEnd.z;
  float apart = endClip.w > 0.0 ? length((gl_Position.xy / gl_Position.w - endClip.xy / endClip.w) * 0.5 * uView) : 1e6;
  float show = clamp(aLevel - need + 1.0, 0.0, 1.0) * smoothstep(clearPx, clearPx + 2.0, apart);
  float glint = uMotion * step(0.0, aAlong) * pow(max(0.0, sin(aAlong * 0.16 - uTime * 0.9)), 18.0);
  vAlpha = aAlpha * show * (1.0 + glint * 1.6);
  gl_PointSize = show > 0.0 ? uDotPx * uPixelRatio * (1.0 + glint * 0.6) : 0.0;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0 || vAlpha <= 0.0) discard;
  gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.5, 1.0, r)) * vAlpha);
}`;

export interface ChartUniforms {
    [key: string]: THREE.IUniform;
    uPixelRatio: THREE.IUniform<number>;
    uView: THREE.IUniform<THREE.Vector2>;
    uStep: THREE.IUniform<number>;
    uSpacingPx: THREE.IUniform<number>;
    uDotPx: THREE.IUniform<number>;
    uTime: THREE.IUniform<number>;
    uMotion: THREE.IUniform<number>;
    uSizeScale: THREE.IUniform<number>;
    uMinPx: THREE.IUniform<number>;
    uFocusMood: THREE.IUniform<number>;
    uFocusMix: THREE.IUniform<number>;
    uColor: THREE.IUniform<THREE.Color>;
}

/** The chart reads the track stars' own mood-preview uniforms, so its gaps grow with the stars. */
export function createChartMaterial(color: string, stars: StarUniforms) {
    const uniforms: ChartUniforms = {
        uPixelRatio: { value: 1 },
        uView: { value: new THREE.Vector2(1, 1) },
        uStep: { value: 1 },
        uSpacingPx: { value: 5.5 },
        uDotPx: { value: 1.5 },
        uTime: { value: 0 },
        uMotion: { value: 1 },
        uSizeScale: { value: STAR_SIZE_SCALE },
        uMinPx: { value: STAR_MIN_PX },
        uFocusMood: stars.uFocusMood,
        uFocusMix: stars.uFocusMix,
        uColor: { value: new THREE.Color(color) },
    };
    return overlayMaterial(uniforms, VERT, FRAG);
}

/** How many songs after the playing one are charted, and how many already played trail behind it. */
const CHART_AHEAD = 60;
const CHART_BEHIND = 3;
/** Songs after the playing one that get a ring. */
export const CHART_RINGED = 8;

const MAX_LEVEL = 8;

interface QueueChartStar {
    id: string;
    /** Position in the queue relative to the playing song: 1 is next. */
    order: number;
}

export interface QueueChart {
    geometry: THREE.BufferGeometry;
    /** The charted songs after the playing one, nearest first. */
    ahead: QueueChartStar[];
    /** World distance between the finest dots. */
    step: number;
}

function aheadAlpha(order: number) {
    if (order < CHART_RINGED) return 0.62;
    return THREE.MathUtils.lerp(0.62, 0.14, (order - CHART_RINGED) / (CHART_AHEAD - CHART_RINGED));
}

/**
 * The stipple for a queue resolved to map positions, in play order; `playing` is the playing song's index (or -1).
 * `end(i)` gives star i's size scale and the pixels kept clear beyond its disc; `reach`, how far a jump shows from each end.
 */
export function buildQueueChart(
    stars: Array<{ id: string; at: [number, number, number]; size: number; mood: number }>,
    playing: number,
    opts: { step: number; reach: number; end: (index: number) => { scale: number; clear: number } },
): QueueChart {
    const from = Math.max(0, playing - CHART_BEHIND);
    const origin = Math.max(0, playing);
    const to = Math.min(stars.length - 1, origin + CHART_AHEAD);
    const positions: number[] = [];
    const alpha: number[] = [];
    const level: number[] = [];
    const along: number[] = [];
    const endAt: number[] = [];
    const ends: number[] = [];
    const endMood: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const fall = opts.reach * 0.45;

    const segments: Array<{ i: number; length: number }> = [];
    for (let i = from; i < to; i++) {
        a.fromArray(stars[i].at);
        b.fromArray(stars[i + 1].at);
        segments.push({ i, length: a.distanceTo(b) });
    }
    // Distance along the thread counts from the playing song, so the glint leaves from it.
    let travelled = -segments.filter((s) => s.i < origin).reduce((sum, s) => sum + s.length, 0);

    for (const { i, length } of segments) {
        const order = i - origin;
        const count = Math.floor(length / opts.step);
        if (count >= 2) {
            a.fromArray(stars[i].at);
            b.fromArray(stars[i + 1].at);
            dir.subVectors(b, a).divideScalar(length);
            const base = order < 0 ? 0.2 * (1 + (order + 1) / CHART_BEHIND) : aheadAlpha(order);
            const pad = (length - count * opts.step) / 2;
            const head = opts.end(i);
            const tail = opts.end(i + 1);
            for (let j = 1; j < count; j++) {
                const s = pad + j * opts.step;
                const fromEnd = Math.min(s, length - s);
                const fade = Math.exp(-Math.max(0, fromEnd - opts.reach) / fall);
                if (fade < 0.02) continue;
                const nearHead = s <= length - s;
                const near = nearHead ? head : tail;
                const star = stars[nearHead ? i : i + 1];
                positions.push(a.x + dir.x * s, a.y + dir.y * s, a.z + dir.z * s);
                alpha.push(base * fade);
                // Both ends of a segment keep their coarsest dots, so a far view still shows where it leaves and lands.
                const k = Math.min(j, count - j);
                level.push(k === 1 ? MAX_LEVEL : Math.min(MAX_LEVEL, Math.log2(k & -k)));
                along.push(travelled + s);
                endAt.push(...star.at);
                ends.push(star.size, near.scale, near.clear);
                endMood.push(star.mood);
            }
        }
        travelled += length;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alpha, 1));
    geometry.setAttribute("aLevel", new THREE.Float32BufferAttribute(level, 1));
    geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
    geometry.setAttribute("aEndAt", new THREE.Float32BufferAttribute(endAt, 3));
    geometry.setAttribute("aEndMood", new THREE.Float32BufferAttribute(endMood, 1));
    geometry.setAttribute("aEnd", new THREE.Float32BufferAttribute(ends, 3));
    geometry.computeBoundingSphere();

    const ahead: QueueChartStar[] = [];
    for (let i = origin + 1; i <= to; i++) ahead.push({ id: stars[i].id, order: i - origin });
    return { geometry, ahead, step: opts.step };
}

/** Per-frame update: the glint's clock, the canvas size in CSS pixels, and the chart's finest step. */
export function tickChart(u: ChartUniforms, time: number | null, pixelRatio: number, width: number, height: number, step: number) {
    u.uMotion.value = time === null ? 0 : 1;
    u.uStep.value = step;
    if (time !== null) u.uTime.value = time;
    u.uPixelRatio.value = pixelRatio;
    u.uView.value.set(width, height);
}
