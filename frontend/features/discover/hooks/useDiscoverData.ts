import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
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
  const queryClient = useQueryClient();
  const [playlist, setPlaylist] = useState<DiscoverPlaylist | null>(null);
  const [config, setConfig] = useState<DiscoverConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const wasActiveRef = useRef(false);

  // SSE-populated batch status (populated by useEventSource via queryClient.setQueryData)
  const { data: sseBatchStatus } = useQuery<BatchStatus | null>({
    queryKey: ["discover-batch-status"],
    queryFn: () => queryClient.getQueryData<BatchStatus>(["discover-batch-status"]) ?? null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Derive batchStatus from SSE data or use null
  const batchStatus = sseBatchStatus || null;

  const loadData = useCallback(async () => {
    try {
      const [playlistData, configData] = await Promise.all([
        api.getCurrentDiscoverWeekly().catch(() => null),
        api.getDiscoverConfig().catch(() => null),
      ]);

      setPlaylist(playlistData);
      setConfig(configData);
    } catch (error) {
      console.error('Failed to load discover data:', error);
    }
  }, []);

  // Check initial batch status on mount (one-time fetch)
  const checkBatchStatus = useCallback(async () => {
    try {
      const status = await api.getDiscoverBatchStatus();
      // Seed the React Query cache so SSE has a baseline
      queryClient.setQueryData(["discover-batch-status"], status);
      return status;
    } catch (error) {
      console.error('Failed to check batch status:', error);
      setPendingGeneration(false);
      return null;
    }
  }, [queryClient]);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await checkBatchStatus();
      await loadData();
      setTimeout(() => { setLoading(false); }, 100);
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  // React to SSE-driven batch status changes
  useEffect(() => {
    if (!batchStatus) return;

    // Clear pending state once batch is confirmed active
    if (batchStatus.active) {
      setPendingGeneration(false);
    }

    // If batch was active and now isn't, reload data
    if (wasActiveRef.current && !batchStatus.active) {
      wasActiveRef.current = false;
      setPendingGeneration(false);
      loadData();
    }

    // Track if batch is currently active
    if (batchStatus.active) {
      wasActiveRef.current = true;
    }
  }, [batchStatus, loadData]);

  // Optimistically update a track's liked status
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
    reloadData: loadData,
    batchStatus,
    refreshBatchStatus: checkBatchStatus,
    setPendingGeneration,
    updateTrackLiked,
    isGenerating: pendingGeneration || batchStatus?.active || false,
  };
}
