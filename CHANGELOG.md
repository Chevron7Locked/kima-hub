# Changelog

All notable changes to Lidify will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.3] - 2025-01-07

Bug fix patch release addressing 6 P1 critical issues and 2 P2 quality-of-life improvements.

### Fixed

#### Critical (P1)
-   **Docker:** PostgreSQL/Redis bind mount permission errors on Linux hosts ([#59](https://github.com/Chevron7Locked/lidify/issues/59)) - @arsaboo via [#62](https://github.com/Chevron7Locked/lidify/pull/62)
-   **Audio Analyzer:** Memory consumption/OOM crashes with large libraries ([#21](https://github.com/Chevron7Locked/lidify/issues/21), [#26](https://github.com/Chevron7Locked/lidify/issues/26)) - @rustyricky via [#53](https://github.com/Chevron7Locked/lidify/pull/53)
-   **LastFM:** ".map is not a function" crashes with obscure artists ([#37](https://github.com/Chevron7Locked/lidify/issues/37)) - @RustyJonez via [#39](https://github.com/Chevron7Locked/lidify/pull/39)
-   **Wikidata:** 403 Forbidden errors from missing User-Agent header ([#57](https://github.com/Chevron7Locked/lidify/issues/57))
-   **Downloads:** Singles directory creation race conditions ([#58](https://github.com/Chevron7Locked/lidify/issues/58))
-   **Firefox:** FLAC playback stopping at ~4:34 mark on large files ([#42](https://github.com/Chevron7Locked/lidify/issues/42), [#17](https://github.com/Chevron7Locked/lidify/issues/17))

#### Quality of Life (P2)
-   **Desktop UI:** Added missing "Releases" link to desktop sidebar navigation ([#41](https://github.com/Chevron7Locked/lidify/issues/41))
-   **iPhone:** Dynamic Island/notch overlapping TopBar buttons ([#54](https://github.com/Chevron7Locked/lidify/issues/54))

### Technical Details

-   **Docker Permissions (#62):** Creates `/data/postgres` and `/data/redis` directories with proper ownership; validates write permissions at startup using `gosu <user> test -w`
-   **Audio Analyzer Memory (#53):** TensorFlow GPU memory growth enabled; `MAX_ANALYZE_SECONDS` configurable (default 90s); explicit garbage collection in finally blocks
-   **LastFM Normalization (#39):** `normalizeToArray()` utility wraps single-object API responses; protects 5 locations in artist discovery endpoints
-   **Wikidata User-Agent (#57):** All 4 API endpoints now use configured axios client with proper User-Agent header
-   **Singles Directory (#58):** Replaced TOCTOU `existsSync()`+`mkdirSync()` pattern with idempotent `mkdir({recursive: true})`
-   **Firefox FLAC (#42):** Replaced Express `res.sendFile()` with manual range request handling via `fs.createReadStream()` with proper `Content-Range` headers
-   **Desktop Releases (#41):** Single-line addition to Sidebar.tsx navigation array
-   **iPhone Safe Area (#54):** TopBar and AuthenticatedLayout use `env(safe-area-inset-top)` CSS environment variable

### Deferred to Future Release

-   **PR #49** - Playlist visibility toggle (needs PR review)
-   **PR #47** - Mood bucket tags (already implemented, verify and close)
-   **PR #36** - Docker --user flag (needs security review)

### Contributors

Thanks to everyone who contributed to this release:

-   @arsaboo - Docker bind mount permissions fix ([#62](https://github.com/Chevron7Locked/lidify/pull/62))
-   @rustyricky - Audio analyzer memory limits ([#53](https://github.com/Chevron7Locked/lidify/pull/53))
-   @RustyJonez - LastFM array normalization ([#39](https://github.com/Chevron7Locked/lidify/pull/39))
-   @tombatossals - Testing and validation

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

-   Multi-source download system with configurable Soulseek/Lidarr primary source and fallback options
-   Configurable enrichment speed control (1-5x concurrency) in Settings → Cache & Automation
-   Stale job cleanup button in Settings to clear stuck Discovery batches and downloads
-   Mobile touch drag support for seek sliders on all player views
-   Skip ±30s buttons for audiobooks/podcasts on mobile players
-   iOS PWA media controls support (Control Center and Lock Screen)
-   Artist name alias resolution via Last.fm (e.g., "of mice" → "Of Mice & Men")
-   Library grid now supports 8 columns on ultra-wide displays (2xl breakpoint)
-   Artist discography sorting options (Year/Date Added)
-   Enrichment failure notifications with retry/skip modal
-   Download history deduplication to prevent duplicate entries
-   Utility function for normalizing API responses to arrays (`normalizeToArray`) - @tombatossals
-   Keyword-based mood scoring for standard analysis mode tracks - @RustyJonez
-   Global and route-level error boundaries for better error handling
-   React Strict Mode for development quality checks
-   Next.js image optimization enabled by default
-   Mobile-aware animation rendering (GalaxyBackground disables particles on mobile)
-   Accessibility motion preferences support (`prefers-reduced-motion`)
-   Lazy loading for heavy components (MoodMixer, VibeOverlay, MetadataEditor)
-   Bundle analyzer tooling (`npm run analyze`)
-   Loading states for all 10 priority routes
-   Skip links for keyboard navigation (WCAG 2.1 AA compliance)
-   ARIA attributes on all interactive controls and navigation elements
-   Toast notifications with ARIA live regions for screen readers
-   Bull Board admin dashboard authentication (requires admin user)
-   Lidarr webhook signature verification with configurable secret
-   Encryption key validation on startup (prevents insecure defaults)
-   Session cookie security (httpOnly, sameSite=strict, secure in production)
-   Swagger API documentation authentication in production
-   JWT token expiration (24h access tokens, 30d refresh tokens)
-   JWT refresh token endpoint (`/api/auth/refresh`)
-   Token version validation (password changes invalidate existing tokens)
-   Download queue reconciliation on server startup (marks stale jobs as failed)
-   Redis batch operations for cache warmup (MULTI/EXEC pipelining)
-   Memory-efficient database-level shuffle (`ORDER BY RANDOM() LIMIT n`)
-   Dynamic import caching in queue cleaner (lazy-load pattern)
-   Database index for `DownloadJob.targetMbid` field
-   PWA install prompt dismissal persistence (7-day cooldown)

### Fixed

-   **Critical:** Audio analyzer crashes on libraries with non-ASCII filenames ([#6](https://github.com/Chevron7Locked/lidify/issues/6))
-   **Critical:** Audio analyzer BrokenProcessPool after ~1900 tracks ([#21](https://github.com/Chevron7Locked/lidify/issues/21))
-   **Critical:** Audio analyzer OOM kills with aggressive worker auto-scaling ([#26](https://github.com/Chevron7Locked/lidify/issues/26))
-   **Critical:** Audio analyzer model downloads and volume mount conflicts ([#2](https://github.com/Chevron7Locked/lidify/issues/2))
-   Radio stations playing songs from wrong decades due to remaster dates ([#43](https://github.com/Chevron7Locked/lidify/issues/43))
-   Manual metadata editing failing with 500 errors ([#9](https://github.com/Chevron7Locked/lidify/issues/9))
-   Active downloads not resolving after Lidarr successfully imports ([#31](https://github.com/Chevron7Locked/lidify/issues/31))
-   Discovery playlist downloads failing for artists with large catalogs ([#34](https://github.com/Chevron7Locked/lidify/issues/34))
-   Discovery batches stuck in "downloading" status indefinitely
-   Audio analyzer rhythm extraction failures on short/silent audio ([#13](https://github.com/Chevron7Locked/lidify/issues/13))
-   "Of Mice & Men" artist name truncated to "Of Mice" during scanning
-   Edition variant albums (Remastered, Deluxe) failing with "No releases available"
-   Downloads stuck in "Lidarr #1" state for 5 minutes before failing
-   Download duplicate prevention race condition causing 10+ duplicate jobs
-   Lidarr downloads incorrectly cancelled during temporary network issues
-   Discovery Weekly track durations showing "NaN:NaN"
-   Artist name search ampersand handling ("Earth, Wind & Fire")
-   Vibe overlay display issues on mobile devices
-   Pagination scroll behavior (now scrolls to top instead of bottom)
-   LastFM API crashes when receiving single objects instead of arrays ([#37](https://github.com/Chevron7Locked/lidify/issues/37)) - @tombatossals
-   Mood bucket infinite loop for tracks analyzed in standard mode ([#40](https://github.com/Chevron7Locked/lidify/issues/40)) - @RustyJonez
-   Playlist visibility toggle not properly syncing hide/show state - @tombatossals
-   Audio player time display showing current time exceeding total duration (e.g., "58:00 / 54:34")
-   Progress bar could exceed 100% for long-form media with stale metadata
-   Enrichment P2025 errors when retrying enrichment for deleted entities
-   Download settings fallback not resetting when changing primary source
-   SeekSlider touch events bubbling to parent OverlayPlayer swipe handlers
-   Audiobook/podcast position showing 0:00 after page refresh instead of saved progress
-   Volume slider showing no visual fill indicator for current level
-   PWA install prompt reappearing after user dismissal

### Changed

-   Audio analyzer default workers reduced from auto-scale to 2 (memory conservative)
-   Audio analyzer Docker memory limits: 6GB limit, 2GB reservation
-   Download status polling intervals: 5s (active) / 10s (idle) / 30s (none), previously 15s
-   Library pagination options changed to 24/40/80/200 (divisible by 8-column grid)
-   Lidarr download failure detection now has 90-second grace period (3 checks)
-   Lidarr catalog population timeout increased from 45s to 60s
-   Download notifications now use API-driven state instead of local pending state
-   Enrichment stop button now gracefully finishes current item before stopping
-   Per-album enrichment triggers immediately instead of waiting for batch completion
-   Lidarr edition variant detection now proactive (enables `anyReleaseOk` before first search)
-   Discovery system now uses AcquisitionService for unified album/track acquisition
-   Podcast and audiobook time display now shows time remaining instead of total duration
-   Edition variant albums automatically fall back to base title search when edition-specific search fails
-   Stale pending downloads cleaned up after 2 minutes (was indefinite)
-   Download source detection now prioritizes actual service availability over user preference

### Removed

-   Artist delete buttons hidden on mobile to prevent accidental deletion
-   Audio analyzer models volume mount (shadowed built-in models)

### Database Migrations Required

```bash
# Run Prisma migrations
cd backend
npx prisma migrate deploy
```

**New Schema Fields:**

-   `Album.originalYear` - Stores original release year (separate from remaster dates)
-   `SystemSettings.enrichmentConcurrency` - User-configurable enrichment speed (1-5)
-   `SystemSettings.downloadSource` - Primary download source selection
-   `SystemSettings.primaryFailureFallback` - Fallback behavior on primary source failure
-   `SystemSettings.lidarrWebhookSecret` - Shared secret for Lidarr webhook signature verification
-   `User.tokenVersion` - Version number for JWT token invalidation on password change
-   `DownloadJob.targetMbid` - Index added for improved query performance

**Backfill Script (Optional):**

```bash
# Backfill originalYear for existing albums
cd backend
npx ts-node scripts/backfill-original-year.ts
```

### Breaking Changes

-   None - All changes are backward compatible

### Security

-   **Critical:** Bull Board admin dashboard now requires authenticated admin user
-   **Critical:** Lidarr webhooks verify signature/secret before processing requests
-   **Critical:** Encryption key validation on startup prevents insecure defaults
-   Session cookies use secure settings in production (httpOnly, sameSite=strict, secure)
-   Swagger API documentation requires authentication in production (unless `DOCS_PUBLIC=true`)
-   JWT tokens have proper expiration (24h access, 30d refresh) with refresh token support
-   Password changes invalidate all existing tokens via tokenVersion increment
-   Transaction-based download job creation prevents race conditions
-   Enrichment stop control no longer bypassed by worker state
-   Download queue webhook handlers use Serializable isolation transactions
-   Webhook race conditions protected with exponential backoff retry logic

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
6. Review Settings → Downloads for new multi-source download options
7. Review Settings → Cache for new enrichment speed control
8. Configure Lidarr webhook secret in Settings for webhook signature verification (recommended)
9. Review Settings → Security for JWT token settings

### Known Issues

-   Pre-existing TypeScript errors in spotifyImport.ts matchTrack method (unrelated to this release)
-   Simon & Garfunkel artist name may be truncated due to short second part (edge case, not blocking)

### Contributors

Big thanks to everyone who contributed, tested, and helped make this release happen:

-   @tombatossals - LastFM API normalization utility ([#39](https://github.com/Chevron7Locked/lidify/pull/39)), playlist visibility toggle fix ([#49](https://github.com/Chevron7Locked/lidify/pull/49))
-   @RustyJonez - Mood bucket standard mode keyword scoring ([#47](https://github.com/Chevron7Locked/lidify/pull/47))
-   @iamiq - Audio analyzer crash reporting ([#2](https://github.com/Chevron7Locked/lidify/issues/2))
-   @volcs0 - Memory pressure testing ([#26](https://github.com/Chevron7Locked/lidify/issues/26))
-   @Osiriz - Long-running analysis testing ([#21](https://github.com/Chevron7Locked/lidify/issues/21))
-   @hessonam - Non-ASCII character testing ([#6](https://github.com/Chevron7Locked/lidify/issues/6))
-   @niles - RhythmExtractor edge case reporting ([#13](https://github.com/Chevron7Locked/lidify/issues/13))
-   @TheChrisK - Metadata editor bug reporting ([#9](https://github.com/Chevron7Locked/lidify/issues/9))
-   @lizar93 - Discovery playlist testing ([#34](https://github.com/Chevron7Locked/lidify/issues/34))
-   @brokenglasszero - Mood tags feature verification ([#35](https://github.com/Chevron7Locked/lidify/issues/35))

And all users who reported bugs, tested fixes, and provided feedback!

---

For detailed technical implementation notes, see [docs/PENDING_DEPLOY.md](docs/PENDING_DEPLOY.md).
