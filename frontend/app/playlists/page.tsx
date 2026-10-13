"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePlaylistsQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useAudioControls } from "@/lib/audio-context";
import {
    Play,
    Music,
    Eye,
    EyeOff,
    ListMusic,
    Plus,
    Link2,
    FileMusic,
    Compass,
    X,
    Check,
    ImagePlus,
} from "lucide-react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/layout/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { plural } from "@/lib/format";
import { MediaCard } from "@/components/cards/MediaCard";
import { mosaicCovers } from "@/features/playlist/coverMosaic";
import { useUploadPlaylistCoverMutation } from "@/hooks/useQueries";
import { COVER_ACCEPT, coverUploadError } from "@/features/playlist/playlistCover";
import { notify } from "@/lib/notify";

type ActionPanel = "create" | "importUrl" | "importFile" | null;

interface PlaylistItem {
    id: string;
    track: {
        album?: {
            coverUrl?: string;
        };
    };
}

interface Playlist {
    id: string;
    name: string;
    trackCount?: number;
    items?: PlaylistItem[];
    isOwner?: boolean;
    isHidden?: boolean;
    coverUrl?: string | null;
    user?: {
        username: string;
    };
}

function mosaicUrls(items: PlaylistItem[] | undefined, coverUrl?: string | null): string[] {
    // A custom cover (issue #151) takes the whole card; only fall back to the
    // track mosaic when there is no custom cover.
    if (coverUrl) return [api.getCoverArtUrl(coverUrl, 200)];
    return mosaicCovers((items ?? []).map((item) => item.track?.album?.coverUrl)).map(
        (cover) => api.getCoverArtUrl(cover, 200),
    );
}

function PlaylistCard({
    playlist,
    index,
    onPlay,
    onToggleHide,
    onSetCover,
    isHiddenView = false,
}: {
    playlist: Playlist;
    index: number;
    onPlay: (playlistId: string) => void;
    onToggleHide: (playlistId: string, hide: boolean) => void;
    onSetCover: (playlistId: string, file: File) => Promise<void>;
    isHiddenView?: boolean;
}) {
    const isShared = playlist.isOwner === false;
    const isOwner = playlist.isOwner === true;
    const [isHiding, setIsHiding] = useState(false);
    const [isUploadingCover, setIsUploadingCover] = useState(false);
    const coverFileRef = useRef<HTMLInputElement>(null);
    const imageUrl = useMemo(
        () => mosaicUrls(playlist.items, playlist.coverUrl),
        [playlist.items, playlist.coverUrl],
    );

    const handleToggleHide = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsHiding(true);
        try {
            await onToggleHide(playlist.id, !playlist.isHidden);
        } finally {
            setIsHiding(false);
        }
    };

    const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;

        const problem = coverUploadError(file);
        if (problem) {
            notify.error(problem);
            return;
        }

        setIsUploadingCover(true);
        try {
            await onSetCover(playlist.id, file);
        } catch (error) {
            console.error("Failed to upload playlist cover:", error);
            notify.error("Failed to upload cover image");
        } finally {
            setIsUploadingCover(false);
        }
    };

    return (
        <MediaCard
            href={`/playlist/${playlist.id}`}
            title={playlist.name}
            subtitle={`${isShared && playlist.user?.username ? `${playlist.user.username} · ` : ""}${plural(playlist.trackCount || 0, "song")}`}
            imageUrl={imageUrl}
            fallbackIcon={Music}
            type="track"
            index={index}
            className={cn(isHiddenView && "opacity-60 hover:opacity-100")}
            action={{ icon: Play, label: "Play", onClick: () => onPlay(playlist.id) }}
            corner={
                isShared ? (
                    <button
                        type="button"
                        onClick={handleToggleHide}
                        disabled={isHiding}
                        aria-label={playlist.isHidden ? "Show playlist" : "Hide playlist"}
                        title={playlist.isHidden ? "show playlist" : "hide playlist"}
                        className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150",
                            playlist.isHidden ? "text-success" : "text-[var(--text-muted)]",
                            isHiding && "opacity-50 cursor-not-allowed",
                        )}
                    >
                        {playlist.isHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    </button>
                ) : isOwner ? (
                    <>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                coverFileRef.current?.click();
                            }}
                            disabled={isUploadingCover}
                            aria-label="Set cover image"
                            title="Set cover"
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 text-[var(--text-muted)] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <ImagePlus className="w-3.5 h-3.5" />
                        </button>
                        <input
                            ref={coverFileRef}
                            type="file"
                            accept={COVER_ACCEPT}
                            className="hidden"
                            onChange={handleCoverFileChange}
                        />
                    </>
                ) : null
            }
        />
    );
}

