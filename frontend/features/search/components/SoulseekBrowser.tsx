"use client";

import { useState, useMemo, useCallback } from "react";
import { Download, CheckCircle, Music, ChevronDown, ChevronRight, List, Users } from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { formatFileSize, getQualityBadge, parseFilename } from "./soulseekHelpers";
import type {
    SoulseekResult,
    SoulseekSortField,
    SoulseekViewMode,
    SoulseekFormatFilter,
} from "../types";

interface SoulseekBrowserProps {
    results: SoulseekResult[];
    isSearching: boolean;
    isPolling: boolean;
    isComplete: boolean;
    uniqueUserCount: number;
    downloadingFiles: Set<string>;
    onDownload: (result: SoulseekResult) => void;
    onBulkDownload: (results: SoulseekResult[]) => void;
}

const INITIAL_DISPLAY_LIMIT = 100;

const FORMAT_PILLS: { label: string; value: SoulseekFormatFilter }[] = [
    { label: "All", value: "all" },
    { label: "FLAC", value: "flac" },
    { label: "320+", value: "320" },
    { label: "256+", value: "256" },
];

const SORT_OPTIONS: { label: string; value: SoulseekSortField }[] = [
    { label: "Quality", value: "quality" },
    { label: "Bitrate", value: "bitrate" },
    { label: "Size", value: "size" },
    { label: "Filename", value: "filename" },
];

function getResultKey(r: SoulseekResult): string {
    return `${r.username}:${r.path}`;
}

function qualityScore(r: SoulseekResult): number {
    return r.format === "flac" ? 10000 : r.bitrate;
}

