"use client";

/**
 * The mood-mix item: save as playlist, rebuild, or keep. Nothing clears until
 * Rebuild. A retired mix offers save or remove only. Loads the server's
 * recorded answer first, so another device's answer shows here.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ChoiceButton } from "./ChoiceButton";
import { refreshOpenCount } from "./useVersionChip";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { api, type MoodMixDecision, type MoodMixReleaseState } from "@/lib/api";
import { opensHere } from "./WhatsNewWindow";

type Busy = "save" | MoodMixDecision | null;

/** `onNavigate` puts the window off for this tab when the user follows the playlist link, as the window's own links do. */
export function MoodMixChoice({ onNavigate }: { onNavigate?: () => void }) {
    const queryClient = useQueryClient();
    const [state, setState] = useState<MoodMixReleaseState | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState<Busy>(null);
    const [error, setError] = useState<string | null>(null);
    // The mix is gone once cleared, so remember which wording cleared it.
    const [removedRetired, setRemovedRetired] = useState(false);

    useEffect(() => {
        let cancelled = false;
        api.getMoodMixReleaseState()
            .then((s) => { if (!cancelled) setState(s); })
            .catch(() => { if (!cancelled) setLoadFailed(true); });
        return () => { cancelled = true; };
    }, []);

    if (loadFailed) {
        return (
            <p className="text-sm text-danger-light">
                Couldn&rsquo;t load your mood mix.
            </p>
        );
    }
    if (!state) {
        return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" aria-label="Loading" />;
    }

    const { mix, decision, playlist } = state;

    const save = async () => {
        if (!mix) return;
        setBusy("save");
        setError(null);
        try {
            const saved = await api.saveMoodMixAsPlaylist(mix.id);
            refreshOpenCount(queryClient);
            setState((s) => s && { ...s, playlist: { id: saved.id, name: saved.name } });
        } catch {
            setError("Couldn't save as a playlist");
        } finally {
            setBusy(null);
        }
    };

    const decide = async (next: MoodMixDecision) => {
        setBusy(next);
        setError(null);
        try {
            await api.decideMoodMixes(next);
            refreshOpenCount(queryClient);
            if (next === "remove") setRemovedRetired(true);
            setState((s) => s && { ...s, decision: next === "keep" ? "keep" : "rebuild", mix: next === "keep" ? s.mix : null });
        } catch {
            setError(next === "keep" ? "Couldn't save your answer." : "Couldn't clear the mix");
        } finally {
            setBusy(null);
        }
    };

    const savedNote = playlist && (
        <p className="text-sm text-success flex items-center gap-2" data-testid="moodmix-saved">
            <Check className="w-4 h-4" />
            Saved as the playlist&nbsp;
            <Link href={`/playlist/${playlist.id}`} onClick={(e) => { if (opensHere(e)) onNavigate?.(); }} className="underline hover:text-white">
                {playlist.name}
            </Link>
        </p>
    );

    // Cleared: the mix is gone. Only a playlist saved before it remains.
    if (!mix) {
        return (
            <div className="flex flex-col gap-2">
                {savedNote}
                <p className="text-sm text-success flex items-center gap-2" data-testid="moodmix-cleared">
                    <Check className="w-4 h-4" />
                    {decision !== "rebuild"
                        ? "No saved mood mix"
                        : removedRetired
                          ? "Removed."
                          : "Cleared"}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-white/80" data-testid="moodmix-name">
                {mix.name} &middot; {mix.trackCount} {mix.trackCount === 1 ? "track" : "tracks"}
            </p>
            {savedNote ?? (
                <Button onClick={save} disabled={busy !== null} data-testid="moodmix-save" className="self-start">
                    {busy === "save" && <Loader2 className="w-4 h-4 animate-spin" />}
                    {busy === "save" ? "Saving..." : "Save as playlist"}
                </Button>
            )}
            <div className="flex gap-2">
                {mix.retired ? (
                    // Can't be shown any more, so there is nothing to keep.
                    <ChoiceButton
                        label="Remove"
                        selected={false}
                        busy={busy === "remove"}
                        disabled={busy !== null}
                        onClick={() => decide("remove")}
                        testId="moodmix-remove"
                    />
                ) : (
                    <>
                        <ChoiceButton
                            label="Rebuild"
                            selected={false}
                            busy={busy === "rebuild"}
                            disabled={busy !== null}
                            onClick={() => decide("rebuild")}
                            testId="moodmix-rebuild"
                        />
                        <ChoiceButton
                            label="Keep"
                            selected={decision === "keep"}
                            busy={busy === "keep"}
                            disabled={busy !== null}
                            onClick={() => decide("keep")}
                            testId="moodmix-keep"
                        />
                    </>
                )}
            </div>
            {error && <p className="text-sm text-danger-light" data-testid="moodmix-error">{error}</p>}
        </div>
    );
}
