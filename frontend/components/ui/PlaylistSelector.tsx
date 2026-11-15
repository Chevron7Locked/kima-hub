"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type ApiError } from "@/lib/api";
import { X, Plus, Music2 } from "lucide-react";
import { GradientSpinner } from "./GradientSpinner";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/hooks/useDialog";
import { useAddToPlaylistMutation } from "@/hooks/useQueries";
import { announcePlaylistEvent } from "@/lib/playlist-events";
import { newRequestKey } from "@/lib/request-key";

interface PlaylistSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    /** The songs to add to the playlist that is picked. The selector asks before it adds a repeat. */
    trackIds?: string[];
    /** Called once the songs are added (not when the person skips). */
    onAdded?: () => void;
}

/** An entry of a playlist as the playlist page's request returns it. */
interface PlaylistEntry {
    trackId?: string;
    track?: { id?: string };
}

/** Songs the chosen playlist already holds, put to the person before any copy is added. */
interface RepeatQuestion {
    playlistId: string;
    trackIds: string[];
    repeated: string[];
}

/** What an add that ended without closing the dialog has to tell: songs the server could not add. */
interface AddOutcome {
    added: number;
    rejected: number;
}

const songCount = (n: number) => `${n} song${n === 1 ? "" : "s"}`;

/** Asks what to do with songs the playlist already holds: one song or all of them get add again / skip, a mix gets add all / add new ones. */
function RepeatPrompt({
    question,
    busy,
    onAnswer,
}: {
    question: RepeatQuestion;
    busy: boolean;
    onAnswer: (choice: "again" | "new" | "skip") => void;
}) {
    const total = question.trackIds.length;
    const some = question.repeated.length < total;
    const message =
        total === 1
            ? "already in this playlist. add again?"
            : some
              ? `${question.repeated.length} of ${total} songs are already in this playlist. add them again?`
              : `all ${total} songs are already in this playlist. add them again?`;
    return (
        <div className="p-6 space-y-4">
            <p className="text-white">{message}</p>
            <div className="flex gap-2 justify-end">
                <Button variant="secondary" onClick={() => onAnswer(some ? "new" : "skip")} disabled={busy}>
                    {some ? "add new ones" : "skip"}
                </Button>
                <Button variant="primary" onClick={() => onAnswer("again")} disabled={busy}>
                    {some ? "add all" : "add again"}
                </Button>
            </div>
        </div>
    );
}

