"use client";

import { useRef, useEffect, useMemo, useCallback } from "react";
import * as THREE from "three";
import { ThreeEvent } from "@react-three/fiber";
import type { MapTrack } from "./types";
import { getTrackBloomColor, getTrackSphereRadius } from "./universeUtils";

interface TrackCloudProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    onTrackClick: (trackId: string) => void;
    onTrackHover: (track: MapTrack | null, point: THREE.Vector3 | null) => void;
}

const SPHERE_SEGMENTS = 8;
const DIM_OPACITY = 0.15;

export function TrackCloud({
    tracks,
    highlightedIds,
    selectedTrackId,
    onTrackClick,
    onTrackHover,
}: TrackCloudProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null!);
    const dummy = useMemo(() => new THREE.Object3D(), []);
    const colorObj = useMemo(() => new THREE.Color(), []);

    const hasHighlights = highlightedIds.size > 0;

    useEffect(() => {
        const mesh = meshRef.current;
        if (!mesh || tracks.length === 0) return;

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const radius = getTrackSphereRadius(track);

            dummy.position.set(track.x, track.y, 0);
            dummy.scale.setScalar(radius / 0.02);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);

            const color = getTrackBloomColor(track);
            const isHighlighted = !hasHighlights || highlightedIds.has(track.id);
            const isSelected = track.id === selectedTrackId;

            if (isSelected) {
                colorObj.setRGB(1.8, 1.8, 1.8);
            } else if (isHighlighted) {
                colorObj.copy(color);
            } else {
                colorObj.set(color);
                colorObj.multiplyScalar(DIM_OPACITY);
            }

            mesh.setColorAt(i, colorObj);
        }

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }, [tracks, highlightedIds, selectedTrackId, hasHighlights, dummy, colorObj]);

    const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined && e.instanceId < tracks.length) {
            onTrackClick(tracks[e.instanceId].id);
        }
    }, [tracks, onTrackClick]);

    const handlePointerOver = useCallback((e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined && e.instanceId < tracks.length) {
            const track = tracks[e.instanceId];
            const point = new THREE.Vector3(track.x, track.y, 0);
            onTrackHover(track, point);
        }
    }, [tracks, onTrackHover]);

    const handlePointerOut = useCallback(() => {
        onTrackHover(null, null);
    }, [onTrackHover]);

    if (tracks.length === 0) return null;

    return (
        <instancedMesh
            ref={meshRef}
            args={[undefined, undefined, tracks.length]}
            onClick={handleClick}
            onPointerOver={handlePointerOver}
            onPointerOut={handlePointerOut}
        >
            <sphereGeometry args={[0.02, SPHERE_SEGMENTS, SPHERE_SEGMENTS]} />
            <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
    );
}