export function SoulseekBrowser({
    results,
    isSearching,
    isPolling,
    isComplete,
    uniqueUserCount,
    downloadingFiles,
    onDownload,
    onBulkDownload,
}: SoulseekBrowserProps) {
    const [formatFilters, setFormatFilters] = useState<Set<SoulseekFormatFilter>>(new Set(["all"]));
    const [sortField, setSortField] = useState<SoulseekSortField>("quality");
    const [viewMode, setViewMode] = useState<SoulseekViewMode>("flat");
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [showAll, setShowAll] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [groupsInitialized, setGroupsInitialized] = useState(false);

    const isActive = isSearching || isPolling;

    const handleFormatToggle = useCallback((filter: SoulseekFormatFilter) => {
        setFormatFilters((prev) => {
            if (filter === "all") return new Set(["all"]);
            const next = new Set(prev);
            next.delete("all");
            if (next.has(filter)) {
                next.delete(filter);
            } else {
                next.add(filter);
            }
            return next.size === 0 ? new Set<SoulseekFormatFilter>(["all"]) : next;
        });
    }, []);

    const filtered = useMemo(() => {
        if (formatFilters.has("all")) return results;
        return results.filter((r) => {
            if (formatFilters.has("flac") && r.format === "flac") return true;
            if (formatFilters.has("320") && r.bitrate >= 320) return true;
            if (formatFilters.has("256") && r.bitrate >= 256) return true;
            return false;
        });
    }, [results, formatFilters]);

    const sorted = useMemo(() => {
        const copy = [...filtered];
        switch (sortField) {
            case "quality":
                return copy.sort((a, b) => qualityScore(b) - qualityScore(a));
            case "bitrate":
                return copy.sort((a, b) => b.bitrate - a.bitrate);
            case "size":
                return copy.sort((a, b) => b.size - a.size);
            case "filename":
                return copy.sort((a, b) => a.filename.localeCompare(b.filename));
            default:
                return copy;
        }
    }, [filtered, sortField]);

    const displayResults = showAll ? sorted : sorted.slice(0, INITIAL_DISPLAY_LIMIT);
    const hasMore = sorted.length > INITIAL_DISPLAY_LIMIT && !showAll;

    // Group results by username
    const grouped = useMemo(() => {
        const map = new Map<string, SoulseekResult[]>();
        for (const r of sorted) {
            const list = map.get(r.username) || [];
            list.push(r);
            map.set(r.username, list);
        }
        return map;
    }, [sorted]);

    // Auto-expand first 3 groups on initial render
    if (!groupsInitialized && grouped.size > 0) {
        const firstThree = new Set(Array.from(grouped.keys()).slice(0, 3));
        setExpandedGroups(firstThree);
        setGroupsInitialized(true);
    }

    const toggleGroup = useCallback((username: string) => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(username)) {
                next.delete(username);
            } else {
                next.add(username);
            }
            return next;
        });
    }, []);

    const toggleSelect = useCallback((key: string) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, []);

    const toggleSelectAll = useCallback(() => {
        const visibleKeys = displayResults.map(getResultKey);
        setSelectedKeys((prev) => {
            const allSelected = visibleKeys.every((k) => prev.has(k));
            if (allSelected) return new Set();
            return new Set([...prev, ...visibleKeys]);
        });
    }, [displayResults]);

    const selectedResults = useMemo(
        () => sorted.filter((r) => selectedKeys.has(getResultKey(r))),
        [sorted, selectedKeys],
    );

    const handleBulkDownloadClick = useCallback(() => {
        if (selectedResults.length > 0) {
            onBulkDownload(selectedResults);
        }
    }, [selectedResults, onBulkDownload]);

    if (results.length === 0 && !isActive) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <Music className="w-12 h-12 text-gray-600 mb-3" />
                <p className="text-gray-400">No Soulseek results found</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Status bar */}
            <div className="flex items-center gap-3 px-4 py-3 bg-[#181818] rounded-lg">
                {isActive ? (
                    <>
                        <GradientSpinner size="sm" />
                        <span className="text-sm text-gray-300">
                            Searching... {results.length} results from {uniqueUserCount} users
                        </span>
                    </>
                ) : (
                    <span className="text-sm text-gray-400">
                        Search complete &mdash; {results.length} results from {uniqueUserCount} users
                    </span>
                )}
            </div>

            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                {/* Format pills */}
                <div className="flex gap-1.5">
                    {FORMAT_PILLS.map((pill) => (
                        <button
                            key={pill.value}
                            onClick={() => handleFormatToggle(pill.value)}
                            className={cn(
                                "px-3 py-1.5 text-xs font-semibold rounded-full transition-colors",
                                formatFilters.has(pill.value)
                                    ? "bg-[#ecb200]/20 text-[#ecb200]"
                                    : "bg-[#282828] text-gray-400 hover:text-white hover:bg-[#333]",
                            )}
                        >
                            {pill.label}
                        </button>
                    ))}
                </div>

                {/* Sort selector */}
                <select
                    value={sortField}
                    onChange={(e) => setSortField(e.target.value as SoulseekSortField)}
                    className="bg-[#282828] text-sm text-gray-300 rounded-md px-3 py-1.5 border border-white/10 focus:outline-none focus:border-[#ecb200]/50"
                >
                    {SORT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>

                {/* View toggle */}
                <div className="flex gap-1 bg-[#282828] rounded-md p-0.5">
                    <button
                        onClick={() => setViewMode("flat")}
                        className={cn(
                            "p-1.5 rounded transition-colors",
                            viewMode === "flat" ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300",
                        )}
                        title="Flat list"
                    >
                        <List className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setViewMode("grouped")}
                        className={cn(
                            "p-1.5 rounded transition-colors",
                            viewMode === "grouped" ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300",
                        )}
                        title="Group by user"
                    >
                        <Users className="w-4 h-4" />
                    </button>
                </div>

                {/* Bulk download */}
                {selectedKeys.size > 0 && (
                    <button
                        onClick={handleBulkDownloadClick}
                        className="ml-auto px-4 py-1.5 text-sm font-bold rounded-full bg-[#ecb200] text-black hover:bg-[#d4a000] transition-colors flex items-center gap-2"
                    >
                        <Download className="w-4 h-4" />
                        Download {selectedKeys.size} selected
                    </button>
                )}
            </div>

            {/* Results */}
            {viewMode === "flat" ? (
                <FlatView
                    results={displayResults}
                    selectedKeys={selectedKeys}
                    downloadingFiles={downloadingFiles}
                    onToggleSelect={toggleSelect}
                    onToggleSelectAll={toggleSelectAll}
                    onDownload={onDownload}
                />
            ) : (
                <GroupedView
                    grouped={grouped}
                    expandedGroups={expandedGroups}
                    selectedKeys={selectedKeys}
                    downloadingFiles={downloadingFiles}
                    onToggleGroup={toggleGroup}
                    onToggleSelect={toggleSelect}
                    onDownload={onDownload}
                />
            )}

            {/* Show all button */}
            {hasMore && (
                <button
                    onClick={() => setShowAll(true)}
                    className="w-full py-3 text-sm text-gray-400 hover:text-white bg-[#181818] hover:bg-[#1f1f1f] rounded-lg transition-colors"
                >
                    Show all {sorted.length} results
                </button>
            )}
        </div>
    );
}

// --- Flat View ---

interface FlatViewProps {
    results: SoulseekResult[];
    selectedKeys: Set<string>;
    downloadingFiles: Set<string>;
    onToggleSelect: (key: string) => void;
    onToggleSelectAll: () => void;
    onDownload: (result: SoulseekResult) => void;
}

