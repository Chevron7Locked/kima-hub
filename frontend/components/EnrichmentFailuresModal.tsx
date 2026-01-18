"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { enrichmentApi, EnrichmentFailure } from "@/lib/enrichmentApi";
import {
    X,
    RefreshCw,
    SkipForward,
    Trash2,
    AlertCircle,
    Filter,
} from "lucide-react";

interface EnrichmentFailuresModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function EnrichmentFailuresModal({
    isOpen,
    onClose,
}: EnrichmentFailuresModalProps) {
    const [selectedType, setSelectedType] = useState<
        "all" | "artist" | "track" | "audio"
    >("all");
    const [selectedFailures, setSelectedFailures] = useState<Set<string>>(
        new Set()
    );
    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 20;
    const queryClient = useQueryClient();

    // Fetch failures
    const {
        data: failures,
        isLoading,
        refetch,
    } = useQuery({
        queryKey: ["enrichment-failures", selectedType, currentPage],
        queryFn: async () => {
            const params: any = {
                limit: pageSize,
                offset: (currentPage - 1) * pageSize,
                resolved: false,
            };
            if (selectedType !== "all") {
                params.entityType = selectedType;
            }
            return enrichmentApi.getFailures(params);
        },
        enabled: isOpen,
    });

    // Fetch counts
    const { data: counts } = useQuery({
        queryKey: ["enrichment-failure-counts"],
        queryFn: () => enrichmentApi.getFailureCounts(),
        enabled: isOpen,
    });

    // Retry mutation
    const retryMutation = useMutation({
        mutationFn: (failureIds: string[]) =>
            enrichmentApi.retryFailures(failureIds),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-progress"],
            });
            setSelectedFailures(new Set());
        },
    });

    // Skip mutation
    const skipMutation = useMutation({
        mutationFn: (failureIds: string[]) =>
            enrichmentApi.skipFailures(failureIds),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
            setSelectedFailures(new Set());
        },
    });

    // Delete mutation
    const deleteMutation = useMutation({
        mutationFn: (failureId: string) =>
            enrichmentApi.deleteFailure(failureId),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failures"],
            });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-failure-counts"],
            });
        },
    });

    const toggleFailureSelection = (id: string) => {
        const newSelected = new Set(selectedFailures);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedFailures(newSelected);
    };

    const handleSelectAll = () => {
        if (selectedFailures.size === failures?.failures.length) {
            setSelectedFailures(new Set());
        } else {
            setSelectedFailures(
                new Set(failures?.failures.map((f) => f.id) || [])
            );
        }
    };

    const handleRetrySelected = () => {
        if (selectedFailures.size > 0) {
            retryMutation.mutate(Array.from(selectedFailures));
        }
    };

    const handleSkipSelected = () => {
        if (selectedFailures.size > 0) {
            skipMutation.mutate(Array.from(selectedFailures));
        }
    };

    if (!isOpen) return null;

    const totalFailures = counts?.total || 0;
    const totalPages = Math.ceil((failures?.total || 0) / pageSize);

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
            <div className="bg-[#1a1a1a] rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col border border-white/10">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-white/10">
                    <div>
                        <h2 className="text-xl font-bold text-white">
                            Enrichment Failures
                        </h2>
                        <p className="text-sm text-white/50 mt-1">
                            {totalFailures} total failure
                            {totalFailures !== 1 ? "s" : ""} to review
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5 text-white/70" />
                    </button>
                </div>

                {/* Filter Tabs */}
                <div className="flex gap-3 px-6 py-4 border-b border-white/10 overflow-x-auto">
                    {(
                        [
                            { key: "all" as const, label: "All", count: counts?.total || 0 },
                            {
                                key: "artist" as const,
                                label: "Artists",
                                count: counts?.artist || 0,
                            },
                            {
                                key: "track" as const,
                                label: "Tracks",
                                count: counts?.track || 0,
                            },
                            {
                                key: "audio" as const,
                                label: "Audio Analysis",
                                count: counts?.audio || 0,
                            },
                        ]
                    ).map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => {
                                setSelectedType(tab.key);
                                setCurrentPage(1);
                                setSelectedFailures(new Set());
                            }}
                            className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                                selectedType === tab.key
                                    ? "bg-[#ecb200] text-black"
                                    : "bg-white/5 text-white/70 hover:bg-white/10"
                            }`}
                        >
                            {tab.label} ({tab.count})
                        </button>
                    ))}
                </div>

                {/* Action Bar */}
                {selectedFailures.size > 0 && (
                    <div className="flex items-center gap-2 p-4 bg-white/5 border-b border-white/10">
                        <span className="text-sm text-white/70">
                            {selectedFailures.size} selected
                        </span>
                        <div className="flex gap-2 ml-auto">
                            <button
                                onClick={handleRetrySelected}
                                disabled={retryMutation.isPending}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg
                                    hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                Retry
                            </button>
                            <button
                                onClick={handleSkipSelected}
                                disabled={skipMutation.isPending}
                                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                    hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <SkipForward className="w-3.5 h-3.5" />
                                Skip
                            </button>
                        </div>
                    </div>
                )}

                {/* Failures List */}
                <div className="flex-1 overflow-y-auto p-4">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-64">
                            <div className="text-white/50">
                                Loading failures...
                            </div>
                        </div>
                    ) : failures?.failures.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-white/50">
                            <AlertCircle className="w-12 h-12 mb-3 opacity-50" />
                            <p className="text-lg font-medium">
                                No failures found
                            </p>
                            <p className="text-sm mt-1">
                                All items enriched successfully
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {/* Select All */}
                            <div className="flex items-center gap-3 px-3 py-2">
                                <input
                                    type="checkbox"
                                    checked={
                                        selectedFailures.size ===
                                        failures?.failures.length
                                    }
                                    onChange={handleSelectAll}
                                    className="w-4 h-4 rounded border-white/20 bg-white/10"
                                />
                                <span className="text-sm text-white/50">
                                    Select all
                                </span>
                            </div>

                            {failures?.failures.map((failure) => (
                                <div
                                    key={failure.id}
                                    className="flex items-start gap-3 p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedFailures.has(
                                            failure.id
                                        )}
                                        onChange={() =>
                                            toggleFailureSelection(failure.id)
                                        }
                                        className="w-4 h-4 mt-1 rounded border-white/20 bg-white/10"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-white truncate">
                                                {failure.entityName ||
                                                    failure.entityId}
                                            </span>
                                            <span className="text-xs px-2 py-0.5 bg-white/10 text-white/50 rounded uppercase">
                                                {failure.entityType}
                                            </span>
                                        </div>
                                        <p className="text-xs text-red-400 mt-1">
                                            {failure.errorMessage ||
                                                "Unknown error"}
                                        </p>
                                        <div className="flex items-center gap-3 mt-2 text-[10px] text-white/30">
                                            <span>
                                                Retry {failure.retryCount}/
                                                {failure.maxRetries}
                                            </span>
                                            <span>•</span>
                                            <span>
                                                Last:{" "}
                                                {new Date(
                                                    failure.lastFailedAt
                                                ).toLocaleString()}
                                            </span>
                                            {failure.errorCode && (
                                                <>
                                                    <span>•</span>
                                                    <span>
                                                        {failure.errorCode}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() =>
                                            deleteMutation.mutate(failure.id)
                                        }
                                        disabled={deleteMutation.isPending}
                                        className="p-2 hover:bg-red-500/20 rounded-lg transition-colors"
                                        title="Delete failure record"
                                    >
                                        <Trash2 className="w-4 h-4 text-red-400" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between p-4 border-t border-white/10">
                        <button
                            onClick={() =>
                                setCurrentPage((p) => Math.max(1, p - 1))
                            }
                            disabled={currentPage === 1}
                            className="px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-white/50">
                            Page {currentPage} of {totalPages}
                        </span>
                        <button
                            onClick={() =>
                                setCurrentPage((p) =>
                                    Math.min(totalPages, p + 1)
                                )
                            }
                            disabled={currentPage === totalPages}
                            className="px-3 py-1.5 text-sm bg-white/10 text-white/70 rounded-lg
                                hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Next
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
