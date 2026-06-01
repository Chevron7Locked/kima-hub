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
  const [loadError, setLoadError] = useState(false);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const wasActiveRef = useRef(false);
  const generationStartTimeRef = useRef<number | null>(null);

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
    setLoadError(false);
    try {
      const [playlistData, configData] = await Promise.all([
        api.getCurrentDiscoverWeekly(),
        api.getDiscoverConfig().catch(() => null),
      ]);

      setPlaylist(playlistData);
      setConfig(configData as DiscoverConfig | null);
    } catch (error) {
      console.error('Failed to load discover data:', error);
      setLoadError(true);
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
      generationStartTimeRef.current = null;
    }

    // Clear pending state if batch is not active (handles immediate failures)
    // But only after 5 seconds to allow backend time to create the batch
    if (!batchStatus.active && pendingGeneration) {
      const timeSinceStart = generationStartTimeRef.current
        ? Date.now() - generationStartTimeRef.current
        : Infinity;

      if (timeSinceStart > 5000) {
        setPendingGeneration(false);
        generationStartTimeRef.current = null;
      }
    }

    // If batch was active and now isn't, reload data
    if (wasActiveRef.current && !batchStatus.active) {
      wasActiveRef.current = false;
      setPendingGeneration(false);
      generationStartTimeRef.current = null;
      loadData();
    }

    // Track if batch is currently active
    if (batchStatus.active) {
      wasActiveRef.current = true;
    }
  }, [batchStatus, loadData, pendingGeneration]);

  // Stale batch detection - clear stuck "active" state after 5 minutes
  useEffect(() => {
    if (!batchStatus?.active) return;

    const timeout = setTimeout(() => {
      // If still active after 5 minutes, assume stale and clear
      console.warn('[DiscoverWeekly] Batch stuck active for 5 minutes - clearing stale state');
      queryClient.setQueryData(["discover-batch-status"], { active: false, status: null, batchId: null });
      setPendingGeneration(false);
      loadData();
    }, 5 * 60 * 1000); // 5 minutes

    return () => clearTimeout(timeout);
  }, [batchStatus?.active, queryClient, loadData]);

  // Mark when generation starts
  const markGenerationStart = useCallback(() => {
    generationStartTimeRef.current = Date.now();
  }, []);

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
    loadError,
    reloadData: loadData,
    batchStatus,
    refreshBatchStatus: checkBatchStatus,
    setPendingGeneration,
    markGenerationStart,
    updateTrackLiked,
    isGenerating: pendingGeneration || batchStatus?.active || false,
  };
}
