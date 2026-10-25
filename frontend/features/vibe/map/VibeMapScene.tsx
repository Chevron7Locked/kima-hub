"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Html, OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";

import type { VibeOperation } from "@/lib/audio-state-context";
import { useDoubleClickById } from "@/hooks/useDoubleTap";
import { useReducedMotion } from "@/hooks/useMediaQuery";
import { normalizeNFC } from "@/lib/format";
import { MOOD_COLORS, moodIndex } from "../mapUtils";
import type { MapTrack } from "../types";
import { createStarMaterial, emphasisScale, setStarFocus, STAR_MIN_PX, STAR_SIZE_SCALE, tickStars, type StarUniforms } from "./starShader";
import { buildTrackField, easeEmphasis, FIELD_RADIUS, toWorld, type TrackField } from "./trackField";
import { buildQueueChart, CHART_RINGED, createChartMaterial, tickChart, type ChartUniforms } from "./queueChart";
import { buildSkyField } from "./skyField";
import { computeMoodAnchors } from "./moodAnchors";
import { ScreenPicker } from "./screenPick";
import { createRingMaterial, fitRing, ringRadius, screenOf, type RingStar } from "./ringMark";

export interface VibeMapSceneProps {
    tracks: MapTrack[];
    trackMap: Map<string, MapTrack>;
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    playingTrackId: string | null;
    queueTrackIds: string[];
    activeOperation: VibeOperation | null;
    showLabels: boolean;
    /** A mood being previewed from the legend: its stars take on its colour. */
    focusMood: string | null;
    /** True while the next click on a star picks a destination. */
    picking: boolean;
    /** Bump to fly back to the whole-library view. */
    resetSignal: number;
    /** Fly to this track (a search pick). `nonce` makes a repeat request count. */
    flyTo: { id: string; nonce: number } | null;
    /** Pixels covered by a panel on the right; the selected star is kept clear of them. */
    coveredRight: number;
    onTrackClick: (trackId: string) => void;
    onTrackDoubleClick: (trackId: string) => void;
    onTrackMenu: (trackId: string, at: { x: number; y: number }) => void;
    onBackgroundClick: () => void;
}

const CAMERA_KEY = "kima_vibe_camera_v3";
const AMBER = "#fca200";
const OPERATION_RING: Partial<Record<VibeOperation["type"], string>> = {
    drift: AMBER,
    vibe: "#4fcf8a",
    similar: "#6f9be0",
};
const QUEUE_COLOR = "#c9b184";

const DRAG_TOLERANCE_PX = 5;
const PICK_RADIUS_PX = 12;
const HOVER_DWELL_MS = 400;
// Matches useDoubleClickById's window; nothing moves the camera inside it.
const DOUBLE_CLICK_WINDOW_MS = 420;
// The home view looks at the cloud from a little above, far enough back that
// 95% of the stars fit the screen across and up, whatever its shape.
const HOME_DIRECTION = new THREE.Vector3(0, 0.42, 1).normalize();
const HOME_SHARE = 0.95;

/** Distance from the cloud's centre at which the home view fits it on a screen of this shape. */
function homeDistance(field: TrackField, fovDegrees: number, aspect: number): number {
    const forward = HOME_DIRECTION.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward);
    const n = field.positions.length / 3;
    const across = new Float32Array(n);
    const upward = new Float32Array(n);
    const toward = new Float32Array(n);
    const o = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
        o.fromArray(field.positions, i * 3).sub(field.center);
        across[i] = Math.abs(o.dot(right));
        upward[i] = Math.abs(o.dot(up));
        toward[i] = o.dot(HOME_DIRECTION);
    }
    const share = (values: Float32Array) => values.sort()[Math.floor((n - 1) * HOME_SHARE)] ?? 0;
    const halfUp = THREE.MathUtils.degToRad(fovDegrees) / 2;
    const halfAcross = Math.atan(Math.tan(halfUp) * aspect);
    return Math.max(0, share(toward)) + Math.max(share(across) / Math.tan(halfAcross), share(upward) / Math.tan(halfUp), field.radius);
}

type Controls = ComponentRef<typeof OrbitControls>;
interface Flight { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t: number; duration: number }

