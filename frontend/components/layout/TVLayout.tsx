"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { cn } from "@/utils/cn";
import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
import { DPAD_KEYS } from "@/lib/tv-utils";
import { useTVNavigation } from "@/hooks/useTVNavigation";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { RefreshCw, SkipBack, SkipForward, Shuffle, Repeat } from "lucide-react";

const tvNavigation = [
    { name: "Home", href: "/" },
    { name: "Search", href: "/search" },
    { name: "Library", href: "/library" },
    { name: "Audiobooks", href: "/audiobooks" },
    { name: "Podcasts", href: "/podcasts" },
    { name: "Discovery", href: "/discover" },
    { name: "Playlists", href: "/playlists" },
];

export function TVLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    // Start with nav focused and first tab selected for immediate D-pad usability
    const [focusedTabIndex, setFocusedTabIndex] = useState(0);
    const [isNavFocused, setIsNavFocused] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);
    const navRef = useRef<HTMLDivElement>(null);

    // TV content navigation hook
    const {
        containerRef: contentRef,
        focusFirstCard,
        handleKeyDown: handleContentKeyDown,
        isContentFocused,
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
        resume,
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

    // Add tv-mode class to body on mount
    useEffect(() => {
        document.documentElement.classList.add('tv-mode');
        document.body.classList.add('tv-mode');
        return () => {
            document.documentElement.classList.remove('tv-mode');
            document.body.classList.remove('tv-mode');
        };
    }, []);

    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    let title = "";
    let artist = "";
    let coverUrl: string | null = null;

    if (playbackType === "track" && currentTrack) {
        title = currentTrack.title;
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

    // CRITICAL: Clamp currentTime to prevent display of invalid times
    const clampedCurrentTime = clampTime(currentTime, duration);

    // Sync library
    const handleSync = async () => {
        setIsSyncing(true);
        try {
            await api.scanLibrary();
        } catch (error) {
            console.error("Sync failed:", error);
        } finally {
            setIsSyncing(false);
        }
    };

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        // Media keys work globally regardless of focus state
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
                    isPlaying ? pause() : resume();
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
                    seek(Math.min(currentTime + 10, duration));
                    return;
                case DPAD_KEYS.REWIND:
                case "MediaRewind":
                    e.preventDefault();
                    seek(Math.max(currentTime - 10, 0));
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
                // Use the navigation hook to focus first card
                focusFirstCard();
            } else if (e.key === DPAD_KEYS.CENTER) {
                e.preventDefault();
                router.push(tvNavigation[focusedTabIndex].href);
            }
        } else {
            // Delegate to content navigation hook
            handleContentKeyDown(e);
        }
    }, [isNavFocused, focusedTabIndex, router, hasMedia, isPlaying, pause, resume, next, previous, seek, currentTime, duration, focusFirstCard, handleContentKeyDown]);

    useEffect(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown]);

    // Focus correct nav tab when isNavFocused changes or focusedTabIndex changes
    useEffect(() => {
        if (isNavFocused && navRef.current) {
            const tabs = navRef.current.querySelectorAll<HTMLAnchorElement>('[data-tv-tab]');
            tabs[focusedTabIndex]?.focus();
        }
    }, [focusedTabIndex, isNavFocused]);

    // On initial mount and pathname change, set the correct focused tab
    useEffect(() => {
        const currentIndex = tvNavigation.findIndex(n =>
            n.href === pathname || (n.href !== "/" && pathname.startsWith(n.href))
        );
        if (currentIndex >= 0) {
            setFocusedTabIndex(currentIndex);
        }
    }, [pathname]);

    return (
        <>
            {/* Nav */}
            <header className="tv-nav">
                <Link href="/" className="tv-logo">
                    <Image src="/assets/images/LIDIFY.webp" alt="Lidify" width={24} height={24} />
                    <span>Lidify</span>
                </Link>

                <nav ref={navRef} className="tv-nav-links">
                    {tvNavigation.map((item, index) => {
                        const isActive = pathname === item.href || 
                            (item.href !== "/" && pathname.startsWith(item.href));
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

                {/* Spacer */}
                <div className="flex-1" />

                {/* Sync button */}
                <button 
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="tv-sync-btn"
                    title="Sync Library"
                >
                    <RefreshCw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                </button>
            </header>

            {/* Now Playing Bar - below nav */}
            {hasMedia && (
                <div className="tv-now-playing-bar">
                    {coverUrl && (
                        <Image src={coverUrl} alt={title} width={48} height={48} className="tv-np-cover" />
                    )}
                    <div className="tv-np-info">
                        <div className="tv-np-title">{title}</div>
                        <div className="tv-np-artist">{artist}</div>
                    </div>
                    
                    {/* Time counter */}
                    <div className="tv-np-time">
                        {formatTime(clampedCurrentTime)} / {
                            playbackType === "podcast" || playbackType === "audiobook"
                                ? formatTimeRemaining(Math.max(0, duration - clampedCurrentTime))
                                : formatTime(duration)
                        }
                    </div>

                    {/* Shuffle */}
                    <button
                        onClick={toggleShuffle}
                        className={cn("tv-np-ctrl", isShuffle && "active")}
                        title="Shuffle"
                    >
                        <Shuffle className="w-4 h-4" />
                    </button>

                    {/* Previous */}
                    <button onClick={previous} className="tv-np-ctrl" title="Previous">
                        <SkipBack className="w-4 h-4" />
                    </button>

                    {/* Play/Pause */}
                    <button onClick={() => isPlaying ? pause() : resume()} className="tv-np-btn">
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

                    {/* Next */}
                    <button onClick={next} className="tv-np-ctrl" title="Next">
                        <SkipForward className="w-4 h-4" />
                    </button>

                    {/* Repeat */}
                    <button
                        onClick={toggleRepeat}
                        className={cn("tv-np-ctrl", repeatMode !== "off" && "active")}
                        title={repeatMode === "one" ? "Repeat One" : repeatMode === "all" ? "Repeat All" : "Repeat Off"}
                    >
                        <Repeat className="w-4 h-4" />
                        {repeatMode === "one" && <span className="tv-np-repeat-one">1</span>}
                    </button>
                </div>
            )}

            {/* Content */}
            <main id="main-content" tabIndex={-1} ref={contentRef} className="tv-content">
                {children}
            </main>
        </>
    );
}
