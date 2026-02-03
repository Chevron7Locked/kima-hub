"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { useFeatures } from "@/lib/features-context";
import { useAudio } from "@/lib/audio-context";
import { useAudioState } from "@/lib/audio-state-context";
import Image from "next/image";
import Link from "next/link";
import {
    Loader2,
    RefreshCw,
    AlertCircle,
    Disc3,
    Play,
    Search,
    Shuffle,
    X,
    AudioWaveform,
} from "lucide-react";

// ============================================
// TYPES
// ============================================

interface TrackFeatures {
    energy: number;
    valence: number;
    arousal: number;
    danceability: number;
    instrumentalness: number;
    acousticness: number;
    speechiness: number;
    bpm: number | null;
    key: string | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
}

interface TrackData {
    id: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    coverUrl: string | null;
    duration: number;
    features: TrackFeatures;
    distance?: number;
    similarity?: number;
    lastfmTags?: string[];
    essentiaGenres?: string[];
}

interface LibraryTrack {
    id: string;
    title: string;
    duration: number;
    album: {
        id: string;
        title: string;
        coverUrl?: string | null;
        coverArt?: string | null;
        artist: { id: string; name: string };
    };
}

interface VibePreset {
    id: string;
    name: string;
    query: string;
}

type ViewMode = "comparison" | "search-results";

function trackDataToTrack(track: TrackData) {
    return {
        id: track.id,
        title: track.title,
        artist: { name: track.artist, id: track.artistId },
        album: { title: track.album, id: track.albumId, coverArt: track.coverUrl || undefined },
        duration: track.duration,
        audioFeatures: {
            energy: track.features.energy,
            valence: track.features.valence,
            arousal: track.features.arousal,
            danceability: track.features.danceability,
            instrumentalness: track.features.instrumentalness,
            acousticness: track.features.acousticness,
            bpm: track.features.bpm,
            keyScale: track.features.key,
        },
    };
}

const VIBE_PRESETS: VibePreset[] = [
    { id: "chill", name: "Chill", query: "relaxing calm ambient peaceful mellow" },
    { id: "energy", name: "High Energy", query: "energetic powerful intense driving upbeat" },
    { id: "dark", name: "Dark", query: "dark atmospheric moody brooding cinematic" },
    { id: "happy", name: "Feel Good", query: "happy upbeat cheerful bright positive" },
    { id: "melancholic", name: "Melancholic", query: "sad melancholic emotional nostalgic bittersweet" },
    { id: "electronic", name: "Electronic", query: "electronic synth digital pulsing techno" },
];

const FEATURE_CONFIG = [
    { key: "energy", label: "Energy" },
    { key: "valence", label: "Positivity" },
    { key: "danceability", label: "Groove" },
    { key: "acousticness", label: "Acoustic" },
    { key: "instrumentalness", label: "Instrumental" },
    { key: "arousal", label: "Intensity" },
];

const MOOD_CONFIG = [
    { key: "moodHappy", label: "Happy" },
    { key: "moodSad", label: "Sad" },
    { key: "moodRelaxed", label: "Relaxed" },
    { key: "moodAggressive", label: "Intense" },
    { key: "moodParty", label: "Party" },
    { key: "moodElectronic", label: "Electronic" },
];

function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance / 2);
}

// ============================================
// COVER IMAGE
// ============================================
function CoverImage({
    coverUrl,
    title,
    size = 160,
    className,
    priority = false,
}: {
    coverUrl: string | null;
    title: string;
    size?: number;
    className?: string;
    priority?: boolean;
}) {
    const [hasError, setHasError] = useState(false);

    const imgSrc = useMemo(() => {
        if (coverUrl) return api.getCoverArtUrl(coverUrl);
        return null;
    }, [coverUrl]);

    if (!imgSrc || hasError) {
        return (
            <div
                className={cn("bg-[#282828] flex items-center justify-center", className)}
                style={{ width: size, height: size }}
            >
                <Disc3 className="text-[#525252]" style={{ width: size * 0.3, height: size * 0.3 }} />
            </div>
        );
    }

    return (
        <div className={cn("relative overflow-hidden bg-[#1a1a1a]", className)} style={{ width: size, height: size }}>
            <Image
                src={imgSrc}
                alt={title}
                fill
                sizes={`${size}px`}
                className="object-cover"
                priority={priority}
                unoptimized
                onError={() => setHasError(true)}
            />
        </div>
    );
}

