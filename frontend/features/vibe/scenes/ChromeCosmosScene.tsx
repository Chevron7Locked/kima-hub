"use client";

import { useState, useCallback, useMemo, useRef, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
    OrthographicCamera,
    PerspectiveCamera,
    OrbitControls,
    PointerLockControls,
    Instances,
    Instance,
} from "@react-three/drei";
import * as THREE from "three";
import type { MapTrack } from "../types";
import { getTrackColor, getTrackHighlightColor, computeEdges } from "../universeUtils";

export interface VibeSceneProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    onTrackClick: (trackId: string) => void;
    onBackgroundClick: () => void;
}

const WORLD_SCALE = 400;

function hashToFloat(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return ((h & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

function useIsMobile(): boolean {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 768;
}

function FlyMovement({ speed = 30 }: { speed?: number }) {
    const { camera } = useThree();
    const keys = useRef<Set<string>>(new Set());

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            keys.current.add(e.code);
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            keys.current.delete(e.code);
        };
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    useFrame((_, delta) => {
        const velocity = new THREE.Vector3();
        const boost = keys.current.has("KeyR") ? 3 : 1;
        const actualSpeed = speed * boost;

        if (keys.current.has("KeyW") || keys.current.has("ArrowUp")) velocity.z -= 1;
        if (keys.current.has("KeyS") || keys.current.has("ArrowDown")) velocity.z += 1;
        if (keys.current.has("KeyA") || keys.current.has("ArrowLeft")) velocity.x -= 1;
        if (keys.current.has("KeyD") || keys.current.has("ArrowRight")) velocity.x += 1;
        if (keys.current.has("Space")) velocity.y += 1;
        if (keys.current.has("ShiftLeft") || keys.current.has("ShiftRight")) velocity.y -= 1;

        if (velocity.length() > 0) {
            velocity.normalize().multiplyScalar(actualSpeed * delta);
            velocity.applyQuaternion(camera.quaternion);
            camera.position.add(velocity);
        }
    });

    return null;
}

function FloorGrid({ worldCenter }: { worldCenter: readonly [number, number, number] }) {
    const material = useMemo(() => {
        const halfSize = WORLD_SCALE * 3.0;
        return new THREE.ShaderMaterial({
            uniforms: {
                uCenter: { value: new THREE.Vector3(worldCenter[0], 0, worldCenter[2]) },
                uGridSpacing: { value: WORLD_SCALE * 0.06 },
                uHalfSize: { value: halfSize },
                uColorA: { value: new THREE.Color(168 / 255, 85 / 255, 247 / 255) },
                uColorB: { value: new THREE.Color(252 / 255, 162 / 255, 0) },
            },
            vertexShader: `
                varying vec3 vWorldPos;
                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPos = worldPos.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uCenter;
                uniform float uGridSpacing;
                uniform float uHalfSize;
                uniform vec3 uColorA;
                uniform vec3 uColorB;
                varying vec3 vWorldPos;
                void main() {
                    vec2 coord = vWorldPos.xz / uGridSpacing;
                    vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
                    float line = min(grid.x, grid.y);
                    float alpha = 1.0 - min(line, 1.0);

                    float dist = length(vWorldPos.xz - uCenter.xz) / uHalfSize;
                    float t = smoothstep(0.0, 1.0, dist);
                    vec3 color = mix(uColorA, uColorB, t);

                    alpha *= smoothstep(1.0, 0.3, dist);
                    alpha *= 0.10;

                    gl_FragColor = vec4(color, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
    }, [worldCenter]);

    const gridSize = WORLD_SCALE * 6;

    return (
        <mesh
            position={[worldCenter[0], 0, worldCenter[2]]}
            rotation={[-Math.PI / 2, 0, 0]}
            material={material}
        >
            <planeGeometry args={[gridSize, gridSize]} />
        </mesh>
    );
}

function ConnectionLines({
    tracks,
    getWorldPosition,
}: {
    tracks: MapTrack[];
    getWorldPosition: (track: MapTrack) => [number, number, number];
}) {
    const { lineGeo, lineMat } = useMemo(() => {
        if (tracks.length === 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
            geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
            const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.2 });
            return { lineGeo: geo, lineMat: mat };
        }

        const edges = computeEdges(tracks, 3);
        const linePositions = new Float32Array(edges.length * 6);
        const lineColors = new Float32Array(edges.length * 6);

        for (let e = 0; e < edges.length; e++) {
            const [i, j] = edges[e];
            const posA = getWorldPosition(tracks[i]);
            const posB = getWorldPosition(tracks[j]);

            linePositions[e * 6] = posA[0];
            linePositions[e * 6 + 1] = posA[1];
            linePositions[e * 6 + 2] = posA[2];
            linePositions[e * 6 + 3] = posB[0];
            linePositions[e * 6 + 4] = posB[1];
            linePositions[e * 6 + 5] = posB[2];

            const ci = getTrackColor(tracks[i]);
            const cj = getTrackColor(tracks[j]);
            const lr = (ci.r + cj.r) * 0.5;
            const lg = (ci.g + cj.g) * 0.5;
            const lb = (ci.b + cj.b) * 0.5;
            lineColors[e * 6] = lr;
            lineColors[e * 6 + 1] = lg;
            lineColors[e * 6 + 2] = lb;
            lineColors[e * 6 + 3] = lr;
            lineColors[e * 6 + 4] = lg;
            lineColors[e * 6 + 5] = lb;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(lineColors, 3));

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.2,
            blending: THREE.NormalBlending,
        });

        return { lineGeo: geo, lineMat: mat };
    }, [tracks, getWorldPosition]);

    if (tracks.length === 0) return null;

    return <lineSegments geometry={lineGeo} material={lineMat} />;
}

function ChromeSpheres({
    tracks,
    highlightedIds,
    selectedTrackId,
    onTrackClick,
    getWorldPosition,
}: {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    onTrackClick: (trackId: string) => void;
    getWorldPosition: (track: MapTrack) => [number, number, number];
}) {
    const hasHighlights = highlightedIds.size > 0;

    const trackData = useMemo(() => {
        return tracks.map((track) => {
            const pos = getWorldPosition(track);
            const energy = track.energy ?? 0.5;
            const baseScale = 2 + energy * 6;
            const isSelected = track.id === selectedTrackId;
            const isDimmed = hasHighlights && !highlightedIds.has(track.id) && !isSelected;

            let color: THREE.Color;
            let scale: number;

            if (isSelected) {
                color = new THREE.Color(1, 1, 1);
                scale = baseScale * 1.4;
            } else if (isDimmed) {
                const c = getTrackColor(track);
                color = new THREE.Color(c.r * 0.4, c.g * 0.4, c.b * 0.4);
                scale = baseScale * 0.5;
            } else {
                color = getTrackHighlightColor(track);
                scale = baseScale;
            }

            return { track, pos, color, scale };
        });
    }, [tracks, highlightedIds, selectedTrackId, hasHighlights, getWorldPosition]);

    const emissiveColor = useMemo(() => new THREE.Color(0.15, 0.08, 0.2), []);

    return (
        <Instances limit={Math.max(tracks.length, 1)}>
            <sphereGeometry args={[1, 32, 32]} />
            <meshStandardMaterial
                metalness={1.0}
                roughness={0.08}
                envMapIntensity={1.0}
                emissive={emissiveColor}
                emissiveIntensity={0.15}
            />
            {trackData.map(({ track, pos, color, scale }) => (
                <Instance
                    key={track.id}
                    position={pos}
                    scale={scale}
                    color={color}
                    onClick={(e) => {
                        e.stopPropagation();
                        onTrackClick(track.id);
                    }}
                />
            ))}
        </Instances>
    );
}

function SceneContent({
    tracks,
    highlightedIds,
    selectedTrackId,
    is3D,
    isLocked: _isLocked,
    onLockChange,
    onTrackClick,
}: VibeSceneProps & {
    is3D: boolean;
    isLocked: boolean;
    onLockChange: (locked: boolean) => void;
}) {
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
    const worldCenterZ = center[1] * WORLD_SCALE;
    const worldCenter = useMemo(
        () => [worldCenterX, 0, worldCenterZ] as const,
        [worldCenterX, worldCenterZ]
    );

    const getWorldPosition = useCallback(
        (track: MapTrack): [number, number, number] => [
            track.x * WORLD_SCALE,
            3 + Math.abs(hashToFloat(track.id)) * WORLD_SCALE * 0.12,
            track.y * WORLD_SCALE,
        ],
        []
    );

    const handleLock = useCallback(() => onLockChange(true), [onLockChange]);
    const handleUnlock = useCallback(() => onLockChange(false), [onLockChange]);

    const orthoZoom = useMemo(() => {
        if (typeof window === "undefined") return 2;
        const viewportMin = Math.min(window.innerWidth, window.innerHeight);
        const worldSpan = span * WORLD_SCALE;
        return viewportMin / (worldSpan * 1.3);
    }, [span]);

    return (
        <>
            {is3D ? (
                <>
                    <PerspectiveCamera
                        makeDefault
                        position={[
                            worldCenterX,
                            WORLD_SCALE * 0.4,
                            worldCenterZ + WORLD_SCALE * 0.5,
                        ]}
                        fov={60}
                        near={0.1}
                        far={WORLD_SCALE * 10}
                    />
                    <PointerLockControls onLock={handleLock} onUnlock={handleUnlock} />
                    <FlyMovement speed={WORLD_SCALE * 0.08} />
                </>
            ) : (
                <>
                    <OrthographicCamera
                        makeDefault
                        position={[worldCenterX, WORLD_SCALE * 0.8, worldCenterZ]}
                        zoom={orthoZoom}
                        near={0.1}
                        far={WORLD_SCALE * 10}
                        rotation={[-Math.PI / 2, 0, 0]}
                    />
                    <OrbitControls
                        enableRotate={false}
                        enableDamping
                        dampingFactor={0.12}
                        target={[worldCenterX, 0, worldCenterZ]}
                    />
                </>
            )}

            <ambientLight intensity={0.08} />
            <directionalLight position={[1, 3, 1]} intensity={0.6} color="#ffffff" />
            <pointLight
                position={[
                    worldCenterX - WORLD_SCALE * 0.5,
                    WORLD_SCALE * 0.3,
                    worldCenterZ,
                ]}
                color="#a855f7"
                intensity={0.8}
            />
            <pointLight
                position={[
                    worldCenterX + WORLD_SCALE * 0.5,
                    WORLD_SCALE * 0.5,
                    worldCenterZ,
                ]}
                color="#fca200"
                intensity={0.6}
            />
            <pointLight
                position={[worldCenterX, -WORLD_SCALE * 0.2, worldCenterZ]}
                color="#3b82f6"
                intensity={0.3}
            />

            <FloorGrid worldCenter={worldCenter} />

            <ConnectionLines tracks={tracks} getWorldPosition={getWorldPosition} />

            <ChromeSpheres
                tracks={tracks}
                highlightedIds={highlightedIds}
                selectedTrackId={selectedTrackId}
                onTrackClick={onTrackClick}
                getWorldPosition={getWorldPosition}
            />
        </>
    );
}

export function ChromeCosmosScene({
    tracks,
    highlightedIds,
    selectedTrackId,
    onTrackClick,
    onBackgroundClick,
}: VibeSceneProps) {
    const [is3D, setIs3D] = useState(false);
    const [isLocked, setIsLocked] = useState(false);
    useIsMobile();

    return (
        <div className="w-full h-full relative">
            <Canvas
                dpr={[1, 1.5]}
                gl={{
                    antialias: true,
                    toneMapping: THREE.ACESFilmicToneMapping,
                    outputColorSpace: THREE.SRGBColorSpace,
                    powerPreference: "high-performance",
                }}
                style={{ background: "#030306" }}
                onPointerMissed={onBackgroundClick}
            >
                <Suspense fallback={null}>
                    <SceneContent
                        tracks={tracks}
                        highlightedIds={highlightedIds}
                        selectedTrackId={selectedTrackId}
                        is3D={is3D}
                        isLocked={isLocked}
                        onLockChange={setIsLocked}
                        onTrackClick={onTrackClick}
                        onBackgroundClick={onBackgroundClick}
                    />
                </Suspense>
            </Canvas>

            <div className="absolute top-4 left-4 z-10 text-white/20 text-[10px] tracking-widest uppercase font-medium">
                C: Chrome Cosmos
            </div>

            <div className="absolute top-4 right-4 z-10 flex gap-2">
                <button
                    onClick={() => setIs3D(!is3D)}
                    className="px-3 py-1.5 rounded-lg backdrop-blur-md border text-xs font-medium transition-colors bg-white/10 border-white/10 text-white/70 hover:text-white hover:bg-white/15"
                >
                    {is3D ? "2D" : "3D"}
                </button>
            </div>

            {is3D && !isLocked && (
                <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                    <div className="text-center pointer-events-auto">
                        <p className="text-white/60 text-sm mb-1">Click anywhere to explore</p>
                        <p className="text-white/30 text-xs">WASD to move -- Mouse to look -- R for boost -- ESC to exit</p>
                    </div>
                </div>
            )}

            <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-10 text-white/15 text-[10px] tracking-widest uppercase font-medium">
                {tracks.length} tracks
            </div>
        </div>
    );
}
