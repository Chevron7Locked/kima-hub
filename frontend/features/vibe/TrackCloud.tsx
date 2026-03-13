"use client";

import { useRef, useEffect, useMemo, useCallback } from "react";
import * as THREE from "three";
import { ThreeEvent } from "@react-three/fiber";
import type { MapTrack } from "./types";
import { getTrackColor, getTrackHighlightColor, computeEdges } from "./universeUtils";

function hashToFloat(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return ((h & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

interface TrackCloudProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    onTrackClick: (trackId: string) => void;
    onTrackHover: (track: MapTrack | null, point: THREE.Vector3 | null) => void;
}

const WORLD_SCALE = 200;

const vertexShader = `
    attribute float size;
    attribute vec3 customColor;
    attribute float opacity;
    varying vec3 vColor;
    varying float vOpacity;
    void main() {
        vColor = customColor;
        vOpacity = opacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (200.0 / -mvPosition.z);
        gl_PointSize = clamp(gl_PointSize, 1.0, 20.0);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = `
    varying vec3 vColor;
    varying float vOpacity;
    void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float core = 1.0 - smoothstep(0.0, 0.2, d);
        float halo = 1.0 - smoothstep(0.1, 0.5, d);
        float alpha = (core * 0.9 + halo * 0.3) * vOpacity;
        vec3 color = vColor * (1.0 + core * 0.5);
        gl_FragColor = vec4(color, alpha);
    }
`;

export function TrackCloud({
    tracks,
    highlightedIds,
    selectedTrackId,
    onTrackClick,
    onTrackHover,
}: TrackCloudProps) {
    const pointsRef = useRef<THREE.Points>(null!);
    const linesRef = useRef<THREE.LineSegments>(null!);

    const hasHighlights = highlightedIds.size > 0;

    // Compute positions once (shared between points and lines)
    const positions = useMemo(() => {
        const pos = new Float32Array(tracks.length * 3);
        for (let i = 0; i < tracks.length; i++) {
            pos[i * 3] = tracks[i].x * WORLD_SCALE;
            pos[i * 3 + 1] = tracks[i].y * WORLD_SCALE;
            pos[i * 3 + 2] = hashToFloat(tracks[i].id) * WORLD_SCALE * 0.1;
        }
        return pos;
    }, [tracks]);

    // Points geometry and material
    const { pointGeo, pointMat } = useMemo(() => {
        const geo = new THREE.BufferGeometry();
        const colors = new Float32Array(tracks.length * 3);
        const sizes = new Float32Array(tracks.length);
        const opacities = new Float32Array(tracks.length);

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const color = getTrackColor(track);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;

            const energy = track.energy ?? 0.5;
            sizes[i] = 0.6 + energy * 1.2;
            opacities[i] = 0.85;
        }

        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geo.setAttribute("customColor", new THREE.BufferAttribute(colors, 3));
        geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
        geo.setAttribute("opacity", new THREE.BufferAttribute(opacities, 1));

        const mat = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending,
        });

        return { pointGeo: geo, pointMat: mat };
    }, [tracks, positions]);

    // Connection lines geometry
    const { lineGeo, lineMat } = useMemo(() => {
        const edges = computeEdges(tracks, 3);
        const linePositions = new Float32Array(edges.length * 6);
        const lineColors = new Float32Array(edges.length * 6);

        for (let e = 0; e < edges.length; e++) {
            const [i, j] = edges[e];
            linePositions[e * 6] = positions[i * 3];
            linePositions[e * 6 + 1] = positions[i * 3 + 1];
            linePositions[e * 6 + 2] = positions[i * 3 + 2];
            linePositions[e * 6 + 3] = positions[j * 3];
            linePositions[e * 6 + 4] = positions[j * 3 + 1];
            linePositions[e * 6 + 5] = positions[j * 3 + 2];

            // Blend colors of both endpoints, very dim
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
            opacity: 0.15,
            blending: THREE.NormalBlending,
        });

        return { lineGeo: geo, lineMat: mat };
    }, [tracks, positions]);

    // Update colors/opacity when highlights or selection change
    useEffect(() => {
        if (!pointGeo || tracks.length === 0) return;

        const colors = pointGeo.getAttribute("customColor") as THREE.BufferAttribute;
        const opacities = pointGeo.getAttribute("opacity") as THREE.BufferAttribute;
        const sizes = pointGeo.getAttribute("size") as THREE.BufferAttribute;

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const isHighlighted = !hasHighlights || highlightedIds.has(track.id);
            const isSelected = track.id === selectedTrackId;
            const energy = track.energy ?? 0.5;

            if (isSelected) {
                colors.setXYZ(i, 0.9, 0.9, 0.9);
                opacities.setX(i, 1.0);
                sizes.setX(i, (0.6 + energy * 1.2) * 2.5);
            } else if (isHighlighted) {
                const c = getTrackHighlightColor(track);
                colors.setXYZ(i, c.r, c.g, c.b);
                opacities.setX(i, 0.9);
                sizes.setX(i, 0.6 + energy * 1.2);
            } else {
                const c = getTrackColor(track);
                colors.setXYZ(i, c.r * 0.4, c.g * 0.4, c.b * 0.4);
                opacities.setX(i, 0.25);
                sizes.setX(i, (0.6 + energy * 1.2) * 0.6);
            }
        }

        colors.needsUpdate = true;
        opacities.needsUpdate = true;
        sizes.needsUpdate = true;
    }, [tracks, highlightedIds, selectedTrackId, hasHighlights, pointGeo]);

    const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.index !== undefined && e.index < tracks.length) {
            onTrackClick(tracks[e.index].id);
        }
    }, [tracks, onTrackClick]);

    const handlePointerOver = useCallback((e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.index !== undefined && e.index < tracks.length) {
            const track = tracks[e.index];
            const point = new THREE.Vector3(
                track.x * WORLD_SCALE,
                track.y * WORLD_SCALE,
                hashToFloat(track.id) * WORLD_SCALE * 0.1
            );
            onTrackHover(track, point);
        }
    }, [tracks, onTrackHover]);

    const handlePointerOut = useCallback(() => {
        onTrackHover(null, null);
    }, [onTrackHover]);

    if (tracks.length === 0) return null;

    return (
        <group>
            {/* Connection lines (rendered behind points) */}
            <lineSegments
                ref={linesRef}
                geometry={lineGeo}
                material={lineMat}
            />
            {/* Track points */}
            <points
                ref={pointsRef}
                geometry={pointGeo}
                material={pointMat}
                onClick={handleClick}
                onPointerOver={handlePointerOver}
                onPointerOut={handlePointerOut}
            />
        </group>
    );
}

export { WORLD_SCALE };