// ============================================
// SIMILARITY BADGE - the signature element
// ============================================
function SimilarityBadge({ similarity, size = "md" }: { similarity: number; size?: "sm" | "md" | "lg" }) {
    const percent = Math.round(similarity * 100);
    const sizeClasses = {
        sm: "w-10 h-10 text-xs",
        md: "w-14 h-14 text-sm",
        lg: "w-20 h-20 text-lg",
    };

    return (
        <div className={cn(
            "relative flex items-center justify-center rounded-full font-semibold",
            sizeClasses[size],
            percent >= 80 ? "text-[#22c55e]" : percent >= 60 ? "text-[#a855f7]" : "text-[#737373]"
        )}>
            {/* Outer ring */}
            <svg className="absolute inset-0 w-full h-full -rotate-90">
                <circle
                    cx="50%"
                    cy="50%"
                    r="45%"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeOpacity="0.15"
                />
                <circle
                    cx="50%"
                    cy="50%"
                    r="45%"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={`${similarity * 283} 283`}
                    className="transition-all duration-500"
                />
            </svg>
            <span className="tabular-nums">{percent}%</span>
        </div>
    );
}

// ============================================
// FEATURE COMPARISON - side by side bars
// ============================================
function FeatureComparison({
    source,
    match,
}: {
    source: TrackData;
    match: TrackData;
}) {
    return (
        <div className="space-y-3">
            {FEATURE_CONFIG.map(({ key, label }) => {
                const sVal = (source.features[key as keyof TrackFeatures] as number) || 0;
                const mVal = (match.features[key as keyof TrackFeatures] as number) || 0;
                const matchPct = Math.round((1 - Math.abs(sVal - mVal)) * 100);

                return (
                    <div key={key} className="group">
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-[#737373] uppercase tracking-wide">{label}</span>
                            <span className={cn(
                                "text-xs tabular-nums transition-colors",
                                matchPct >= 80 ? "text-[#22c55e]" : "text-[#525252] group-hover:text-[#737373]"
                            )}>
                                {matchPct}%
                            </span>
                        </div>
                        <div className="relative h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                            {/* Source bar */}
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${sVal * 100}%` }}
                                transition={{ duration: 0.5, ease: "easeOut" }}
                                className="absolute h-full bg-[#eab308]/50 rounded-full"
                            />
                            {/* Match indicator */}
                            <motion.div
                                initial={{ left: 0 }}
                                animate={{ left: `calc(${mVal * 100}% - 4px)` }}
                                transition={{ duration: 0.5, ease: "easeOut" }}
                                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-[#a855f7] shadow-[0_0_8px_rgba(168,85,247,0.5)]"
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ============================================
// MOOD GRID - compact mood comparison
// ============================================
function MoodGrid({ source, match }: { source: TrackData; match: TrackData }) {
    const validMoods = MOOD_CONFIG.filter(({ key }) => {
        const sVal = source.features[key as keyof TrackFeatures];
        const mVal = match.features[key as keyof TrackFeatures];
        return sVal !== null || mVal !== null;
    });

    if (validMoods.length === 0) return null;

    return (
        <div className="grid grid-cols-3 gap-2">
            {validMoods.map(({ key, label }) => {
                const sVal = (source.features[key as keyof TrackFeatures] as number) || 0;
                const mVal = (match.features[key as keyof TrackFeatures] as number) || 0;
                const matchPct = Math.round((1 - Math.abs(sVal - mVal)) * 100);

                return (
                    <div
                        key={key}
                        className={cn(
                            "px-2.5 py-2 rounded-md text-center transition-colors",
                            matchPct >= 80 ? "bg-[#22c55e]/10" : "bg-[#1a1a1a]"
                        )}
                    >
                        <div className="text-xs text-[#737373] mb-0.5">{label}</div>
                        <div className={cn(
                            "text-sm font-medium tabular-nums",
                            matchPct >= 80 ? "text-[#22c55e]" : "text-[#a3a3a3]"
                        )}>
                            {matchPct}%
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ============================================
// TAG PILLS - shared tags highlighted
// ============================================
function TagPills({ source, match }: { source: TrackData; match: TrackData }) {
    const sourceTags = source.lastfmTags || [];
    const matchTags = match.lastfmTags || [];
    const allTags = [...new Set([...sourceTags, ...matchTags])];
    const sharedTags = sourceTags.filter(t => matchTags.includes(t));

    if (allTags.length === 0) return null;

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-[#737373] uppercase tracking-wide">Tags</span>
                {sharedTags.length > 0 && (
                    <span className="text-xs text-[#22c55e]">{sharedTags.length} shared</span>
                )}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {allTags.slice(0, 10).map((tag) => {
                    const isShared = sharedTags.includes(tag);
                    return (
                        <span
                            key={tag}
                            className={cn(
                                "px-2 py-0.5 text-xs rounded-full transition-colors",
                                isShared
                                    ? "bg-[#22c55e]/15 text-[#22c55e] ring-1 ring-[#22c55e]/30"
                                    : "bg-[#1a1a1a] text-[#737373]"
                            )}
                        >
                            {tag}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

// ============================================
// COMPARISON PANEL - the detailed view
// ============================================
function ComparisonPanel({
    source,
    match,
    onClose,
}: {
    source: TrackData;
    match: TrackData;
    onClose: () => void;
}) {
    const similarity = match.similarity ?? 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-[#0f0f0f] border border-[#1c1c1c] rounded-xl overflow-hidden"
        >
            {/* Header with gradient accent */}
            <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-r from-[#eab308]/10 via-transparent to-[#a855f7]/10" />
                <div className="relative flex items-center justify-between px-4 py-3">
                    <span className="text-xs font-medium text-[#737373] uppercase tracking-wider">Vibe Match</span>
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-white/5 rounded transition-colors"
                    >
                        <X className="w-4 h-4 text-[#737373]" />
                    </button>
                </div>
            </div>

            {/* Central similarity display */}
            <div className="flex items-center justify-center py-6 border-b border-[#1c1c1c]">
                <div className="flex items-center gap-6">
                    <CoverImage
                        coverUrl={source.coverUrl}
                        title={source.title}
                        size={56}
                        className="rounded-md ring-2 ring-[#eab308]/30"
                    />
                    <SimilarityBadge similarity={similarity} size="lg" />
                    <CoverImage
                        coverUrl={match.coverUrl}
                        title={match.title}
                        size={56}
                        className="rounded-md ring-2 ring-[#a855f7]/30"
                    />
                </div>
            </div>

            {/* Track details */}
            <div className="grid grid-cols-2 divide-x divide-[#1c1c1c] border-b border-[#1c1c1c]">
                <div className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#eab308]" />
                        <span className="text-[10px] text-[#737373] uppercase tracking-wider">Source</span>
                    </div>
                    <p className="font-medium text-white text-sm truncate">{source.title}</p>
                    <p className="text-xs text-[#a3a3a3] truncate">{source.artist}</p>
                    <div className="flex gap-1.5 mt-2">
                        {source.features.bpm && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] rounded text-[#525252]">
                                {Math.round(source.features.bpm)} BPM
                            </span>
                        )}
                        {source.features.key && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] rounded text-[#525252]">
                                {source.features.key}
                            </span>
                        )}
                    </div>
                </div>
                <div className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#a855f7]" />
                        <span className="text-[10px] text-[#737373] uppercase tracking-wider">Match</span>
                    </div>
                    <p className="font-medium text-white text-sm truncate">{match.title}</p>
                    <p className="text-xs text-[#a3a3a3] truncate">{match.artist}</p>
                    <div className="flex gap-1.5 mt-2">
                        {match.features.bpm && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] rounded text-[#525252]">
                                {Math.round(match.features.bpm)} BPM
                            </span>
                        )}
                        {match.features.key && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a1a] rounded text-[#525252]">
                                {match.features.key}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Audio features */}
            <div className="p-4 border-b border-[#1c1c1c]">
                <h4 className="text-[10px] font-medium text-[#737373] uppercase tracking-wider mb-4">Audio DNA</h4>
                <FeatureComparison source={source} match={match} />
            </div>

            {/* Mood profile */}
            <div className="p-4 border-b border-[#1c1c1c]">
                <h4 className="text-[10px] font-medium text-[#737373] uppercase tracking-wider mb-3">Mood Profile</h4>
                <MoodGrid source={source} match={match} />
            </div>

            {/* Tags */}
            <div className="p-4">
                <TagPills source={source} match={match} />
            </div>
        </motion.div>
    );
}

// ============================================
// TRACK ROW
// ============================================
function TrackRow({
    track,
    index,
    isSelected,
    onClick,
    onDoubleClick,
    onPlay,
}: {
    track: TrackData;
    index: number;
    isSelected?: boolean;
    onClick?: () => void;
    onDoubleClick?: () => void;
    onPlay: () => void;
}) {
    const similarity = track.similarity ?? 0;

    return (
        <div
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            className={cn(
                "group grid grid-cols-[auto_1fr_auto_auto] gap-4 px-4 py-2.5 rounded-lg cursor-pointer transition-all items-center",
                isSelected
                    ? "bg-gradient-to-r from-[#eab308]/5 to-[#a855f7]/5 ring-1 ring-[#a855f7]/20"
                    : "hover:bg-[#141414]"
            )}
        >
            {/* Index / Play */}
            <div className="w-8 text-center">
                <span className="text-sm text-[#525252] tabular-nums group-hover:hidden">
                    {index + 1}
                </span>
                <button
                    onClick={(e) => { e.stopPropagation(); onPlay(); }}
                    className="hidden group-hover:block"
                >
                    <Play className="w-4 h-4 text-white fill-white mx-auto" />
                </button>
            </div>

            {/* Track info */}
            <div className="flex items-center gap-3 min-w-0">
                <div className="relative">
                    <CoverImage
                        coverUrl={track.coverUrl}
                        title={track.title}
                        size={44}
                        className="rounded flex-shrink-0"
                    />
                    {isSelected && (
                        <div className="absolute inset-0 rounded ring-2 ring-[#a855f7]/50" />
                    )}
                </div>
                <div className="min-w-0">
                    <p className={cn(
                        "text-sm font-medium truncate transition-colors",
                        isSelected ? "text-[#a855f7]" : "text-white"
                    )}>
                        {track.title}
                    </p>
                    <Link
                        href={`/artist/${track.artistId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs text-[#737373] hover:text-[#a3a3a3] hover:underline truncate block transition-colors"
                    >
                        {track.artist}
                    </Link>
                </div>
            </div>

            {/* Album */}
            <Link
                href={`/album/${track.albumId}`}
                onClick={(e) => e.stopPropagation()}
                className="text-sm text-[#525252] hover:text-[#737373] hover:underline truncate hidden md:block max-w-[180px] transition-colors"
            >
                {track.album}
            </Link>

            {/* Similarity */}
            <SimilarityBadge similarity={similarity} size="sm" />
        </div>
    );
}

// ============================================
// MAIN PAGE
// ============================================
export default function VibePage() {
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();

    if (featuresLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <Loader2 className="w-6 h-6 animate-spin text-[#525252]" />
            </div>
        );
    }

    if (!vibeEmbeddings) {
        return (
            <div className="p-6">
                <h1 className="text-xl font-semibold text-white mb-4">Vibe</h1>
                <div className="bg-[#0f0f0f] border border-[#1c1c1c] rounded-lg p-6">
                    <p className="text-[#a3a3a3] mb-2">Feature not available</p>
                    <p className="text-sm text-[#737373]">
                        Vibe similarity requires the CLAP analyzer service.
                    </p>
                </div>
            </div>
        );
    }

    return <VibePageContent />;
}

function VibePageContent() {
    const { playTracks } = useAudio();
    const { setVibeMode, setVibeSourceFeatures, setVibeQueueIds, currentTrack, vibeMode } = useAudioState();
    const [libraryTracks, setLibraryTracks] = useState<LibraryTrack[]>([]);
    const [sourceTrack, setSourceTrack] = useState<TrackData | null>(null);
    const [similarTracks, setSimilarTracks] = useState<TrackData[]>([]);
    const [selectedMatch, setSelectedMatch] = useState<TrackData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [vibeStatus, setVibeStatus] = useState<{ totalTracks: number; embeddedTracks: number } | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>("comparison");
    const [searchQuery, setSearchQuery] = useState<string | null>(null);
    const [inputValue, setInputValue] = useState("");
    const [recentSearches, setRecentSearches] = useState<string[]>([]);

    // Capture the track that was playing when page loaded (don't react to changes)
    const initialTrackRef = useRef(currentTrack);
    const hasLoadedRef = useRef(false);

    useEffect(() => {
        const saved = localStorage.getItem("vibe-recent-searches");
        if (saved) {
            try {
                setRecentSearches(JSON.parse(saved));
            } catch {
                // ignore
            }
        }
    }, []);

    const playTrack = useCallback(async (track: TrackData) => {
        await playTracks([trackDataToTrack(track)]);
    }, [playTracks]);

    const playAllSimilar = useCallback(async () => {
        if (similarTracks.length === 0) return;
        const vibeSource = sourceTrack || similarTracks[0];
        if (vibeSource) {
            setVibeSourceFeatures({
                energy: vibeSource.features.energy,
                valence: vibeSource.features.valence,
                danceability: vibeSource.features.danceability,
                arousal: vibeSource.features.arousal,
            });
            const trackIds = similarTracks.map(t => t.id);
            setVibeQueueIds(trackIds);
            setVibeMode(true);
            const tracks = similarTracks.map(trackDataToTrack);
            await playTracks(tracks, 0, true);
        }
    }, [similarTracks, sourceTrack, playTracks, setVibeMode, setVibeSourceFeatures, setVibeQueueIds]);

    const fetchTrackWithFeatures = useCallback(async (
        trackInfo: {
            id: string;
            title: string;
            duration: number;
            album: { id: string; title: string; coverUrl?: string | null; coverArt?: string | null };
            artist: { id: string; name: string };
            distance?: number;
            similarity?: number;
        }
    ): Promise<TrackData> => {
        const incomingCover = trackInfo.album.coverUrl || trackInfo.album.coverArt || null;

        try {
            const analysis = await api.getTrackAnalysis(trackInfo.id);
            return {
                id: trackInfo.id,
                title: trackInfo.title,
                artist: trackInfo.artist.name,
                artistId: trackInfo.artist.id,
                album: trackInfo.album.title,
                albumId: trackInfo.album.id,
                coverUrl: incomingCover,
                duration: trackInfo.duration,
                distance: trackInfo.distance,
                similarity: trackInfo.similarity ?? (trackInfo.distance !== undefined ? distanceToSimilarity(trackInfo.distance) : undefined),
                features: {
                    energy: analysis.energy ?? 0.5,
                    valence: analysis.valence ?? 0.5,
                    arousal: analysis.arousal ?? 0.5,
                    danceability: analysis.danceability ?? 0.5,
                    instrumentalness: analysis.instrumentalness ?? 0.5,
                    acousticness: analysis.acousticness ?? 0.5,
                    speechiness: analysis.speechiness ?? 0.1,
                    bpm: analysis.bpm,
                    key: analysis.key ? `${analysis.key}${analysis.keyScale ? ` ${analysis.keyScale}` : ""}` : null,
                    moodHappy: analysis.moodHappy ?? null,
                    moodSad: analysis.moodSad ?? null,
                    moodRelaxed: analysis.moodRelaxed ?? null,
                    moodAggressive: analysis.moodAggressive ?? null,
                    moodParty: analysis.moodParty ?? null,
                    moodAcoustic: analysis.moodAcoustic ?? null,
                    moodElectronic: analysis.moodElectronic ?? null,
                },
                lastfmTags: analysis.lastfmTags || [],
                essentiaGenres: analysis.essentiaGenres || [],
            };
        } catch {
            return {
                id: trackInfo.id,
                title: trackInfo.title,
                artist: trackInfo.artist.name,
                artistId: trackInfo.artist.id,
                album: trackInfo.album.title,
                albumId: trackInfo.album.id,
                coverUrl: incomingCover,
                duration: trackInfo.duration,
                distance: trackInfo.distance,
                similarity: trackInfo.similarity ?? (trackInfo.distance !== undefined ? distanceToSimilarity(trackInfo.distance) : undefined),
                features: {
                    energy: 0.5, valence: 0.5, arousal: 0.5, danceability: 0.5,
                    instrumentalness: 0.5, acousticness: 0.5, speechiness: 0.1,
                    bpm: null, key: null,
                    moodHappy: null, moodSad: null, moodRelaxed: null,
                    moodAggressive: null, moodParty: null, moodAcoustic: null, moodElectronic: null,
                },
                lastfmTags: [],
                essentiaGenres: [],
            };
        }
    }, []);

    const loadSimilarTracks = useCallback(async (track: LibraryTrack) => {
        setIsLoading(true);
        setError(null);
        setViewMode("comparison");
        setSearchQuery(null);
        setSelectedMatch(null);

        try {
            const result = await api.getVibeSimilarTracks(track.id, 20);

            if (result.tracks.length === 0) {
                setError("No similar tracks found. This track may not have been analyzed yet.");
                setIsLoading(false);
                return;
            }

            const sourceData = await fetchTrackWithFeatures({
                id: track.id,
                title: track.title,
                duration: track.duration,
                album: {
                    id: track.album.id,
                    title: track.album.title,
                    coverUrl: track.album.coverUrl,
                    coverArt: track.album.coverArt,
                },
                artist: track.album.artist,
            });
            setSourceTrack(sourceData);

            const similarWithFeatures = await Promise.all(
                result.tracks.map(t => fetchTrackWithFeatures(t))
            );
            setSimilarTracks(similarWithFeatures);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load similar tracks");
        } finally {
            setIsLoading(false);
        }
    }, [fetchTrackWithFeatures]);

    const handleVibeSearch = useCallback(async (query: string) => {
        setRecentSearches(prev => {
            const updated = [query, ...prev.filter(s => s.toLowerCase() !== query.toLowerCase())].slice(0, 5);
            localStorage.setItem("vibe-recent-searches", JSON.stringify(updated));
            return updated;
        });

        setIsSearching(true);
        setError(null);
        setViewMode("search-results");
        setSearchQuery(query);
        setSourceTrack(null);
        setSelectedMatch(null);

        try {
            const result = await api.vibeSearch(query, 20);

            if (result.tracks.length === 0) {
                const threshold = result.minSimilarity ? Math.round(result.minSimilarity * 100) : 60;
                setError(`No tracks found matching "${query}" above ${threshold}% similarity. Try a different search term.`);
                setSimilarTracks([]);
                setIsSearching(false);
                return;
            }

            const tracksWithFeatures = await Promise.all(
                result.tracks.map(t => fetchTrackWithFeatures(t))
            );
            setSimilarTracks(tracksWithFeatures);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Search failed");
        } finally {
            setIsSearching(false);
        }
    }, [fetchTrackWithFeatures]);

    const handleSelectSearchResult = useCallback(async (track: TrackData) => {
        setIsLoading(true);
        setError(null);
        setViewMode("comparison");

        try {
            const result = await api.getVibeSimilarTracks(track.id, 20);

            if (result.tracks.length === 0) {
                setError("No similar tracks found for this track.");
                setIsLoading(false);
                return;
            }

            setSourceTrack(track);

            const similarWithFeatures = await Promise.all(
                result.tracks.map(t => fetchTrackWithFeatures(t))
            );
            setSimilarTracks(similarWithFeatures);
            setSelectedMatch(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load similar tracks");
        } finally {
            setIsLoading(false);
        }
    }, [fetchTrackWithFeatures]);

    const handleRandomTrack = useCallback(() => {
        if (libraryTracks.length === 0) return;
        const randomIndex = Math.floor(Math.random() * libraryTracks.length);
        loadSimilarTracks(libraryTracks[randomIndex]);
    }, [libraryTracks, loadSimilarTracks]);

    const loadInitialData = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const status = await api.getVibeStatus();
            setVibeStatus(status);

            if (status.embeddedTracks === 0) {
                setError("No tracks analyzed yet. Run vibe analysis first.");
                setIsLoading(false);
                return;
            }

            const { tracks } = await api.getTracks({ limit: 200 });
            setLibraryTracks(tracks);

            // Priority 1: Use the track that was playing when page loaded
            const playingTrack = initialTrackRef.current;
            if (playingTrack?.id) {
                const currentAsLibraryTrack: LibraryTrack = {
                    id: playingTrack.id,
                    title: playingTrack.title,
                    duration: playingTrack.duration,
                    album: {
                        id: playingTrack.album.id || "",
                        title: playingTrack.album.title,
                        coverUrl: playingTrack.album.coverArt || null,
                        artist: {
                            id: playingTrack.artist.id || "",
                            name: playingTrack.artist.name,
                        },
                    },
                };

                try {
                    const result = await api.getVibeSimilarTracks(playingTrack.id, 20);
                    if (result.tracks.length > 0) {
                        await loadSimilarTracks(currentAsLibraryTrack);
                        return;
                    }
                } catch {
                    // Current track doesn't have embeddings, fall through to find another
                }
            }

            // Priority 2: Find first track with embeddings
            for (const track of tracks) {
                try {
                    const result = await api.getVibeSimilarTracks(track.id, 20);
                    if (result.tracks.length > 0) {
                        await loadSimilarTracks(track);
                        return;
                    }
                } catch {
                    continue;
                }
            }

            setError("No tracks with embeddings found.");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load");
        } finally {
            setIsLoading(false);
        }
    }, [loadSimilarTracks]);

    // Load initial data only once on mount
    useEffect(() => {
        if (hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        loadInitialData();
    }, [loadInitialData]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputValue.trim()) {
            handleVibeSearch(inputValue.trim());
        }
    };

    // Use the currently playing track as source
    const handleUseCurrentTrack = useCallback(async () => {
        if (!currentTrack?.id) return;

        const currentAsLibraryTrack: LibraryTrack = {
            id: currentTrack.id,
            title: currentTrack.title,
            duration: currentTrack.duration,
            album: {
                id: currentTrack.album.id || "",
                title: currentTrack.album.title,
                coverUrl: currentTrack.album.coverArt || null,
                artist: {
                    id: currentTrack.artist.id || "",
                    name: currentTrack.artist.name,
                },
            },
        };

        await loadSimilarTracks(currentAsLibraryTrack);
    }, [currentTrack, loadSimilarTracks]);

    return (
        <div className="min-h-screen relative">
            {/* Subtle ambient gradient - responsive to selection */}
            <div className="fixed inset-0 pointer-events-none overflow-hidden">
                <motion.div
                    animate={{
                        opacity: selectedMatch ? 0.6 : 0.3,
                    }}
                    transition={{ duration: 1 }}
                    className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full bg-[#a855f7]/5 blur-[100px]"
                />
                <motion.div
                    animate={{
                        opacity: sourceTrack ? 0.5 : 0.2,
                    }}
                    transition={{ duration: 1 }}
                    className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full bg-[#eab308]/5 blur-[100px]"
                />
            </div>

            <div className="relative px-6 py-6">
                {/* Header */}
                <div className="mb-8">
                    <div className="flex items-center justify-between mb-1">
                        <h1 className="text-2xl font-semibold text-white tracking-tight">Vibe</h1>
                        <div className="flex items-center gap-1">
                            {/* Use Current Track button - only show when something is playing */}
                            {currentTrack && (
                                <button
                                    onClick={handleUseCurrentTrack}
                                    disabled={isLoading}
                                    className={cn(
                                        "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-50",
                                        sourceTrack?.id === currentTrack.id
                                            ? "text-[#eab308] bg-[#eab308]/10"
                                            : "text-[#737373] hover:text-white hover:bg-white/5"
                                    )}
                                    title={`Find tracks similar to "${currentTrack.title}"`}
                                >
                                    <AudioWaveform className="w-4 h-4" />
                                    <span className="hidden sm:inline">Now Playing</span>
                                </button>
                            )}
                            <button
                                onClick={handleRandomTrack}
                                disabled={isLoading || libraryTracks.length === 0}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm text-[#737373] hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
                            >
                                <Shuffle className="w-4 h-4" />
                                <span className="hidden sm:inline">Random</span>
                            </button>
                            <button
                                onClick={loadInitialData}
                                disabled={isLoading}
                                className="p-1.5 text-[#737373] hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
                            >
                                <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
                            </button>
                        </div>
                    </div>
                    {vibeStatus && (
                        <p className="text-sm text-[#525252]">
                            {vibeStatus.embeddedTracks.toLocaleString()} tracks with audio fingerprints
                        </p>
                    )}

                    {/* Search */}
                    <form onSubmit={handleSearch} className="relative max-w-lg mt-5">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#525252]" />
                        <input
                            type="text"
                            placeholder="Search by vibe... try 'dark atmospheric' or 'upbeat dance'"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 bg-[#0f0f0f] border border-[#1c1c1c] focus:border-[#333] rounded-lg text-sm text-white placeholder-[#525252] focus:outline-none transition-colors"
                        />
                        {isSearching && (
                            <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#525252] animate-spin" />
                        )}
                    </form>

                    {/* Presets & Recent */}
                    <div className="flex flex-wrap items-center gap-2 mt-4">
                        {VIBE_PRESETS.map((preset) => (
                            <button
                                key={preset.id}
                                onClick={() => handleVibeSearch(preset.query)}
                                className="px-3 py-1.5 text-xs text-[#737373] bg-[#0f0f0f] border border-[#1c1c1c] hover:border-[#333] hover:text-white rounded-full transition-all hover:scale-[1.02]"
                            >
                                {preset.name}
                            </button>
                        ))}
                        {recentSearches.length > 0 && (
                            <>
                                <div className="w-px h-5 bg-[#1c1c1c] mx-1" />
                                {recentSearches.slice(0, 3).map((query) => (
                                    <button
                                        key={query}
                                        onClick={() => handleVibeSearch(query)}
                                        className="text-xs text-[#525252] hover:text-[#737373] transition-colors"
                                    >
                                        {query}
                                    </button>
                                ))}
                            </>
                        )}
                    </div>
                </div>

                {/* Error */}
                {error && (
                    <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-[#ef4444]/5 border border-[#ef4444]/20 rounded-lg">
                        <AlertCircle className="w-4 h-4 text-[#ef4444] flex-shrink-0" />
                        <span className="text-sm text-[#ef4444]">{error}</span>
                    </div>
                )}

                {/* Loading */}
                {(isLoading || isSearching) && !error && (
                    <div className="flex items-center justify-center py-24">
                        <div className="relative">
                            <div className="w-12 h-12 rounded-full border-2 border-[#1c1c1c] border-t-[#a855f7] animate-spin" />
                        </div>
                    </div>
                )}

                {/* Search Results */}
                {!isLoading && !isSearching && viewMode === "search-results" && similarTracks.length > 0 && (
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h2 className="text-lg font-medium text-white">
                                    &ldquo;{searchQuery}&rdquo;
                                </h2>
                                <p className="text-sm text-[#525252]">
                                    {similarTracks.length} tracks found - click to play
                                </p>
                            </div>
                            <button
                                onClick={playAllSimilar}
                                className="flex items-center gap-2 px-5 py-2.5 bg-[#1db954] hover:bg-[#1ed760] text-black text-sm font-medium rounded-full transition-all hover:scale-[1.02]"
                            >
                                <Play className="w-4 h-4 fill-black" />
                                Play All
                            </button>
                        </div>
                        <div className="space-y-0.5">
                            {similarTracks.map((track, i) => (
                                <TrackRow
                                    key={track.id}
                                    track={track}
                                    index={i}
                                    onClick={() => playTrack(track)}
                                    onPlay={() => playTrack(track)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* Comparison View */}
                {!isLoading && !isSearching && viewMode === "comparison" && sourceTrack && similarTracks.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
                        {/* Track List */}
                        <div>
                            <div className="flex items-center justify-between mb-5">
                                <div className="flex items-center gap-4">
                                    <div className="relative">
                                        <CoverImage
                                            coverUrl={sourceTrack.coverUrl}
                                            title={sourceTrack.title}
                                            size={56}
                                            className="rounded-lg"
                                        />
                                        <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[#eab308] ring-2 ring-[#0a0a0a]" />
                                    </div>
                                    <div>
                                        <h2 className="font-medium text-white">Similar to</h2>
                                        <p className="text-sm text-[#a3a3a3]">{sourceTrack.title}</p>
                                    </div>
                                </div>
                                <button
                                    onClick={playAllSimilar}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-[#1db954] hover:bg-[#1ed760] text-black text-sm font-medium rounded-full transition-all hover:scale-[1.02]"
                                >
                                    <Play className="w-4 h-4 fill-black" />
                                    Play All
                                </button>
                            </div>
                            <div className="space-y-0.5">
                                {similarTracks.map((track, i) => (
                                    <TrackRow
                                        key={track.id}
                                        track={track}
                                        index={i}
                                        isSelected={selectedMatch?.id === track.id}
                                        onClick={() => setSelectedMatch(track)}
                                        onDoubleClick={() => playTrack(track)}
                                        onPlay={() => playTrack(track)}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* Comparison Panel */}
                        <div className="hidden lg:block">
                            <div className="sticky top-6">
                                <AnimatePresence mode="wait">
                                    {selectedMatch ? (
                                        <ComparisonPanel
                                            key={selectedMatch.id}
                                            source={sourceTrack}
                                            match={selectedMatch}
                                            onClose={() => setSelectedMatch(null)}
                                        />
                                    ) : (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="bg-[#0f0f0f] border border-[#1c1c1c] rounded-xl p-8 text-center"
                                        >
                                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-[#eab308]/10 to-[#a855f7]/10 flex items-center justify-center">
                                                <Disc3 className="w-8 h-8 text-[#333]" />
                                            </div>
                                            <p className="text-sm text-[#525252]">
                                                Select a track to compare audio DNA
                                            </p>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    </div>
                )}

                {/* Empty state */}
                {!isLoading && !isSearching && !error && !sourceTrack && similarTracks.length === 0 && (
                    <div className="text-center py-24">
                        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-gradient-to-br from-[#eab308]/10 to-[#a855f7]/10 flex items-center justify-center">
                            <Disc3 className="w-10 h-10 text-[#333]" />
                        </div>
                        <p className="text-[#525252]">No vibe data available</p>
                        <p className="text-sm text-[#333] mt-1">Run CLAP analysis to start exploring</p>
                    </div>
                )}
            </div>
        </div>
    );
}