// --- Inline action panels ---

const PANEL_INPUT =
    "px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30";

function PanelCloseButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="px-3 py-2 rounded-lg text-xs tabular-nums text-[var(--text-muted)] hover:text-white/70 transition-colors"
        >
            <X className="w-4 h-4" />
        </button>
    );
}

function CreatePanel({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [name, setName] = useState("");
    const [isPublic, setIsPublic] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;

        setIsSubmitting(true);
        setError(null);
        try {
            const result = await api.createPlaylist(trimmed, isPublic);
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
            onClose();
            if (result?.id) {
                router.push(`/playlist/${result.id}`);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create playlist");
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-3">
            <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Playlist name..."
                className={cn("flex-1 min-w-[180px]", PANEL_INPUT)}
                disabled={isSubmitting}
            />
            <button
                type="button"
                onClick={() => setIsPublic(!isPublic)}
                className={cn(
                    "px-3 py-2 rounded-lg text-xs tabular-nums border transition-colors",
                    isPublic
                        ? "bg-brand/10 border-brand/30 text-brand"
                        : "bg-white/5 border-white/10 text-[var(--text-muted)] hover:text-white/60"
                )}
            >
                {isPublic ? "Public" : "Private"}
            </button>
            <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!name.trim()}
                isLoading={isSubmitting}
            >
                {!isSubmitting && <Check className="w-3.5 h-3.5" />}
                Create
            </Button>
            <PanelCloseButton onClick={onClose} />
            {error && (
                <p className="w-full text-xs tabular-nums text-danger-light mt-1">{error}</p>
            )}
        </form>
    );
}

function ImportUrlPanel({ onClose }: { onClose: () => void }) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = url.trim();
        if (!trimmed) return;

        try {
            new URL(trimmed);
        } catch {
            setError("Enter a valid URL");
            return;
        }

        const supportedDomains = ["spotify.com", "deezer.com", "youtube.com", "youtu.be", "soundcloud.com", "bandcamp.com", "mixcloud.com"];
        if (!supportedDomains.some(domain => trimmed.includes(domain))) {
            setError("Supported: Spotify, Deezer, YouTube, SoundCloud, Bandcamp, Mixcloud");
            return;
        }

        setIsSubmitting(true);
        setError(null);
        try {
            await api.post<{ jobId: string }>("/spotify/import/quick", { url: trimmed });
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to start import");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-3">
            <input
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(null); }}
                placeholder="Paste a playlist URL (Spotify, YouTube, SoundCloud...)"
                className={cn("flex-1 min-w-[220px]", PANEL_INPUT)}
                disabled={isSubmitting}
            />
            <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!url.trim()}
                isLoading={isSubmitting}
            >
                {!isSubmitting && <Link2 className="w-3.5 h-3.5" />}
                Import
            </Button>
            <PanelCloseButton onClick={onClose} disabled={isSubmitting} />
            {error && (
                <p className="w-full text-xs tabular-nums text-danger-light mt-1">{error}</p>
            )}
        </form>
    );
}

