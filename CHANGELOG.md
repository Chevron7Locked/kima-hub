# Changelog

All notable changes to Kima will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
