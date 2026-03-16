"use client";

import { useState, useMemo, useRef, useEffect, useLayoutEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
    PerspectiveCamera,
    OrthographicCamera,
    MapControls,
    Text,
    Billboard,
} from "@react-three/drei";
// Post-processing disabled for GPU performance (see performance optimization)
import * as THREE from "three";
import type { MapTrack } from "../types";
import type { VibeOperation } from "@/lib/audio-state-context";
import { useDoubleClickById } from "@/hooks/useDoubleTap";
import { computeClusterLabels } from "../mapUtils";

export interface VibeSceneProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    playingTrackId?: string | null;
    selectedTrackId: string | null;
    queueTrackIds?: string[];
    activeOperation?: VibeOperation;
    showLabels?: boolean;
    onTrackClick: (trackId: string) => void;
    onTrackDoubleClick?: (trackId: string) => void;
    onTrackContextMenu?: (trackId: string, op: 'vibe' | 'similar' | 'drift') => void;
    onBackgroundClick: () => void;
}

const WORLD_SCALE = 1200;

// Soft white star palette -- neutral, slightly cool, not blue
const COLOR_DEFAULT    = new THREE.Color(0.72, 0.74, 0.78);
const COLOR_PLAYING    = new THREE.Color(1.0,  1.0,  1.0 );
const COLOR_SELECTED   = new THREE.Color(0.90, 0.92, 0.96);
const COLOR_HIGHLIGHT  = new THREE.Color(0.75, 0.85, 1.0 );
const COLOR_QUEUE      = new THREE.Color(0.988, 0.635, 0.0);
const COLOR_QUEUE_PAST = new THREE.Color(0.18,  0.11,  0.0); // played -- dim amber
const COLOR_DIMMED     = new THREE.Color(0.22, 0.23, 0.26);

const _scratchVec3 = new THREE.Vector3();
// Module-lifetime singletons -- GravityGridScene is mounted once per page session, so these are never leaked.
const PULSE_RING_GEO = new THREE.RingGeometry(0.8, 1.0, 32);

// Circular point shader -- draws gl_PointCoord-based circles with a soft glow core.
// uScale = viewportHeight * pixelRatio / 2; handles both perspective and ortho modes.
const TRACK_VERT = `
uniform float uScale;
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;
void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float ps = aSize * projectionMatrix[1][1] * uScale;
    bool isPerspective = projectionMatrix[2][3] < -0.5;
    if (isPerspective) ps /= max(1.0, -mvPosition.z);
    gl_PointSize = max(1.5, ps);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const TRACK_FRAG = `