/** What the DOM layer needs from the 3-D scene. */
interface SceneApi {
    pick: (x: number, y: number) => string | null;
    isCameraMoving: () => boolean;
}

function loadCamera(): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    try {
        const raw = sessionStorage.getItem(CAMERA_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw) as { p: number[]; t: number[] };
        if (s.p?.length !== 3 || s.t?.length !== 3 || [...s.p, ...s.t].some((v) => !Number.isFinite(v))) return null;
        return { position: new THREE.Vector3(...s.p), target: new THREE.Vector3(...s.t) };
    } catch {
        return null;
    }
}

function saveCamera(position: THREE.Vector3, target: THREE.Vector3) {
    try {
        sessionStorage.setItem(CAMERA_KEY, JSON.stringify({ p: position.toArray(), t: target.toArray() }));
    } catch { /* storage unavailable */ }
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

function Chip({ position, tone, children }: { position: [number, number, number]; tone: "track" | "focus"; children: React.ReactNode }) {
    return (
        <Html position={position} center zIndexRange={[20, 0]} pointerEvents="none" style={{ pointerEvents: "none" }}>
            <div className={`vibe-chip vibe-chip--${tone}`}>{children}</div>
        </Html>
    );
}

/**
 * Mood names floating at each mood's densest pocket. Every frame they are
 * projected and laid out biggest-mood-first; a label that would overlap one
 * already placed, or sit off the edge of the view, fades out.
 */
function MoodLabels({ anchors }: { anchors: Array<{ mood: string; label: string; position: [number, number, number] }> }) {
    const refs = useRef<Array<HTMLDivElement | null>>([]);
    const v = useMemo(() => new THREE.Vector3(), []);
    const { size } = useThree();
    useFrame(({ camera }) => {
        const placed: Array<[number, number, number, number]> = [];
        anchors.forEach((a, k) => {
            const el = refs.current[k];
            if (!el) return;
            v.set(...a.position).project(camera);
            let show = v.z < 1 && Math.abs(v.x) < 0.86 && Math.abs(v.y) < 0.86;
            if (show) {
                const x = ((v.x + 1) / 2) * size.width;
                const y = ((1 - v.y) / 2) * size.height;
                const w = el.offsetWidth / 2 + 6, h = el.offsetHeight / 2 + 4;
                show = !placed.some(([px, py, pw, ph]) => Math.abs(px - x) < pw + w && Math.abs(py - y) < ph + h);
                if (show) placed.push([x, y, w, h]);
            }
            el.style.opacity = show ? "1" : "0";
        });
    });
    return (
        <>
            {anchors.map((a, k) => (
                <Html key={a.mood} position={a.position} center zIndexRange={[10, 0]} pointerEvents="none" style={{ pointerEvents: "none" }}>
                    <div ref={(el) => { refs.current[k] = el; }} className="vibe-chip vibe-chip--region" style={{ transition: "opacity 200ms", opacity: 0 }}>{a.label}</div>
                </Html>
            ))}
        </>
    );
}

/** Gaps in CSS pixels between a star's disc and its rings. */
const GAP = { queued: 4.5, hover: 4, selectedInner: 3, selectedOuter: 6.5, playing: 6.5, operation: 10 } as const;
// Emphasis the playing and selected stars ease toward.
const PLAYING_EMPHASIS = 1.5;
const SELECTED_EMPHASIS = 1.7;

/** A star as the field draws it, for its rings and the queue's stipple. */
function fieldStar(field: TrackField, stars: StarUniforms, id: string | null | undefined): RingStar | null {
    const i = id ? field.indexById.get(id) : undefined;
    if (i === undefined) return null;
    const p = field.positions;
    const g = field.geometry;
    return {
        at: [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]],
        size: g.getAttribute("aSize").getX(i),
        mood: g.getAttribute("aMood").getX(i),
        emphasis: field.emphasis,
        index: i,
        stars,
    };
}

