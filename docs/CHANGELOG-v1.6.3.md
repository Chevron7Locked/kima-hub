# v1.6.3 - Library Cleanup, OpenSubsonic, Track Identity

Closes #143, #141.

## Library Cleanup (#143)

- **Corrupt file detection** -- Tracks that fail metadata parsing during scan are flagged as `corrupt` instead of silently ignored. Corrupt flag clears automatically if the file is fixed and re-scanned.
- **Playlist-protected track removal** -- Missing tracks referenced by playlists are now converted to `PlaylistPendingTrack` entries (shown as "unavailable" in the UI) instead of blocking deletion.
- **Enrichment circuit breaker** -- Tracks that exceed max retry attempts are marked `permanently_failed` and excluded from future enrichment cycles.
- **Corrupt tracks admin UI** -- New section in Settings to view and bulk-delete corrupt tracks. Endpoints require admin auth.

## OpenSubsonic Enhanced Endpoints (#141)

- **getMusicDirectory** -- Folder-based browsing for clients that use directory navigation
- **getLyrics** -- Serves lyrics from the existing lyrics database
- **getSongsByGenre** -- Filter tracks by genre
- **getTopSongs / getSimilarSongs** -- Artist-based track discovery
- **savePlayQueue / getPlayQueue** -- Cross-device playback resume
- **createBookmark / deleteBookmark / getBookmarks** -- Position bookmarks for audiobooks/podcasts
- **getAlbumList2 songCount fix** -- Album list responses now include correct track counts
- **Stub endpoints** -- getNowPlaying, getScanStatus, startScan, setRating, getAlbumInfo return valid empty responses

## Track Identity & Cross-Platform Import

- **ISRC from ID3 tags** -- Library scanner extracts ISRC codes from audio file metadata during scan
- **ISRC Strategy 0** -- Import matching now tries deterministic ISRC lookup before any fuzzy text matching
- **song.link integration** -- New `SongLinkService` resolves any streaming URL to canonical metadata (Spotify ID, title, artist, cover art) with Redis caching
- **TrackIdentityService** -- Central service for URL resolution, ISRC storage (priority-based: id3 > spotify > deezer > musicbrainz > songlink), and genre population
- **MusicBrainz genre enrichment** -- ISRC-based genre and tag lookup populates `TrackGenre` junction table during import and background enrichment
- **YouTube playlist import** -- YouTube and YouTube Music playlist URLs extracted via yt-dlp (replaced dead Invidious instances). Tracks with native metadata (YouTube Music, Bandcamp, SoundCloud) skip song.link for faster resolution
- **SoundCloud / Bandcamp / Mixcloud import** -- Playlist URLs from these platforms are now accepted in the import flow, resolved via yt-dlp + song.link
- **Background ISRC enrichment** -- Existing library tracks without ISRC are enriched via MusicBrainz during the unified enrichment cycle
- **Normalization consolidation** -- Five inline normalization functions extracted from `spotifyImport.ts` into shared `utils/normalization.ts`

## Security Hardening

- **SQL injection fix** -- Parameterized genre LIKE patterns in Subsonic raw SQL queries (`getSongsByGenre`, search endpoints). Switched from JS-side string concatenation to SQL-side `'%' || $param || '%'` to preserve Prisma's automatic parameterization
- **SSE ticket-based auth** -- Replaced JWT in EventSource query strings with one-time-use UUID tickets (30s TTL, Redis GETDEL). Eliminates token leakage via server logs, browser history, and referrer headers (OWASP token-in-URL)
- **Content-Security-Policy** -- Added CSP header with restrictive defaults: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, whitelisted image CDNs. `'unsafe-eval'` only in dev mode
- **Self-hosted fonts** -- Replaced Google Fonts CDN with locally hosted Montserrat woff2. No outbound requests to Google on page load
- **Error page genericization** -- Removed raw `error.message` from error boundary pages to prevent information disclosure

## Audio Analysis Optimization

