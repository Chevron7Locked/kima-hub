# Changelog

All notable changes to Kima will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - nightly

### Changed

- **TypeScript strict mode enabled (frontend)**: `"strict": true` in `frontend/tsconfig.json`. Fixed 31 implicit-any and strictNullChecks errors across album/artist/podcast pages, MetadataEditor, AlbumHero, ArtistHero, ArtistActionBar, AvailableAlbums, useDiscoverData, LibraryAlbumsGrid, LibraryTracksList, UnifiedSongsList, CacheSection, useQueries, useTVNavigation.
- **Redis client consolidation**: Removed `redis` (node-redis v4) dependency entirely. All ~30 backend files now use `ioredis` exclusively. Eliminated the dual-client footgun. Pub/sub in `textEmbeddingBridge` rewritten to ioredis event-based API.
- **routes/library.ts split**: 4364-line god-file split into `routes/library/` sub-routers: `artists`, `albums`, `tracks`, `streaming`, `coverArt`, `scan`, `backfill`. Each file has a single clear responsibility. `library.ts` is now a 10-line re-export barrel.
- **services/programmaticPlaylists.ts split**: 3842-line god-file split into `services/mixes/` sub-modules: `genreMixes`, `moodMixes`, `timeMixes`, `discoveryMixes`, `helpers`, `index`. `programmaticPlaylists.ts` is now a 7-line re-export barrel.
- **Startup task consolidation**: Three concurrent IIFE startup tasks (audiobook sync, artist counts backfill, image backfill) consolidated into a sequential `runStartupTasks()` function to avoid overwhelming DB connections at startup.
- **Dead code removal**: Removed unused `ffmpeg-static` dependency (not imported anywhere); added `prebuild` script to clean `dist/` before each build.

### Fixed

- **enrichmentStateMachine tests**: Updated mock for `enrichmentStateService` to include `publishToChannel` method. Tests for Python analyzer C2 bridge now correctly assert against `publishToChannel` instead of raw Redis `publish` (which was never called after the ioredis consolidation refactored the channel through the service layer).

### Tests

- **Tier 1 backend test coverage added**: New test suites for `services/search.ts` (22 tests -- `queryToTsquery` logic, special char handling, search service), `routes/share.ts` (17 tests -- share token lifecycle, play counting, unauthenticated access), `routes/webhooks.ts` (14 tests -- Lidarr webhook events, secret validation, error handling), `services/musicScanner.ts` (49 tests -- pure parsing helpers, path normalization, metadata extraction), `routes/library/albums.ts` (17 tests -- pagination, filtering, delete). Total test count: 307 (up from 173).

## [1.7.3] - 2026-03-20

### Fixed