function ImportM3UPanel({ onClose }: { onClose: () => void }) {
    const queryClient = useQueryClient();
    const [file, setFile] = useState<File | null>(null);
    const [playlistName, setPlaylistName] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{ playlistId: string; matched: number; total: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const nameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fileInputRef.current?.click();
    }, []);

    useEffect(() => {
        if (file) {
            nameInputRef.current?.focus();
        }
    }, [file]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0];
        if (!selected) {
            onClose();
            return;
        }
        setFile(selected);
        const nameWithoutExt = selected.name.replace(/\.(m3u8?|M3U8?)$/, "");
        setPlaylistName(nameWithoutExt);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file || !playlistName.trim()) return;

        setIsSubmitting(true);
        setError(null);
        try {
            const res = await api.importM3U(file, playlistName.trim());
            setResult({ playlistId: res.playlistId, matched: res.matched, total: res.total });
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        } catch (err) {
            setError(err instanceof Error ? err.message : "M3U import failed");
            setIsSubmitting(false);
        }
    };

    if (result) {
        return (
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-white">
                    <Check className="w-4 h-4 text-success shrink-0" />
                    <span>
                        Created &ldquo;{playlistName}&rdquo; with {result.matched} of {result.total} tracks matched.
                    </span>
                </div>
                <Link
                    href={`/playlist/${result.playlistId}`}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-brand text-black hover:bg-brand-hover transition-colors"
                >
                    View Playlist
                </Link>
                <PanelCloseButton onClick={onClose} />
            </div>
        );
    }

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept=".m3u,.m3u8"
                onChange={handleFileChange}
                className="hidden"
            />
            {file && (
                <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs tabular-nums text-[var(--text-secondary)] shrink-0">
                        <FileMusic className="w-3.5 h-3.5 text-brand" />
                        {file.name}
                    </div>
                    <input
                        ref={nameInputRef}
                        type="text"
                        value={playlistName}
                        onChange={(e) => setPlaylistName(e.target.value)}
                        placeholder="Playlist name..."
                        className={cn("flex-1 min-w-[180px]", PANEL_INPUT)}
                        disabled={isSubmitting}
                    />
                    <Button
                        variant="primary"
                        size="sm"
                        type="submit"
                        disabled={!playlistName.trim()}
                        isLoading={isSubmitting}
                    >
                        {!isSubmitting && <Check className="w-3.5 h-3.5" />}
                        Create Playlist
                    </Button>
                    <PanelCloseButton onClick={onClose} />
                    {error && (
                        <p className="w-full text-xs tabular-nums text-danger-light mt-1">{error}</p>
                    )}
                </form>
            )}
        </>
    );
}

// --- Action bar button ---

function ActionButton({
    icon: Icon,
    label,
    active,
    onClick,
    primary = false,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    active: boolean;
    onClick: () => void;
    primary?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all",
                primary
                    ? active
                        ? "bg-brand text-black ring-2 ring-brand/40"
                        : "bg-brand text-black hover:bg-brand-hover"
                    : active
                        ? "bg-white/10 text-white border border-white/20"
                        : "text-[var(--text-secondary)] hover:bg-white/5 border border-white/10 hover:text-white/70 hover:border-white/20"
            )}
        >
            <Icon className="w-4 h-4" />
            <span className="hidden sm:inline">{label}</span>
        </button>
    );
}

// --- Getting started ---

function ActionRow({
    icon: Icon,
    title,
    subtitle,
    brand = false,
    onClick,
    children,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    subtitle: string;
    brand?: boolean;
    onClick: () => void;
    children?: React.ReactNode;
}) {
    return (
        <div className="space-y-3">
            <button onClick={onClick} className="flex items-center gap-3 text-left group">
                <div
                    className={cn(
                        "w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 transition-colors",
                        brand
                            ? "bg-brand/10 border-brand/20 group-hover:bg-brand/20"
                            : "bg-white/5 border-white/10 group-hover:bg-white/10"
                    )}
                >
                    <Icon className={cn("w-5 h-5", brand ? "text-brand" : "text-[var(--text-muted)]")} />
                </div>
                <div>
                    <h3 className="text-sm font-bold tracking-tight text-white">{title}</h3>
                    <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
                </div>
            </button>
            {children && <div className="pl-[52px]">{children}</div>}
        </div>
    );
}

