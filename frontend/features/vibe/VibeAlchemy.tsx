"use client";

import { useState, useCallback } from "react";
import { ScenePanel } from "./ScenePanel";
import { NumberedRow } from "@/components/ui/NumberedRow";
import { X, Plus, Minus, FlaskConical, Play, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { LibraryIndex } from "./librarySearch";
import { useTrackFinder } from "./useTrackFinder";
import { TrackFinderResults, TrackSearchInput } from "./TrackFinder";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track, VibeOperation } from "@/lib/audio-state-context";

interface VibeAlchemyProps {
    library: LibraryIndex;
    onHighlight: (ids: Set<string>) => void;
    onClose: () => void;
}

type Column = "add" | "subtract";

interface PickedTrack {
    id: string;
    title: string;
}

type BlendResult = Awaited<ReturnType<typeof api.getVibeAlchemy>>["tracks"][number];

const COLUMNS: Record<Column, { label: string; icon: LucideIcon; activeClass: string }> = {
    add: { label: "More Like", icon: Plus, activeClass: "text-success" },
    subtract: { label: "Less Like", icon: Minus, activeClass: "text-danger-light" },
};

interface AlchemyColumnProps {
    column: Column;
    tracks: PickedTrack[];
    active: boolean;
    onSelect: () => void;
    onRemove: (id: string) => void;
}

function AlchemyColumn({ column, tracks, active, onSelect, onRemove }: AlchemyColumnProps) {
    const { label, icon: Icon, activeClass } = COLUMNS[column];
    return (
        <div>
            <button
                onClick={onSelect}
                className={cn("text-xs mb-2 flex items-center gap-1", active ? activeClass : "text-[var(--text-muted)]")}
                aria-pressed={active}
            >
                <Icon className="w-3 h-3" /> {label}
            </button>
            {tracks.map((t) => (
                <div key={t.id} className="flex items-center gap-1 mb-1">
                    <span className="text-xs text-[var(--text-secondary)] truncate flex-1">{t.title}</span>
                    <button
                        onClick={() => onRemove(t.id)}
                        className="text-[var(--text-muted)] hover:text-white"
                        aria-label={`Remove ${t.title}`}
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            ))}
        </div>
    );
}

export function VibeAlchemy({ library, onHighlight, onClose }: VibeAlchemyProps) {
    const { replaceOperation } = useAudioControls();
    const [picked, setPicked] = useState<Record<Column, PickedTrack[]>>({ add: [], subtract: [] });
    const [searchQuery, setSearchQuery] = useState("");
    const [addingTo, setAddingTo] = useState<Column>("add");
    const [results, setResults] = useState<BlendResult[]>([]);
    const [computeError, setComputeError] = useState<string | null>(null);

    const finder = useTrackFinder(library, searchQuery, true);

    const addToColumn = useCallback(
        (track: { id: string; title: string }) => {
            setPicked((prev) =>
                prev[addingTo].some((t) => t.id === track.id)
                    ? prev
                    : { ...prev, [addingTo]: [...prev[addingTo], { id: track.id, title: track.title }] },
            );
            setSearchQuery("");
        },
        [addingTo],
    );

    const removeTrack = useCallback(
        (column: Column, id: string) =>
            setPicked((prev) => ({ ...prev, [column]: prev[column].filter((t) => t.id !== id) })),
        [],
    );

    const mutation = useMutation({
        mutationFn: () => api.getVibeAlchemy(picked.add.map((t) => t.id), picked.subtract.map((t) => t.id), 30),
    });

    // Callbacks passed to mutate() do not run once the panel has closed, so a late
    // result cannot dim the map after the user has left Blend.
    const runBlend = useCallback(() => {
        mutation.mutate(undefined, {
            onSuccess: (result) => {
                setResults(result.tracks);
                onHighlight(new Set(result.tracks.map((t) => t.id)));
                setComputeError(null);
            },
            onError: (error) => {
                setResults([]);
                setComputeError(error instanceof Error && error.message ? error.message : "Failed to compute blend");
            },
        });
    }, [mutation, onHighlight]);

    const handlePlayResults = useCallback(() => {
        const playable: Track[] = results.map((t) => ({
            id: t.id,
            title: t.title,
            displayTitle: t.displayTitle,
            duration: t.duration,
            album: { title: t.album.title, coverArt: t.album.coverUrl ?? undefined, id: t.album.id },
            artist: { name: t.artist.name, id: t.artist.id },
        }));
        const op: VibeOperation = {
            type: "blend",
            addTrackIds: picked.add.map((t) => t.id),
            subtractTrackIds: picked.subtract.map((t) => t.id),
            resultTrackIds: playable.map((t) => t.id),
        };
        replaceOperation(op, playable, 0);
    }, [results, picked, replaceOperation]);

    return (
        <ScenePanel icon={FlaskConical} title="blend" closeLabel="Close alchemy" onClose={onClose} className="sm:w-[480px]">
                <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        {(Object.keys(COLUMNS) as Column[]).map((column) => (
                            <AlchemyColumn
                                key={column}
                                column={column}
                                tracks={picked[column]}
                                active={addingTo === column}
                                onSelect={() => setAddingTo(column)}
                                onRemove={(id) => removeTrack(column, id)}
                            />
                        ))}
                    </div>

                    <TrackSearchInput
                        id="alchemy-search"
                        label="Search tracks for alchemy"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={`Search to add to "${COLUMNS[addingTo].label}"...`}
                    />

                    <TrackFinderResults finder={finder} query={searchQuery} onPick={addToColumn} />

                    <Button className="w-full" onClick={runBlend} disabled={picked.add.length === 0} isLoading={mutation.isPending}>
                        {!mutation.isPending && <FlaskConical className="w-4 h-4" />}
                        {mutation.isPending ? "Computing..." : "Blend"}
                    </Button>
                    {computeError && <p className="text-xs text-danger-light/70 text-center mt-1">{computeError}</p>}
                </div>

                {results.length > 0 && (
                    <div className="border-t border-white/10">
                        <div className="px-4 py-2">
                            <Button className="w-full" onClick={handlePlayResults}>
                                <Play className="w-4 h-4" /> Play Result ({results.length})
                            </Button>
                        </div>
                        <div>
                            {results.map((track, i) => (
                                <NumberedRow
                                    key={track.id}
                                    n={i + 1}
                                    title={track.title}
                                    subtitle={track.artist.name}
                                    trailing={`${Math.round(track.similarity * 100)}%`}
                                />
                            ))}
                        </div>
                    </div>
                )}
        </ScenePanel>
    );
}