export function PlaylistSelector({
    isOpen,
    onClose,
    trackIds = [],
    onAdded,
}: PlaylistSelectorProps) {
    const [playlists, setPlaylists] = useState<Array<{ id: string; name: string; trackCount?: number }>>([]);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [isPublic, setIsPublic] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [isLoading, setIsLoading] = useState(isOpen);
    const [error, setError] = useState<string | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    // Set while the person is being asked about songs the chosen playlist already holds.
    const [question, setQuestion] = useState<RepeatQuestion | null>(null);
    // Set when an add ended with songs the server could not add: the dialog stays and says so.
    const [outcome, setOutcome] = useState<AddOutcome | null>(null);
    // What the add in progress has done so far, across the repeat question's answers.
    const tally = useRef<AddOutcome>({ added: 0, rejected: 0 });
    // The id of the playlist this dialog made for these songs and could not finish adding to: a retry adds to it, whatever the form says now.
    const createdId = useRef<string | null>(null);
    // The key a create goes out with. A retry of a create whose answer was lost sends the same key, so the server returns
    // the playlist the first try made. Fresh for each set of songs and each time the dialog opens.
    const createKey = useRef<string | null>(null);
    const { mutateAsync: addToPlaylist } = useAddToPlaylistMutation();

    // Reset dialog state when `isOpen` flips. Done during render (the
    // React-endorsed prop-change pattern) rather than in an effect body,
    // where a synchronous setState is a lint error.
    const [prevOpen, setPrevOpen] = useState(isOpen);
    if (isOpen !== prevOpen) {
        setPrevOpen(isOpen);
        if (isOpen) {
            setNewPlaylistName("");
            setIsPublic(false);
            // Last time's list is not shown while this time's loads.
            setPlaylists([]);
            setIsLoading(true);
            setError(null);
            setQuestion(null);
            setOutcome(null);
            // Whatever was in flight when it closed no longer holds the buttons.
            setIsAdding(false);
            setIsCreating(false);
        }
    }

    // Each load takes a number; only the newest load's answer is used, so an older answer never replaces a newer list.
    const loads = useRef(0);
    // Shows the list. The first load of a session shows a spinner (set when the dialog opens); a refresh keeps the list on screen.
    const loadPlaylists = () => {
        const load = ++loads.current;
        return api
            .getPlaylists()
            .then((data) => {
                if (load === loads.current) setPlaylists(Array.isArray(data) ? data : []);
            })
            .catch((error) => console.error("Failed to load playlists:", error))
            .finally(() => {
                if (load === loads.current) setIsLoading(false);
            });
    };
    const dialogRef = useRef<HTMLDivElement>(null);
    const adding = useRef(false);
    const creating = useRef(false);
    // Counts the times the dialog has opened. A create or add still in flight from an earlier opening finishes quietly:
    // it neither closes the new opening nor reports into it nor lifts its guards.
    const session = useRef(0);
    // Nothing closes the dialog while an add or create is in flight: its late result would still call onAdded and onClose.
    const requestClose = () => {
        if (adding.current || creating.current) return;
        onClose();
    };
    useDialog(dialogRef, isOpen, requestClose);

    useEffect(() => {
        if (!isOpen) return;
        session.current++;
        adding.current = false;
        creating.current = false;
        void loadPlaylists();
    }, [isOpen]);

    // A playlist made, and a create key used, are for one set of songs in one opening.
    const songsKey = trackIds.join(",");
    useEffect(() => {
        createdId.current = null;
        createKey.current = null;
    }, [isOpen, songsKey]);

    const handleCreatePlaylist = async () => {
        const name = newPlaylistName.trim();
        // The create button's own rule, for Enter in the name box too: one create at a time, never nameless.
        if (!name || creating.current || adding.current) return;
        creating.current = true;
        const mine = session.current;
        try {
            setIsCreating(true);
            setError(null);
            // After a failed add the playlist is already made: the retry adds to it, one playlist per attempt.
            const pending = createdId.current;
            let playlist: { id: string };
            if (pending) {
                playlist = { id: pending };
            } else {
                createKey.current ??= newRequestKey();
                playlist = await api.createPlaylist(name, isPublic, createKey.current);
                announcePlaylistEvent("playlist-created", playlist);
                if (session.current !== mine) return;
            }

            if (trackIds.length === 0) {
                onClose();
            } else {
                createdId.current = playlist.id;
                // The playlist was empty before this dialog, so a repeat the server names is one a failed try of this
                // dialog added: it is skipped without asking.
                const done = await whileAdding(() => {
                    tally.current = { added: 0, rejected: 0 };
                    return addSongs(playlist.id, trackIds, false, true);
                });
                if (session.current !== mine) return;
                if (!done) {
                    void loadPlaylists();
                    return;
                }
                createdId.current = null;
            }

            setNewPlaylistName("");
            setIsPublic(false);
        } catch (error) {
            console.error("Failed to create playlist:", error);
            if (session.current === mine) setError("couldn't create that playlist — try again.");
        } finally {
            if (session.current === mine) {
                creating.current = false;
                setIsCreating(false);
            }
        }
    };

    const handleSelectPlaylist = async (playlistId: string) => {
        if (creating.current) return;
        if (trackIds.length === 0) return;

        await whileAdding(async () => {
            tally.current = { added: 0, rejected: 0 };
            if (createdId.current === playlistId) {
                // The playlist this dialog made: what it holds came from a failed try of this dialog.
                await addSongs(playlistId, trackIds, false, true);
                return;
            }
            const held = await heldSongs(playlistId);
            const repeated = trackIds.filter((id) => held.has(id));
            if (repeated.length > 0) {
                setQuestion({ playlistId, trackIds, repeated });
                return;
            }
            await addSongs(playlistId, trackIds, false);
        });
    };

    /** One add at a time: a second click while one is in flight does nothing. A failure is reported and the dialog stays. */
    const whileAdding = async (work: () => Promise<void>): Promise<boolean> => {
        if (adding.current) return false;
        adding.current = true;
        const mine = session.current;
        try {
            setError(null);
            setIsAdding(true);
            await work();
            return true;
        } catch (error) {
            console.error("Failed to add to playlist:", error);
            if (session.current === mine) setError("couldn't add to that playlist — try again.");
            return false;
        } finally {
            if (session.current === mine) {
                adding.current = false;
                setIsAdding(false);
            }
        }
    };

    /** The songs a playlist holds. When it can't be read the add goes ahead and the server skips repeats itself. */
    const heldSongs = async (playlistId: string): Promise<Set<string>> => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            const items = Array.isArray(playlist?.items) ? (playlist.items as PlaylistEntry[]) : [];
            return new Set(items.flatMap((item) => item.trackId ?? item.track?.id ?? []));
        } catch (error) {
            console.error("Failed to read the playlist before adding:", error);
            return new Set();
        }
    };

    /**
     * Adds the songs. Without `allowRepeats` the server skips songs the playlist holds and names them: the read
     * before the add can be stale or have failed, so those are put to the person now, and the dialog stays open.
     * With `ownPlaylist` (a playlist this dialog made) a named repeat was put there by this dialog's own earlier try:
     * it counts as added and is not asked about.
     */
    const addSongs = async (playlistId: string, ids: string[], allowRepeats: boolean, ownPlaylist = false) => {
        let result: { added: number; duplicateIds?: string[]; rejected: string[] };
        const mine = session.current;
        try {
            result = await addToPlaylist(
                allowRepeats ? { playlistId, trackIds: ids, allowRepeats } : { playlistId, trackIds: ids },
            );
        } catch (error) {
            // When every song is refused the server answers 404 and names them: that is not a failure to retry.
            const failure = error as ApiError;
            const refused = failure.data?.rejected;
            if (failure.status !== 404 || !Array.isArray(refused)) throw error;
            result = { added: 0, rejected: refused as string[] };
        }
        // The dialog was reopened while this add was in flight: its answer is not for this opening.
        if (session.current !== mine) return;
        // The add's own settle (useAddToPlaylistMutation) refreshes the playlist pages, whatever way it ended.
        tally.current.added += result.added;
        tally.current.rejected += result.rejected.length;
        const skipped = result.duplicateIds ?? [];
        if (ownPlaylist) {
            tally.current.added += skipped.length;
        } else if (!allowRepeats && skipped.length > 0) {
            setQuestion({ playlistId, trackIds: skipped, repeated: skipped });
            return;
        }
        finish();
    };

    /** The add is over: close, unless songs were refused, which the dialog says before it goes. */
    const finish = () => {
        const { added, rejected } = tally.current;
        if (added > 0) onAdded?.();
        if (rejected === 0) {
            onClose();
            return;
        }
        setQuestion(null);
        setOutcome({ added, rejected });
    };

    /** The person's answer: add the repeats too (`again`), only the songs that are new (`new`), or nothing (`skip`). */
    const answer = async (choice: "again" | "new" | "skip") => {
        if (!question) return;
        if (choice === "skip") {
            finish();
            return;
        }
        await whileAdding(async () => {
            if (choice === "again") {
                await addSongs(question.playlistId, question.trackIds, true);
            } else {
                const fresh = question.trackIds.filter((id) => !question.repeated.includes(id));
                await addSongs(question.playlistId, fresh, false);
            }
        });
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-(--z-modal) p-4 transition-opacity duration-200"
            onClick={requestClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="playlist-selector-title"
                className="bg-[#121212] rounded-xl max-w-md w-full max-h-[80vh] overflow-hidden flex flex-col border border-white/10 animate-pop"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-6 border-b border-white/10">
                    <h2 id="playlist-selector-title" className="text-2xl font-bold text-white">
                        add to playlist
                    </h2>
                    <button
                        onClick={requestClose}
                        aria-label="close"
                        className="p-2 hover:bg-white/10 rounded-full transition-colors"
                    >
                        <X className="w-5 h-5 text-[var(--text-secondary)]" />
                    </button>
                </div>

                {error && (
                    <div
                        role="alert"
                        className="px-6 py-3 bg-black/30 border-b border-white/10 text-sm text-[var(--text-primary)]"
                    >
                        {error}
                    </div>
                )}

                {outcome ? (
                    <div className="p-6 space-y-4">
                        <p className="text-white">
                            {outcome.added > 0 && `added ${songCount(outcome.added)}. `}
                            {`${songCount(outcome.rejected)} couldn't be added.`}
                        </p>
                        <div className="flex justify-end">
                            <Button variant="primary" onClick={onClose}>
                                done
                            </Button>
                        </div>
                    </div>
                ) : question ? (
                    <RepeatPrompt question={question} busy={isAdding} onAnswer={answer} />
                ) : (<>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <GradientSpinner size="md" />
                        </div>
                    ) : playlists.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <Music2 className="w-12 h-12 text-[var(--text-muted)] mb-3" />
                            <p className="text-[var(--text-secondary)]">no playlists yet</p>
                            <p className="text-[var(--text-muted)] text-sm mt-1">
                                create one below to get started
                            </p>
                        </div>
                    ) : (
                        playlists.map((playlist, i) => {
                            return (
                                <button
                                    key={playlist.id}
                                    onClick={() => handleSelectPlaylist(playlist.id)}
                                    className={`w-full text-left px-4 py-4 rounded-lg transition-all border group bg-white/5 hover:bg-white/10 border-white/5 hover:border-white/10 ${
                                        i < 8 ? `animate-rise [animation-delay:calc(var(--i)*45ms)]` : ""
                                    }`}
                                    disabled={isAdding || isCreating}
                                    style={{ "--i": i } as CSSProperties}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex-1 min-w-0">
                                            <p className="font-semibold truncate text-white transition-colors group-hover:text-brand">
                                                {playlist.name}
                                            </p>
                                            <p className="text-xs text-[var(--text-secondary)] mt-1">
                                                {playlist.trackCount || 0}{" "}
                                                {playlist.trackCount === 1
                                                    ? "track"
                                                    : "tracks"}
                                            </p>
                                        </div>
                                        <Plus className="w-5 h-5 text-[var(--text-secondary)] group-hover:text-brand transition-colors ml-2 shrink-0" />
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="p-6 border-t border-white/10 bg-[var(--bg-primary)]/50">
                    <p className="text-sm text-[var(--text-secondary)] mb-3 font-medium">
                        create new playlist
                    </p>
                    <div className="flex gap-2 mb-3">
                        <input
                            type="text"
                            placeholder="enter playlist name..."
                            value={newPlaylistName}
                            onChange={(e) => setNewPlaylistName(e.target.value)}
                            onKeyDown={(e) =>
                                // Enter that confirms an IME composition is not a submit (Safari reports it as keyCode 229).
                                e.key === "Enter" &&
                                !e.nativeEvent.isComposing &&
                                e.nativeEvent.keyCode !== 229 &&
                                handleCreatePlaylist()
                            }
                            className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-[var(--color-brand)] focus:bg-white/10 transition-all"
                        />
                        <Button
                            variant="primary"
                            onClick={handleCreatePlaylist}
                            disabled={!newPlaylistName.trim() || isCreating || isAdding}
                        >
                            <Plus className="w-5 h-5" />
                            <span className="hidden sm:inline">create</span>
                        </Button>
                    </div>
                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className="relative">
                            <input
                                type="checkbox"
                                checked={isPublic}
                                onChange={(e) => setIsPublic(e.target.checked)}
                                className="sr-only peer"
                            />
                            <div className="w-10 h-5 bg-white/10 rounded-full peer-checked:bg-brand transition-colors" />
                            <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
                        </div>
                        <span className="text-sm text-[var(--text-secondary)] group-hover:text-gray-300 transition-colors">
                            share with other users
                        </span>
                    </label>
                </div>
                </>)}
            </div>
        </div>
    );
}