function GettingStarted({
    activeAction,
    toggle,
    close,
}: {
    activeAction: ActionPanel;
    toggle: (a: ActionPanel) => void;
    close: () => void;
}) {
    return (
        <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-8 md:p-12">
            <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-brand to-brand-dark" />

            <div className="flex items-center gap-3 mb-8 pb-4 border-b border-white/10">
                <div className="w-2 h-2 bg-brand" />
                <span className="text-xs text-[var(--text-secondary)]">
                    Getting Started
                </span>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
                <ActionRow
                    icon={Plus}
                    title="Create your first playlist"
                    subtitle="Start from scratch"
                    brand
                    onClick={() => toggle("create")}
                >
                    {activeAction === "create" && <CreatePanel onClose={close} />}
                </ActionRow>

                <ActionRow
                    icon={Link2}
                    title="Import from Spotify or Deezer"
                    subtitle="Paste a playlist URL"
                    onClick={() => toggle("importUrl")}
                >
                    {activeAction === "importUrl" && <ImportUrlPanel onClose={close} />}
                </ActionRow>

                <ActionRow
                    icon={FileMusic}
                    title="Import from M3U file"
                    subtitle="Upload .m3u or .m3u8"
                    onClick={() => toggle("importFile")}
                >
                    {activeAction === "importFile" && <ImportM3UPanel onClose={close} />}
                </ActionRow>

                <div>
                    <Link
                        href="/browse/playlists"
                        className="flex items-center gap-3 text-left group"
                    >
                        <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0 group-hover:bg-white/10 transition-colors">
                            <Compass className="w-5 h-5 text-[var(--text-muted)]" />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold tracking-tight text-white">Browse public playlists</h3>
                            <p className="text-xs text-[var(--text-muted)]">Discover shared music</p>
                        </div>
                    </Link>
                </div>
            </div>
        </div>
    );
}

// --- Main page ---

