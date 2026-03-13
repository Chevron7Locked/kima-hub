"use client";

import { useState, useCallback, useMemo, useRef, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
    OrthographicCamera,
    PerspectiveCamera,
    OrbitControls,
    PointerLockControls,
} from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import type { MapTrack } from "./types";
import { TrackCloud, WORLD_SCALE } from "./TrackCloud";
import { TrackTooltip } from "./TrackTooltip";

interface VibeUniverseProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    onTrackClick: (trackId: string) => void;
    onBackgroundClick: () => void;
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

function SceneContent({
    tracks,
    highlightedIds,
    selectedTrackId,
    is3D,
    isMobile,
    isLocked,
    onLockChange,
    onTrackClick,
    onBackgroundClick: _onBackgroundClick,
}: VibeUniverseProps & {
    is3D: boolean;
    isMobile: boolean;
    isLocked: boolean;
    onLockChange: (locked: boolean) => void;
}) {
    const [hoveredTrack, setHoveredTrack] = useState<MapTrack | null>(null);
    const [hoverPosition, setHoverPosition] = useState<THREE.Vector3 | null>(null);

    const handleTrackHover = useCallback((track: MapTrack | null, point: THREE.Vector3 | null) => {
        setHoveredTrack(track);
        setHoverPosition(point);
    }, []);

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

    const worldCenter = useMemo(
        () => [center[0] * WORLD_SCALE, center[1] * WORLD_SCALE, 0] as const,
        [center]
    );

    const handleLock = useCallback(() => onLockChange(true), [onLockChange]);
    const handleUnlock = useCallback(() => onLockChange(false), [onLockChange]);

    // 2D zoom: fit all tracks in view with padding
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
                        position={[worldCenter[0], worldCenter[1], WORLD_SCALE * span * 0.6]}
                        fov={60}
                        near={0.1}
                        far={WORLD_SCALE * 5}
                    />
                    <PointerLockControls onLock={handleLock} onUnlock={handleUnlock} />
                    <FlyMovement speed={WORLD_SCALE * 0.12} />
                </>
            ) : (
                <>
                    <OrthographicCamera
                        makeDefault
                        position={[worldCenter[0], worldCenter[1], 100]}
                        zoom={orthoZoom}
                        near={0.1}
                        far={WORLD_SCALE * 5}
                    />
                    <OrbitControls
                        enableRotate={false}
                        enableDamping
                        dampingFactor={0.12}
                        target={[worldCenter[0], worldCenter[1], 0]}
                    />
                </>
            )}

            <TrackCloud
                tracks={tracks}
                highlightedIds={highlightedIds}
                selectedTrackId={selectedTrackId}
                onTrackClick={onTrackClick}
                onTrackHover={handleTrackHover}
            />

            {hoveredTrack && hoverPosition && !isLocked && (
                <TrackTooltip track={hoveredTrack} position={hoverPosition} />
            )}

            {/* Subtle bloom -- only bright nodes glow slightly */}
            {!isMobile && (
                <EffectComposer>
                    <Bloom
                        mipmapBlur
                        intensity={0.3}
                        luminanceThreshold={0.4}
                        luminanceSmoothing={0.9}
                    />
                </EffectComposer>
            )}
        </>
    );
}

export function VibeUniverse({
    tracks,
    highlightedIds,
    selectedTrackId,
    onTrackClick,
    onBackgroundClick,
}: VibeUniverseProps) {
    const [is3D, setIs3D] = useState(false);
    const [isLocked, setIsLocked] = useState(false);
    const isMobile = useIsMobile();

    return (
        <div className="w-full h-full relative">
            <Canvas
                dpr={[1, 1.5]}
                gl={{
                    antialias: true,
                    toneMapping: THREE.NoToneMapping,
                    outputColorSpace: THREE.SRGBColorSpace,
                    powerPreference: "high-performance",
                }}
                style={{ background: "#050508" }}
                onPointerMissed={onBackgroundClick}
            >
                <Suspense fallback={null}>
                    <SceneContent
                        tracks={tracks}
                        highlightedIds={highlightedIds}
                        selectedTrackId={selectedTrackId}
                        is3D={is3D}
                        isMobile={isMobile}
                        isLocked={isLocked}
                        onLockChange={setIsLocked}
                        onTrackClick={onTrackClick}
                        onBackgroundClick={onBackgroundClick}
                    />
                </Suspense>
            </Canvas>

            {/* 2D / 3D toggle */}
            <div className="absolute top-4 right-4 z-10 flex gap-2">
                <button
                    onClick={() => setIs3D(!is3D)}
                    className="px-3 py-1.5 rounded-lg backdrop-blur-md border text-xs font-medium transition-colors bg-white/10 border-white/10 text-white/70 hover:text-white hover:bg-white/15"
                >
                    {is3D ? "2D" : "3D"}
                </button>
            </div>

            {/* 3D mode instructions */}
            {is3D && !isLocked && (
                <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                    <div className="text-center pointer-events-auto">
                        <p className="text-white/60 text-sm mb-1">Click anywhere to explore</p>
                        <p className="text-white/30 text-xs">WASD to move -- Mouse to look -- R for boost -- ESC to exit</p>
                    </div>
                </div>
            )}

            {/* Track count */}
            <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-10 text-white/15 text-[10px] tracking-widest uppercase font-medium">
                {tracks.length} tracks
            </div>
        </div>
    );
}
