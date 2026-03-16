"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, TextLayer, LineLayer } from "@deck.gl/layers";
import { OrthographicView } from "@deck.gl/core";
import type { Layer, PickingInfo } from "@deck.gl/core";
import type { VibeOperation } from "@/lib/audio-state-context";
import type { MapTrack, PathResult, VibeMode } from "./types";
import { useDoubleClickById } from "@/hooks/useDoubleTap";
import {
    blendMoodColorRGB,
    getTrackRadius,
    computeClusterLabels,
    computeInitialViewState,
} from "./mapUtils";

interface VibeMapProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    selectedTrackId: string | null;
    pathResult: PathResult | null;
    mode: VibeMode;
    trackMap: Map<string, MapTrack>;
    queueTrackIds?: string[];
    showLabels?: boolean;
    playingTrackId: string | null;
    activeOperation: VibeOperation | null;
    onTrackClick: (trackId: string) => void;
    onTrackDoubleClick?: (trackId: string) => void;
    onBackgroundClick: () => void;
}

const TOOLTIP_STYLE = {
    backgroundColor: "rgba(15, 15, 15, 0.95)",
    color: "#e5e5e5",
    fontSize: "12px",
    padding: "8px 12px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.08)",
    fontFamily: "var(--font-montserrat), Montserrat, system-ui, sans-serif",
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    lineHeight: "1.4",
};

const MAP_VIEW = new OrthographicView({
    id: "vibe-map",
    flipY: false,
    controller: true,
});