export default function PlaylistsPage() {
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [showHiddenTab, setShowHiddenTab] = useState(false);
    const [activeAction, setActiveAction] = useState<ActionPanel>(null);

    const { data: playlists = [], isLoading } = usePlaylistsQuery();

    const { visiblePlaylists, hiddenPlaylists } = useMemo(() => {
        const visible: Playlist[] = [];
        const hidden: Playlist[] = [];

        playlists.forEach((p: Playlist) => {
            if (p.isHidden) {
                hidden.push(p);
            } else {
                visible.push(p);
            }
        });

        return { visiblePlaylists: visible, hiddenPlaylists: hidden };
    }, [playlists]);

    useEffect(() => {
        const handlePlaylistEvent = () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [queryClient]);

    const handlePlayPlaylist = async (playlistId: string) => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            if (playlist?.items && playlist.items.length > 0) {
                const tracks = playlist.items.map((item: { track: { id: string; title: string; duration: number; album?: { id?: string; title?: string; coverArt?: string; artist?: { id?: string; name?: string } } } }) => ({
                    id: item.track.id,
                    title: item.track.title,
                    artist: {
                        name: item.track.album?.artist?.name || "Unknown",
                        id: item.track.album?.artist?.id,
                    },
                    album: {
                        title: item.track.album?.title || "Unknown",
                        coverArt: item.track.album?.coverArt,
                        id: item.track.album?.id,
                    },
                    duration: item.track.duration,
                }));
                playTracks(tracks, 0);
            }
        } catch (error) {
            console.error("Failed to play playlist:", error);
        }
    };

    const handleToggleHide = async (playlistId: string, hide: boolean) => {
        try {
            if (hide) {
                await api.hidePlaylist(playlistId);
            } else {
                await api.unhidePlaylist(playlistId);
            }
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        }
    };

    // Custom cover upload (issue #151); the mutation itself invalidates the
    // playlist + playlist-list queries on success.
    const { mutateAsync: uploadPlaylistCover } = useUploadPlaylistCoverMutation();

    const handleSetCover = async (playlistId: string, file: File) => {
        await uploadPlaylistCover({ playlistId, file });
    };

    const toggleAction = (action: ActionPanel) => {
        setActiveAction((prev) => (prev === action ? null : action));
    };

    if (isLoading) {
        return <LoadingScreen />;
    }

    const displayedPlaylists = showHiddenTab
        ? hiddenPlaylists
        : visiblePlaylists;
    const emptyStateHasForms = displayedPlaylists.length === 0 && !showHiddenTab;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black section-stack">
            <PageHeader
                eyebrow="Your library"
                title="Playlists"
                description={
                    `${visiblePlaylists.length} ${visiblePlaylists.length === 1 ? "playlist" : "playlists"}` +
                    (hiddenPlaylists.length > 0 ? ` · ${hiddenPlaylists.length} hidden` : "")
                }
                actions={
                    hiddenPlaylists.length > 0 && (
                        <Button
                            variant="secondary"
                            size="sm"
                            aria-pressed={showHiddenTab}
                            onClick={() => setShowHiddenTab(!showHiddenTab)}
                        >
                            {showHiddenTab ? "Show all" : `Hidden (${hiddenPlaylists.length})`}
                        </Button>
                    )
                }
            >
                <div className="flex flex-wrap items-center gap-2 mt-5">
                    <ActionButton
                        icon={Plus}
                        label="Create"
                        active={activeAction === "create"}
                        onClick={() => toggleAction("create")}
                        primary
                    />
                    <ActionButton
                        icon={Link2}
                        label="Import URL"
                        active={activeAction === "importUrl"}
                        onClick={() => toggleAction("importUrl")}
                    />
                    <ActionButton
                        icon={FileMusic}
                        label="Import File"
                        active={activeAction === "importFile"}
                        onClick={() => toggleAction("importFile")}
                    />
                    <Link
                        href="/browse/playlists"
                        aria-label="browse playlists"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:bg-white/5 border border-white/10 hover:text-white/70 hover:border-white/20 transition-all"
                    >
                        <Compass className="w-4 h-4" />
                        <span className="hidden sm:inline">Browse</span>
                    </Link>
                </div>

                {/* Inline action panel; with no playlists the empty state below shows the same forms */}
                {activeAction && !emptyStateHasForms && (
                    <div className="mt-4 p-4 rounded-lg bg-white/[0.02] border border-white/10">
                        {activeAction === "create" && (
                            <CreatePanel onClose={() => setActiveAction(null)} />
                        )}
                        {activeAction === "importUrl" && (
                            <ImportUrlPanel onClose={() => setActiveAction(null)} />
                        )}
                        {activeAction === "importFile" && (
                            <ImportM3UPanel onClose={() => setActiveAction(null)} />
                        )}
                    </div>
                )}
            </PageHeader>

            <div className="relative page-shell pb-24 animate-rise">
                {showHiddenTab && (
                    <div className="mb-6 px-4 py-3 bg-white/5 rounded-lg border border-white/10">
                        <p className="text-xs text-[var(--text-muted)]">
                            Unhide with the eye button.
                        </p>
                    </div>
                )}

                {displayedPlaylists.length > 0 ? (
                    <div>
                        <SectionHeader type="track" title={showHiddenTab ? "Hidden" : "All Playlists"} count={displayedPlaylists.length} />

                        <div
                            data-tv-section="playlists"
                            className="grid-media"
                        >
                            {displayedPlaylists.map(
                                (playlist: Playlist, index: number) => (
                                    <PlaylistCard
                                        key={playlist.id}
                                        playlist={playlist}
                                        index={index}
                                        onPlay={handlePlayPlaylist}
                                        onToggleHide={handleToggleHide}
                                        onSetCover={handleSetCover}
                                        isHiddenView={showHiddenTab}
                                    />
                                )
                            )}
                        </div>
                    </div>
                ) : (
                    showHiddenTab ? (
                        <EmptyState
                            icon={<ListMusic className="w-12 h-12" />}
                            title="No hidden playlists"
                            description="You haven't hidden any playlists"
                        />
                    ) : (
                        <GettingStarted
                            activeAction={activeAction}
                            toggle={toggleAction}
                            close={() => setActiveAction(null)}
                        />
                    )
                )}
            </div>
        </div>
    );
}