function FlatView({
    results,
    selectedKeys,
    downloadingFiles,
    onToggleSelect,
    onToggleSelectAll,
    onDownload,
}: FlatViewProps) {
    const allSelected = results.length > 0 && results.every((r) => selectedKeys.has(getResultKey(r)));

    return (
        <div>
            {/* Header row */}
            <div className="grid grid-cols-[32px_1fr_minmax(80px,120px)_80px_80px_80px_44px] md:grid-cols-[32px_1fr_minmax(80px,120px)_80px_80px_80px_44px] gap-2 px-3 py-2 text-xs text-gray-500 border-b border-white/5">
                <div className="flex items-center justify-center">
                    <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={onToggleSelectAll}
                        className="w-3.5 h-3.5 accent-[#ecb200] cursor-pointer"
                    />
                </div>
                <div>Title</div>
                <div>User</div>
                <div className="hidden md:block">Format</div>
                <div className="hidden md:block text-right font-mono">Bitrate</div>
                <div className="hidden md:block text-right font-mono">Size</div>
                <div />
            </div>

            {/* Result rows */}
            {results.map((result, index) => (
                <ResultRow
                    key={`${result.username}-${result.path}-${index}`}
                    result={result}
                    isSelected={selectedKeys.has(getResultKey(result))}
                    isDownloading={downloadingFiles.has(getResultKey(result))}
                    onToggleSelect={onToggleSelect}
                    onDownload={onDownload}
                    animationDelay={index < 20 ? index * 15 : 0}
                />
            ))}
        </div>
    );
}

// --- Result Row ---

interface ResultRowProps {
    result: SoulseekResult;
    isSelected: boolean;
    isDownloading: boolean;
    onToggleSelect: (key: string) => void;
    onDownload: (result: SoulseekResult) => void;
    animationDelay: number;
}

function ResultRow({
    result,
    isSelected,
    isDownloading,
    onToggleSelect,
    onDownload,
    animationDelay,
}: ResultRowProps) {
    const key = getResultKey(result);
    const parsed = result.parsedTitle
        ? { artist: result.parsedArtist || "Unknown", title: result.parsedTitle }
        : parseFilename(result.filename);

    return (
        <div
            className="grid grid-cols-[32px_1fr_minmax(80px,120px)_80px_80px_80px_44px] md:grid-cols-[32px_1fr_minmax(80px,120px)_80px_80px_80px_44px] gap-2 px-3 py-2 items-center hover:bg-white/5 transition-colors rounded"
            style={
                animationDelay > 0
                    ? {
                          animation: `fadeSlideIn 150ms ${animationDelay}ms both`,
                      }
                    : undefined
            }
        >
            <div className="flex items-center justify-center">
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(key)}
                    className="w-3.5 h-3.5 accent-[#ecb200] cursor-pointer"
                />
            </div>

            <div className="min-w-0">
                <p className="text-sm text-white truncate">{parsed.title}</p>
                <p className="text-xs text-gray-500 truncate">{parsed.artist}</p>
            </div>

            <div className="text-xs text-gray-400 truncate">{result.username}</div>

            <div className="hidden md:block">{getQualityBadge(result)}</div>

            <div className="hidden md:block text-xs text-gray-400 text-right font-mono">
                {result.bitrate}k
            </div>

            <div className="hidden md:block text-xs text-gray-400 text-right font-mono">
                {formatFileSize(result.size)}
            </div>

            <div className="flex items-center justify-center">
                <button
                    onClick={() => onDownload(result)}
                    disabled={isDownloading}
                    className={cn(
                        "p-1.5 rounded-full transition-colors",
                        isDownloading
                            ? "text-green-400 cursor-not-allowed"
                            : "text-[#fca200] hover:bg-[#fca200]/10",
                    )}
                >
                    {isDownloading ? (
                        <CheckCircle className="w-4 h-4" />
                    ) : (
                        <Download className="w-4 h-4" />
                    )}
                </button>
            </div>
        </div>
    );
}

// --- Grouped View ---

interface GroupedViewProps {
    grouped: Map<string, SoulseekResult[]>;
    expandedGroups: Set<string>;
    selectedKeys: Set<string>;
    downloadingFiles: Set<string>;
    onToggleGroup: (username: string) => void;
    onToggleSelect: (key: string) => void;
    onDownload: (result: SoulseekResult) => void;
}

function GroupedView({
    grouped,
    expandedGroups,
    selectedKeys,
    downloadingFiles,
    onToggleGroup,
    onToggleSelect,
    onDownload,
}: GroupedViewProps) {
    return (
        <div className="space-y-1">
            {Array.from(grouped.entries()).map(([username, userResults]) => {
                const isExpanded = expandedGroups.has(username);

                return (
                    <div key={username} className="bg-[#181818] rounded-lg overflow-hidden">
                        <button
                            onClick={() => onToggleGroup(username)}
                            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors"
                        >
                            {isExpanded ? (
                                <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            ) : (
                                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            )}
                            <span className="text-sm font-medium text-white">{username}</span>
                            <span className="text-xs text-gray-500">
                                ({userResults.length} {userResults.length === 1 ? "file" : "files"})
                            </span>
                        </button>

                        {isExpanded && (
                            <div className="px-2 pb-2">
                                {userResults.map((result, index) => (
                                    <ResultRow
                                        key={`${result.path}-${index}`}
                                        result={result}
                                        isSelected={selectedKeys.has(getResultKey(result))}
                                        isDownloading={downloadingFiles.has(getResultKey(result))}
                                        onToggleSelect={onToggleSelect}
                                        onDownload={onDownload}
                                        animationDelay={0}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
