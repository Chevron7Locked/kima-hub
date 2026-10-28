import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DiscoverPlaylist, DiscoverConfig } from '../types';

interface BatchStatus {
  active: boolean;
  status: "downloading" | "scanning" | null;
  batchId?: string;
  progress?: number;
  completed?: number;
  failed?: number;
  total?: number;
}

export function useDiscoverData() {
  const [playlist, setPlaylist] = useState<DiscoverPlaylist | null>(null);
  const [config, setConfig] = useState<DiscoverConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const [wasActive, setWasActive] = useState(false);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [reloadRequest, setReloadRequest] = useState(0);
  const [syncedBatchStatus, setSyncedBatchStatus] = useState<BatchStatus | null>(null);
  const [syncedPending, setSyncedPending] = useState(false);

  // The server's batch status. SSE events update it as they arrive; while a batch
  // runs it is also read again every 30 s, so a missed event cannot leave the
  // page showing "generating" after the batch has ended.
  const { data: batchStatus = null, dataUpdatedAt, refetch: refetchBatchStatus } = useQuery<BatchStatus | null>({
    queryKey: ["discover-batch-status"],
    queryFn: () => api.getDiscoverBatchStatus(),
    refetchInterval: (query) => (query.state.data?.active ? 30_000 : false),
  });

  const loadData = useCallback(() => {
    return Promise.all([
      api.getCurrentDiscoverWeekly(),
      api.getDiscoverConfig().catch(() => null),
    ])
      .then(([playlistData, configData]) => {
        setPlaylist(playlistData);
        setConfig(configData as DiscoverConfig | null);
      })
      .catch((error) => {
        console.error('Failed to load discover data:', error);
        setLoadError(true);
      });
  }, []);

  const reloadData = useCallback(() => {
    setLoadError(false);
    return loadData();
  }, [loadData]);

  const refreshBatchStatus = useCallback(async () => {
    const { data, error } = await refetchBatchStatus();
    if (error) setPendingGeneration(false);
    return data ?? null;
  }, [refetchBatchStatus]);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await loadData();
      setTimeout(() => { setLoading(false); }, 100);
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  // React to SSE-driven batch status changes (adjusted during render when the status or pending flag changes)
  if (batchStatus !== syncedBatchStatus || pendingGeneration !== syncedPending) {
    setSyncedBatchStatus(batchStatus);
    setSyncedPending(pendingGeneration);

    if (batchStatus) {
      // Clear pending state once batch is confirmed active
      if (batchStatus.active) {
        setPendingGeneration(false);
        setGenerationStartedAt(null);
      }

      // Clear pending state if batch is not active (handles immediate failures)
      // But only after 5 seconds to allow backend time to create the batch
      if (!batchStatus.active && pendingGeneration) {
        const timeSinceStart = generationStartedAt !== null
          ? dataUpdatedAt - generationStartedAt
          : Infinity;

        if (timeSinceStart > 5000) {
          setPendingGeneration(false);
          setGenerationStartedAt(null);
        }
      }

      // If batch was active and now isn't, reload data
      if (wasActive && !batchStatus.active) {
        setWasActive(false);
        setPendingGeneration(false);
        setGenerationStartedAt(null);
        setLoadError(false);
        setReloadRequest((n) => n + 1);
      }

      if (batchStatus.active) {
        setWasActive(true);
      }
    }
  }

  useEffect(() => {
    if (reloadRequest > 0) loadData();
  }, [reloadRequest, loadData]);

  const markGenerationStart = useCallback(() => {
    setGenerationStartedAt(Date.now());
  }, []);

  const updateTrackLiked = useCallback((albumId: string, isLiked: boolean) => {
    setPlaylist(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(track =>
          track.albumId === albumId
            ? { ...track, isLiked, likedAt: isLiked ? new Date().toISOString() : null }
            : track
        ),
      };
    });
  }, []);

  return {
    playlist,
    config,
    setConfig,
    loading,
    loadError,
    reloadData,
    batchStatus,
    refreshBatchStatus,
    setPendingGeneration,
    markGenerationStart,
    updateTrackLiked,
    isGenerating: pendingGeneration || batchStatus?.active || false,
  };
}