varying vec3 vColor;
void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float r = sqrt(r2);
    float core = 1.0 - smoothstep(0.0, 0.4, r);
    float glow = 1.0 - r;
    gl_FragColor = vec4(vColor, core * 0.85 + glow * 0.35);
}
`;

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function hashToFloat(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return ((h & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
}

function computeWorldPositions(tracks: MapTrack[]): Float32Array {
    const positions = new Float32Array(tracks.length * 3);
    for (let i = 0; i < tracks.length; i++) {
        positions[i * 3] = tracks[i].x * WORLD_SCALE;
        positions[i * 3 + 1] = tracks[i].y * WORLD_SCALE;
        positions[i * 3 + 2] = hashToFloat(tracks[i].id) * WORLD_SCALE * 0.25;
    }
    return positions;
}

// ---------------------------------------------------------------------------
// Space Grid -- sparse axis lines + per-star vertical depth ticks
// ---------------------------------------------------------------------------

function SpaceGrid({
    centerX = 0,
    centerY = 0,
    spread = WORLD_SCALE,
    starPositions,
}: {
    centerX?: number;
    centerY?: number;
    spread?: number;
    starPositions: Float32Array;
}) {
    const { gridGeo, tickGeo } = useMemo(() => {
        const half = spread * 1.2;
        const step = spread * 0.25;
        const lines: number[] = [];

        // XY grid -- horizontal and vertical lines across the plane
        for (let v = -half; v <= half + 0.01; v += step) {
            // horizontal line (along X)
            lines.push(centerX - half, centerY + v, 0,  centerX + half, centerY + v, 0);
            // vertical line (along Y)
            lines.push(centerX + v, centerY - half, 0,  centerX + v, centerY + half, 0);
        }

        // Z axis lines at grid intersections
        const zHalf = spread * 0.5;
        for (let xi = -half; xi <= half + 0.01; xi += step * 2) {
            for (let yi = -half; yi <= half + 0.01; yi += step * 2) {
                lines.push(centerX + xi, centerY + yi, -zHalf,  centerX + xi, centerY + yi, zHalf);
            }
        }

        const gridArr = new Float32Array(lines);
        const gGeo = new THREE.BufferGeometry();
        gGeo.setAttribute("position", new THREE.BufferAttribute(gridArr, 3));

        // Per-star vertical depth ticks -- short line from (x,y,0) to (x,y,z)
        const ticks: number[] = [];
        const count = starPositions.length / 3;
        for (let i = 0; i < count; i++) {
            const x = starPositions[i * 3];
            const y = starPositions[i * 3 + 1];
            const z = starPositions[i * 3 + 2];
            if (Math.abs(z) < 1) continue;
            ticks.push(x, y, 0,  x, y, z);
        }
        const tickArr = new Float32Array(ticks);
        const tGeo = new THREE.BufferGeometry();
        tGeo.setAttribute("position", new THREE.BufferAttribute(tickArr, 3));

        return { gridGeo: gGeo, tickGeo: tGeo };
    }, [centerX, centerY, spread, starPositions]);

    useEffect(() => {
        return () => { gridGeo.dispose(); tickGeo.dispose(); };
    }, [gridGeo, tickGeo]);

    return (
        <>
            <lineSegments geometry={gridGeo}>
                <lineBasicMaterial color="#0088cc" transparent opacity={0.03} depthWrite={false} />
            </lineSegments>
            <lineSegments geometry={tickGeo}>
                <lineBasicMaterial color="#0066aa" transparent opacity={0.02} depthWrite={false} />
            </lineSegments>
        </>
    );
}

// ---------------------------------------------------------------------------
// Background Stars -- depth and atmosphere
// ---------------------------------------------------------------------------

function BackgroundStars({
    count = 1500,
    centerX = 0,
    centerY = 0,
    spread = WORLD_SCALE,
}: {
    count?: number;
    centerX?: number;
    centerY?: number;
    spread?: number;
}) {
    const geo = useMemo(() => {
        const rng = seededRandom(7);
        const pos = new Float32Array(count * 3);
        const col = new Float32Array(count * 3);
        const halfSpread = spread * 1.5;

        for (let i = 0; i < count; i++) {
            pos[i * 3] = centerX + (rng() - 0.5) * halfSpread * 2;
            pos[i * 3 + 1] = centerY + (rng() - 0.5) * halfSpread * 2;
            pos[i * 3 + 2] = (rng() - 0.5) * halfSpread * 2;

            const brightness = 0.3 + rng() * 0.4;
            col[i * 3] = brightness * (0.6 + rng() * 0.2);     // slight red/violet
            col[i * 3 + 1] = brightness * (0.5 + rng() * 0.2); // muted green
            col[i * 3 + 2] = brightness * (0.9 + rng() * 0.1); // strong blue
        }

        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        return g;
    }, [count, centerX, centerY, spread]);

    useEffect(() => {
        return () => { geo.dispose(); };
    }, [geo]);

    return (
        <points geometry={geo}>
            <pointsMaterial
                vertexColors
                size={0.8}
                sizeAttenuation
                transparent
                opacity={0.09}
                depthWrite={false}
            />
        </points>
    );
}

// ---------------------------------------------------------------------------
// Queue Connectors -- lines tracing the playback order of queued tracks
// ---------------------------------------------------------------------------

function QueueConnectors({
    trackPosMap,
    queueTrackIds,
    playingTrackId,
}: {
    trackPosMap: Map<string, THREE.Vector3>;
    queueTrackIds: string[];
    playingTrackId?: string | null;
}) {
    const playingIdx = playingTrackId
        ? queueTrackIds.indexOf(playingTrackId)
        : -1;

    const geometry = useMemo(() => {
        const validIds = queueTrackIds.filter(id => trackPosMap.has(id));
        if (validIds.length < 2) {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
            return g;
        }

        const segCount = validIds.length - 1;
        const positions = new Float32Array(segCount * 6);
        const colors = new Float32Array(segCount * 6);

        // Brightness envelope: glow window of ±3 segments around current position.
        // Segments outside the window are near-invisible so only the local path lights up.
        function segBrightness(i: number): number {
            if (playingIdx < 0) return 0.008;
            const fwd = i - playingIdx; // negative = past, 0 = current→next
            if (fwd < 0) {
                const d = -fwd;
                if (d === 1) return 0.035;
                if (d === 2) return 0.012;
                if (d === 3) return 0.005;
                return 0.002;
            }
            if (fwd === 0) return 0.08;
            if (fwd === 1) return 0.052;
            if (fwd === 2) return 0.026;
            if (fwd === 3) return 0.010;
            return 0.004;
        }

        for (let i = 0; i < segCount; i++) {
            const a = trackPosMap.get(validIds[i])!;
            const b = trackPosMap.get(validIds[i + 1])!;
            positions[i * 6] = a.x;
            positions[i * 6 + 1] = a.y;
            positions[i * 6 + 2] = a.z;
            positions[i * 6 + 3] = b.x;
            positions[i * 6 + 4] = b.y;
            positions[i * 6 + 5] = b.z;

            const br = segBrightness(i);
            // Amber hue (#fca200) scaled by brightness
            const r = 0.988 * br;
            const g = 0.635 * br;
            colors[i * 6] = r; colors[i * 6 + 1] = g; colors[i * 6 + 2] = 0;
            colors[i * 6 + 3] = r; colors[i * 6 + 4] = g; colors[i * 6 + 5] = 0;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        return geo;
    }, [queueTrackIds, trackPosMap, playingIdx]);

    useEffect(() => {
        return () => { geometry.dispose(); };
    }, [geometry]);

    if (queueTrackIds.length < 2) return null;

    return (
        <lineSegments geometry={geometry} renderOrder={1}>
            <lineBasicMaterial
                vertexColors
                transparent
                opacity={0.9}
                depthWrite={false}
            />
        </lineSegments>
    );
}

// ---------------------------------------------------------------------------
// Animation Driver -- single 30fps invalidate pump for all continuous animations.
// Replaces per-animation state.invalidate() calls, which each create their own
// 60fps loop and bypass frameloop="demand".
// ---------------------------------------------------------------------------

function AnimationDriver({ active }: { active: boolean }) {
    const { invalidate } = useThree();
    useEffect(() => {
        if (!active) return;
        const tick = () => { if (!document.hidden) invalidate(); };
        const id = setInterval(tick, 1000 / 30);
        return () => clearInterval(id);
    }, [active, invalidate]);
    return null;
}

// ---------------------------------------------------------------------------
// Track Points -- circular shader-based points (1 draw call, no triangular artifacts)
// ---------------------------------------------------------------------------

function TrackPoints({
    tracks,
    worldPositions,
    highlightedIds,
    playingTrackId,
    selectedTrackId,
    queueTrackIds,
    animated,
    onTrackClick,
    onTrackDoubleClick,
    onShowContextMenu,
}: {
    tracks: MapTrack[];
    worldPositions: Float32Array;
    highlightedIds: Set<string>;
    playingTrackId?: string | null;
    selectedTrackId: string | null;
    queueTrackIds?: string[];
    animated: boolean;
    onTrackClick: (trackId: string) => void;
    onTrackDoubleClick?: (trackId: string) => void;
    onShowContextMenu?: (trackId: string, x: number, y: number) => void;
}) {
    const pointsRef = useRef<THREE.Points>(null);
    const count = tracks.length;
    const detectDoubleClick = useDoubleClickById(onTrackClick, onTrackDoubleClick);
    const { gl, raycaster, size, invalidate } = useThree();

    useEffect(() => {
        const prev = raycaster.params.Points?.threshold ?? 1;
        raycaster.params.Points = { threshold: 18 };
        return () => { raycaster.params.Points = { threshold: prev }; };
    }, [raycaster]);

    const geometry = useMemo(() => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(worldPositions, 3));
        geo.setAttribute("aColor", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
        geo.setAttribute("aSize", new THREE.Float32BufferAttribute(new Float32Array(count), 1));
        return geo;
    }, [worldPositions, count]);

    const material = useMemo(() => new THREE.ShaderMaterial({
        uniforms: { uScale: { value: size.height * gl.getPixelRatio() / 2 } },
        vertexShader: TRACK_VERT,
        fragmentShader: TRACK_FRAG,
        transparent: true,
        depthWrite: false,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []); // size/gl captured for correct initial value; resize handled by useEffect

    useLayoutEffect(() => {
        const pts = pointsRef.current;
        if (!pts) return;
        (pts.material as THREE.ShaderMaterial).uniforms.uScale.value = size.height * gl.getPixelRatio() / 2;
        invalidate();
    }, [size, gl, invalidate]);

    useLayoutEffect(() => {
        const pts = pointsRef.current;
        if (!pts || count === 0) return;
        const geo = pts.geometry;
        const colorArr = (geo.attributes.aColor as THREE.BufferAttribute).array as Float32Array;
        const sizeArr = (geo.attributes.aSize as THREE.BufferAttribute).array as Float32Array;

        // Pre-build queue position Map -- eliminates O(q) indexOf per queue track in the loop.
        const queuePosMap = new Map<string, number>();
        if (queueTrackIds) for (let q = 0; q < queueTrackIds.length; q++) queuePosMap.set(queueTrackIds[q], q);
        const playingQueueIdx = playingTrackId ? (queuePosMap.get(playingTrackId) ?? -1) : -1;
        const hasActive = highlightedIds.size > 0 || !!playingTrackId || !!selectedTrackId;
        const _c = new THREE.Color();

        for (let i = 0; i < count; i++) {
            const track = tracks[i];
            const energy = track.energy ?? 0.5;
            const baseSize = 14 + energy * 14;

            const isPlaying     = track.id === playingTrackId;
            const isSelected    = track.id === selectedTrackId;
            const isHighlighted = highlightedIds.has(track.id);
            const queuePos      = queuePosMap.get(track.id) ?? -1;
            const isInQueue     = queuePos !== -1;
            const isPastQueue   = isInQueue && playingQueueIdx >= 0 && queuePos < playingQueueIdx;

            if (isPlaying) {
                _c.copy(COLOR_PLAYING);
                sizeArr[i] = baseSize * 1.7;
            } else if (isSelected) {
                _c.copy(COLOR_SELECTED);
                sizeArr[i] = baseSize * 1.4;
            } else if (isHighlighted) {
                _c.copy(COLOR_HIGHLIGHT);
                sizeArr[i] = baseSize * 1.2;
            } else if (isInQueue && !isPastQueue) {
                _c.copy(COLOR_QUEUE);
                sizeArr[i] = baseSize * 1.15;
            } else if (isPastQueue) {
                _c.copy(COLOR_QUEUE_PAST);
                sizeArr[i] = baseSize * 0.9;
            } else if (hasActive) {
                _c.copy(COLOR_DIMMED);
                sizeArr[i] = baseSize;
            } else {
                _c.copy(COLOR_DEFAULT);
                sizeArr[i] = baseSize;
            }

            colorArr[i * 3]     = _c.r;
            colorArr[i * 3 + 1] = _c.g;
            colorArr[i * 3 + 2] = _c.b;
        }

        (geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
        (geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
        invalidate();
    }, [count, tracks, worldPositions, highlightedIds, playingTrackId, selectedTrackId, queueTrackIds, invalidate]);

    const trackIdToIndex = useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < tracks.length; i++) map.set(tracks[i].id, i);
        return map;
    }, [tracks]);

    const lastPulseTime = useRef(0);

    useFrame((state) => {
        if (!animated) return;
        const pts = pointsRef.current;
        if (!playingTrackId || !pts || count === 0) return;
        const now = state.clock.elapsedTime;
        if (now - lastPulseTime.current < 0.033) return;
        lastPulseTime.current = now;

        const playingIdx = trackIdToIndex.get(playingTrackId) ?? -1;
        if (playingIdx === -1) return;

        const energy = tracks[playingIdx].energy ?? 0.5;
        const baseSize = 4 + energy * 4;
        const pulse = 1 + Math.sin(now * 2.5) * 0.15;
        const sizeAttr = pts.geometry.attributes.aSize as THREE.BufferAttribute;
        (sizeAttr.array as Float32Array)[playingIdx] = baseSize * 1.7 * pulse;
        sizeAttr.needsUpdate = true;
    });

    useEffect(() => {
        return () => { geometry.dispose(); material.dispose(); };
    }, [geometry, material]);

    return (
        <points
            ref={pointsRef}
            geometry={geometry}
            material={material}
            renderOrder={2}
            onClick={(e) => {
                e.stopPropagation();
                const idx = e.index;
                if (idx !== undefined && idx >= 0 && idx < tracks.length) {
                    detectDoubleClick(tracks[idx].id);
                }
            }}
            onContextMenu={(e) => {
                e.stopPropagation();
                const idx = e.index;
                if (idx !== undefined && idx >= 0 && idx < tracks.length) {
                    e.nativeEvent.preventDefault();
                    onShowContextMenu?.(tracks[idx].id, e.nativeEvent.clientX, e.nativeEvent.clientY);
                }
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// Track Labels -- Billboard text for selected/playing tracks (0-2 labels max)
// ---------------------------------------------------------------------------

function TrackLabels({
    tracks,
    worldPositions,
    selectedTrackId,
    playingTrackId,
}: {
    tracks: MapTrack[];
    worldPositions: Float32Array;
    selectedTrackId: string | null;
    playingTrackId?: string | null;
}) {
    const labels = useMemo(() => {
        const result: Array<{ track: MapTrack; index: number; isSelected: boolean }> = [];
        for (let i = 0; i < tracks.length; i++) {
            const id = tracks[i].id;
            if (id === selectedTrackId || id === playingTrackId) {
                result.push({ track: tracks[i], index: i, isSelected: id === selectedTrackId });
            }
        }
        return result;
    }, [tracks, selectedTrackId, playingTrackId]);

    if (labels.length === 0) return null;

    return (
        <>
            {labels.map(({ track, index, isSelected }) => {
                const energy = track.energy ?? 0.5;
                const labelOffset = 14 + energy * 6;

                return (
                    <Billboard
                        key={track.id}
                        position={[
                            worldPositions[index * 3],
                            worldPositions[index * 3 + 1] + labelOffset,
                            worldPositions[index * 3 + 2],
                        ]}
                    >
                        <Text
                            fontSize={10}
                            color="#c0d8ff"
                            fillOpacity={isSelected ? 0.8 : 0.6}
                            anchorX="center"
                            anchorY="bottom"
                            maxWidth={80}
                            textAlign="center"
                        >
                            {track.title + "\n" + track.artist}
                        </Text>
                    </Billboard>
                );
            })}
        </>
    );
}

// ---------------------------------------------------------------------------
// Chart Labels -- astronomical map style labels with leader lines (2D only)
// ---------------------------------------------------------------------------

// Region labels -- mood-cluster names floating over each vibe zone.
// Uses a fine grid then deduplicates by mood name via weighted centroid so each
// label (Upbeat, Chill, etc.) appears exactly once at its geographic center.
function RegionLabels({ tracks }: { tracks: MapTrack[] }) {
    const labels = useMemo(() => {
        const raw = computeClusterLabels(tracks, { minX: 0, maxX: 1, minY: 0, maxY: 1 }, 6);
        // Merge cells with the same mood name into a single weighted centroid
        const byLabel = new Map<string, { x: number; y: number; weight: number }>();
        for (const l of raw) {
            const prev = byLabel.get(l.label);
            if (prev) {
                const w = prev.weight + l.count;
                prev.x = (prev.x * prev.weight + l.x * l.count) / w;
                prev.y = (prev.y * prev.weight + l.y * l.count) / w;
                prev.weight = w;
            } else {
                byLabel.set(l.label, { x: l.x, y: l.y, weight: l.count });
            }
        }
        return Array.from(byLabel.entries()).map(([label, { x, y }]) => ({ label, x, y }));
    }, [tracks]);

    if (labels.length === 0) return null;

    return (
        <>
            {labels.map((label, i) => (
                <Billboard key={i} position={[label.x * WORLD_SCALE, label.y * WORLD_SCALE, 0]}>
                    <Text
                        fontSize={15}
                        color="#c8d4e8"
                        fillOpacity={0.11}
                        anchorX="center"
                        anchorY="middle"
                        letterSpacing={0.20}
                        depthOffset={-1}
                    >
                        {label.label.toUpperCase()}
                    </Text>
                </Billboard>
            ))}
        </>
    );
}

// ---------------------------------------------------------------------------
// Operation Source Pulse -- expanding ring at the vibe/drift/similar source track
// ---------------------------------------------------------------------------

function OperationSourcePulse({
    tracks,
    worldPositions,
    trackId,
    color,
    animated,
}: {
    tracks: MapTrack[];
    worldPositions: Float32Array;
    trackId: string;
    color: string;
    animated: boolean;
}) {
    const meshRef = useRef<THREE.Mesh>(null);
    const matRef = useRef<THREE.MeshBasicMaterial>(null);

    const sourceIdx = useMemo(() => {
        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].id === trackId) return i;
        }
        return -1;
    }, [tracks, trackId]);

    useFrame((state) => {
        if (!animated || sourceIdx === -1) return;
        const mesh = meshRef.current;
        const mat = matRef.current;
        if (!mesh || !mat) return;

        const time = state.clock.elapsedTime;
        const cycle = (time * 0.5) % 1;

        mesh.position.set(
            worldPositions[sourceIdx * 3],
            worldPositions[sourceIdx * 3 + 1],
            worldPositions[sourceIdx * 3 + 2],
        );
        mesh.lookAt(state.camera.position);

        const scale = 5 + cycle * 35;
        mesh.scale.setScalar(scale);
        mat.opacity = 0.2 * (1 - cycle * cycle);
    });

    if (sourceIdx === -1) return null;

    return (
        <mesh ref={meshRef} geometry={PULSE_RING_GEO}>
            <meshBasicMaterial
                ref={matRef}
                color={color}
                transparent
                opacity={0.2}
                side={THREE.DoubleSide}
                depthWrite={false}
            />
        </mesh>
    );
}

// Max raw mouse delta (pixels) consumed per RAF flush.
// Prevents a single high-DPI or turbo-polling-rate event burst
// from snapping the camera by hundreds of degrees in one frame.
const MAX_MOUSE_DELTA = 50;

// ---------------------------------------------------------------------------
// FPS Controls -- direct Pointer Lock API for mouse look + WASD movement
// ---------------------------------------------------------------------------

function FPSControls({
    speed = 80,
    lookAtX,
    lookAtY,
    onLockChange,
}: {
    speed?: number;
    lookAtX: number;
    lookAtY: number;
    onLockChange: (locked: boolean) => void;
}) {
    const { camera, gl, invalidate } = useThree();
    const keys = useRef<Set<string>>(new Set());
    const isLocked = useRef(false);
    const hasInitLook = useRef(false);
    const eulerRef = useRef(new THREE.Euler(0, 0, 0, "YXZ"));

    useEffect(() => {
        if (!hasInitLook.current) {
            camera.lookAt(lookAtX, lookAtY, 0);
            hasInitLook.current = true;
        }
    }, [camera, lookAtX, lookAtY]);

    useEffect(() => {
        const canvas = gl.domElement;

        // Accumulate raw mouse deltas and flush once per RAF tick.
        // Without this, high-polling-rate mice (1000-8000 Hz) call invalidate()
        // thousands of times per second, triggering a full render on each event.
        let pendingDX = 0, pendingDY = 0;
        let rafId: number | null = null;

        const flushMove = () => {
            rafId = null;
            if (pendingDX === 0 && pendingDY === 0) return;
            const sensitivity = 0.002;
            const euler = eulerRef.current;
            euler.setFromQuaternion(camera.quaternion);
            const dx = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, pendingDX));
            const dy = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, pendingDY));
            euler.y -= dx * sensitivity;
            euler.x -= dy * sensitivity;
            euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
            camera.quaternion.setFromEuler(euler);
            pendingDX = 0;
            pendingDY = 0;
            invalidate();
        };

        const onClick = () => {
            if (!isLocked.current) canvas.requestPointerLock();
        };

        const onLockChangeEvent = () => {
            const locked = document.pointerLockElement === canvas;
            isLocked.current = locked;
            onLockChange(locked);
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isLocked.current) return;
            pendingDX += e.movementX;
            pendingDY += e.movementY;
            if (rafId === null) rafId = requestAnimationFrame(flushMove);
        };

        canvas.addEventListener("click", onClick);
        document.addEventListener("pointerlockchange", onLockChangeEvent);
        document.addEventListener("mousemove", onMouseMove);

        return () => {
            canvas.removeEventListener("click", onClick);
            document.removeEventListener("pointerlockchange", onLockChangeEvent);
            document.removeEventListener("mousemove", onMouseMove);
            if (rafId !== null) cancelAnimationFrame(rafId);
            if (document.pointerLockElement === canvas) document.exitPointerLock();
        };
    }, [camera, gl, onLockChange, invalidate]);

    useEffect(() => {
        const down = (e: KeyboardEvent) => keys.current.add(e.code);
        const up = (e: KeyboardEvent) => keys.current.delete(e.code);
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
        };
    }, []);

    useFrame((state, delta) => {
        if (!isLocked.current) return;
        const v = _scratchVec3.set(0, 0, 0);
        const boost = keys.current.has("KeyR") ? 3 : 1;
        const s = speed * boost;
        if (keys.current.has("KeyW") || keys.current.has("ArrowUp")) v.z -= 1;
        if (keys.current.has("KeyS") || keys.current.has("ArrowDown")) v.z += 1;
        if (keys.current.has("KeyA") || keys.current.has("ArrowLeft")) v.x -= 1;
        if (keys.current.has("KeyD") || keys.current.has("ArrowRight")) v.x += 1;
        if (keys.current.has("Space")) v.y += 1;
        if (keys.current.has("ShiftLeft") || keys.current.has("ShiftRight")) v.y -= 1;
        if (v.length() > 0) {
            v.normalize().multiplyScalar(s * delta);
            v.applyQuaternion(camera.quaternion);
            camera.position.add(v);
            state.invalidate();
        }
    });

    return null;
}

// ---------------------------------------------------------------------------
// Camera persistence -- save/restore view position across reloads
// ---------------------------------------------------------------------------

const GALAXY_CAM_KEY = "kima_galaxy_camera";

interface SavedCameraState {
    px: number; py: number; pz: number;
    qx: number; qy: number; qz: number; qw: number;
    zoom: number;
    is3D: boolean;
}

function saveCameraState(camera: THREE.Camera, is3D: boolean) {
    const state: SavedCameraState = {
        px: camera.position.x, py: camera.position.y, pz: camera.position.z,
        qx: camera.quaternion.x, qy: camera.quaternion.y,
        qz: camera.quaternion.z, qw: camera.quaternion.w,
        zoom: (camera as THREE.OrthographicCamera).zoom ?? 1,
        is3D,
    };
    try { sessionStorage.setItem(GALAXY_CAM_KEY, JSON.stringify(state)); } catch { /* noop */ }
}

function loadCameraState(): SavedCameraState | null {
    try {
        const raw = sessionStorage.getItem(GALAXY_CAM_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function CameraPersistence({ is3D }: { is3D: boolean }) {
    const { camera } = useThree();
    const frameCount = useRef(0);
    const lastSavedPos = useRef<THREE.Vector3>(new THREE.Vector3(Infinity, Infinity, Infinity));

    useLayoutEffect(() => {
        const saved = loadCameraState();
        if (!saved) return;
        camera.position.set(saved.px, saved.py, saved.pz);
        if (is3D) {
            camera.quaternion.set(saved.qx, saved.qy, saved.qz, saved.qw);
        }
        if (!is3D && "zoom" in camera) {
            (camera as THREE.OrthographicCamera).zoom = saved.zoom;
            camera.updateProjectionMatrix();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // run once on mount

    useFrame((state) => {
        frameCount.current++;
        if (frameCount.current % 60 === 0) {
            // Only write sessionStorage if camera has actually moved
            if (state.camera.position.distanceToSquared(lastSavedPos.current) > 0.01) {
                lastSavedPos.current.copy(state.camera.position);
                saveCameraState(state.camera, is3D);
            }
        }
    });

    return null;
}

// ---------------------------------------------------------------------------
// Scene content
// ---------------------------------------------------------------------------

function SceneContent({
    tracks,
    highlightedIds,
    playingTrackId,
    selectedTrackId,
    queueTrackIds,
    activeOperation,
    showLabels = true,
    is3D,
    animated,
    onLockChange,
    onTrackClick,
    onTrackDoubleClick,
    onShowContextMenu,
    onRecenterRef,
}: Omit<VibeSceneProps, "onBackgroundClick" | "onTrackContextMenu"> & {
    is3D: boolean;
    animated: boolean;
    onLockChange: (locked: boolean) => void;
    onShowContextMenu?: (trackId: string, x: number, y: number) => void;
    onRecenterRef: React.MutableRefObject<(() => void) | null>;
}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controlsRef = useRef<any>(null);

    const worldPositions = useMemo(
        () => computeWorldPositions(tracks),
        [tracks],
    );

    const trackPosMap = useMemo(() => {
        const map = new Map<string, THREE.Vector3>();
        for (let i = 0; i < tracks.length; i++) {
            map.set(tracks[i].id, new THREE.Vector3(
                worldPositions[i * 3],
                worldPositions[i * 3 + 1],
                worldPositions[i * 3 + 2],
            ));
        }
        return map;
    }, [tracks, worldPositions]);

    const { center, span } = useMemo(() => {
        if (tracks.length === 0) {
            return { center: [0.5, 0.5] as const, span: 1 };
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const t of tracks) {
            if (t.x < minX) minX = t.x;
            if (t.x > maxX) maxX = t.x;
            if (t.y < minY) minY = t.y;
            if (t.y > maxY) maxY = t.y;
        }
        return {
            center: [(minX + maxX) / 2, (minY + maxY) / 2] as const,
            span: Math.max(maxX - minX, maxY - minY) || 1,
        };
    }, [tracks]);

    const worldCenterX = center[0] * WORLD_SCALE;
    const worldCenterY = center[1] * WORLD_SCALE;

    const { camera } = useThree();

    const orthoZoom = useMemo(() => {
        if (typeof window === "undefined") return 2;
        const viewportMin = Math.min(window.innerWidth, window.innerHeight);
        const worldSpan = span * WORLD_SCALE;
        return viewportMin / (worldSpan * 0.5);
    }, [span]);

    useEffect(() => {
        onRecenterRef.current = () => {
            camera.position.set(worldCenterX, worldCenterY, camera.position.z);
            if (controlsRef.current?.target) {
                controlsRef.current.target.set(worldCenterX, worldCenterY, 0);
                controlsRef.current.update();
            }
            if ("zoom" in camera && typeof camera.zoom === "number") {
                (camera as THREE.OrthographicCamera).zoom = orthoZoom;
                camera.updateProjectionMatrix();
            }
        };
        return () => { onRecenterRef.current = null; };
    }, [camera, worldCenterX, worldCenterY, orthoZoom, onRecenterRef]);

    const mapTarget = useMemo(
        () => new THREE.Vector3(worldCenterX, worldCenterY, 0),
        [worldCenterX, worldCenterY],
    );

    return (
        <>
            {is3D ? (
                <>
                    <PerspectiveCamera
                        makeDefault
                        position={[
                            worldCenterX - span * WORLD_SCALE * 0.35,
                            worldCenterY,
                            0,
                        ]}
                        fov={70}
                        near={0.1}
                        far={WORLD_SCALE * 50}
                    />
                    <FPSControls
                        speed={WORLD_SCALE * 0.08}
                        lookAtX={worldCenterX}
                        lookAtY={worldCenterY}
                        onLockChange={onLockChange}
                    />
                </>
            ) : (
                <>
                    <OrthographicCamera
                        makeDefault
                        position={[worldCenterX, worldCenterY, WORLD_SCALE * 2]}
                        zoom={orthoZoom}
                        near={0.1}
                        far={WORLD_SCALE * 50}
                    />
                    <MapControls
                        ref={controlsRef}
                        enableRotate={false}
                        enableDamping
                        dampingFactor={0.12}
                        screenSpacePanning
                        target={mapTarget}
                        minZoom={0.05}
                        maxZoom={orthoZoom * 12}
                    />
                </>
            )}

            <CameraPersistence is3D={is3D} />
            <AnimationDriver active={animated && !!playingTrackId} />

            <SpaceGrid
                centerX={worldCenterX}
                centerY={worldCenterY}
                spread={span * WORLD_SCALE}
                starPositions={worldPositions}
            />

            <BackgroundStars
                count={300}
                centerX={worldCenterX}
                centerY={worldCenterY}
                spread={span * WORLD_SCALE}
            />

            {queueTrackIds && queueTrackIds.length >= 2 && (
                <QueueConnectors
                    trackPosMap={trackPosMap}
                    queueTrackIds={queueTrackIds}
                    playingTrackId={playingTrackId}
                />
            )}

            {tracks.length > 0 && (
                <>
                    <TrackPoints
                        tracks={tracks}
                        worldPositions={worldPositions}
                        highlightedIds={highlightedIds}
                        playingTrackId={playingTrackId}
                        selectedTrackId={selectedTrackId}
                        queueTrackIds={queueTrackIds}
                        animated={animated}
                        onTrackClick={onTrackClick}
                        onTrackDoubleClick={onTrackDoubleClick}
                        onShowContextMenu={onShowContextMenu}
                    />
                    <TrackLabels
                        tracks={tracks}
                        worldPositions={worldPositions}
                        selectedTrackId={selectedTrackId}
                        playingTrackId={playingTrackId}
                    />
                    {showLabels && <RegionLabels tracks={tracks} />}
                </>
            )}

            {activeOperation?.type === 'vibe' && tracks.length > 0 && playingTrackId && (
                <OperationSourcePulse
                    tracks={tracks}
                    worldPositions={worldPositions}
                    trackId={playingTrackId}
                    color="#1db954"
                    animated={animated}
                />
            )}
            {activeOperation?.type === 'drift' && tracks.length > 0 && playingTrackId && (
                <OperationSourcePulse
                    tracks={tracks}
                    worldPositions={worldPositions}
                    trackId={playingTrackId}
                    color="#ecb200"
                    animated={animated}
                />
            )}
            {activeOperation?.type === 'similar' && tracks.length > 0 && playingTrackId && (
                <OperationSourcePulse
                    tracks={tracks}
                    worldPositions={worldPositions}
                    trackId={playingTrackId}
                    color="#5c8dd6"
                    animated={animated}
                />
            )}

            {/* EffectComposer disabled -- saves a full-screen pass per frame
            <EffectComposer>
                <Noise opacity={0.02} />
                <Vignette offset={0.3} darkness={0.65} />
            </EffectComposer>
            */}
        </>
    );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

export function GravityGridScene({
    tracks,
    highlightedIds,
    playingTrackId,
    selectedTrackId,
    queueTrackIds,
    activeOperation,
    showLabels = true,
    onTrackClick,
    onTrackDoubleClick,
    onTrackContextMenu,
    onBackgroundClick,
}: VibeSceneProps) {
    const [is3D, setIs3D] = useState(false);
    const [isLocked, setIsLocked] = useState(false);
    const [animated, setAnimated] = useState(true);
    const recenterRef = useRef<(() => void) | null>(null);
    const [contextMenu, setContextMenu] = useState<{ trackId: string; x: number; y: number } | null>(null);

    return (
        <div className="w-full h-full relative" onContextMenu={(e) => e.preventDefault()}>
            <Canvas
                id="galactic-canvas"
                frameloop="demand"
                dpr={[1, 1.5]}
                gl={{
                    antialias: false,
                    toneMapping: THREE.NoToneMapping,
                    outputColorSpace: THREE.SRGBColorSpace,
                    powerPreference: "high-performance",
                }}
                style={{ background: "#000000" }}
                onPointerMissed={onBackgroundClick}
            >
                <Suspense fallback={null}>
                    <SceneContent
                        tracks={tracks}
                        highlightedIds={highlightedIds}
                        playingTrackId={playingTrackId}
                        selectedTrackId={selectedTrackId}
                        queueTrackIds={queueTrackIds}
                        activeOperation={activeOperation}
                        showLabels={showLabels}
                        is3D={is3D}
                        animated={animated}
                        onLockChange={setIsLocked}
                        onTrackClick={onTrackClick}
                        onTrackDoubleClick={onTrackDoubleClick}
                        onShowContextMenu={(trackId, x, y) => setContextMenu({ trackId, x, y })}
                        onRecenterRef={recenterRef}
                    />
                </Suspense>
            </Canvas>

            <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-10 flex gap-2">
                <button
                    onClick={() => setAnimated(!animated)}
                    className={`px-3 py-1.5 rounded-lg backdrop-blur-md border text-xs font-medium transition-colors bg-black/20 border-white/8 hover:bg-black/30 ${
                        animated ? "text-white/40 hover:text-white/70" : "text-white/20 hover:text-white/40"
                    }`}
                >
                    {animated ? "Pause" : "Play"}
                </button>
                <button
                    onClick={() => recenterRef.current?.()}
                    className="px-3 py-1.5 rounded-lg backdrop-blur-md border text-xs font-medium transition-colors bg-black/20 border-white/8 text-white/40 hover:text-white/70 hover:bg-black/30"
                >
                    Recenter
                </button>
                <button
                    onClick={() => setIs3D(!is3D)}
                    className="px-3 py-1.5 rounded-lg backdrop-blur-md border text-xs font-medium transition-colors bg-black/20 border-white/8 text-white/40 hover:text-white/70 hover:bg-black/30"
                >
                    {is3D ? "2D" : "3D"}
                </button>
            </div>

            {contextMenu && (
                <>
                    <div className="fixed inset-0 z-30" onClick={() => setContextMenu(null)} />
                    <div
                        className="fixed z-40 bg-black/90 border border-white/10 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden text-sm min-w-[120px]"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        {(["vibe", "similar", "drift"] as const).map((op) => (
                            <button
                                key={op}
                                className="w-full px-4 py-2.5 text-left text-white/70 hover:text-white hover:bg-white/8 capitalize transition-colors first:pt-3 last:pb-3"
                                onClick={() => {
                                    onTrackContextMenu?.(contextMenu.trackId, op);
                                    setContextMenu(null);
                                }}
                            >
                                {op.charAt(0).toUpperCase() + op.slice(1)}
                            </button>
                        ))}
                    </div>
                </>
            )}

            {is3D && !isLocked && (
                <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                    <div className="text-center">
                        <p className="text-white/30 text-sm mb-1">Click to explore</p>
                        <p className="text-white/15 text-xs">
                            WASD to move -- Mouse to look -- R for boost -- ESC to exit
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
