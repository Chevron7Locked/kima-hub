import { useState, useEffect, useCallback, useRef } from 'react';
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
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const wasActiveRef = useRef(false);
  const pendingRef = useRef(false); // Track pending state for polling callback

  // Keep pendingRef in sync with pendingGeneration
  useEffect(() => {
    pendingRef.current = pendingGeneration;
  }, [pendingGeneration]);

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

  const checkBatchStatus = useCallback(async () => {
    try {
      const status = await api.getDiscoverBatchStatus();
      setBatchStatus(status);

      // Clear pending state once batch is confirmed active
      if (status.active) {
        setPendingGeneration(false);
      }

      // If batch was active and now isn't, reload data
      if (wasActiveRef.current && !status.active) {
        wasActiveRef.current = false;
        setPendingGeneration(false);
        await loadData();
      }
      
      // Track if batch is currently active
      if (status.active) {
        wasActiveRef.current = true;
      }

      return status;
    } catch (error) {
      console.error('Failed to check batch status:', error);
      setPendingGeneration(false);
      return null;
    }
  }, [loadData]);

  // Start polling for batch status
  const startPolling = useCallback(() => {
    if (pollingRef.current) return; // Already polling

    pollingRef.current = setInterval(async () => {
      const status = await checkBatchStatus();
      
      // Only stop polling if:
      // 1. Status is not active AND
      // 2. We're not waiting for generation to start (pendingRef) AND
      // 3. We previously had an active batch (wasActiveRef)
      // This ensures we keep polling while waiting for the batch to be created
      if (status && !status.active && !pendingRef.current && wasActiveRef.current) {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    }, 3000); // Poll every 3 seconds
  }, [checkBatchStatus]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      
      // Check batch status first
      const status = await checkBatchStatus();
      
      // Load playlist data
      await loadData();
      
      // Start polling if batch is active
      if (status?.active) {
        startPolling();
      }

      setTimeout(() => {
        setLoading(false);
      }, 100);
    };

    init();

    return () => {
      stopPolling();
    };
  }, []);

  // Start polling when batch becomes active OR when generation is pending
  // This ensures we catch the batch as soon as it's created
  useEffect(() => {
    if ((batchStatus?.active || pendingGeneration) && !pollingRef.current) {
      startPolling();
    }
  }, [batchStatus?.active, pendingGeneration, startPolling]);

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