export function VibeMap({
    tracks,
    highlightedIds,
    selectedTrackId,
    pathResult,
    mode,
    trackMap,
    queueTrackIds,
    showLabels = true,
    playingTrackId: currentlyPlayingId,
    activeOperation,
    onTrackClick,
    onTrackDoubleClick,
    onBackgroundClick,
}: VibeMapProps) {
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [viewState, setViewState] = useState(() => {
        try {
            const saved = sessionStorage.getItem("kima_vibemap_camera");
            if (saved) {
                const s = JSON.parse(saved);
                if (s.target && typeof s.zoom === "number") {
                    return { target: s.target as [number, number, number], zoom: s.zoom, minZoom: 2, maxZoom: 14 };
                }
            }
        } catch { /* noop */ }
        const fit = tracks.length > 0
            ? computeInitialViewState(tracks)
            : { target: [0.5, 0.5, 0] as [number, number, number], zoom: 8 };
        return { target: fit.target, zoom: fit.zoom, minZoom: 2, maxZoom: 14 };
    });

    // Only persist camera to sessionStorage after user has actually interacted.
    // DeckGL fires onViewStateChange during init/resize/strict-mode remount with
    // computed defaults that would overwrite the saved position.
    const userInteracted = useRef(false);

    const hasHighlights = highlightedIds.size > 0;
    const zoom = viewState.zoom;

    // Pre-bake mood colors once per tracks reference. getFillColor is called for
    // every track on each interaction (click, search, play). At 10k+ tracks the
    // per-call cache in blendMoodColorRGB evicts constantly (cap << n), causing
    // 15-37ms stalls. Pre-baking makes each getFillColor lookup O(1).
    const trackBaseColors = useMemo(() => {
        const map = new Map<string, [number, number, number]>();
        for (const track of tracks) {
            map.set(track.id, blendMoodColorRGB(track));
        }
        return map;
    }, [tracks]);

    const detectDoubleClick = useDoubleClickById(onTrackClick, onTrackDoubleClick);

    const handleClick = useCallback(
        (info: PickingInfo) => {
            const id = (info?.object as MapTrack | undefined)?.id;
            if (id) {
                detectDoubleClick(id);
            } else {
                onBackgroundClick();
            }
        },
        [detectDoubleClick, onBackgroundClick],
    );

    const scatterLayer = useMemo(
        () =>
            new ScatterplotLayer<MapTrack>({
                id: "tracks",
                data: tracks,
                getPosition: (d) => [d.x, d.y],
                getRadius: (d) => {
                    const r = getTrackRadius(d, zoom);
                    if (currentlyPlayingId === d.id)
                        return r * 1.3;
                    return r;
                },
                radiusUnits: "pixels",
                getFillColor: (d) => {
                    if (currentlyPlayingId === d.id)
                        return [255, 255, 255, 255] as [number, number, number, number];
                    if (selectedTrackId === d.id)
                        return [255, 255, 255, 255] as [number, number, number, number];
                    const base = trackBaseColors.get(d.id) ?? [163, 163, 163];
                    if (hasHighlights && !highlightedIds.has(d.id))
                        return [base[0], base[1], base[2], 30] as [number, number, number, number];
                    if (hasHighlights && highlightedIds.has(d.id))
                        return [base[0], base[1], base[2], 255] as [number, number, number, number];
                    return [base[0], base[1], base[2], 230] as [number, number, number, number];
                },
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 60],
                updateTriggers: {
                    getFillColor: [selectedTrackId, highlightedIds, hasHighlights, currentlyPlayingId, trackBaseColors],
                    getRadius: [zoom, currentlyPlayingId],
                },
            }),
        [tracks, zoom, selectedTrackId, highlightedIds, hasHighlights, currentlyPlayingId, trackBaseColors],
    );

    const ringLayer = useMemo(() => {
        if (!hasHighlights && !selectedTrackId && !currentlyPlayingId) return null;

        // Build ring track list from trackMap -- O(highlighted) not O(n tracks)
        const seen = new Set<string>();
        const ringTracks: MapTrack[] = [];
        const addIfPresent = (id: string) => {
            if (!seen.has(id)) {
                const t = trackMap.get(id);
                if (t) { seen.add(id); ringTracks.push(t); }
            }
        };
        if (selectedTrackId) addIfPresent(selectedTrackId);
        if (currentlyPlayingId) addIfPresent(currentlyPlayingId);
        if (hasHighlights) for (const id of highlightedIds) addIfPresent(id);

        if (ringTracks.length === 0) return null;

        return new ScatterplotLayer<MapTrack>({
            id: "track-rings",
            data: ringTracks,
            getPosition: (d) => [d.x, d.y],
            getRadius: (d) => {
                const r = getTrackRadius(d, zoom);
                if (currentlyPlayingId === d.id)
                    return r * 1.3 + 3;
                return r + 2;
            },
            radiusUnits: "pixels",
            filled: false,
            stroked: true,
            getLineColor: (d) => {
                if (currentlyPlayingId === d.id)
                    return [255, 255, 255, 180] as [number, number, number, number];
                if (selectedTrackId === d.id)
                    return [255, 255, 255, 120] as [number, number, number, number];
                const base = trackBaseColors.get(d.id) ?? [163, 163, 163];
                return [base[0], base[1], base[2], 80] as [number, number, number, number];
            },
            getLineWidth: (d) => {
                if (currentlyPlayingId === d.id) return 1.5;
                return 1;
            },
            lineWidthUnits: "pixels",
            pickable: false,
            updateTriggers: {
                getLineColor: [selectedTrackId, highlightedIds, currentlyPlayingId],
                getRadius: [zoom, currentlyPlayingId],
                getLineWidth: [currentlyPlayingId],
            },
        });
    }, [trackMap, zoom, selectedTrackId, highlightedIds, hasHighlights, currentlyPlayingId, trackBaseColors]);

    // Quantize zoom to 0.5 steps -- prevents cluster label recompute on every
    // fractional zoom change during interactive pan/zoom (would otherwise run 60fps).
    const labelZoom = Math.round(zoom * 2) / 2;

    const labelLayer = useMemo(() => {
        if (labelZoom > 9) return null;

        const labels = computeClusterLabels(
            tracks,
            { minX: 0, maxX: 1, minY: 0, maxY: 1 },
            labelZoom < 7 ? 4 : 6,
        );

        if (labels.length === 0) return null;

        return new TextLayer({
            id: "cluster-labels",
            data: labels,
            getPosition: (d) => [d.x, d.y],
            getText: (d) => d.label,
            getSize: labelZoom < 7 ? 13 : 10,
            getColor: [255, 255, 255, labelZoom < 7 ? 50 : 35],
            fontFamily: "Montserrat, system-ui, sans-serif",
            fontWeight: 500,
            getTextAnchor: "middle" as const,
            getAlignmentBaseline: "center" as const,
            sizeUnits: "pixels" as const,
            billboard: false,
            fontSettings: { sdf: true },
            outlineWidth: 3,
            outlineColor: [10, 10, 10, 200],
        });
    }, [tracks, labelZoom]);

    const pathLayer = useMemo(() => {
        if (!pathResult || mode !== "path-result") return null;

        const allPathTracks = [
            pathResult.startTrack,
            ...pathResult.path,
            pathResult.endTrack,
        ];

        const lineData: Array<{
            sourcePosition: [number, number];
            targetPosition: [number, number];
            color: [number, number, number, number];
        }> = [];

        if (!trackMap.get(pathResult.startTrack.id) || !trackMap.get(pathResult.endTrack.id)) return null;

        const startBase = trackBaseColors.get(pathResult.startTrack.id) ?? [163, 163, 163];
        const endBase = trackBaseColors.get(pathResult.endTrack.id) ?? [163, 163, 163];

        for (let i = 0; i < allPathTracks.length - 1; i++) {
            const from = trackMap.get(allPathTracks[i].id);
            const to = trackMap.get(allPathTracks[i + 1].id);
            if (!from || !to) continue;

            const t = i / Math.max(1, allPathTracks.length - 2);
            const color: [number, number, number, number] = [
                Math.round(startBase[0] + (endBase[0] - startBase[0]) * t),
                Math.round(startBase[1] + (endBase[1] - startBase[1]) * t),
                Math.round(startBase[2] + (endBase[2] - startBase[2]) * t),
                100,
            ];

            lineData.push({
                sourcePosition: [from.x, from.y],
                targetPosition: [to.x, to.y],
                color,
            });
        }

        return new LineLayer({
            id: "path-line",
            data: lineData,
            getSourcePosition: (d) => d.sourcePosition,
            getTargetPosition: (d) => d.targetPosition,
            getColor: (d) => d.color,
            getWidth: 1.5,
            widthUnits: "pixels",
        });
    }, [pathResult, mode, trackMap, trackBaseColors]);

    const queuePathLayer = useMemo(() => {
        if (!queueTrackIds || queueTrackIds.length < 2) return null;

        const playingIdx = currentlyPlayingId
            ? queueTrackIds.indexOf(currentlyPlayingId)
            : -1;

        const lineData: Array<{
            sourcePosition: [number, number];
            targetPosition: [number, number];
            color: [number, number, number, number];
        }> = [];

        for (let i = 0; i < queueTrackIds.length - 1; i++) {
            const from = trackMap.get(queueTrackIds[i]);
            const to = trackMap.get(queueTrackIds[i + 1]);
            if (!from || !to) continue;

            const isPast = playingIdx >= 0 && i < playingIdx;
            const alpha = isPast ? 25 : 50;

            lineData.push({
                sourcePosition: [from.x, from.y],
                targetPosition: [to.x, to.y],
                color: [180, 160, 120, alpha],
            });
        }

        if (lineData.length === 0) return null;

        return new LineLayer({
            id: "queue-path",
            data: lineData,
            getSourcePosition: (d) => d.sourcePosition,
            getTargetPosition: (d) => d.targetPosition,
            getColor: (d) => d.color,
            getWidth: 1,
            widthUnits: "pixels",
        });
    }, [queueTrackIds, trackMap, currentlyPlayingId]);

    const sourceRingLayer = useMemo(() => {
        if (!activeOperation) return null;

        let sourceId: string;
        let color: [number, number, number, number];

        switch (activeOperation.type) {
            case 'drift':
                sourceId = activeOperation.startTrackId;
                color = [236, 178, 0, 120];
                break;
            case 'vibe':
                sourceId = activeOperation.sourceTrackId;
                color = [29, 185, 84, 120];
                break;
            case 'similar':
                sourceId = activeOperation.sourceTrackId;
                color = [92, 141, 214, 120];
                break;
            default:
                return null;
        }

        const sourceTrack = trackMap.get(sourceId);
        if (!sourceTrack) return null;

        return new ScatterplotLayer<MapTrack>({
            id: "operation-source-ring",
            data: [sourceTrack],
            getPosition: (d) => [d.x, d.y],
            getRadius: () => getTrackRadius(sourceTrack, zoom) * 3,
            radiusUnits: "pixels",
            filled: false,
            stroked: true,
            getLineColor: () => color,
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            pickable: false,
        });
    }, [activeOperation, trackMap, zoom]);

    const trackNameLayer = useMemo(() => {
        if (!showLabels || zoom < 11.5) return null;

        const offsetY = 16 / Math.pow(2, zoom);

        return new TextLayer<MapTrack>({
            id: "track-names",
            data: tracks,
            getPosition: (d) => [d.x, d.y + offsetY],
            getText: (d) => d.title,
            getSize: 9,
            getColor: [255, 255, 255, 55],
            fontFamily: "Montserrat, system-ui, sans-serif",
            fontWeight: 400,
            getTextAnchor: "middle" as const,
            getAlignmentBaseline: "bottom" as const,
            sizeUnits: "pixels" as const,
            outlineWidth: 2,
            outlineColor: [5, 5, 5, 220],
        });
    }, [tracks, zoom, showLabels]);

    const layers = useMemo(() => {
        const result: Layer[] = [scatterLayer];
        if (ringLayer) result.push(ringLayer);
        if (sourceRingLayer) result.push(sourceRingLayer);
        if (labelLayer) result.push(labelLayer);
        if (trackNameLayer) result.push(trackNameLayer);
        if (queuePathLayer) result.push(queuePathLayer);
        if (pathLayer) result.push(pathLayer);
        return result.filter(Boolean);
    }, [scatterLayer, ringLayer, sourceRingLayer, labelLayer, trackNameLayer, queuePathLayer, pathLayer]);

    const getTooltip = useCallback((info: PickingInfo) => {
        if (!info?.object) return null;
        const track = info.object as MapTrack;
        if (!track.title) return null;
        return { text: `${track.title}\n${track.artist}`, style: TOOLTIP_STYLE };
    }, []);

    return (
        <div className="w-full h-full relative">
            <div className="absolute inset-0 vibe-map-bg" />
            <DeckGL
                views={MAP_VIEW}
                viewState={viewState}
                onViewStateChange={({ viewState: vs, interactionState }) => {
                    const next = vs as typeof viewState;
                    setViewState(next);
                    if (interactionState?.isDragging || interactionState?.isZooming || interactionState?.isPanning) {
                        userInteracted.current = true;
                    }
                    if (userInteracted.current) {
                        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                        saveTimerRef.current = setTimeout(() => {
                            try { sessionStorage.setItem("kima_vibemap_camera", JSON.stringify({ target: next.target, zoom: next.zoom })); } catch { /* noop */ }
                        }, 150);
                    }
                }}
                layers={layers}
                onClick={handleClick}
                getTooltip={getTooltip}
                controller={true}
                useDevicePixels={false}
                getCursor={({ isDragging, isHovering }) => {
                    if (mode === "path-picking") return "crosshair";
                    if (isDragging) return "grabbing";
                    if (isHovering) return "pointer";
                    return "grab";
                }}
                style={{ background: "transparent" }}
            />
            {mode === "path-picking" && (
                <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-black/80 text-white px-4 py-2 rounded-lg text-sm backdrop-blur-sm border border-white/10">
                    Click a destination track
                </div>
            )}
        </div>
    );
}