- **Valence/arousal ensemble** -- Replaced heuristic valence/arousal formulas with an ensemble of DEAM + emomusic MusiCNN regression models. Averages predictions from two independently trained models for more stable values. Heuristic fallback if models are unavailable
- **CLAP checkpoint stripping** -- Strip optimizer state from CLAP checkpoint at Docker build time. Model file reduced from 2.35 GB to 764 MB (~1.57 GB saving) with zero accuracy impact (laion_clap only reads `state_dict`)
- **HNSW vector index** -- Switched pgvector index from IVFFlat to HNSW (`m=16, ef_construction=200`). Eliminates silent recall degradation after bulk inserts (IVFFlat required periodic REINDEX which was never implemented)
- **Similarity score fixes** -- Clamped CLAP cosine similarity to [0,1] (was [-1,1]). Fixed NULL feature COALESCE that gave unanalyzed tracks a free "average" similarity score -- NULLs now contribute 0 instead of inflated matches
- **Web Lock removal** -- Removed Web Lock API from audio engine. Silent audio bridge already handles mobile background playback keepalive
- **LastFM API key restore** -- Restored built-in default LastFM API key for Docker builds. Fallback chain: user settings > env var > built-in default
- **Mood tag flooding fix** -- Replaced min/max OOD detection with entropy-based approach (catches 80-90% vs 40% of confused predictions). Added grouped softmax on contradictory mood pairs (happy/sad, relaxed/aggressive). Per-frame variance shrinkage pulls uncertain predictions toward neutral
- **Valence/arousal spread** -- Temperature scaling (2.5x) amplifies deviation from center in raw [1,9] space before normalization. Existing tracks recalibrated via batch migration script
- **CLAP vocal detection** -- Zero-shot instrumentalness via CLAP text-audio similarity replaces broken MusiCNN voice_instrumental head (81% of vocal tracks were scoring 0.9+). Runs during vibe embedding phase with zero new dependencies
- **Vibe vocabulary expansion** -- 69 to 166 pre-computed CLAP text embeddings. New categories: sub-genres (35), cultural/regional (7), instrumentation (12), production (9), vocal styles (7), use-cases (7), moods (14), eras (7). Added subgenre TermType to genreConfidence matching
- **Danceability saturation fix** -- Essentia `Danceability()` returns [0,3], was clamped to [0,1] causing 95% of tracks to score 1.0. Fixed by normalizing with `/3.0`. Similarity system switched from `danceability` to `danceabilityMl`
- **Acousticness aliasing fix** -- `mood_acoustic` (a mood classifier) was directly aliased as acousticness, causing vocal pop/rock to score 0.999. Now detected by CLAP zero-shot ("acoustic instruments" vs "electronic synthesizers")
- **CLAP zero-shot acousticness** -- Replaces `dynamicRange / 12` proxy with CLAP text-audio similarity. Same zero-shot pattern as vocal detection, zero new dependencies
- **CLAP zero-shot speechiness** -- Replaces `(1-instrumentalness)*0.6` stub with actual speech/rap detection. Distinguishes rapping/spoken word from melodic singing using 3+3 text prompt ensemble
- **CLAP valence/arousal blend** -- Zero-shot emotion detection blended with DEAM regression (70/30 valence, 50/50 arousal). Provides full V/A signal when DEAM unavailable. Different failure modes reduce compression artifacts
- **Speechiness NULL default fix** -- Vibe re-ranking NULL default for speechiness changed from 0.5 to 0.0 (most music has no speech). Prevents inflated match scores for rap/spoken word terms on unanalyzed tracks

## Background Playlist Import

- **Background import** -- Playlist import fires via API call with toast notification instead of navigating to a full-page progress screen. User stays on their current page
- **Import dedup** -- Backend checks for active imports of the same URL before creating a new job, preventing duplicate imports on page refresh
- **Imports management tab** -- New tab in the activity panel showing all import jobs with status, progress, and cancel buttons
- **Import toast notifications** -- SSE events trigger toast notifications on import completion, failure, or cancellation via custom DOM events
- **Onboarding simplification** -- Removed informational step 3, onboarding is now Account + Integrations + done

## Audit Fixes

- Removed dead `enrichTrackIdentity()` method from enrichment.ts
- Added `requireAdmin` to corrupt tracks endpoints, removed `filePath` from GET response
- Fixed ISRC priority bug where unknown `isrcSource` values blocked overwrites
- Batched `populateTrackGenres()` with `$transaction` to reduce DB round-trips
- Collapsed duplicate branches in `resolveUrl()`
- Removed Apple Music/Tidal from import validation (no playlist extraction support)
- Removed unused `axios` import from spotifyImport.ts
- Added SSRF protection on preview route with `supportedDomains` whitelist
- Added song.link per-track timeout (8s) to prevent import stalls on unresolvable URLs
