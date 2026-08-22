## Repository map

backend/src/services/spotifyImport.ts:
  interface MatchedTrack
  interface AlbumToDownload
  interface ImportPreview
  interface ImportJob
  function extractPlaylistHint(url: string): string
  async function saveImportJob(job: ImportJob): Promise<void>
  async function getImportJob(importJobId: string): Promise<ImportJob | null>
  class SpotifyImportService
  type TrackWithRelations = Awaited<ReturnType<typeof prisma.track.findMany>>[number] &
backend/src/services/discoverWeekly.ts:
  interface RecommendedAlbum
  interface BatchLogEntry
  function getTierFromSimilarity(
  class DiscoverWeeklyService
backend/src/services/lidarr.ts:
  export enum AcquisitionErrorType
  export class AcquisitionError extends Error
  type: AcquisitionErrorType,
  interface MusicBrainzArtist
  type?: string;
  class LidarrService
  type: a.artistType,
  export interface ReconciliationSnapshot
  interface QueueSnapshotItem
  interface AlbumSnapshotInfo
  export interface CalendarRelease
  export interface LidarrIndexerRelease
  export async function cleanStuckDownloads(
  export async function getRecentCompletedDownloads(
backend/src/routes/discover.ts:
backend/src/services/simpleDownloadManager.ts:
  type TransactionClient = Omit<
  function generateCorrelationId(): string
  class SimpleDownloadManager
services/audio-analyzer/analyzer.py:
  def _pool_recycle_kwargs(limit)
  class DatabaseConnection  (connect, get_cursor, commit, rollback, close)
  def _get_workers_from_db()
  class AudioAnalyzer  (load_audio, validate_audio, analyze)
  def _pool_health_check()
  def _validate_track_in_process(args)
  def _init_worker_process()
  def _analyze_track_in_process(args)
  class AnalysisWorker  (start, process_batch_parallel, process_scan_queue)
  def main()
backend/src/workers/unifiedEnrichment.ts:
  async function clearPauseState(): Promise<void>
  async function withTimeout<T>(
  function filterMoodTags(tags: string[]): string[]
  function getRedis(): Redis
  async function setupControlChannel()
  export async function startUnifiedEnrichmentWorker()
  function scheduleNextEnrichmentCycle(delayMs: number = ENRICHMENT_INTERVAL_MS)
  function bumpScheduleToFastInterval(): void
  export async function stopUnifiedEnrichmentWorker()
  export async function runFullEnrichment(): Promise<
  async function resetArtistsOnly(): Promise<{ count: number }>
  async function resetMoodTagsOnly(): Promise<{ count: number }>
  async function runEnrichmentCycle(fullMode: boolean): Promise<
  export async function enrichSingleTrack(trackId: string): Promise<void>
  async function queueAudioAnalysis(): Promise<number>
  async function shouldHaltCycle(): Promise<boolean>
  async function runPhase(
  export async function executeArtistsPhase(): Promise<number>
  export async function executeMoodTagsPhase(): Promise<number>
  export async function markScanInvalid(trackId: string, reason: string): Promise<void>
  async function executeScanPhase(): Promise<number>
  async function executeAudioPhase(): Promise<number>
  async function executeVibePhase(): Promise<number>
  export async function executePodcastRefreshPhase(): Promise<number>
  type EnrichmentProgress = Awaited<ReturnType<typeof computeEnrichmentProgress>>;
  export async function getEnrichmentProgress(): Promise<EnrichmentProgress>
  export function invalidateEnrichmentProgress(): void
  async function computeEnrichmentProgress()
  export async function triggerEnrichmentNow(): Promise<
  export async function reRunArtistsOnly(): Promise<{ count: number }>
  export async function reRunMoodTagsOnly(): Promise<{ count: number }>
  export async function reRunAudioAnalysisOnly(): Promise<number>
  export async function resetAllEnrichmentData(): Promise<
backend/src/services/soulseek.ts:
  export interface SearchResult
  interface TrackMatch
  interface SearchTrackResult
  interface RateLimiterWaiter
  class SlidingWindowRateLimiter
  class SoulseekService
  type:
  type GroupScore =
  type MatchCandidate = { trackIdx: number; fileIdx: number; score: number };
backend/src/routes/podcasts.ts:
  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T>
  async function previewDeezerPodcast(req: Request, res: Response, deezerId: string)
  function parseEpisodePage(query: Record<string, unknown>):
  export async function refreshPodcastFeed(podcastId: string): Promise<{ newEpisodesCount: number; totalEpisodes: number }>
frontend/lib/audio-controls-context.tsx:
  interface AudioControlsContextType
  function getNextTrackInfo(
  export function AudioControlsProvider({ children }: { children: ReactNode })
  type: 'vibe',
  export function useAudioControls()
frontend/features/settings/components/sections/CacheSection.tsx:
  type LucideIcon,
  interface CacheSectionProps
  function ProgressBar(
  function EnrichmentStage(
  function EnrichmentFailuresList({ active = false }: { active?: boolean })
  type ConfirmTarget =
  export function CacheSection({ settings, onUpdate }: CacheSectionProps)
  type="range"
  type="range"
  type="range"
  type="range"
  type="range"
frontend/lib/api.ts:
  export type MoodType =
  export interface MoodBucketPreset
  export interface MoodBucketMix
  interface ApiError extends Error
  interface ServiceTestResult
  type ApiData = any;
  function toSearchParams(params: Record<string, string | number | boolean | undefined>): URLSearchParams
  type RefreshResult = "refreshed" | "rejected" | "network-error";
  export class NetworkError extends Error
  class ApiClient
  type:
  type: string;
  type: string;
  type: string;
frontend/app/import/playlist/page.tsx:
  interface SpotifyTrack
  interface MatchedTrack
  interface AlbumToDownload
  interface ImportPreview
  interface ImportJob
  type Step = "input" | "previewing" | "preview" | "importing" | "complete";
  function ImportPlaylistPageContent()
  type PreviewStatus = { status: string; preview?: ImportPreview; error?: string; phase?: string; message?: string };
  type="text"
  type="checkbox"
  type="text"

[map covers 13 of 624 files]