function Ring({ star, gap, color, opacity = 0.75, width = 1, pulse = false }: { star: RingStar; gap: number; color: string; opacity?: number; width?: number; pulse?: boolean }) {
    const mesh = useRef<THREE.Mesh>(null);
    const reduced = useReducedMotion();
    const material = useMemo(() => createRingMaterial(color, opacity), [color, opacity]);
    useEffect(() => () => material.dispose(), [material]);
    useFrame(({ camera, size, gl, clock }) => {
        if (!mesh.current) return;
        const swell = pulse && !reduced ? 1 + Math.sin(clock.elapsedTime * 2.4) * 0.08 : 1;
        fitRing(mesh.current, star, camera as THREE.PerspectiveCamera, size.height, gl.getPixelRatio(), gap, width, swell);
    });
    return (
        <Billboard position={star.at}>
            <mesh ref={mesh} renderOrder={6} material={material}>
                <planeGeometry args={[2, 2]} />
            </mesh>
        </Billboard>
    );
}

/**
 * Rings on the next few songs. Each frame a ring is left off where it would cross a
 * ring already drawn: the playing, selected and song-path start stars' first, then nearer songs'.
 */
function QueueRings({ stars, avoid }: { stars: Array<{ order: number; star: RingStar }>; avoid: Array<{ star: RingStar; gap: number }> }) {
    const meshes = useRef<Array<THREE.Mesh | null>>([]);
    const materials = useMemo(() => stars.map((s) => createRingMaterial(QUEUE_COLOR, 0.5 - s.order * 0.03)), [stars]);
    useEffect(() => () => { for (const m of materials) m.dispose(); }, [materials]);
    useFrame(({ camera, size, gl }) => {
        const cam = camera as THREE.PerspectiveCamera;
        const pixelRatio = gl.getPixelRatio();
        const taken: Array<[number, number, number]> = [];
        for (const a of avoid) {
            const p = screenOf(a.star.at, cam, size.width, size.height);
            if (p) taken.push([p[0], p[1], ringRadius(a.star, cam, pixelRatio, a.gap) * 1.08]);
        }
        stars.forEach((s, k) => {
            const m = meshes.current[k];
            if (!m) return;
            const r = fitRing(m, s.star, cam, size.height, pixelRatio, GAP.queued, 0.75);
            const p = screenOf(s.star.at, cam, size.width, size.height);
            m.visible = p !== null && taken.every(([x, y, tr]) => Math.hypot(p[0] - x, p[1] - y) > r + tr + 2);
            if (m.visible && p) taken.push([p[0], p[1], r]);
        });
    });
    return (
        <>
            {stars.map((s, k) => (
                <Billboard key={s.order} position={s.star.at}>
                    <mesh ref={(el) => { meshes.current[k] = el; }} renderOrder={6} material={materials[k]}>
                        <planeGeometry args={[2, 2]} />
                    </mesh>
                </Billboard>
            ))}
        </>
    );
}