- **Cover art 404s after volume wipe or permission change (#149)**: Artist enrichment and album cover fetch now check if native cover files actually exist on disk before preserving stale DB paths. Added `nativeFileExists()` utility, `repairBrokenCovers()` service, and `POST /enrichment/repair-covers` endpoint to scan and clear broken cover paths for re-fetch.
- **ARM64 Docker builds missing core Python dependencies (#1)**: `tensorflow-cpu` has no Linux ARM64 wheels, and all pip installs were chained -- so tensorflow failure prevented redis, bullmq, and other core deps from installing. Split into three layers: core deps (always succeed), ML deps (torch/CLAP -- works on ARM64), and tensorflow/essentia (gracefully degrades on ARM64 with log message).
- **Misleading "Remove docker-compose.override.yml" message on non-Docker installs (#147)**: Replaced Docker-specific text with generic "Service not detected" message for Audio Analysis and Vibe Similarity on Proxmox LXC and bare metal installs.
- **Unused `artistHeroUrl` parameter in enrichAlbumCovers**: Cleaned up dead parameter that was passed but never used.

## [1.7.2] - 2026-03-18

### Fixed

- **Multi-container docker-compose: fresh install shows login instead of setup wizard (#158)**: Next.js rewrites were compiled at build time with `127.0.0.1:3006` baked in because `NEXT_PUBLIC_BACKEND_URL` was never passed as a build arg. In multi-container mode the frontend container can't reach `127.0.0.1:3006` (that's the backend container). Fix: added `NEXT_PUBLIC_BACKEND_URL` as a Dockerfile build arg, defaulting to `http://backend:3006` in docker-compose.yml. The reporter's CORS issue was a secondary symptom -- once the proxy works, all requests are same-origin.
- **Audiobookshelf sync silently skips books**: Books with no title returned early without throwing, but `syncAll` counted them as synced. Now `syncAudiobook` returns a boolean; skipped books increment `result.skipped` instead of `result.synced`.
- **Audiobookshelf sync notification hides failures**: The "Synced N audiobooks" notification now includes failed/skipped counts when non-zero.
- **Audiobookshelf cover download can hang indefinitely**: `downloadCover()` had no fetch timeout. Added `AbortSignal.timeout(10_000)` to prevent a single slow cover from stalling the entire sync.
- **Audiobookshelf book size includes non-audio files**: Changed `book.size` to `book.media?.size` for audio-only size.

### Added

- **Sync button on audiobooks page**: Users can now sync audiobooks directly from the audiobooks page without going through settings or triggering a full enrichment cycle. Shows synced/failed/skipped counts in a toast and refreshes the grid automatically.

## [1.7.1] - 2026-03-17

### Fixed

- **Playlist track count not updating live**: Adding a track to a playlist from the album page or library (collection) no longer requires a page refresh. The React Query cache is now invalidated at all three `addTrackToPlaylist` call sites (`album/[id]/page.tsx`, `useLibraryActions`, `useAddToPlaylistMutation`). Closes #157.
- **Settings: stale restart-required modal removed**: The "Restart Required" modal was a remnant of an old architecture -- services reinitialize live when settings are saved. The modal and all supporting state (`changedServices`, `originalSettings`) have been removed. Closes #158.
- **YouTube / YouTube Music playlist import broken**: `/api/browse/playlists/parse` now handles `youtube.com` and `music.youtube.com` URLs in addition to the short `youtu.be` form. Closes #155.
- **Lidarr MBID mismatch (album MBID sent to artist endpoint)**: `verifyArtistName` was incorrectly receiving the album MBID from Lidarr search results and passing it to the MusicBrainz `/artist/{id}` endpoint, causing 404s on every verification. Closes #156.
- **Hardcoded port-3030 in API base URL detection**: `getApiBaseUrl` no longer hard-codes port 3030 as the "frontend" port. It now returns a relative URL by default, making Kima work behind any reverse proxy or non-standard port mapping. Closes #154.

### Changed

- Dead code removed: unused `setIsBulkAdd` / `setIsAddingToPlaylist` state on album page; unused `useSearchParams()` call in settings page.

## [1.7.0] - 2026-03-16

### Added

- **Vibe 3D galaxy view**: New immersive "galaxy" toggle on the Vibe page renders your library as a navigable 3D star field using React Three Fiber + Three.js. Tracks are positioned by their vibe embeddings, lit by a dynamic space grid with depth lines, and colored by mood. Double-click any point to play. Camera uses map controls with smooth zoom and pan. Rendered in a dedicated `GravityGridScene` with cluster label billboards, optimized point instancing, and post-processing disabled for GPU performance.
- **Vibe map pre-compute and KNN acceleration**: Map data is now pre-computed on the backend at enrichment completion rather than on first page load. KNN graph is built incrementally (100-at-a-time) against a pre-sorted index, cutting cold-start time from seconds to milliseconds on large libraries.
- **GitHub Actions CI pipeline**: Full multi-stage CI across all PRs and pushes to main. Stages: lint + typecheck (frontend + backend), unit tests (Jest), security scan (CodeQL + secrets), E2E predeploy tests (Playwright against a real Docker build), nightly build + push to Docker Hub and GHCR.
- **E2E enrichment cycle spec**: Playwright test that wipes all enrichment data, triggers a full re-enrich, polls until completion, then asserts track success rate >= 80%, vibe map populated, vibe search returning results, and failure rate < 20%. Skips gracefully when the library has fewer than 10 tracks (CI containers). Companion shell script (`scripts/run-enrichment-memory-test.sh`) captures host SUnreclaim and container RSS before/after and fails the run if slab growth exceeds 1 GB.
- **E2E vibe spec**: Playwright test covering vibe map load, track selection, song path generation, vibe search, alchemy (track blending), and similar-tracks suggestions.
- **PWA offline fallback**: Service worker now serves a cached offline page when navigation requests fail. Cached on install alongside the app shell.
- **PWA update banner**: App detects when a new service worker is waiting and shows a non-blocking "Update available" banner. Clicking it activates the new worker and reloads.
- **Web app manifest fixes**: `display_override` with `window-controls-overlay` for desktop PWA title bar space. Corrected `scope`, `start_url`, and `id` fields. Added `edge_side_panel` and screenshot metadata.

### Fixed

- **Enrichment: audio counter stale at completion**: `audio.completed` in the Redis state snapshot was frozen at the value from the last `audioQueued > 0` cycle. Once all tracks were queued, the update block was skipped while Essentia continued processing in the background, leaving the counter stuck (e.g. 171/232). The counter is now flushed from the live DB count at the `isFullyComplete` transition before going idle.
- **Security: double authentication in system settings**: `requireAdmin` already enforces authentication, so the redundant `requireAuth` call before it was removed.
- **Security: OOM from Next.js VMA accumulation**: The App Router's map-style routes allocate ~15 TB of virtual memory, causing `anon_vma_chain` slab exhaustion on the host kernel. Mitigations: Docker memory cap (`mem_limit: 6g`, `memswap_limit: 8g`) in both compose files; Node 22 in the Dockerfile (V8 improvements reduce anonymous VMAs); `MALLOC_ARENA_MAX=1` for the frontend process (fewer glibc arenas); `NODE_OPTIONS=--max-old-space-size=512` for the frontend (bounds heap to reduce GC-driven VMAs).
- **Security: DoS vectors patched**: Unbounded enrichment queue, unguarded bulk endpoints, and routes missing rate limits addressed in the production hardening pass.
- **Security: SSRF vector in webhook callback validation**: Callback URLs are now validated against an allowlist of configured hosts before being followed.
- **Vibe map accuracy**: SLERP interpolation corrected, similarity formula made consistent between search and map. Distinct mood colors assigned per cluster. ARIA labels added to interactive elements.
- **Vibe map timer leak**: `setInterval` polling the map data endpoint was not cleared on unmount. Replaced with React Query cache with explicit `staleTime`.
- **Vibe request ref cleanup**: `vibeRequestRef` was not cleaned up on component unmount, causing stale abort signals on re-mount.
- **Mobile: full-height vibe page rendering**: CSS height chain corrected from `html`/`body` through layout to vibe page so the map fills the viewport without overflow or clipping on mobile.
- **Subsonic: `.view` suffix normalization**: Requests from clients that append `.view` to endpoint names (e.g. `getCoverArt.view`) are now normalized before routing. Expanded OpenSubsonic endpoint compatibility.
- **Service worker: stale styles after rebuild**: SW was caching HTML and CSS documents, causing users to see outdated styles until manual cache clear. HTML and CSS are now excluded from the SW cache entirely.
- **dead `sourceTrack` variable**: Removed dead variable from vibe request path.
- **Abort signal not wired to vibe fetch**: Cancelling a vibe search now properly aborts the in-flight fetch.

### Changed

- **vibe-test prototype page removed**: The `/vibe-test` dev sandbox page and its associated R3F prototype components (`VibeUniverse`, `TrackCloud`, `TrackTooltip`, `universeUtils`) have been removed. The production galaxy view lives in `GravityGridScene`.
- **NowPlayingTab simplified**: Removed legacy MusicCNN sections from the vibe sidebar -- radar chart (recharts), mood spectrum bars, audio features grid (BPM/key/energy/danceability/valence/arousal), and match score badge. These all showed "--" because `audioFeatures` is no longer populated since the vibe system moved to CLAP. The tab now shows album art and track info only.
- **README**: Vibe section rewritten with Map, Galaxy, Drift, and Blend subsections and fresh screenshots. All 19 screenshots retaken at 1440x900 desktop / 390x844 mobile with correct logo rendering.

### Removed

- `recharts` dependency (zero usages after NowPlayingTab cleanup).
- Dead dev artifacts: `backend/test_dedup_manual.ts`, `backend/src/scripts/testDataCleanup.ts`.

## [1.6.4] - 2026-03-12

Fixes #152. Addresses #145.

### Fixed

- **Version display (#152)**: Frontend and backend package.json were not bumped for 1.6.3. Both now read from package.json dynamically
- **Long track playback stalling (#145)**: Added playback watchdog that monitors currentTime progress every 1s. If no advancement for 3s while playing, automatically reloads the stream at the saved position and resumes playback. Supplementary stalled event listener with 10s grace timer as fallback recovery path. Recovery limited to 3 attempts before surfacing an error
- **Page refresh kills playback (#145)**: After a page refresh, pressing play now reloads the stream for the restored track/audiobook/podcast instead of doing nothing. Audiobook and podcast progress is seeked to saved position
- **Network retry improvements**: Exponential backoff (1s/2s/4s) replaces linear (2s/4s), max retries bumped from 2 to 3. Network retries and stall recoveries now auto-resume playback instead of requiring manual "Tap play to resume"
- **Stream cache validation**: Added ETag and Last-Modified headers to audio streaming responses, enabling browser If-Range optimization for efficient reconnection after stalls

### Changed

- **Centralized User-Agent version**: All backend HTTP clients now use a shared USER_AGENT constant from config.ts (derived from package.json) instead of hardcoded version strings scattered across 12 files

## [1.6.2] - 2026-03-05

Closes #32. Partially addresses #25, #90, #124, #139.

### Added

- **Skip MusicBrainz when Lidarr disabled (#90, #124)**: Playlist imports no longer call MusicBrainz for MBID resolution when Lidarr is not configured. Soulseek searches by artist+album+track text and never uses MBIDs, so MB API calls were pure waste for Soulseek-only users. A 170-song import that took ~15 minutes now generates its preview in seconds. Albums without MBIDs route directly to Soulseek instead of being blocked or misrouted to track-based acquisition.
- **Import cancellation with AbortSignal**: Cancelling a playlist import now immediately aborts all in-flight and queued Soulseek searches and downloads. Previously, `cancelJob()` only marked DB records as failed while rate-limiter-queued searches continued executing for minutes. AbortSignal threads from `cancelJob()` through the PQueue album pipeline, acquisition service, rate limiter, search strategies, and download retry loop.
- **Background playlist imports**: Importing a playlist URL no longer navigates to a full-page progress screen. Imports fire in the background with a toast notification, and the user stays on their current page. Completion, failure, and cancellation show toast notifications via SSE events.
- **Import URL dedup**: Submitting the same playlist URL while an import is already active returns the existing job instead of creating a duplicate. URLs are normalized (host + pathname, trailing slashes stripped) for reliable matching.
- **Imports management tab**: New "Imports" tab in the Activity Panel shows all active and past imports with real-time progress bars, status badges, cancel buttons, and links to created playlists.
- **Import page reconnect**: Refreshing `/import/playlist` while an import is running reconnects to the active job's progress instead of showing a blank form.
- **Early playlist name resolution**: Quick imports now fetch the real playlist name from Spotify/Deezer before enqueueing, so the Imports tab shows the actual name immediately instead of a generic placeholder.

- **Playlist action hub**: Create, Import URL, Import File (M3U), and Browse buttons directly on the playlists page. No more navigating through Browse to import.
- **Sidebar create playlist**: The "+" button in the sidebar now opens an inline create dialog instead of navigating away.
- **M3U playlist import**: Upload `.m3u` / `.m3u8` playlist files to create playlists by matching entries against your library. 4-tier matching: file path, filename, exact metadata, fuzzy metadata (fuzzball).
- **Multi-playlist add**: The "Add to Playlist" picker in the full player now supports selecting multiple playlists at once with checkboxes and a confirm button. Existing single-select callers are unchanged.
- **Playlist visibility toggle**: Globe/Lock button on the playlist detail page lets owners toggle public/private visibility. Previously required database editing for imported playlists.
- **BullMQ import queue**: Playlist imports (Spotify, Deezer, M3U) now run via a dedicated `playlist-import` BullMQ queue instead of fire-and-forget async. Provides crash recovery, visibility in Bull Board admin panel, and proper queue semantics.
- **Podcast refresh buttons**: RefreshCw button on podcast detail page checks for new episodes. "Refresh All" button on main podcasts page queues refresh for all subscriptions via BullMQ.
- **Custom RSS feed subscription**: "Add RSS Feed" button on the main podcasts page lets users subscribe to any podcast by pasting a direct RSS feed URL, without needing to find it on Apple Podcasts.
- **Conditional GET for feed refresh**: Podcast feed fetches now send `If-Modified-Since` and `ETag` headers, receiving 304 Not Modified when feeds haven't changed. Reduces bandwidth and server load for hourly auto-refresh.

### Changed

- **Route rename**: `/library` is now `/collection` (redirects preserved). `/import/spotify` is now `/import/playlist` (redirects preserved with query params).
- **Onboarding simplified to 2 steps**: Removed the informational step 3 (enrichment/analysis features). Onboarding is now Account + Integrations, with "Complete Setup" finishing directly from step 2.
- **Smoother sync progress bar**: SSE events now emit every 1% instead of 2%, and polling fallback tightened from 2s to 500ms. Progress bar reflects real scan data at higher resolution.
- **Import cancel cleanup**: Cancelling an import now fully removes all DB records, Redis cache entries, and BullMQ jobs. Failed imports with zero matched tracks also clean up automatically. Partial failures preserve matched tracks.

### Fixed

- **Security: hardcoded Last.fm API key removed**: Default fallback API key removed from source code. `LASTFM_API_KEY` environment variable is now required for Last.fm enrichment.

### Removed

- Dead code cleanup: removed 3 unused service files (`openai.ts`, `fileValidator.ts`, `Skeleton.tsx`), 16 unused exports across utils/middleware/workers, and debug console.logs from Soulseek search hook.

- **Spotify 100-track pagination**: Anonymous Spotify tokens cap `tracks.total` at 100, preventing pagination from triggering. Now speculatively fetches additional pages when a full page of results is received, bypassing the cap for playlists of any size.
- **Playlist partial update schema**: `PUT /playlists/:id` previously required `name` in every request body (using create schema). Now uses a dedicated update schema where both `name` and `isPublic` are optional, supporting partial updates without resetting unrelated fields.
- **Artist MBID race condition**: Concurrent enrichment workers could both check that an MBID was free, then both try to claim it, crashing the second worker with a unique constraint violation. All four MBID write sites now catch Prisma `P2002` errors and gracefully skip the MBID update while preserving other enrichment data.
- **Double import on page refresh**: Refreshing `/import/playlist` while an import was running fired a second import for the same URL. Removed auto-start behavior; the page now checks for active imports and reconnects to them.

## [1.6.1] - 2026-03-03

Closes #121, #125, #136, #138. Partially addresses #139, #25, #108, #30.

### Added

- **Share links**: Generate shareable URLs for playlists, tracks, and albums. Public playback page with built-in audio player, no account required. Token-based access with optional expiry and play count limits. Share popover in playlist page with copy-to-clipboard and revoke.
- **Playlist inline rename**: Click playlist title to edit in place. Enter to save, Escape to cancel, click-away to save. Input stays open on save failure for retry.
- **Player queue and add-to-playlist buttons**: Queue navigation button and add-current-track-to-playlist button in the full player bar.
- **Local artist images**: Library scanner discovers `artist.jpg`/`folder.jpg`/`.png`/`.webp` in music directories and copies them to the image cache. Enrichment preserves local images over external URLs.
- **Playback queue expanded to 2000 items**: Queue storage increased from 100 to 2000 tracks (frontend and backend).
- **GHCR publishing**: Docker images now published to GitHub Container Registry alongside Docker Hub on tagged releases. Credit to @SupremeMortal (#48).
- **#134 Lidarr batch album fetching**: Large Lidarr libraries no longer crash with V8 string overflow -- albums are fetched in paginated batches. Credit to @cachamber.
- **#132 Preview volume sync**: Preview audio volume now syncs with the global player volume. Credit to @cachamber.
- **Safari audio session hint**: Explicitly sets `navigator.audioSession.type = "playback"` on Safari 16.4+ to ensure the correct AVAudioSession category before first playback.

### Fixed

- **Security: path traversal in cover art serving**: `getLocalImagePath` and `getResizedImagePath` lacked path containment checks. Added `path.resolve` + `startsWith` guards matching the existing `validateCoverPath` pattern. Removed dead `localImageExists` function.
- **Security: share stream missing error handlers**: Raw `createReadStream.pipe(res)` replaced with `streamFileWithRangeSupport` utility for proper stream error handling and file descriptor cleanup on client disconnect.
- **Security: global JSON body limit too broad**: 5mb limit applied to all routes. Replaced with conditional middleware -- 5mb for playback state only, 1mb for everything else.
- **Enrichment: manual enrich overwrites local artist images**: `applyArtistEnrichment` unconditionally replaced `heroUrl` with external URLs. Added DB re-read + native path guard matching the background worker.
- **Enrichment: stale heroUrl reference in download fallback**: Removed misleading `artist.heroUrl` check on stale function parameter. The downstream DB re-read handles native path preservation.
- **Scanner: wrong artist image in deep directory structures**: Directory iteration went shallow-to-deep, matching genre-level `folder.jpg` before artist-level. Reversed to deep-to-shallow.
- **UI: playlist rename and add-to-playlist fail silently**: Added try/catch with toast errors. Rename input stays open on failure for retry.
- **Mobile: double-tap to play tracks not working**: `onDoubleClick` on track rows does not fire on touch devices. Added `touch-action: manipulation` and custom double-tap detection via `onTouchEnd` with 300ms window across all 7 track list components. Desktop double-click preserved.
- **Mobile lyrics: text clipped by album art container**: Lyrics crawl rendered above album art but was clipped by the parent's `overflow-hidden`. Replaced with a full lyrics view that swaps out the album art when active. Synced lyrics auto-scroll to the active line; plain lyrics are freely scrollable.
- **Enrichment: audio analysis and vibe embeddings running simultaneously**: Both ML models (Essentia + CLAP) competed for CPU/GPU, causing UI flickering. Vibe phase now defers until audio analysis is fully idle. Removed per-track vibe job queuing from the audio completion subscriber -- `executeVibePhase` sweep is now the sole queuing path.
- **UI: activity panel reopens after closing**: `useEffect` dependency on the full `activityPanel` object caused event listener teardown/re-register on every open/close. Destructured to stable `useCallback` refs.
- **UI: silent failures on playlist operations**: `handleRemoveTrack`, `handleToggleHide`, `handleRemovePendingTrack`, and `handleDeletePlaylist` caught errors with only `console.error`. Added `toast.error` to all four.
- **Player: dead `handleSeek` wrappers**: Removed pass-through wrappers in FullPlayer, OverlayPlayer, and MiniPlayer. `seek` passed directly to `SeekSlider`.
- **Artist page popular tracks**: Improved title matching with three-tier fallback (exact, normalized, aggressively stripped) so remaster/deluxe variants match correctly as owned. Unowned tracks now show artist hero image instead of gray placeholder.
- **Card hover overlay regression**: Dark gradient overlays caused blackout effect on album art hover. Made overlay conditional on playable cards, softened opacity on grid cards.
- **Album navigation delay**: First click to album pages felt unresponsive due to `prefetch={false}` on all card Links. Enabled Next.js prefetching for instant navigation.
- **GHCR image name casing**: `github.repository_owner` preserves uppercase but GHCR requires all-lowercase. Compute image name at runtime with bash lowercase conversion.
- **#128 Subsonic rate limit too low for Symfonium sync**: Large libraries (2000+ songs) hit the 300 req/min rate limit during Symfonium sync. Bumped to 1500 req/min -- self-hosted service behind auth, no brute-force risk.
- **Mobile: lock screen always shows "playing" / steals Bluetooth/CarPlay**: Removed the silence keepalive system that looped near-silent audio to maintain the OS audio session while paused.
- **Mobile: resumeWithGesture shows "playing" when blocked by OS**: Now awaits confirmation and reverts on failure.
- **Audiobook progress overwritten on track end**: Completion flag was immediately overwritten by the pause-triggered progress save. Fixed ordering.
- **Duplicate "play" event firing**: Now emits only on `playing` (when audio is actually producing sound).
- **MediaSession metadata unnecessary re-renders**: Removed `isPlaying` from metadata effect deps.
- **Mobile: lock screen stuck on "playing" after errors**: Added `error` event to MediaSession playbackState listeners.
- **Mobile: audio stops silently in background**: Network retry now emits proper error for UI recovery.
- **Mobile: foreground recovery too narrow**: Clears error on foreground return.
- **Podcast progress bar reverts on pause**: Now updates React state after API save.
- **Mobile: permanent pause after phone call/Siri**: Tracks pre-interruption state and attempts auto-resume.
- **Enrichment: `isPaused` permanently stuck after Stop**: Moved `isStopping` handler to top of cycle.
- **Enrichment: vibe re-run doesn't restart cycle**: Now calls `triggerEnrichmentNow()` and cleans completed BullMQ jobs.
- **Enrichment: BullMQ jobId dedup silently drops re-queued vibe tracks**: Added `vibeQueue.clean(0, 0, 'completed')` before `addBulk()`.
- **Enrichment: stale failure records inflate "View Failures" count**: CLAP analyzer resolves failures on success.

### Removed

- **Swagger API documentation**: Removed `swagger-jsdoc`, `swagger-ui-express`, and all 16 `@openapi` annotations. 30 packages eliminated.
- **Debug logging**: Removed 20 debug `console.log`/`console.warn` statements.
- **Unused dependencies**: Removed `react-virtuoso`, `silence-keepalive.ts`, dead `pauseRef`.

### Changed

- **Audio state context cleanup**: Removed unused exports `isRepeat`, `lastServerSync`, `setLastServerSync`, `isHydrated` from context type and provider value.

- **Frontend query keys standardized**: Raw `["playlist", id]` string arrays replaced with centralized `queryKeys` helpers across the playlist page.
- **Share API `entityType` typed**: Parameter typed as `"playlist" | "track" | "album"` union instead of `string`.
- **Playlist mutations use React Query**: Track removal and playlist deletion now use mutation hooks with automatic cache invalidation instead of direct API calls.
- **AuthenticatedLayout**: Public path matching changed from exact match to prefix match for `/share/*` routes.
- **Playlist import performance**: Parallelized MusicBrainz lookups via Promise.all. Batch-loaded all library tracks -- reduced ~3000 per-track DB queries to 2 batch queries.
- **Dependencies**: Updated safe patches -- @bull-board 6.20.3, axios 1.13.6, bullmq 5.70.1, ioredis 5.10.0, fast-xml-parser 5.4.1 (stack overflow CVE fix), tailwindcss 4.2.1, framer-motion 12.34.3, tailwind-merge 3.5.0. Fixed npm audit vulnerabilities.

## [1.6.0] - 2026-03-02

### Fixed

- **Enrichment: failure count inflation**: Python audio analyzer recorded EnrichmentFailure on every attempt, not just after max retries. Removed Python writer; Node.js audioAnalysisCleanup is now the sole writer. Added success resolution in `_save_results()` for immediate cleanup instead of hourly sweep lag.
- **Enrichment: isPaused permanently stuck after Stop**: Stop control message set `isPaused=true` which was never cleared because `shouldHaltCycle()` was unreachable from the early return. Moved `isStopping` handler to top of `runEnrichmentCycle()`. Added `userStopped` flag to prevent auto-restart via timer while allowing explicit re-run/enrich actions.
- **Enrichment: Stop doesn't reach Python analyzer**: `enrichmentState.stop()` only published to `enrichment:control`. Now also publishes `pause` to `audio:analysis:control` (not `stop`, which would exit the process). Resume publishes `resume` to both channels. All re-run functions resume the Python analyzer via `clearPauseState()`.
- **Enrichment: state sync stopping deadlock**: If `enrichment:control` message was lost but state service showed `stopping`, the sync set `isPaused=true` with no `isStopping` to clear it. State sync now handles `stopping` directly by transitioning to idle.
- **Enrichment: reverse sync for missed resume**: If local `isPaused` was stale but state service showed `running`, the cycle stayed paused. Added reverse sync to detect and clear the mismatch.
- **Enrichment: crash recovery gaps**: Startup now resets artists stuck in `enriching` status and tracks with `_queued` sentinel in `lastfmTags`, in addition to existing audio/vibe processing resets.
- **Import: duplicate playlists on large imports**: `checkImportCompletion()`, `buildPlaylistAfterScan()`, and `buildPlaylist()` lacked idempotency guards. Late download callbacks and queueCleaner re-queued scans that each created a new playlist. Added status guards at all three layers.
- **Import: processImport overwrites cancel**: Setting `status="downloading"` without checking if already cancelled. Added cancel guard.
- **Enrichment failures: TOCTOU race in recordFailure**: Find-then-create pattern replaced with atomic `prisma.enrichmentFailure.upsert()`. Also resets `resolved=false` on re-failure (previously hidden from UI).
- **Enrichment failures: Python/Node.js Track status race**: Added `WHERE analysisStatus='processing'` optimistic lock to `_save_results()` and `_save_failed()`. Prevents stale writes when cleanup resets a track near the 15-minute threshold.
- **Discovery: duplicate Discover Weekly jobs**: `discoverQueue.add()` now uses deterministic `jobId` based on userId + week, preventing cron/manual trigger overlap.
- **Discovery: checkBatchCompletion race**: Re-reads batch status after 60s Lidarr wait. Added `expectedStatus` parameter to `updateBatchStatus` optimistic locking for belt-and-suspenders protection.
- **Discovery: album status reset on regeneration**: `discoveryAlbum.upsert()` update branch no longer sets `status: "ACTIVE"`, preserving user's LIKED/DELETED decisions.
- **Scanner: ownedAlbum duplicate constraint violation**: Replaced `create()` with `upsert()` using compound key.
- **Streaming: transcodedFile duplicate constraint violation**: Replaced `create()` with `upsert()` on `cachePath`.
- **Downloads: notification retry creates duplicates**: Added dedup check before `downloadJob.create()` at all 3 retry handlers.
- **Webhook: unnecessary Lidarr API calls**: Skip reconciliation when no processing download jobs exist.
- **Infrastructure: audio-analyzer supervisor autorestart**: Changed from `unexpected` to `true` (matching backend fix).
- **Infrastructure: Redis startup race**: Added Redis readiness loop to `wait-for-db.sh` with separate counter. Backend supervisor changed to `autorestart=true`.
- **Python: deprecated datetime.utcnow()**: Replaced with `datetime.now(timezone.utc)`.

### Added

- 37 new tests across 9 test files covering enrichment state machine, idempotency guards, queue dedup, notification dedup, and Python optimistic locking.

## [1.6.0-pre.2] - 2026-03-01 (nightly)

### Fixed

- **Enrichment: vibe progress jumps 0% to 100%**: CLAP analyzer reported completion via internal HTTP callbacks but never emitted SSE events. Added `enrichment:progress` SSE event type with broadcast support (`userId: "*"`), emitted from vibe success/failure endpoints. Frontend SSE handler invalidates the `enrichment-progress` query on each event for immediate re-fetch.
- **SSRF protection**: Added `validateUrlForFetch()` to podcast stream and download paths to block requests to internal networks.
- **CORS enforcement**: Reject unlisted CORS origins instead of allowing all.
- **Encryption KDF**: Always derive encryption key via SHA-256 with legacy fallback.
- **Query limits**: Clamp `/plays` limit to max 200.
- **Webhook secret comparison**: Use `crypto.timingSafeEqual` for timing-safe webhook secret validation.
- **Webhook log spam**: Rate-limit missing webhook secret warning to once per process.
- **Stream TTL sweep**: Add 1-hour TTL sweep for stale `activeStreams` entries.
- **Transcode race condition**: Deduplicate concurrent transcodes via in-flight map.
- **Streaming singleton**: Make `AudioStreamingService` a singleton to prevent duplicate instances.
- **Enrichment reset**: Exclude processing tracks from full enrichment reset.
- **Image cache eviction**: Add LRU eviction to `useImageColor` localStorage cache (max 500 entries).
- **Preview audio leak**: Remove old preview audio elements from map when switching tracks.
- **Keyboard shortcut re-renders**: Move keyboard shortcut deps to refs for stable effect.
- **Player polling loop**: Move `lastServerSync`/queue/index/shuffle to refs in poll effect.
- **Queue desync on track removal**: Handle removing current track from middle of queue.
- **Overlay re-open on auto-advance**: Don't re-open overlay on auto-advance after first play.
- **Previous track restart**: Restart current track if position > 3s on previous button press.
- **Podcast detection**: Split podcast composite ID before URL comparison.

## [1.6.0] - 2026-02-28

### Added

- **Synchronized lyrics**: LRCLIB integration fetches timed `.lrc` lyrics during library scan. Full-player and overlay-player display synced lyrics with a 3-line stacked view (previous/current/next). Lyrics toggle in activity panel with owner-based priority so Discovery settings don't override an active lyrics view.
- **LRCLIB rate limiting**: Lyrics API calls go through the global rate limiter (2 req/s, concurrency 1) to respect upstream limits.

### Fixed

- **Enrichment pipeline**: Fixed 7 issues -- vibe re-run no-ops (dedup cache not cleared), completion notification never firing (dead in-memory counters replaced with DB query), infinite artist retry loop (final attempt reset status to pending), phantom state after shutdown, podcast failures excluded from counts, orphaned frontend type, and removed dead vibe reset endpoint.
- **Feature flags go stale**: Now polls every 60s instead of fetching once on mount.
- **Mood mixer threshold mismatch**: Frontend threshold now matches backend minimum (8 tracks).
- **iOS Safari audio playback**: Reset stale network retry count on preload swap, removed competing silence keepalive from resume gesture, guarded redundant `play()` calls, pre-set track ref for deterministic deduplication, and capped error cascade at 3 consecutive failures.
- **iOS AirPod/lock-screen resume**: Silence keepalive `prime()` in the MediaSession play handler consumed the iOS user gesture budget before the actual audio resume. Moved keepalive priming to the pause handler so the play handler's full gesture is available for `tryResume()`.
- **Audio analyzer retry loop**: Failed tracks had retry count reset to 0 on re-queue, bypassing the max-retries guard. Now preserves count so broken tracks are excluded after 3 attempts.
- **CLAP search timeouts**: Model unloaded after 10s idle when all tracks were embedded, causing ~20s cold-start on every vibe search. Now uses standard 5-minute idle timeout. Backend search timeout increased to 60s.

## [1.5.11] - 2026-02-27

### Added

- **#25** Full playlist pagination for Spotify and Deezer imports -- playlists of any size are now fully imported instead of silently capping at 100 (Spotify) or 25 (Deezer) tracks. Paginated fetch with rate limit handling, partial result recovery, and SSE progress reporting ("Fetching tracks: X of Y...").
- **#8** Configurable Lidarr quality and metadata profiles -- previously hardcoded to profile ID 1. New dropdowns in Settings > Download Services appear after a successful connection test, populated from Lidarr's API. Stored in system settings and used for all artist/album additions.

## [1.5.10] - 2026-02-27

### Added

- **#122** `DISABLE_CLAP=true` environment variable to disable the CLAP audio embedding analyzer on startup in the all-in-one container (useful for low-memory deployments)
- **#123** Foobar2000-style track title formatting in Settings > Playback -- configure a format string with `%field%`, `[conditional blocks]`, `$if2()`, `$filepart()` syntax; applied in playlist view
- **#124** Cancelling a playlist import now creates a partial playlist from all tracks already matched to your library, instead of discarding progress

### Fixed

- **#124** Cancel button previously promised "Playlist will be created with tracks downloaded so far" but discarded all progress -- now delivers on that promise
- **iOS lock screen controls inverted**: MediaSession `playbackState` was driven by React `useEffect` on `isPlaying` state, which fires asynchronously after render -- not synchronously with the actual audio state change. This caused lock screen controls to show the opposite state (play when playing, pause when paused). Rewrote MediaSession to drive `playbackState` directly from `audioEngine` events, call the engine directly from action handlers to preserve iOS user-gesture context, and use ref-based one-time handler registration to avoid re-registration churn.
- **Favicon showing old Lidify icon or wrong Kima logo**: Browser tab showed the pre-rebrand Lidify favicon. Replaced with the waveform-only icon generated from `kima-black.webp` as a proper multi-size ICO (16/32/48/64/128/256px) with tight cropping so the waveform fills the tab space.
- **Enrichment pipeline: no periodic vibe sweep**: The enrichment cycle had no phase for queueing vibe/CLAP embedding jobs. The only automatic path was a lossy pub/sub event from Essentia completion -- if missed (crash, restart, migration wipe), tracks were orphaned forever. Added Phase 5 that sweeps for tracks with completed audio but missing embedding rows via LEFT JOIN.
- **Enrichment pipeline: crash recovery dead end**: Crash recovery reset `vibeAnalysisStatus` from `processing` to `null`, which nothing in the regular cycle re-queued. Changed to reset to `pending` so the periodic sweep picks them up.
- **Enrichment pipeline: CLAP analyzer permanent death**: When enrichment was stopped, the backend sent a stop command causing the CLAP analyzer to exit cleanly (code 0). Supervisor's `autorestart=unexpected` treated this as expected and never restarted. Changed to `autorestart=true` and removed the stop signal entirely -- the analyzer has its own idle timeout.
- **Enrichment pipeline: completion never triggers**: `isFullyComplete` required `clapCompleted + clapFailed >= trackTotal`, which was impossible after `track_embeddings` was wiped by migration. Now checks for actual un-embedded tracks via LEFT JOIN.
- **Enrichment pipeline: "Reset Vibe Embeddings" incomplete**: `reRunVibeEmbeddingsOnly()` reset `vibeAnalysisStatus` but did not delete existing `track_embeddings` rows, so the re-queue query (which uses LEFT JOIN) silently skipped tracks that already had embeddings. Now deletes all embeddings first for full regeneration.
- **Feature detection: CLAP reported available when disabled**: When `DISABLE_CLAP=true` was set, `checkCLAP()` skipped the file-existence check but still fell through to heartbeat and data checks. If old embeddings existed in the database, it returned `true`, causing the vibe sweep to queue jobs that no CLAP worker would ever process. Now returns `false` immediately when disabled.
- **docker-compose.server.yml healthcheck using removed tool**: Healthcheck used `wget` which is removed from the production image during security hardening. Changed to `node /app/healthcheck.js` to match docker-compose.prod.yml.
- **#126 Subsonic JSON `getGenres.view` breaking Symfonium**: Genre responses used `#text` for the genre name in JSON output -- correct for XML but violates the Subsonic JSON convention which uses `value`. Symfonium's strict JSON parser rejected the response. Fixed `stripAttrPrefix()` to map `#text` to `value` in all JSON responses.
- **#126 Subsonic `getBookmarks.view` not implemented**: Symfonium calls `getBookmarks.view` during sync and expects a valid response with a `bookmarks` key. The endpoint hit the catch-all "not implemented" handler, returning an error without the required key. Added an empty stub returning `{ bookmarks: {} }`.
- **#91 Artist page only showing 5 popular tracks**: Frontend sliced popular tracks to 5 even though the backend returned 10. Now displays all 10.
- **#63 MusicBrainz base URL hardcoded**: MusicBrainz API URL was hardcoded, preventing use of self-hosted mirrors. Now configurable via `MUSICBRAINZ_BASE_URL` environment variable (defaults to `https://musicbrainz.org/ws/2`).

## [1.5.8] - 2026-02-26

### Fixed

- **Mobile playback: infinite network retry loop**: On mobile networks, transient `MEDIA_ERR_NETWORK` errors triggered a retry cycle that never terminated -- `canplay` and `playing` events reset the retry counter to 0 on every cycle, and `audio.load()` reset `currentTime` to 0, causing the "2-3 seconds then starts over" symptom. Fixed by removing the premature counter resets (counter now only resets on new track load) and saving/restoring playback position across retries.
- **Mobile playback: silence keepalive running during active playback**: The silence keepalive element (used to hold the iOS/Android audio session while paused in background) was started via `prime()` from a non-gesture context, then `stop()` failed to pause it because the `play()` promise hadn't resolved yet, making `el.paused` still true. Fixed by adding proper async play-promise tracking with a `pendingStop` flag, and removing the non-gesture `prime()`/`stop()` calls from the audio engine's `playing` event handler.
- **Mobile playback: play button tap fails to resume on iOS**: All in-app play buttons called `resume()` which only set React state; the actual `audio.play()` ran in a `useEffect` after re-render, outside the iOS user-gesture activation window. Fixed by adding a `resumeWithGesture()` helper that calls `audioEngine.tryResume()` and `silenceKeepalive.prime()` synchronously within the gesture context -- the same pattern already used by MediaSession lock-screen handlers. Applied across all 13 play/resume call sites.
- **Mobile playback: lock screen / notification controls unresponsive after app restore**: MediaSession action handlers were never registered when the app loaded with a server-restored track because the `hasPlayedLocallyRef` guard blocked registration, and the handler registration effect's dependency array was missing `isPlaying`, so it never re-ran when the flag was set. Fixed by adding `isPlaying` to the dependency array.
- **Cover art proxy transient fetch errors**: External cover art fetches that hit transient TCP errors (`ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`) now retry once with a 500ms delay before failing.

### Security

- **Error message leakage**: All ~82 backend route catch blocks replaced with a `safeError()` helper that logs the full error server-side but returns only `"Internal server error"` to the client. Prevents stack traces, file paths, and internal details from leaking to users.
- **SSRF protection on cover art proxy**: The cover-art proxy endpoint now validates URLs before fetching -- blocks private/loopback IPs, non-HTTP schemes, and resolves DNS to check for rebinding attacks. Audiobook cover paths also block directory traversal.
- **Login timing side-channel**: Login endpoint previously returned early on user-not-found, allowing username enumeration via response timing. Now runs a dummy bcrypt compare against an invalid hash to normalize response times regardless of whether the user exists.
- **Device link code generation**: Replaced `Math.random()` with `crypto.randomInt()` for cryptographically secure device link codes.
- **Unscoped user queries**: Added `select` clauses to all Prisma user queries that previously loaded full rows (including `passwordHash`) when only the ID or specific fields were needed.
- **Metrics endpoint authentication**: `/api/metrics` now requires authentication.
- **Registration gate**: Added `registrationOpen` system setting (default: closed) and rate limiter on the registration endpoint. After the first user is created, new registrations require an admin to explicitly open registration.
- **Admin password reset role check**: Fixed case mismatch (`"ADMIN"` vs `"admin"`) that could allow non-admin users to trigger password resets.

### Housekeeping

- Removed unused `sectionIndex` variables in audiobooks, home, and podcasts pages.
- Removed dead commented-out album cover grid code and unused imports in DiscoverHero.
- Fixed missing `useCallback` wrapper for `loadPresets` in MoodMixer.
- Added missing `previewLoadState` to effect dependency array in usePodcastData.

## [1.5.7] - 2026-02-23

### Added

- **BullMQ enrichment infrastructure**: Rewrote the entire enrichment pipeline on top of BullMQ v5, replacing the custom BLPOP/Redis queue loops. Artist, track, and podcast enrichment all run as proper BullMQ Worker instances with job-level pause, resume, and stop support. All queues are visible in the Bull Board admin dashboard. The orchestrator pushes jobs into BullMQ and uses a sentinel pattern to track when all jobs in a phase have completed before advancing.
- **Reactive vibe queuing**: The Essentia audio analyzer now publishes an `audio:analysis:complete` event to Redis when each track finishes. The CLAP service subscribes and immediately queues a vibe embedding job for that track — eliminating the previous polling-based approach where CLAP scanned the database on a fixed interval looking for newly-completed Essentia tracks.

### Fixed

- **PWA background audio session lost on iOS and Android**: Pausing from lock-screen / notification controls while the app was backgrounded caused iOS to reclaim the audio session, blocking any subsequent `audio.play()` call until the app was foregrounded. Fixes two related symptoms: (1) resuming from lock-screen controls appeared to do nothing until the app was opened, (2) music stopped after extended background playback during track transitions. Fixed by: calling `audioEngine.tryResume()` synchronously inside the MediaSession `play` handler (within the user-activation window iOS grants to MediaSession callbacks); adding a silent looping audio keepalive (`silence-keepalive.ts`) that holds the OS audio session while user audio is paused and the app is backgrounded; loading the next track directly from the `ended` event handler to eliminate the inter-track silence gap that triggered session reclaim; and adding `visibilitychange` / `pageshow` foreground recovery to retry playback if the engine is paused when the app returns to the foreground.
- **Discovery "Retry All" importing entire albums already in library**: The `POST /discover/retry-unavailable` endpoint fetched all raw `UnavailableAlbum` records for the week without applying the same three-level filter the `GET /current` endpoint uses before displaying them. As a result, clicking "Retry All" triggered full re-downloads of albums that were already present in the library (matched by discovery MBID, library MBID, or fuzzy title+artist). The retry handler now applies all three filters before creating download jobs, and deletes stale `UnavailableAlbum` records for albums already in the library so they do not reappear. Closes #34.
- **Mood-tags phase silently skipping all tracks**: `lastfmTags` was `NULL` for tracks that had been enriched before the column was added. The mood-tags enrichment phase queries `WHERE lastfmTags != '{}'`, which never matches `NULL` — so every track was silently skipped every cycle. Migration backfills all `NULL` values to `'{}'` and sets the column default, so newly enriched tracks are never NULL.
- **Docker image size (28.4 GB → 12.2 GB)**: Removed all CUDA and NVIDIA dependencies from the Docker image. The `audio-analyzer` and `audio-analyzer-clap` services now run on CPU-only PyTorch and TensorFlow. Changed pip installs to use the CPU-only PyTorch wheel index (`--index-url https://download.pytorch.org/whl/cpu`), replaced `tensorflow` with `tensorflow-cpu`, and installed `essentia-tensorflow --no-deps` to prevent pip from pulling the GPU TensorFlow variant as a transitive dependency. Removed `nvidia-cudnn-cu12`, `torchvision` (not imported), the `/opt/cudnn8` CUDA layer, and all NVIDIA library paths from the supervisor `LD_LIBRARY_PATH`. No regressions: TensorFlow confirmed running on CPU, all 9 MusiCNN classification heads load normally.
- **Docker build context bloat**: `frontend/node_modules/` (598 MB) and `frontend/.next/` (313 MB) were not excluded from the Docker build context. The `.dockerignore` `node_modules` pattern only matched root-level; changed to `**/node_modules`. Added `**/.next`. Combined these reduced the `COPY frontend/ ./` layer from 946 MB to ~50 MB.
- **Cover art fetch errors for temp-MBID albums**: Albums with temporary MBIDs (temp-*) were being passed to the Cover Art Archive API, causing 400 errors. Added validation to skip temp-MBIDs in artist enrichment and data cache.
- **VIBE-VOCAB vocabulary file missing**: The vocabulary JSON file wasn't being copied to the Docker image because TypeScript doesn't copy .json files automatically. Added explicit import to force tsc to copy it.
- **Redis memory overcommit warning**: Added `vm.overcommit_memory=1` sysctl to docker-compose.prod.yml and docker-compose.server.yml.
- **Z-index stacking order**: MiniPlayer was z-50 (same tier as modals), causing it to appear above open dialogs due to DOM ordering. Established a consistent stacking hierarchy: MiniPlayer z-[45] → TopBar z-50 → VibeOverlay/toasts z-[55] → MobileSidebar backdrop z-[60] / drawer z-[70] → all modals z-[80] → nested confirm z-[85] → toast z-[100] → OverlayPlayer z-[9999]. MobileSidebar was also using non-standard `z-100` which is not a valid Tailwind class.
- **API token display overflowing viewport on iPhone**: The newly-generated token `<code>` block extended beyond the screen on narrow viewports due to missing `min-w-0` / `overflow-hidden` on its flex container; added both.
- **CLAP BullMQ worker crash on startup**: `import psycopg2` does not implicitly import `psycopg2.pool`; the BullMQ vibe worker was crashing immediately because `psycopg2.pool.ThreadedConnectionPool` was referenced without the submodule being imported. Added explicit `import psycopg2.pool`.
- **EnrichmentStateService Redis disconnect error**: Calling `disconnect()` on an already-closed Redis connection raised an unhandled error. The disconnect is now silenced when the connection is already in a closed state.
- **CLAP worker thread-safety**: All PostgreSQL calls in the CLAP BullMQ worker are now wrapped in `run_in_executor` so they execute on a thread-pool thread rather than blocking the asyncio event loop. Connection pool is initialized once per process and shared safely across concurrent jobs.

## [1.5.5] - 2026-02-21

### Added

- **OpenSubsonic / Subsonic API**: Native client support for Amperfy, Symfonium, DSub, Ultrasonic, Finamp, and any other Subsonic-compatible app
  - Full Subsonic REST API v1.16.1 compatibility, with OpenSubsonic extensions declared
  - **MD5 token auth** — standard Subsonic auth now supported; enter your Kima API token as the password in your client app; the server verifies `md5(token + salt)` against stored API keys, avoiding any need to store plaintext login passwords
  - **OpenSubsonic `apiKey` auth** — generate per-client tokens in Settings > Native Apps; tokens can be named and revoked individually
  - **Endpoints implemented**: `ping`, `getArtists`, `getIndexes`, `getArtist`, `getAlbum`, `getSong`, `getAlbumList2`, `getAlbumList`, `getGenres`, `search3`, `search2`, `getRandomSongs`, `stream`, `download`, `getCoverArt`, `scrobble`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `getUser`, `getStarred`, `getStarred2`, `star`, `unstar`, `getArtistInfo2`
  - **Enrichment-aware genres** — genre fields on albums, songs, and search results are sourced from Last.fm-enriched artist tags rather than static file tags; `getGenres` aggregates across the enriched artist catalogue
  - **Enrichment-aware biographies** — `getArtistInfo2` returns the user-edited summary when present, otherwise the Last.fm biography
  - **HTTP 206 range support** on `stream.view` for seek-capable clients and Firefox/Safari
  - Scrobbles recorded as `SUBSONIC` listen source
  - DISCOVER-location albums are excluded from all library views
- **Named API tokens** — Settings > Native Apps token generator now accepts a client name (e.g., "Amperfy", "Symfonium"); previously all tokens were named "Subsonic"
- **Public server URL setting** — admins can pin a persistent server URL in Settings > Storage; the Native Apps panel reads this URL and falls back to the browser origin when unset

### Fixed

- **Subsonic `contentType` and `suffix` wrong for FLAC/MP3**: The library scanner stores codec names (`FLAC`, `MPEG 1 Layer 3`) rather than MIME types. Added `normalizeMime()` to translate codec names to proper MIME types before surfacing them to clients — fixes clients that refused to play tracks due to unrecognised content types
- **`createPlaylist` returned empty response**: Per OpenSubsonic spec (since 1.14.0), `createPlaylist` must return the full playlist object. Now returns the same shape as `getPlaylist`
- **DISCOVER albums leaking into search and random**: `getRandomSongs` raw SQL and the `search3`/`search2` shared service had no location filter, allowing DISCOVER-only albums to appear in results. Both are now filtered to `LIBRARY` location only
- **PWA icons**: Replaced placeholder icons with the Kima brand — amber diagonal gradient with radial bloom; solid black background for maskable variants; `apple-touch-icon` added; MediaSession fallback artwork wired up
- **Frontend lint errors** (pre-existing): `let sectionIndex` changed to `const` in three pages; `setPreviewLoadState` moved inside the async function to avoid calling setState synchronously in a `useEffect`
- **Vibe orphaned-completed tracks**: Tracks where `vibeAnalysisStatus = 'completed'` but no embedding row exists (left over from the `reduce_embedding_dimension` migration) are now detected and reset each enrichment cycle so they re-enter the CLAP queue

## [1.5.4] - 2026-02-21

### Fixed

- **Vibe embeddings never starting**: `queueVibeEmbeddings` only checked for `NULL` or `'failed'` status, but the `add_vibe_analysis_fields` migration set the column default to `'pending'` — every track was silently skipped forever. Added `'pending'` to the WHERE clause.
- **CLAP infinite retry**: Added `VIBE_MAX_RETRIES` SQL guard to `queueVibeEmbeddings` so permanently-failed tracks (retry count ≥ 3) are never re-queued. Fixed off-by-one: cleanup used `>=` (giving 2 resets) instead of `>` (giving the correct 3).
- **Null byte crash in music scanner**: ASCII control characters in ID3 tags (e.g. embedded null bytes) caused PostgreSQL query failures. `sanitizeTagString()` now strips control chars from title, artist, and album tags before any DB write.
- **Soulseek stuck downloads cycling**: Downloads removed from the active list on timeout or stream error were not removed from `SlskClient.downloads`, causing the slot to be permanently occupied. Added `removeDownload()` and called it in all three error paths (timeout, download stream error, write stream error).
- **Artist enrichment duplicate MBID race condition**: Two artists resolving to the same real MBID simultaneously caused a Prisma `P2002` unique constraint violation, leaving one artist stuck in `processing`. The error is now caught specifically — the duplicate is immediately marked `unresolvable` with a warning log.
- **Admin vibe retry silently skipping tracks**: `POST /vibe/retry` reset `EnrichmentFailure.retryCount` but left `Track.vibeAnalysisRetryCount` at its max value, causing the SQL guard in `queueVibeEmbeddings` to silently skip the track forever. Both counts are now reset together.
- **Preview job missing ownership check**: Spotify preview jobs stored in Redis had no `userId` — any authenticated user could read or consume another user's preview result. `userId` is now stored in the Redis payload and validated on both `GET /preview/:jobId` and `POST /import`.
- **Playlist import DB pool exhaustion**: `matchTrack` inside `startImport` used an unbounded `Promise.all`, saturating the connection pool on large playlists. Wrapped with `pLimit(8)`.
- **PWA safe area double-inset on iOS**: `body` padding and `AuthenticatedLayout` margin both applied `env(safe-area-inset-*)`, doubling the inset gap. Replaced with `--standalone-safe-area-top/bottom` CSS custom properties that default to `0px` in browser mode and are set to the real env values only inside `@media (display-mode: standalone)`. Fixes both the double-inset on iOS PWA and the Vivaldi browser over-inset.
- **Mobile bottom content gap**: Removed the 96px bottom padding (`pb-24`) reserved for the mini player. The player is swipeable so the padding is no longer needed.

## [1.5.3] - 2026-02-18

### Fixed

- **Circuit breaker `circuitOpenedAt` drift**: `failureCount >= CIRCUIT_BREAKER_THRESHOLD` stayed true after threshold failures, resetting `circuitOpenedAt` on every subsequent `onFailure()` call — the same rolling-timestamp problem as `lastFailureTime`. Added `&& this.circuitOpenedAt === null` to enforce the single-write invariant.
- **Circuit breaker deadlock**: `shouldAttemptReset()` measured time since last failure, which resets every cleanup cycle, so the 5-minute recovery window never expired. Fixed by recording `circuitOpenedAt` at the moment the breaker first opens and measuring from that fixed point.
- **`recordSuccess()` race condition**: Success detection bracketed only `cleanupStaleProcessing()` — a millisecond window that never captured Python completions (~14s batch cadence). Replaced with `audioLastCycleCompletedCount` tracked across cycles; `recordSuccess()` fires whenever the completed count grows since the previous cycle.
- **CLAP vibe queue self-heal**: `queueVibeEmbeddings` filtered `vibeAnalysisStatus = 'pending'`, skipping thousands of tracks left as `'completed'` after the `reduce_embedding_dimension` migration dropped their embeddings. Changed filter to `<> 'processing'` so `te.track_id IS NULL` (actual embedding existence) is the source of truth.

## [1.5.2] - 2026-02-18

### Fixed

- **Audio analysis enrichment deadlock**: Three compounding bugs caused enrichment to deadlock after 12+ hours of operation.
  - `runFullEnrichment` reset `analysisStatus` to `pending` without clearing `analysisRetryCount`, silently orphaning tracks the Python analyzer would never pick up (it ignores tracks with `retryCount >= MAX_RETRIES`).
  - `queueAudioAnalysis` had no `retryCount` filter, queuing tracks Python ignores — these timed out and fed false positives to the circuit breaker.
  - The circuit breaker fired on `permanentlyFailedCount > 0`, which is expected cleanup behavior, making it permanently unrecoverable — it reopened immediately on every `HALF_OPEN` attempt.

## [1.5.1] - 2026-02-18

### Fixed

- **SSE streaming through Next.js proxy**: SSE events were buffered by Next.js rewrites, breaking real-time Soulseek search results and download progress in production. Added a dedicated Next.js API route (`app/api/events/route.ts`) that streams SSE responses directly, bypassing the buffering rewrite proxy.
- **CLAP analyzer startup contention**: CLAP model loaded eagerly on container boot (~20s of CPU/memory), competing with the Essentia audio analyzer during startup. Model now loads lazily on first job, which only arrives after audio analysis completes.

## [1.5.0] - 2026-02-17

### Changed

- **REBRAND**: Project renamed from Lidify to Kima
- Repository moved to `kima-hub` on GitHub
- Docker images now published as `chevron7locked/kima`
- All user-facing references updated across codebase
- First official release under Kima branding
- **Soulseek credential changes**: Settings and onboarding now reset and reconnect Soulseek immediately instead of just disconnecting
- **Soulseek search timeout**: Reduced from 45s to 10s for faster UI response (200+ results stream well within that window)
- **Search result streaming**: Low-quality results (< 128kbps MP3) filtered before streaming to UI, capped at 200 streamed results per search

### Added

- **Album-level Soulseek search**: Discovery downloads use a single album-wide search query with directory grouping and fuzzy title matching, reducing download time from ~15 minutes to ~15-30 seconds
- **SSE-based Soulseek search**: Search results stream to the browser in real-time via Server-Sent Events instead of waiting for the full search to complete
- **Multi-tab audio sync**: BroadcastChannel API prevents multiple browser tabs from playing audio simultaneously -- new tab claims playback, other tabs pause
- **Network error retry**: Audio engine retries on network errors with exponential backoff (2s, 4s) before surfacing the failure
- **Stream eviction notification**: Users see "Playback interrupted -- stream may have been taken by another session" instead of a generic error
- **Stuck discovery batch recovery**: Batches stuck in scanning state are automatically recovered after 10 minutes and force-failed after 30 minutes
- **Stuck Spotify import recovery**: Spotify imports stuck in scanning or downloading states are automatically detected and recovered by the queue cleaner
- **Manual download activity feed**: Soulseek manual downloads now emit `download:complete` events and appear in the activity feed
- **Critical Reliability Fixes**: Eliminated Soulseek connection race conditions with distributed locks
- **100% Webhook Reliability**: Event sourcing with PostgreSQL persistence
- **Download Deduplication**: Database unique constraint prevents duplicate jobs
- **Discovery Batch Locking**: Optimistic locking with version field
- **Redis State Persistence**: Search sessions, blocklists, and cache layer
- **Prometheus Metrics**: Full instrumentation at `/metrics` endpoint
- **Automatic Data Cleanup**: 30-60 day retention policies
- **Database-First Configuration**: Encrypted sensitive credentials with runtime updates
- **Automatic Database Baselining**: Seamless migration for existing databases
- **Complete Type Safety**: Eliminated all `as any` assertions
- **Typed Error Handling**: User-friendly error messages with proper HTTP codes

### Fixed

- **Discovery download timeout**: Album-level search eliminates the per-track search overhead (13 tracks x 5 strategies x 15s) that caused 300s acquisition timeouts
- **Worker scheduling starvation**: `setTimeout` rescheduling moved into `finally` blocks so worker cycles always reschedule, even when pile-up guards cause early return
- **Concurrent discovery generation**: Distributed lock (`discover:generate:{userId}`, 30s TTL) prevents duplicate batches when the generate button is clicked rapidly
- **Recovery scan routing**: Fixed source strings (`"discover-weekly-completion"`, `"spotify-import"`) so recovered stuck scans trigger the correct post-scan handlers instead of silently completing
- **Unbounded scan re-queuing**: Added deduplication flags so stuck batches aren't re-queued by the queue cleaner every 30 seconds
- **buildFinalPlaylist idempotency**: Early return guard prevents duplicate playlist generation if the method is called multiple times for the same batch
- **MediaError SSR safety**: Replaced browser-only `MediaError.MEDIA_ERR_NETWORK` with literal value `2` for Next.js server-side rendering compatibility
- **Soulseek search session leak**: Sessions capped at 50 with oldest-eviction to prevent unbounded Map growth
- **Soulseek cooldown Map leak**: Added 5-minute periodic cleanup of expired entries from connection cooldown Maps, cleared on both `disconnect()` and `forceDisconnect()`
- **Unhandled promise rejection**: Wrapped fire-and-forget search `.then()`/`.catch()` handler bodies in try/catch
- **Batch download fault tolerance**: Replaced `Promise.all` with `Promise.allSettled` in album search download phase and per-track batch search/download phases so one failure doesn't abort the entire batch
- **SSE connection establishment**: Added `res.flushHeaders()` and per-message `flush()` calls to ensure SSE data reaches the client immediately through reverse proxies

### Removed

- Debug `console.log` statements from SSE event route and Soulseek search route
- Dead `playback-released` BroadcastChannel broadcast code from audio player
- Animated search background gradient (replaced with cleaner static layout)

### Infrastructure

- Redis-based distributed locking for race condition prevention
- Webhook event store with automatic retry and reconciliation
- Comprehensive type definitions for Lidarr and Soulseek APIs
- Architecture Decision Records (ADRs) documenting key technical choices

## [1.4.3] - 2026-02-08

### Fixed

- **Backend unresponsiveness after hours of uptime:** Replaced `setInterval` with self-rescheduling `setTimeout` for the 2-minute reconciliation cycle and 5-minute Lidarr cleanup cycle in `workers/index.ts`. Previously, `setInterval` fired unconditionally every 2/5 minutes regardless of whether the previous cycle had completed. Since `withTimeout()` resolves via `Promise.race` but never cancels the underlying operation, timed-out operations continued running as zombies. Over hours, hundreds of concurrent zombie operations accumulated, starving the event loop and exhausting database connections and network sockets. Each cycle now waits for the previous one to fully complete before scheduling the next, making pile-up impossible.

## [1.4.2] - 2026-02-07

### Added

- **GPU acceleration:** CLAP vibe embeddings use GPU when available (NVIDIA Container Toolkit required); MusicCNN stays on CPU where it performs better due to small model size
- **GPU documentation:** README section with install commands for NVIDIA Container Toolkit (Fedora/Nobara/RHEL and Ubuntu/Debian), docker-compose GPU config, and verification steps
- **Model idle unloading:** Both MusicCNN and CLAP analyzers unload ML models after idle timeout, freeing 2-4 GB of RAM when not processing
- **Immediate model unload:** Analyzers detect when all work is complete and unload models immediately instead of waiting for the idle timeout
- **CLAP progress reporting:** Enrichment progress endpoint now includes CLAP processing count and queue length for accurate UI status
- **Discovery similar artists:** Search discover endpoint returns musically similar artists (via Last.fm `getSimilar`) separately from text-match results
- **Alias resolution banner:** UI banner shown when Last.fm resolves an artist name alias (e.g., "of mice" -> "Of Mice & Men")

### Fixed

- **Case-sensitive artist search ([#64](https://github.com/Chevron7Locked/kima-hub/issues/64)):** Added PostgreSQL tsvector search with ILIKE fallback; all artist/album/track searches are now case-insensitive
- **Circuit breaker false trips:** Audio analysis cleanup circuit breaker now counts cleanup runs instead of individual tracks, preventing premature breaker trips on large batches of stale tracks
- **DB reconciliation race condition:** Analyzer marks tracks as `processing` in the database before pushing to Redis queue, preventing the backend from double-queuing the same tracks
- **Enrichment completion detection:** `isFullyComplete` now checks CLAP processing count and queue length, not just completed vs total
- **Search special characters:** `queryToTsquery` strips non-word characters and filters empty terms, preventing PostgreSQL syntax errors on queries like `"&"` or `"..."`
- **NaN pagination limit:** Search endpoints guard against `NaN` limit values from malformed query params
- **Discovery cache key collisions:** Normalized cache keys (lowercase, trimmed, collapsed whitespace) prevent duplicate cache entries for equivalent queries
- **Worker resize pool churn:** Added 5-second debounce to worker count changes from the UI slider, preventing rapid pool destroy/recreate cycles

### Performance

- **malloc_trim memory recovery:** Both analyzers call `malloc_trim(0)` after unloading models, forcing glibc to return freed pages to the OS (6.5 GB active -> 2.0 GB idle)
- **MusicCNN worker pool auto-shutdown:** Worker pool shuts down when no pending work remains, freeing process pool memory without waiting for idle timeout
- **Enrichment queue batch size:** Reduced from 50 to 10 to match analyzer batch size, preventing buildup of stale `processing` tracks
- **Search with tsvector indexes:** Artist, album, and track tables now have generated tsvector columns with GIN indexes for fast full-text search
- **Discovery endpoint parallelized:** Artist search, similar artists, and Deezer image lookups run concurrently instead of sequentially

### Changed

- **Audio streaming range parser:** Replaced Express `res.sendFile()` with custom range parser supporting suffix ranges (`bytes=-N`) and proper 416 responses -- fixes Firefox/Safari streaming issues on large FLAC files
- **Similar artists separation:** Discovery results now split into `results` (text matches) and `similarArtists` (musically similar via Last.fm), replacing the mixed array
- **Last.fm search tightened:** Removed `getSimilarArtists` padding from `searchArtists()` and raised fuzzy match threshold from 50 to 75 to reduce false positives (e.g., "Gothica" matching "Mothica")

### Removed

- Dead enrichment worker (`backend/src/workers/enrichment.ts`) and mood bucket worker (`backend/src/workers/moodBucketWorker.ts`) -- functionality consolidated into unified enrichment worker
- Unused `useDebouncedValue` hook (replaced by `useDebounce` from search hooks)

### Contributors

- @Allram - Soulseek import fix ([#85](https://github.com/Chevron7Locked/kima-hub/pull/85))

## [1.4.1] - 2026-02-06

### Fixed

- **Doubled audio stream on next-track:** Fixed race condition where clicking next/previous played two streams simultaneously by making track-change cleanup synchronous and guarding the play/pause effect during loading
- **Soulseek download returns 400 (#101):** Frontend now sends parsed title to the download endpoint; backend derives artist/title from filename when not provided instead of rejecting the request
- **Admin password reset (#97):** Added `ADMIN_RESET_PASSWORD` environment variable support -- set it and restart to reset the admin password, then remove the variable
- **Retry failed audio analysis UI (#79):** Added "Retry Failed Analysis" button in Settings that resets permanently failed tracks back to pending for re-processing
- **Podcast auto-refresh (#81):** Podcasts now automatically refresh during the enrichment cycle (hourly), checking RSS feeds for new episodes without manual intervention
- **Compilation track matching (#70):** Added title-only fallback matching strategy for playlist reconciliation -- when album artist doesn't match (e.g. "Various Artists" compilations), tracks are matched by title with artist similarity scoring
- **Soulseek documentation (#27):** Expanded README with detailed Soulseek integration documentation covering setup, search, download workflow, and limitations
- **Admin route hardening:** Added `requireAdmin` middleware to onboarding config routes and stale job cleanup endpoint
- **2FA userId leak:** Removed userId from 2FA challenge response (information disclosure)
- **Queue bugs:** Fixed cancelJob/refreshJobMatches not persisting state, clear button was no-op, reorder not restarting track, shuffle indices not updating on removeFromQueue
- **Infinite re-render:** Fixed useAlbumData error handling causing infinite re-render loop
- **2FA status not loading:** Fixed AccountSection not loading 2FA status on mount
- **Password change error key mismatch:** Fixed error key mismatch in AccountSection password change handler
- **Discovery polling leak:** Fixed polling never stopping on batch failure
- **Timer leak:** Fixed withTimeout not clearing timer in enrichment worker
- **Audio play rejection:** Fixed unhandled promise rejection on audio.play()
- **Library tab validation:** Added tab parameter validation in library page
- **Onboarding state:** Separated success/error state in onboarding page
- **Audio analysis race condition (#79):** CLAP analyzer was clobbering Essentia's `analysisStatus` field, causing completed tracks to be reset and permanently failed after 3 cycles; both Python analyzers now check for existing embeddings before resetting
- **Enrichment completion check:** `isFullyComplete` now includes CLAP vibe embeddings, not just audio analysis
- **Enrichment UI resilience:** Added `keepPreviousData` and loading/error states to enrichment progress query so the settings block doesn't vanish on failed refetch

### Performance

- **Recommendation N+1 queries:** Eliminated N+1 queries in all 3 recommendation endpoints (60+ queries down to 3-5)
- **Idle worker pool shutdown:** Essentia analyzer shuts down its 8-worker process pool (~5.6 GB) after idle period, lazily restarts when work arrives

### Changed

- **Shared utility consolidation:** Replaced 10 inline `formatDuration` copies with shared `formatTime`/`formatDuration`, extracted `formatNumber` to shared utility, consolidated inline Fisher-Yates shuffle with shared `shuffleArray`
- **Player hook extraction:** Extracted shared `useMediaInfo` hook, eliminating ~120 lines of duplicated media info logic across MiniPlayer, FullPlayer, and OverlayPlayer
- **Preview hook consolidation:** Consolidated artist/album preview hooks into shared `useTrackPreview`
- **Redundant logging cleanup:** Removed console.error calls redundant with toast notifications or re-thrown errors

### Removed

- Dead player files: VibeOverlay, VibeGraph, VibeOverlayContainer, enhanced-vibe-test page
- Dead code: trackEnrichment.ts, discover/types/index.ts, unused artist barrel file
- Unused exports: `playTrack` from useLibraryActions, `useTrackDisplayData`/`TrackDisplayData` from useMetadataDisplay
- Unused `streamLimiter` middleware
- Deprecated `radiosByGenre` from browse API (Deezer radio requires account; internal library radio used instead)

## [1.4.0] - 2026-02-05

### Performance

- **Sequential audio/vibe enrichment:** Vibe phase skips when audio analysis is still running, preventing concurrent CPU-intensive Python analyzers from competing for resources
- **Faster enrichment cycles:** Reduced cycle interval from 30s to 5s; the rate limiter already handles API throttling, making the extra delay redundant
- **GPU auto-detection (CLAP):** PyTorch-based CLAP vibe embeddings auto-detect and use GPU when available, falling back to CPU
- **GPU auto-detection (Essentia):** TensorFlow-based audio analysis detects GPU with memory growth enabled, with device logging on startup

### Changed

- **Enrichment orchestration simplified:** Replaced 4 phase functions with duplicated stop/pause handling with a generic `runPhase()` executor and `shouldHaltCycle()` helper

### Fixed

- **Docker frontend routing:** Fixed `NEXT_PUBLIC_BACKEND_URL` build-time env var in Dockerfile so the frontend correctly proxies API requests to the backend
- **Next.js rewrite proxy:** Updated rewrite config to use `NEXT_PUBLIC_BACKEND_URL` for consistent build-time/runtime behavior
- **False lite mode on startup:** Feature detection now checks for analyzer scripts on disk, preventing false "lite mode" display before analyzers send their first heartbeat
- **Removed playback error banner:** Removed the red error bar from all player components (FullPlayer, MiniPlayer, OverlayPlayer) that displayed raw Howler.js error codes
- **Enrichment failure notifications:** Replaced aggressive per-cycle error banner with a single notification through the notification system when enrichment completes with failures

## [1.3.9] - 2026-02-04

### Fixed

- **Audio analysis cleanup:** Fixed race condition in audio analysis cleanup that could reset tracks still being processed

## [1.3.8] - 2026-02-03

### Fixed

- **Enrichment:** CLAP queue and failure cleanup fixes for enrichment debug mode

## [1.3.7] - 2026-02-01

### Added

#### CLAP Audio Analyzer (Major Feature)

New ML-based audio analysis using CLAP (Contrastive Language-Audio Pretraining) embeddings for semantic audio understanding.

- **CLAP Analyzer Service:** Python-based analyzer using Microsoft's CLAP model for generating audio embeddings
- **pgvector Integration:** Added PostgreSQL vector extension for efficient similarity search on embeddings
- **Vibe Similarity:** "Find similar tracks" feature using hybrid similarity (CLAP embeddings + BPM/key matching)
- **Vibe Explorer UI:** Test page for exploring audio similarity at `/vibe-ui-test`
- **Settings Integration:** CLAP embeddings progress display and configurable worker count in Settings
- **Enrichment Phase 4:** CLAP embedding generation integrated into enrichment pipeline

#### Feature Detection

Automatic detection of available analyzers with graceful degradation.

- **Feature Detection Service:** Backend service that monitors analyzer availability via Redis heartbeats
- **Features API:** New `/api/system/features` endpoint exposes available features to frontend
- **FeaturesProvider:** React context for feature availability throughout the app
- **Graceful UI:** Vibe button hidden when embeddings unavailable; analyzer controls greyed out in Settings
- **Onboarding:** Shows detected features instead of manual toggles

#### Docker & Deployment

- **Lite Mode:** New `docker-compose.lite.yml` override for running without optional analyzers
- **All-in-One Image:** CLAP analyzer and pgvector included in main Docker image
- **Analyzer Profiles:** Optional services can be enabled/disabled via compose overrides

#### Other

- **Local Image Storage:** Artist images stored locally with artist counts
- **Hybrid Similarity Service:** Combines CLAP embeddings with BPM and musical key for better matches
- **BPM/Key Similarity Functions:** Database functions for musical attribute matching

### Fixed

- **CLAP Queue Name:** Corrected queue name to `audio:clap:queue`
- **CLAP Large Files:** Handle large audio files by chunking to avoid memory issues
- **CLAP Dependencies:** Added missing torchvision dependency and fixed model path
- **Embedding Index:** Added missing IVFFlat index to embedding migration for query performance
- **Library Page Performance:** Artist images now cache properly - removed JWT tokens from cover-art URLs that were breaking Service Worker and HTTP cache (tokens only added for CORS canvas access on detail pages)
- **Service Worker:** Increased image cache limit from 500 to 2000 entries for better coverage of large libraries

### Performance

- **CLAP Extraction:** Always extract middle 60s of audio for efficient embedding generation
- **CLAP Duration:** Pass duration from database to avoid file probe overhead
- **Vibe Query:** Use CTE to avoid duplicate embedding lookup in similarity queries
- **PopularArtistsGrid:** Added `memo()` wrapper to prevent unnecessary re-renders when parent state changes
- **FeaturedPlaylistsGrid:** Added `memo()` wrapper and `useCallback` for click handler to ensure child `PlaylistCard` memoization works correctly
- **Scan Reconciliation:** Fixed N+1 database query pattern - replaced per-job album lookups with single batched query, reducing ~250 queries to ~3 queries for 100 pending jobs

### Security

- **Vibe API:** Added internal auth to vibe failure endpoint

### Changed

- **Docker Profiles:** Replaced Docker profiles with override file approach for better compatibility
- **Mood Columns:** Marked as legacy in schema - may be derived from CLAP embeddings in future

## [1.3.5] - 2026-01-22

### Fixed

- **Audio preload:** Emit preload 'load' event asynchronously to prevent race condition during gapless playback

## [1.3.4] - 2026-01-22

### Added

- **Gapless playback:** Preload infrastructure and next-track preloading for seamless transitions
- **Infinite scroll:** Library artists, albums, and tracks now use infinite query pagination
- **CachedImage:** Migrated to Next.js Image component with proper type support

### Fixed

- **CSS hover performance:** Fixed hover state performance issues
- **Audio analyzer:** Fixed Enhanced mode detection
- **Onboarding:** Accessibility improvements
- **Audio format detection:** Simplified to prevent wrong decoder attempts
- **Audio cleanup:** Improved Howl instance cleanup to prevent memory leaks
- **Audio cleanup tracking:** Use Set for pending cleanup tracking
- **Redis connections:** Disconnect enrichmentStateService connections on shutdown

### Changed

- **Library page:** Optimized data fetching with tab-based queries and memoized delete handlers

## [1.3.3] - 2026-01-18

Comprehensive patch release addressing critical stability issues, performance improvements, and production readiness fixes. This release includes community-contributed fixes and extensive internal code quality improvements.

### Fixed

#### Critical (P1)

- **Docker:** PostgreSQL/Redis bind mount permission errors on Linux hosts ([#59](https://github.com/Chevron7Locked/kima-hub/issues/59)) - @arsaboo via [#62](https://github.com/Chevron7Locked/kima-hub/pull/62)
- **Audio Analyzer:** Memory consumption/OOM crashes with large libraries ([#21](https://github.com/Chevron7Locked/kima-hub/issues/21), [#26](https://github.com/Chevron7Locked/kima-hub/issues/26)) - @rustyricky via [#53](https://github.com/Chevron7Locked/kima-hub/pull/53)
- **LastFM:** ".map is not a function" crashes with obscure artists ([#37](https://github.com/Chevron7Locked/kima-hub/issues/37)) - @RustyJonez via [#39](https://github.com/Chevron7Locked/kima-hub/pull/39)
- **Wikidata:** 403 Forbidden errors from missing User-Agent header ([#57](https://github.com/Chevron7Locked/kima-hub/issues/57))
- **Downloads:** Singles directory creation race conditions ([#58](https://github.com/Chevron7Locked/kima-hub/issues/58))
- **Firefox:** FLAC playback stopping at ~4:34 mark on large files ([#42](https://github.com/Chevron7Locked/kima-hub/issues/42), [#17](https://github.com/Chevron7Locked/kima-hub/issues/17))
- **Downloads:** "Skip Track" fallback setting ignored, incorrectly falling back to Lidarr ([#68](https://github.com/Chevron7Locked/kima-hub/issues/68))
- **Auth:** Login "Internal Server Error" and "socket hang up" on NAS hardware ([#75](https://github.com/Chevron7Locked/kima-hub/issues/75))
- **Podcasts:** Seeking backward causing player crash and backend container hang
- **API:** Rate limiter crash with "trust proxy" validation error causing socket hang up
- **Downloads:** Duplicate download jobs created due to race condition (database-level locking fix)

#### Quality of Life (P2)

- **Desktop UI:** Added missing "Releases" link to desktop sidebar navigation ([#41](https://github.com/Chevron7Locked/kima-hub/issues/41))
- **iPhone:** Dynamic Island/notch overlapping TopBar buttons ([#54](https://github.com/Chevron7Locked/kima-hub/issues/54))
- **Album Discovery:** Cover Art Archive timeouts causing slow page loads (2s timeout added)
- **Wikimedia:** Image proxy 429 rate limiting due to incomplete User-Agent header

### Added

- **Selective Enrichment Controls:** Individual "Re-run" buttons for Artists, Mood Tags, and Audio Analysis in Settings
- **XSS Protection:** DOMPurify sanitization for artist biography HTML content
- **AbortController:** Proper fetch request cleanup on component unmount across all hooks

### Changed

- **Performance:** Removed on-demand image fetching from library endpoints (faster page loads)
- **Performance:** Added concurrency limit to Deezer preview fetching (prevents rate limiting)
- **Performance:** Corrected batching for on-demand artist image fetching
- **Soulseek:** Connection stability improvements with auto-disconnect on credential changes
- **Backend:** Production build now uses compiled JavaScript instead of tsx transpilation (faster startup, lower memory on NAS)

### Security

- **XSS Prevention:** Artist bios now sanitized with DOMPurify before rendering
- **Race Conditions:** Database-level locking prevents duplicate download job creation

### Technical Details

#### Community Fixes

- **Docker Permissions (#62):** Creates `/data/postgres` and `/data/redis` directories with proper ownership; validates write permissions at startup using `gosu <user> test -w`
- **Audio Analyzer Memory (#53):** TensorFlow GPU memory growth enabled; `MAX_ANALYZE_SECONDS` configurable (default 90s); explicit garbage collection in finally blocks
- **LastFM Normalization (#39):** `normalizeToArray()` utility wraps single-object API responses; protects 5 locations in artist discovery endpoints

#### Hotfixes

- **Wikidata User-Agent (#57):** All 4 API endpoints now use configured axios client with proper User-Agent header
- **Singles Directory (#58):** Replaced TOCTOU `existsSync()`+`mkdirSync()` pattern with idempotent `mkdir({recursive: true})`
- **Firefox FLAC (#42):** Replaced Express `res.sendFile()` with manual range request handling via `fs.createReadStream()` with proper `Content-Range` headers
- **Skip Track (#68):** Auto-fallback logic now only activates for undefined/null settings, respecting explicit "none" (Skip Track) preference
- **NAS Login (#75):** Backend now built with `tsc` and runs with `node dist/index.js`; proxy trust setting updated; session secret standardized
- **Podcast Seek:** AbortController cancels upstream requests on client disconnect; stream error handlers prevent crashes
- **Rate Limiter:** All rate limiter configurations disable proxy validation (`validate: { trustProxy: false }`)
- **Wikimedia Proxy:** User-Agent standardized to `"Lidify/1.0.0 (https://github.com/Chevron7Locked/kima-hub)"` across all external API calls

#### Production Readiness Improvements

Internal code quality and stability fixes discovered during production readiness review:

**Security:**
- ReDoS guard on `stripAlbumEdition()` regex (500 char input limit)
- Rate limiter path matching uses precise patterns instead of vulnerable `includes()` checks

**Race Conditions:**
- Spotify token refresh uses promise singleton pattern
- Import job state re-fetched after `checkImportCompletion()`
- useSoulseekSearch has cancellation flag pattern

**Memory Leaks:**
- failedUsers Map periodic cleanup (every 5 min)
- jobLoggers Map cleanup on all completion/failure paths

**Code Quality:**
- Async executor anti-pattern removed from Soulseek `searchTrack()`
- Timeout cleanup in catch blocks
- Proper error type narrowing (`catch (error: unknown)`)
- Null guards in artistNormalization functions
- Fisher-Yates shuffle replaces biased `Math.random()` sort
- Debug console.log statements removed/converted
- Empty catch blocks now have proper error handling
- Stale closures fixed with refs in event handlers
- Dead code and unused imports removed

**CSS:**
- Tailwind arbitrary value syntax corrected
- Duplicate z-index values removed

**Infrastructure:**
- Explicit database connection pool configuration
- Deezer album lookups routed through global rate limiter
- Consistent toast system usage

### Deferred to Future Release

- **PR #49** - Playlist visibility toggle (needs PR review)
- **PR #47** - Mood bucket tags (already implemented, verify and close)
- **PR #36** - Docker --user flag (needs security review)

### Contributors

Thanks to everyone who contributed to this release:

- @arsaboo - Docker bind mount permissions fix ([#62](https://github.com/Chevron7Locked/kima-hub/pull/62))
- @rustyricky - Audio analyzer memory limits ([#53](https://github.com/Chevron7Locked/kima-hub/pull/53))
- @RustyJonez - LastFM array normalization ([#39](https://github.com/Chevron7Locked/kima-hub/pull/39))
- @tombatossals - Testing and validation
- @zeknurn - Skip Track bug report ([#68](https://github.com/Chevron7Locked/kima-hub/issues/68))

---

## [1.3.2] - 2025-01-07

### Fixed
- Mobile scrolling blocked by pull-to-refresh component
- Pull-to-refresh component temporarily disabled (will be properly fixed in v1.4)

### Technical Details
- Root cause: CSS flex chain break (`h-full`) and touch event interference
- Implemented early return to bypass problematic wrapper while preserving child rendering
- TODO: Re-enable in v1.4 with proper CSS fix (`flex-1 flex flex-col min-h-0`)

## [1.3.1] - 2025-01-07

### Fixed
- Production database schema mismatch causing SystemSettings endpoints to fail
- Added missing `downloadSource` and `primaryFailureFallback` columns to SystemSettings table

### Database Migrations
- `20260107000000_add_download_source_columns` - Idempotent migration adds missing columns with defaults

### Technical Details
- Root cause: Migration gap between squashed init migration and production database setup
- Uses PostgreSQL IF NOT EXISTS pattern for safe deployment across all environments
- Default values: `downloadSource='soulseek'`, `primaryFailureFallback='none'`

## [1.3.0] - 2026-01-06

### Added

- Multi-source download system with configurable Soulseek/Lidarr primary source and fallback options
- Configurable enrichment speed control (1-5x concurrency) in Settings > Cache & Automation
- Stale job cleanup button in Settings to clear stuck Discovery batches and downloads
- Mobile touch drag support for seek sliders on all player views
- Skip +/-30s buttons for audiobooks/podcasts on mobile players
- iOS PWA media controls support (Control Center and Lock Screen)
- Artist name alias resolution via Last.fm (e.g., "of mice" -> "Of Mice & Men")
- Library grid now supports 8 columns on ultra-wide displays (2xl breakpoint)
- Artist discography sorting options (Year/Date Added)
- Enrichment failure notifications with retry/skip modal
- Download history deduplication to prevent duplicate entries
- Utility function for normalizing API responses to arrays (`normalizeToArray`) - @tombatossals
- Keyword-based mood scoring for standard analysis mode tracks - @RustyJonez
- Global and route-level error boundaries for better error handling
- React Strict Mode for development quality checks
- Next.js image optimization enabled by default
- Mobile-aware animation rendering (GalaxyBackground disables particles on mobile)
- Accessibility motion preferences support (`prefers-reduced-motion`)
- Lazy loading for heavy components (MoodMixer, VibeOverlay, MetadataEditor)
- Bundle analyzer tooling (`npm run analyze`)
- Loading states for all 10 priority routes
- Skip links for keyboard navigation (WCAG 2.1 AA compliance)
- ARIA attributes on all interactive controls and navigation elements
- Toast notifications with ARIA live regions for screen readers
- Bull Board admin dashboard authentication (requires admin user)
- Lidarr webhook signature verification with configurable secret
- Encryption key validation on startup (prevents insecure defaults)
- Session cookie security (httpOnly, sameSite=strict, secure in production)
- Swagger API documentation authentication in production
- JWT token expiration (24h access tokens, 30d refresh tokens)
- JWT refresh token endpoint (`/api/auth/refresh`)
- Token version validation (password changes invalidate existing tokens)
- Download queue reconciliation on server startup (marks stale jobs as failed)
- Redis batch operations for cache warmup (MULTI/EXEC pipelining)
- Memory-efficient database-level shuffle (`ORDER BY RANDOM() LIMIT n`)
- Dynamic import caching in queue cleaner (lazy-load pattern)
- Database index for `DownloadJob.targetMbid` field
- PWA install prompt dismissal persistence (7-day cooldown)

### Fixed

- **Critical:** Audio analyzer crashes on libraries with non-ASCII filenames ([#6](https://github.com/Chevron7Locked/kima-hub/issues/6))
- **Critical:** Audio analyzer BrokenProcessPool after ~1900 tracks ([#21](https://github.com/Chevron7Locked/kima-hub/issues/21))
- **Critical:** Audio analyzer OOM kills with aggressive worker auto-scaling ([#26](https://github.com/Chevron7Locked/kima-hub/issues/26))
- **Critical:** Audio analyzer model downloads and volume mount conflicts ([#2](https://github.com/Chevron7Locked/kima-hub/issues/2))
- Radio stations playing songs from wrong decades due to remaster dates ([#43](https://github.com/Chevron7Locked/kima-hub/issues/43))
- Manual metadata editing failing with 500 errors ([#9](https://github.com/Chevron7Locked/kima-hub/issues/9))
- Active downloads not resolving after Lidarr successfully imports ([#31](https://github.com/Chevron7Locked/kima-hub/issues/31))
- Discovery playlist downloads failing for artists with large catalogs ([#34](https://github.com/Chevron7Locked/kima-hub/issues/34))
- Discovery batches stuck in "downloading" status indefinitely
- Audio analyzer rhythm extraction failures on short/silent audio ([#13](https://github.com/Chevron7Locked/kima-hub/issues/13))
- "Of Mice & Men" artist name truncated to "Of Mice" during scanning
- Edition variant albums (Remastered, Deluxe) failing with "No releases available"
- Downloads stuck in "Lidarr #1" state for 5 minutes before failing
- Download duplicate prevention race condition causing 10+ duplicate jobs
- Lidarr downloads incorrectly cancelled during temporary network issues
- Discovery Weekly track durations showing "NaN:NaN"
- Artist name search ampersand handling ("Earth, Wind & Fire")
- Vibe overlay display issues on mobile devices
- Pagination scroll behavior (now scrolls to top instead of bottom)
- LastFM API crashes when receiving single objects instead of arrays ([#37](https://github.com/Chevron7Locked/kima-hub/issues/37)) - @tombatossals
- Mood bucket infinite loop for tracks analyzed in standard mode ([#40](https://github.com/Chevron7Locked/kima-hub/issues/40)) - @RustyJonez
- Playlist visibility toggle not properly syncing hide/show state - @tombatossals
- Audio player time display showing current time exceeding total duration (e.g., "58:00 / 54:34")
- Progress bar could exceed 100% for long-form media with stale metadata
- Enrichment P2025 errors when retrying enrichment for deleted entities
- Download settings fallback not resetting when changing primary source
- SeekSlider touch events bubbling to parent OverlayPlayer swipe handlers
- Audiobook/podcast position showing 0:00 after page refresh instead of saved progress
- Volume slider showing no visual fill indicator for current level
- PWA install prompt reappearing after user dismissal

### Changed

- Audio analyzer default workers reduced from auto-scale to 2 (memory conservative)
- Audio analyzer Docker memory limits: 6GB limit, 2GB reservation
- Download status polling intervals: 5s (active) / 10s (idle) / 30s (none), previously 15s
- Library pagination options changed to 24/40/80/200 (divisible by 8-column grid)
- Lidarr download failure detection now has 90-second grace period (3 checks)
- Lidarr catalog population timeout increased from 45s to 60s
- Download notifications now use API-driven state instead of local pending state
- Enrichment stop button now gracefully finishes current item before stopping
- Per-album enrichment triggers immediately instead of waiting for batch completion
- Lidarr edition variant detection now proactive (enables `anyReleaseOk` before first search)
- Discovery system now uses AcquisitionService for unified album/track acquisition
- Podcast and audiobook time display now shows time remaining instead of total duration
- Edition variant albums automatically fall back to base title search when edition-specific search fails
- Stale pending downloads cleaned up after 2 minutes (was indefinite)
- Download source detection now prioritizes actual service availability over user preference

### Removed

- Artist delete buttons hidden on mobile to prevent accidental deletion
- Audio analyzer models volume mount (shadowed built-in models)

### Database Migrations Required

```bash
# Run Prisma migrations
cd backend
npx prisma migrate deploy
```

**New Schema Fields:**

- `Album.originalYear` - Stores original release year (separate from remaster dates)
- `SystemSettings.enrichmentConcurrency` - User-configurable enrichment speed (1-5)
- `SystemSettings.downloadSource` - Primary download source selection
- `SystemSettings.primaryFailureFallback` - Fallback behavior on primary source failure
- `SystemSettings.lidarrWebhookSecret` - Shared secret for Lidarr webhook signature verification
- `User.tokenVersion` - Version number for JWT token invalidation on password change
- `DownloadJob.targetMbid` - Index added for improved query performance

**Backfill Script (Optional):**

```bash
# Backfill originalYear for existing albums
cd backend
npx ts-node scripts/backfill-original-year.ts
```

### Breaking Changes

- None - All changes are backward compatible

### Security

- **Critical:** Bull Board admin dashboard now requires authenticated admin user
- **Critical:** Lidarr webhooks verify signature/secret before processing requests
- **Critical:** Encryption key validation on startup prevents insecure defaults
- Session cookies use secure settings in production (httpOnly, sameSite=strict, secure)
- Swagger API documentation requires authentication in production (unless `DOCS_PUBLIC=true`)
- JWT tokens have proper expiration (24h access, 30d refresh) with refresh token support
- Password changes invalidate all existing tokens via tokenVersion increment
- Transaction-based download job creation prevents race conditions
- Enrichment stop control no longer bypassed by worker state
- Download queue webhook handlers use Serializable isolation transactions
- Webhook race conditions protected with exponential backoff retry logic

---

## Release Notes

When deploying this update:

1. **Backup your database** before running migrations
2. **Set required environment variable** (if not already set):
   ```bash
   # Generate secure encryption key
   SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
   ```
3. Run `npx prisma migrate deploy` in the backend directory
4. Optionally run the originalYear backfill script for era mix accuracy:
   ```bash
   cd backend
   npx ts-node scripts/backfill-original-year.ts
   ```
5. Clear Docker volumes for audio-analyzer if experiencing model issues:
   ```bash
   docker volume rm lidify_audio_analyzer_models 2>/dev/null || true
   docker compose build audio-analyzer --no-cache
   ```
6. Review Settings > Downloads for new multi-source download options
7. Review Settings > Cache for new enrichment speed control
8. Configure Lidarr webhook secret in Settings for webhook signature verification (recommended)
9. Review Settings > Security for JWT token settings

### Known Issues

- Pre-existing TypeScript errors in spotifyImport.ts matchTrack method (unrelated to this release)
- Simon & Garfunkel artist name may be truncated due to short second part (edge case, not blocking)

### Contributors

Big thanks to everyone who contributed, tested, and helped make this release happen:

- @tombatossals - LastFM API normalization utility ([#39](https://github.com/Chevron7Locked/kima-hub/pull/39)), playlist visibility toggle fix ([#49](https://github.com/Chevron7Locked/kima-hub/pull/49))
- @RustyJonez - Mood bucket standard mode keyword scoring ([#47](https://github.com/Chevron7Locked/kima-hub/pull/47))
- @iamiq - Audio analyzer crash reporting ([#2](https://github.com/Chevron7Locked/kima-hub/issues/2))
- @volcs0 - Memory pressure testing ([#26](https://github.com/Chevron7Locked/kima-hub/issues/26))
- @Osiriz - Long-running analysis testing ([#21](https://github.com/Chevron7Locked/kima-hub/issues/21))
- @hessonam - Non-ASCII character testing ([#6](https://github.com/Chevron7Locked/kima-hub/issues/6))
- @niles - RhythmExtractor edge case reporting ([#13](https://github.com/Chevron7Locked/kima-hub/issues/13))
- @TheChrisK - Metadata editor bug reporting ([#9](https://github.com/Chevron7Locked/kima-hub/issues/9))
- @lizar93 - Discovery playlist testing ([#34](https://github.com/Chevron7Locked/kima-hub/issues/34))
- @brokenglasszero - Mood tags feature verification ([#35](https://github.com/Chevron7Locked/kima-hub/issues/35))

And all users who reported bugs, tested fixes, and provided feedback!

---

For detailed technical implementation notes, see [docs/PENDING_DEPLOY-2.md](docs/PENDING_DEPLOY-2.md).
