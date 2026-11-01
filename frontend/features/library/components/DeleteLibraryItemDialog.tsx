"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

type Kind = "artist" | "album";

const KINDS: Record<Kind, { heading: string; message: (title: string) => string; back: string }> = {
    artist: {
        heading: "Delete Artist?",
        message: (title) =>
            `Are you sure you want to delete "${title}"? This will permanently delete all albums, tracks, and files from your system.`,
        back: "/collection?tab=artists",
    },
    album: {
        heading: "Delete Album?",
        message: (title) =>
            `Are you sure you want to delete "${title}"? This will permanently delete all tracks and files from your system.`,
        back: "/collection?tab=albums",
    },
};

/**
 * The confirm step for deleting a library artist or album from its own page. On success the cached lists that could
 * still show it are marked stale and the page returns to the collection; on failure the dialog stays open for a retry
 * and the notification tray says what failed.
 */
export function DeleteLibraryItemDialog({
    kind,
    id,
    title,
    isOpen,
    onClose,
}: {
    kind: Kind;
    id: string;
    title: string;
    isOpen: boolean;
    onClose: () => void;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const copy = KINDS[kind];

    const confirm = async () => {
        setBusy(true);
        try {
            if (kind === "artist") await api.deleteArtist(id);
            else await api.deleteAlbum(id);
        } catch (error) {
            console.error(`Failed to delete ${kind}:`, error);
            notify.error(`Could not delete ${kind} "${title}"`, {
                message: error instanceof Error ? error.message : undefined,
            });
            setBusy(false);
            return;
        }
        setBusy(false);
        onClose();
        // Every list that can still show it or its songs: the collection, home rows, popular artists, search,
        // recommendations, playlists and mixes (the ones on screen refetch now; the collection's cached pages too, so
        // the collection this page returns to doesn't flash the deleted item); the detail pages of its artist,
        // albums, playlists and mixes only refetch when next opened. Nothing waits on them: the item is already gone.
        void queryClient.invalidateQueries({ queryKey: ["library"], refetchType: "all" });
        for (const queryKey of [["popular-artists"], ["search"], ["recommendations"], ["playlists"], ["mixes"]]) {
            void queryClient.invalidateQueries({ queryKey });
        }
        for (const queryKey of [["artist"], ["album"], ["playlist"], ["mix"]]) {
            void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
        }
        router.push(copy.back);
    };

    return (
        <ConfirmDialog
            isOpen={isOpen}
            onClose={onClose}
            onConfirm={() => void confirm()}
            closeOnConfirm={false}
            busy={busy}
            title={copy.heading}
            message={copy.message(title)}
            confirmText="Delete"
            cancelText="Cancel"
            variant="danger"
        />
    );
}