function Scene(props: VibeMapSceneProps & { apiRef: MutableRefObject<SceneApi | null>; hoverId: string | null }) {
    const {
        tracks, trackMap, highlightedIds, selectedTrackId, playingTrackId, queueTrackIds, activeOperation,
        showLabels, focusMood, resetSignal, flyTo, coveredRight, apiRef, hoverId,
    } = props;
    const reduced = useReducedMotion();
    const { camera, size } = useThree();
    const controls = useRef<Controls>(null);

    const field: TrackField = useMemo(() => buildTrackField(tracks), [tracks]);
    const anchorPositions = useMemo(
        () => computeMoodAnchors(tracks).map((a) => ({ mood: a.mood, label: a.label, position: toWorld(a) })),
        [tracks],
    );
    const picker = useMemo(() => new ScreenPicker(field.positions), [field]);
    const sky = useMemo(() => buildSkyField(), []);
    const trackStars = useMemo(() => createStarMaterial({ sizeScale: STAR_SIZE_SCALE, opacity: 0.9, minPx: STAR_MIN_PX }), []);
    const skyStars = useMemo(() => createStarMaterial({ sizeScale: STAR_SIZE_SCALE, opacity: 0.9, minPx: STAR_MIN_PX, revealFade: 0.9 }), []);
    const chartInk = useMemo(() => createChartMaterial(QUEUE_COLOR, trackStars.uniforms), [trackStars]);

    useEffect(() => () => { field.geometry.dispose(); }, [field]);
    useEffect(() => () => {
        sky.dispose();
        trackStars.material.dispose();
        skyStars.material.dispose();
        chartInk.material.dispose();
    }, [sky, trackStars, skyStars, chartInk]);

    // ── emphasis: search/similar/path/mood highlights, selection, now playing ──
    const emphasisGoal = useMemo(() => {
        const goal = new Float32Array(tracks.length);
        const hasHighlights = highlightedIds.size > 0;
        goal.fill(hasHighlights ? 0.12 : selectedTrackId ? 0.6 : 1);
        if (hasHighlights) {
            for (const id of highlightedIds) {
                const i = field.indexById.get(id);
                if (i !== undefined) goal[i] = 1.35;
            }
        }
        const playing = playingTrackId ? field.indexById.get(playingTrackId) : undefined;
        if (playing !== undefined) goal[playing] = Math.max(goal[playing], PLAYING_EMPHASIS);
        const selected = selectedTrackId ? field.indexById.get(selectedTrackId) : undefined;
        if (selected !== undefined) goal[selected] = SELECTED_EMPHASIS;
        return goal;
    }, [tracks.length, highlightedIds, selectedTrackId, playingTrackId, field]);
    const emphasisSettled = useRef(false);
    useEffect(() => { emphasisSettled.current = false; }, [emphasisGoal]);

    // Mood focus colour (the legend preview).
    useEffect(() => {
        const idx = focusMood ? moodIndex(focusMood) : -1;
        if (idx >= 0) setStarFocus(trackStars.uniforms, idx, MOOD_COLORS[focusMood!]);
    }, [focusMood, trackStars]);

    // The frame loop mutates GPU-side objects every frame; it reads them through
    // this ref rather than closing over render values.
    const rig = useRef<{ field: TrackField; emphasisGoal: Float32Array; materials: StarUniforms[]; chart: ChartUniforms; chartStep: number; reduced: boolean; focusOn: boolean } | null>(null);
    useLayoutEffect(() => {
        rig.current = {
            field, emphasisGoal, reduced,
            materials: [trackStars.uniforms, skyStars.uniforms],
            chart: chartInk.uniforms,
            chartStep: rig.current?.chartStep ?? 1,
            focusOn: !!focusMood && moodIndex(focusMood) >= 0,
        };
    }, [field, emphasisGoal, trackStars, skyStars, chartInk, reduced, focusMood]);

    // ── camera ──
    const fov = (camera as THREE.PerspectiveCamera).fov;
    const aspect = size.width / Math.max(size.height, 1);
    const home = useMemo(() => {
        const target = field.center.clone();
        const distance = homeDistance(field, fov, aspect);
        return { target, distance, position: target.clone().addScaledVector(HOME_DIRECTION, distance) };
    }, [field, fov, aspect]);
    const flight = useRef<Flight | null>(null);
    const flyToPose = useCallback((position: THREE.Vector3, target: THREE.Vector3, duration: number) => {
        const c = controls.current;
        if (!c) return;
        flight.current = {
            fromPos: camera.position.clone(), toPos: position.clone(),
            fromTarget: c.target.clone(), toTarget: target.clone(),
            t: 0, duration: reduced ? 0.001 : duration,
        };
    }, [camera, reduced]);

    const restored = useRef(false);
    useEffect(() => {
        if (restored.current || !controls.current) return;
        restored.current = true;
        const saved = loadCamera();
        camera.position.copy(saved?.position ?? home.position);
        controls.current.target.copy(saved?.target ?? home.target);
        controls.current.update();
    }, [camera, home]);

    // Each press of "show the whole library" flies home once; a resize does not fly again.
    const handledReset = useRef(resetSignal);
    useEffect(() => {
        if (resetSignal === handledReset.current) return;
        handledReset.current = resetSignal;
        flyToPose(home.position, home.target, 1.2);
    }, [resetSignal, home, flyToPose]);

    // A search pick: glide to the star and stop at a comfortable distance.
    const handledFlyTo = useRef<number | null>(null);
    useEffect(() => {
        const c = controls.current;
        const t = flyTo ? trackMap.get(flyTo.id) : undefined;
        if (!c || !t || !flyTo || flyTo.nonce === handledFlyTo.current) return;
        handledFlyTo.current = flyTo.nonce;
        const star = new THREE.Vector3(...toWorld(t));
        const dir = camera.position.clone().sub(c.target).normalize();
        const dist = Math.min(camera.position.distanceTo(c.target), field.radius * 0.55);
        flyToPose(star.clone().addScaledVector(dir, dist), star, 1.1);
    }, [flyTo, trackMap, camera, field.radius, flyToPose]);

    // Keep the selected star out from under the side panel. The slide waits
    // until a double-click could no longer be in progress (so the second click
    // still lands on the same star) and until any flight -- a search result's
    // fly-to -- has landed, then only moves if the star is actually covered.
    useEffect(() => {
        const i = selectedTrackId ? field.indexById.get(selectedTrackId) : undefined;
        if (i === undefined || coveredRight <= 0) return;
        let timer: ReturnType<typeof setTimeout>;
        const check = () => {
            const c = controls.current;
            if (!c) return;
            if (flight.current) { timer = setTimeout(check, 120); return; }
            const [sx] = picker.screenOf(camera, size.width, size.height, i);
            const limit = size.width - coveredRight - 32;
            if (Number.isFinite(sx) && sx < limit) return;
            const star = new THREE.Vector3(field.positions[i * 3], field.positions[i * 3 + 1], field.positions[i * 3 + 2]);
            if (!Number.isFinite(sx)) {
                // Behind the camera or far off-screen: centre it instead.
                const dir = camera.position.clone().sub(c.target).normalize();
                flyToPose(star.clone().addScaledVector(dir, camera.position.distanceTo(c.target)), star, 0.9);
                return;
            }
            const fovRad = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
            const perPixel = (2 * camera.position.distanceTo(star) * Math.tan(fovRad / 2)) / size.height;
            const shiftPx = sx - (size.width - coveredRight) / 2;
            const shift = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(shiftPx * perPixel);
            flyToPose(camera.position.clone().add(shift), c.target.clone().add(shift), 0.7);
        };
        timer = setTimeout(check, DOUBLE_CLICK_WINDOW_MS);
        return () => clearTimeout(timer);
    }, [selectedTrackId, coveredRight, field, picker, camera, size.width, size.height, flyToPose]);

    const [overview, setOverview] = useState(true);
    const frame = useRef(0);
    const lastSave = useRef(new THREE.Vector3());
    const lastPose = useRef({ p: new THREE.Vector3(), q: new THREE.Quaternion(), movingUntil: 0 });
    const revealStart = useRef<number | null>(null);
    const focusMix = useRef(0);
    useEffect(() => { revealStart.current = null; }, [field]);

    useFrame((state, delta) => {
        const c = controls.current;
        if (!c || !rig.current) return;
        const { camera: cam, clock } = state;
        const { field: f, emphasisGoal: goal, materials, chart, chartStep, reduced: still, focusOn } = rig.current;

        if (flight.current) {
            const fl = flight.current;
            // Leftover drag momentum would keep turning the camera under the
            // flight; with damping off it is spent at once and the flight lands exactly.
            c.enableDamping = false;
            fl.t = Math.min(1, fl.t + delta / fl.duration);
            const k = easeOutExpo(fl.t);
            cam.position.lerpVectors(fl.fromPos, fl.toPos, k);
            c.target.lerpVectors(fl.fromTarget, fl.toTarget, k);
            if (fl.t >= 1) {
                flight.current = null;
                c.enableDamping = true;
            }
        }

        // Keep the orbit centre inside the cloud.
        const offset = c.target.clone().sub(f.center);
        const maxOffset = f.radius * 1.3;
        if (offset.length() > maxOffset) {
            const clamped = f.center.clone().addScaledVector(offset.normalize(), maxOffset);
            cam.position.add(clamped.clone().sub(c.target));
            c.target.copy(clamped);
        }

        if (revealStart.current === null) revealStart.current = clock.elapsedTime;
        const reveal = still ? 1e6 : clock.elapsedTime - revealStart.current;
        focusMix.current += ((focusOn ? 1 : 0) - focusMix.current) * Math.min(1, delta * 8);
        // Star sizes are in device pixels, so they follow the canvas pixel ratio.
        const pixelRatio = state.gl.getPixelRatio();
        for (const u of materials) tickStars(u, still ? null : clock.elapsedTime, reveal, focusMix.current, pixelRatio);
        tickChart(chart, still ? null : clock.elapsedTime, pixelRatio, state.size.width, state.size.height, chartStep);
        if (!emphasisSettled.current) {
            emphasisSettled.current = easeEmphasis(f, goal, still ? 1 : Math.min(1, delta * 7));
        }

        const pose = lastPose.current;
        if (pose.p.distanceToSquared(cam.position) > 1e-6 || pose.q.angleTo(cam.quaternion) > 1e-4) {
            pose.movingUntil = clock.elapsedTime + 0.15;
            pose.p.copy(cam.position);
            pose.q.copy(cam.quaternion);
        }

        frame.current++;
        if (frame.current % 15 === 0) {
            const isOverview = cam.position.distanceTo(c.target) > f.radius * 0.85;
            setOverview((prev) => (prev === isOverview ? prev : isOverview));
            if (!flight.current && cam.position.distanceToSquared(lastSave.current) > 0.01) {
                lastSave.current.copy(cam.position);
                saveCamera(cam.position, c.target);
            }
        }
    });

    // Hand the DOM layer its picking and "is the camera moving" questions.
    const clock = useThree((s) => s.clock);
    useEffect(() => {
        apiRef.current = {
            pick: (x, y) => {
                const i = picker.pick(camera, size.width, size.height, x, y, PICK_RADIUS_PX);
                return i === null ? null : tracks[i]?.id ?? null;
            },
            isCameraMoving: () => !!flight.current || clock.elapsedTime < lastPose.current.movingUntil,
        };
        return () => { apiRef.current = null; };
    }, [apiRef, picker, camera, size.width, size.height, tracks, clock]);

    // ── overlays ──
    const starU = trackStars.uniforms;
    const selectedStar = fieldStar(field, starU, selectedTrackId);
    const playingStar = fieldStar(field, starU, playingTrackId);
    const hoverStar = fieldStar(field, starU, hoverId);
    const hoverTrack = hoverId ? trackMap.get(hoverId) ?? null : null;
    const selectedTrack = selectedTrackId ? trackMap.get(selectedTrackId) ?? null : null;

    const operationSource = useMemo(() => {
        if (!activeOperation) return null;
        const id = activeOperation.type === "drift" ? activeOperation.startTrackId
            : activeOperation.type === "vibe" || activeOperation.type === "similar" ? activeOperation.sourceTrackId
            : null;
        const color = OPERATION_RING[activeOperation.type];
        const star = fieldStar(field, trackStars.uniforms, id);
        return star && color && id ? { id, star, color } : null;
    }, [activeOperation, field, trackStars]);

    const queueChart = useMemo(() => {
        const stars = queueTrackIds.flatMap((id) => {
            const star = fieldStar(field, trackStars.uniforms, id);
            return star ? [{ ...star, id }] : [];
        });
        if (stars.length < 2) return null;
        const playing = playingTrackId ? stars.findIndex((s) => s.id === playingTrackId) : -1;
        return buildQueueChart(stars, playing, {
            step: field.baseSize * 0.15,
            reach: FIELD_RADIUS * 0.06,
            // Dots stop a little outside the star's outermost ring, at the size the star eases to.
            end: (i) => {
                const s = stars[i];
                const scale = emphasisScale(emphasisGoal[s.index]);
                if (s.id === operationSource?.id) return { scale, clear: GAP.operation + 3 };
                if (s.id === selectedTrackId) return { scale, clear: GAP.selectedOuter + 4 };
                if (s.id === playingTrackId) return { scale, clear: GAP.playing * 1.08 + 4 };
                return { scale, clear: GAP.queued + 3 };
            },
        });
    }, [queueTrackIds, playingTrackId, selectedTrackId, operationSource, emphasisGoal, field, trackStars]);
    useEffect(() => () => { queueChart?.geometry.dispose(); }, [queueChart]);
    useLayoutEffect(() => {
        if (rig.current) rig.current.chartStep = queueChart?.step ?? 1;
    }, [queueChart]);
    const ringed = useMemo(
        () => (queueChart?.ahead ?? []).slice(0, CHART_RINGED).flatMap((s) => {
            const star = s.id === playingTrackId || s.id === selectedTrackId ? null : fieldStar(field, trackStars.uniforms, s.id);
            return star ? [{ order: s.order, star }] : [];
        }),
        [queueChart, playingTrackId, selectedTrackId, field, trackStars],
    );
    const ringAvoid = [
        ...(playingStar && playingTrackId !== selectedTrackId ? [{ star: playingStar, gap: GAP.playing }] : []),
        ...(selectedStar ? [{ star: selectedStar, gap: GAP.selectedOuter }] : []),
        ...(operationSource ? [{ star: operationSource.star, gap: GAP.operation }] : []),
    ];

    const showAnchors = showLabels && overview && !selectedTrackId && highlightedIds.size === 0;

    return (
        <>
            <points geometry={sky} material={skyStars.material} renderOrder={0} />
            {queueChart && <points geometry={queueChart.geometry} material={chartInk.material} renderOrder={2} />}

            <points geometry={field.geometry} material={trackStars.material} renderOrder={3} />

            {operationSource && <Ring star={operationSource.star} gap={GAP.operation} color={operationSource.color} opacity={0.5} />}
            {playingStar && playingTrackId !== selectedTrackId && <Ring star={playingStar} gap={GAP.playing} color={AMBER} width={1.25} pulse />}
            {selectedStar && (
                <>
                    <Ring star={selectedStar} gap={GAP.selectedInner} color="#ffffff" opacity={0.8} />
                    <Ring star={selectedStar} gap={GAP.selectedOuter} color={AMBER} opacity={0.7} width={1.25} />
                </>
            )}
            {hoverStar && hoverId !== selectedTrackId && <Ring star={hoverStar} gap={GAP.hover} color="#e8d6ad" opacity={0.55} />}

            {ringed.length > 0 && <QueueRings stars={ringed} avoid={ringAvoid} />}

            {showAnchors && <MoodLabels anchors={anchorPositions} />}
            {selectedTrack && selectedTrack.id !== hoverTrack?.id && (
                <Chip position={toWorld(selectedTrack)} tone="track">{normalizeNFC(selectedTrack.title)}</Chip>
            )}
            {hoverTrack && (
                <Chip position={toWorld(hoverTrack)} tone="focus">
                    <span className="vibe-chip__title">{normalizeNFC(hoverTrack.title)}</span>
                    <span className="vibe-chip__meta">{normalizeNFC(hoverTrack.artist)}</span>
                </Chip>
            )}

            <OrbitControls
                ref={controls}
                makeDefault
                enableDamping
                dampingFactor={0.08}
                screenSpacePanning
                zoomToCursor
                rotateSpeed={0.55}
                zoomSpeed={0.9}
                minDistance={field.baseSize * 3}
                maxDistance={Math.max(field.radius * 3.2, home.distance * 1.5)}
            />

            <EffectComposer>
                <Bloom mipmapBlur luminanceThreshold={0.62} luminanceSmoothing={0.35} intensity={0.2} />
                {reduced ? <></> : <Noise blendFunction={BlendFunction.OVERLAY} opacity={0.08} />}
                <Vignette eskil={false} offset={0.22} darkness={0.82} />
            </EffectComposer>
        </>
    );
}

