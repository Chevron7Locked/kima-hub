"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/cn";
import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
import { DPAD_KEYS } from "@/lib/tv-utils";
import { useTVNavigation } from "@/hooks/useTVNavigation";
import { formatTime, clampTime, formatMediaDuration } from "@/lib/format";
import { RefreshCw, SkipBack, SkipForward, Shuffle, Repeat } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { KimaMark } from "@/components/ui/KimaMark";
import { shownTitle } from "@/lib/track-title";
import { useLibrarySync } from "@/hooks/useLibrarySync";
import { NAV, isCurrentNav } from "./navItems";

const tvNavigation = [NAV.home, NAV.search, NAV.collection, NAV.audiobooks, NAV.podcasts, NAV.discover, NAV.playlists];

const FIRE_TV_BACK = 4;

export function TVLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    // The remote starts on the first tab, so the D-pad works at once.
    const [focusedTabIndex, setFocusedTabIndex] = useState(0);
    const [isNavFocused, setIsNavFocused] = useState(true);
    const { sync: handleSync, syncing: isSyncing } = useLibrarySync();
    const navRef = useRef<HTMLDivElement>(null);

    const {
        containerRef: contentRef,
        focusFirstCard,
        handleKeyDown: handleContentKeyDown,
    } = useTVNavigation({
        onBack: () => {
            setIsNavFocused(true);
            const currentIndex = tvNavigation.findIndex(n => n.href === pathname);
            setFocusedTabIndex(currentIndex >= 0 ? currentIndex : 0);
        },
    });

    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        pause,
        resumeWithGesture,
        currentTime,
        duration,
        next,
        previous,
        isShuffle,
        toggleShuffle,
        repeatMode,
        toggleRepeat,
        seek,
    } = useAudio();

    useEffect(() => {
        document.documentElement.classList.add('tv-mode');
        document.body.classList.add('tv-mode');
        return () => {
            document.documentElement.classList.remove('tv-mode');
            document.body.classList.remove('tv-mode');
        };
    }, []);

    const currentTimeRef = useRef(currentTime);
    const durationRef = useRef(duration);

    useEffect(() => {
        currentTimeRef.current = currentTime;
    }, [currentTime]);

    useEffect(() => {
        durationRef.current = duration;
    }, [duration]);

    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    let title = "";
    let artist = "";
    let coverUrl: string | null = null;

    if (playbackType === "track" && currentTrack) {
        title = shownTitle(currentTrack);
        artist = currentTrack.artist?.name || "";
        coverUrl = currentTrack.album?.coverArt
            ? api.getCoverArtUrl(currentTrack.album.coverArt, 96)
            : null;
    } else if (playbackType === "audiobook" && currentAudiobook) {
        title = currentAudiobook.title;
        artist = currentAudiobook.author || "";
        coverUrl = currentAudiobook.coverUrl
            ? api.getCoverArtUrl(currentAudiobook.coverUrl, 96)
            : null;
    } else if (playbackType === "podcast" && currentPodcast) {
        title = currentPodcast.title;
        artist = currentPodcast.podcastTitle || "";
        coverUrl = currentPodcast.coverUrl
            ? api.getCoverArtUrl(currentPodcast.coverUrl, 96)
            : null;
    }

    const clampedCurrentTime = clampTime(currentTime, duration);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (hasMedia) {
            switch (e.key) {
                case DPAD_KEYS.PLAY_PAUSE:
                case "MediaPlayPause":
                case " ": // Space bar as play/pause
                    // Only use space when not in an input field
                    if (e.key === " ") {
                        const target = e.target as HTMLElement;
                        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
                            return;
                        }
                    }
                    e.preventDefault();
                    if (isPlaying) { pause(); } else { resumeWithGesture(); }
                    return;
                case "MediaTrackNext":
                    e.preventDefault();
                    next();
                    return;
                case "MediaTrackPrevious":
                    e.preventDefault();
                    previous();
                    return;
                case DPAD_KEYS.FAST_FORWARD:
                case "MediaFastForward":
                    e.preventDefault();
                    seek(Math.min(currentTimeRef.current + 10, durationRef.current));
                    return;
                case DPAD_KEYS.REWIND:
                case "MediaRewind":
                    e.preventDefault();
                    seek(Math.max(currentTimeRef.current - 10, 0));
                    return;
            }
        }

        if (isNavFocused) {
            if (e.key === DPAD_KEYS.LEFT) {
                e.preventDefault();
                setFocusedTabIndex(prev => Math.max(0, prev - 1));
            } else if (e.key === DPAD_KEYS.RIGHT) {
                e.preventDefault();
                setFocusedTabIndex(prev => Math.min(tvNavigation.length - 1, prev + 1));
            } else if (e.key === DPAD_KEYS.DOWN) {
                e.preventDefault();
                setIsNavFocused(false);
                focusFirstCard();
            } else if (e.key === DPAD_KEYS.CENTER) {
                e.preventDefault();
                router.push(tvNavigation[focusedTabIndex].href);
            }
        } else {
            handleContentKeyDown(e);
        }
    }, [isNavFocused, focusedTabIndex, router, hasMedia, isPlaying, pause, resumeWithGesture, next, previous, seek, focusFirstCard, handleContentKeyDown]);

    useEffect(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown]);

    // Fire TV's remote sends Back as key code 4 (Amazon's Fire TV remote input table); everything in Kima answers
    // Escape. Back is turned into Escape before anything sees it, and the browser's own back is cancelled.
    useEffect(() => {
        const backToEscape = (e: KeyboardEvent) => {
            if (e.keyCode !== FIRE_TV_BACK) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            (e.target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        };
        window.addEventListener("keydown", backToEscape, true);
        return () => window.removeEventListener("keydown", backToEscape, true);
    }, []);

    useEffect(() => {
        if (isNavFocused && navRef.current) {
            const tabs = navRef.current.querySelectorAll<HTMLAnchorElement>('[data-tv-tab]');
            tabs[focusedTabIndex]?.focus();
        }
    }, [focusedTabIndex, isNavFocused]);

    // On initial mount and pathname change, set the correct focused tab
    const [syncedPathname, setSyncedPathname] = useState<string | null>(null);
    if (pathname !== syncedPathname) {
        setSyncedPathname(pathname);
        const currentIndex = tvNavigation.findIndex(n =>
            n.href === pathname || (n.href !== "/" && pathname.startsWith(n.href))
        );
        if (currentIndex >= 0) {
            setFocusedTabIndex(currentIndex);
        }
    }

    return (
        <>
            <header className="tv-nav">
                <Link href="/" className="tv-logo">
                    <KimaMark size={24} />
                    <span>Kima</span>
                </Link>

                <nav ref={navRef} className="tv-nav-links">
                    {tvNavigation.map((item, index) => {
                        const isActive = isCurrentNav(item, pathname);
                        const isFocused = isNavFocused && focusedTabIndex === index;

                        return (
                            <Link
                                key={item.name}
                                href={item.href}
                                data-tv-tab
                                className={cn("tv-nav-link", isActive && "active", isFocused && "focused")}
                                onFocus={() => {
                                    setIsNavFocused(true);
                                    setFocusedTabIndex(index);
                                }}
                            >
                                {item.name}
                            </Link>
                        );
                    })}
                </nav>

                <div className="flex-1" />

                <button
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="tv-sync-btn"
                    title="sync library"
                >
                    <RefreshCw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                </button>
            </header>

            {/* Now Playing Bar - below nav */}
            {hasMedia && (
                <div className="tv-now-playing-bar">
                    {coverUrl && (
                        <CachedImage src={coverUrl} alt={title} width={48} height={48} className="tv-np-cover" />
                    )}
                    <div className="tv-np-info">
                        <div className="tv-np-title">{title}</div>
                        <div className="tv-np-artist">{artist}</div>
                    </div>

                    <div className="tv-np-time">
                        {formatTime(clampedCurrentTime)} / {formatMediaDuration(playbackType, duration, clampedCurrentTime)}
                    </div>

                    <button
                        onClick={toggleShuffle}
                        className={cn("tv-np-ctrl", isShuffle && "active")}
                        title="shuffle"
                    >
                        <Shuffle className="w-4 h-4" />
                    </button>

                    <button onClick={previous} className="tv-np-ctrl" title="previous">
                        <SkipBack className="w-4 h-4" />
                    </button>

                    <button onClick={() => isPlaying ? pause() : resumeWithGesture()} className="tv-np-btn">
                        {isPlaying ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="4" width="4" height="16" />
                                <rect x="14" y="4" width="4" height="16" />
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5,3 19,12 5,21" />
                            </svg>
                        )}
                    </button>

                    <button onClick={next} className="tv-np-ctrl" title="next">
                        <SkipForward className="w-4 h-4" />
                    </button>

                    <button
                        onClick={toggleRepeat}
                        className={cn("tv-np-ctrl", repeatMode !== "off" && "active")}
                        title={repeatMode === "one" ? "repeat one" : repeatMode === "all" ? "repeat all" : "repeat off"}
                    >
                        <Repeat className="w-4 h-4" />
                        {repeatMode === "one" && <span className="tv-np-repeat-one">1</span>}
                    </button>
                </div>
            )}

            <main id="main-content" tabIndex={-1} ref={contentRef} className="tv-content">
                {children}
            </main>
        </>
    );
}