function hasWebGL2() {
    try {
        const gl = document.createElement("canvas").getContext("webgl2");
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        return !!gl;
    } catch {
        return false;
    }
}

export function VibeMapScene(props: VibeMapSceneProps) {
    const apiRef = useRef<SceneApi | null>(null);
    const pointer = useRef<{ x: number; y: number; button: number; id: number } | null>(null);
    // Fingers currently down; a gesture that ever had two is a pinch, never a tap.
    const activePointers = useRef(new Set<number>());
    const multiTouch = useRef(false);
    const [grabbing, setGrabbing] = useState(false);
    const [hoverId, setHoverId] = useState<string | null>(null);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMove = useRef({ x: 0, y: 0 });
    // three.js fails silently without WebGL 2, leaving an empty sky; say so instead.
    const [supported] = useState(hasWebGL2);
    const { onTrackClick, onTrackDoubleClick, onTrackMenu, onBackgroundClick } = props;
    const clickTrack = useDoubleClickById(onTrackClick, onTrackDoubleClick);

    useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
    // A rebuilt field invalidates whatever was hovered.
    useEffect(() => { setHoverId(null); }, [props.tracks]);

    const local = (e: React.PointerEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const clearHover = useCallback(() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        setHoverId(null);
    }, []);

    // A star names itself only once the pointer has rested on it and the camera
    // is still, so sweeping or orbiting never flashes labels.
    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (e.pointerType !== "mouse" || e.buttons) return clearHover();
        const p = local(e);
        const moved = Math.hypot(p.x - lastMove.current.x, p.y - lastMove.current.y);
        lastMove.current = p;
        if (moved < 1.5 && hoverTimer.current) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(function settle() {
            const api = apiRef.current;
            if (!api) return;
            if (api.isCameraMoving()) {
                hoverTimer.current = setTimeout(settle, 120);
                return;
            }
            hoverTimer.current = null;
            setHoverId(api.pick(lastMove.current.x, lastMove.current.y));
        }, HOVER_DWELL_MS);
        // Keep a nameplate only while the pointer is still on that star.
        setHoverId((cur) => (cur && apiRef.current?.pick(p.x, p.y) === cur ? cur : null));
    }, [clearHover]);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        activePointers.current.add(e.pointerId);
        if (activePointers.current.size > 1) multiTouch.current = true;
        else multiTouch.current = false;
        if (activePointers.current.size === 1) pointer.current = { ...local(e), button: e.button, id: e.pointerId };
        setGrabbing(true);
        clearHover();
    }, [clearHover]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        activePointers.current.delete(e.pointerId);
        if (activePointers.current.size === 0) setGrabbing(false);
        const down = pointer.current;
        if (!down || down.id !== e.pointerId) return;
        pointer.current = null;
        if (multiTouch.current) return;
        const p = local(e);
        if (Math.hypot(p.x - down.x, p.y - down.y) > DRAG_TOLERANCE_PX) return;
        const id = apiRef.current?.pick(p.x, p.y) ?? null;
        if (down.button === 2) {
            // Opened on release, not on the browser's contextmenu event: macOS
            // fires that on press, which would pop the menu on every right-drag.
            if (id) onTrackMenu(id, { x: e.clientX, y: e.clientY });
            return;
        }
        if (down.button !== 0) return;
        if (id) clickTrack(id);
        else onBackgroundClick();
    }, [clickTrack, onTrackMenu, onBackgroundClick]);

    if (!supported) {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-[var(--text-secondary)]" data-testid="vibe-map-unsupported">
                This browser cannot draw the map because WebGL is turned off or unavailable.
            </div>
        );
    }

    return (
        <div
            className="vibe-map-field absolute inset-0 touch-none"
            data-testid="vibe-map-field"
            data-track-count={props.tracks.length}
            data-playing-id={props.playingTrackId ?? ""}
            data-selected-id={props.selectedTrackId ?? ""}
            role="application"
            aria-label={`Music map of ${props.tracks.length} tracks. Tracks that sound alike sit close together.`}
            style={{ cursor: props.picking ? "crosshair" : hoverId ? "pointer" : grabbing ? "grabbing" : "grab" }}
            onPointerDownCapture={onPointerDown}
            onPointerUpCapture={onPointerUp}
            onPointerMove={onPointerMove}
            onPointerLeave={() => { setGrabbing(false); clearHover(); }}
            onPointerCancelCapture={(e) => { activePointers.current.delete(e.pointerId); pointer.current = null; }}
            onContextMenu={(e) => e.preventDefault()}
        >
            <Canvas
                camera={{ position: [0, 40, 100], fov: 40, near: 0.1, far: 1200 }}
                gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
                dpr={[1, 2]}
            >
                <Scene {...props} apiRef={apiRef} hoverId={hoverId} />
            </Canvas>
        </div>
    );
}
