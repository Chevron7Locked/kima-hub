# Kanban

**WIP limit: 1 task in In Progress at any time.**

---

## In Progress

(none)

---

## Backlog (ordered -- top is next)

### v1 Maintenance

(empty -- awaiting user direction)

---

## Done

### v1 -- Production Readiness (completed 2026-03-16)

**Tier 1 -- Critical**
- [x] GET /playlists OOM: replace deep Prisma include with _count + 4-item mosaic select -- `backend/src/routes/playlists.ts`
- [x] Playlist mosaic coverArt->coverUrl field name fix -- `frontend/app/playlists/page.tsx`
- [x] recently-listened DoS: cap limit param to max 100 -- `backend/src/routes/library.ts`
- [x] N+1 Deezer API calls: pLimit(3) on 3 Promise.all loops -- `backend/src/routes/library.ts`
- [x] SSRF in systemSettings: validateUrlForFetch on test-lidarr, lidarr-profiles, test-audiobookshelf -- `backend/src/routes/systemSettings.ts`
- [x] requireAdmin double-auth: remove redundant requireAuth before requireAdmin -- `backend/src/routes/systemSettings.ts`
- [x] webhookEventStore.test.ts: rewrite as mocked unit test (was hitting real PG in CI) -- `backend/src/services/__tests__/`

**Tier 2+3 -- High**
- [x] UMAP nNeighbors: sqrt scaling (min 5, max 50) replacing hard cap of 15 -- `backend/src/services/umapProjection.ts`
- [x] Circular layout cache TTL: 1h instead of 24h -- `backend/src/services/umapProjection.ts`
- [x] Timer cleanup on unmount: saveTimerRef + searchTimerRef -- `frontend/features/vibe/VibeMap.tsx`, `frontend/app/vibe/page.tsx`

---

### Kima 2.0 -- Phase 0: Foundation (completed 2026-03-15)
- [x] Initialize Go module with directory structure from requirements doc Section 1.2
- [x] Set up pgx v5 connection pool with pgxpool and health check
- [x] Set up Redis connection with go-redis/v9
- [x] Configure caarlos0/env/v11 for environment-based config
- [x] Set up slog structured logging
- [x] Set up golang-migrate migration runner with embedded SQL files
- [x] Set up HTTP server with graceful shutdown
- [x] Set up Prometheus metrics endpoint
- [x] Configure rate limiting middleware
- [x] Configure CORS middleware
- [x] Implement health check endpoints (/health, /health/ready)
- [x] Set up testcontainers-go with pgvector/pgvector:pg16 + Redis
- [x] Write initial schema migration (21 tables, HNSW indexes, FTS config, GENERATED columns)
- [x] Integration tests for schema correctness (9 sub-tests)
- [x] sqlc setup: sqlc.yaml, 000002 migration, SQL query files, helpers, 20 store integration tests
- [x] Set up golangci-lint with import boundaries
- [x] CI: lint + test jobs (race detector, testcontainers)
- [x] Structure enforcement script
- [x] GitHub repo created (Chevron7Locked/kima-go), branch ruleset

---

### Kima 2.0 -- Phase 1 Backlog (NOT in progress -- deferred)

**Auth & Users**
- [ ] User auth service: JWT (access+refresh with token versioning), Redis session, API key
- [ ] 2FA service: TOTP enrollment + verification, 10 hashed recovery codes
- [ ] User management: register (first-user admin flow), login, password change, settings CRUD
- [ ] Auth middleware chain: Session -> API Key -> JWT -> query param token
- [ ] User API handlers: register, login, refresh, 2FA, settings, admin user management

**Library Scanner**
- [ ] Metadata extraction service: dhowden/tag + ffprobe fallback, all formats
- [ ] Library scanner: goroutine pool, incremental mtime tracking, per-directory progress via SSE
- [ ] Artist/album matching: MBID-first, Unicode normalization + fuzzy threshold, VA detection
- [ ] Cover art pipeline: Embedded -> local folder (cover.jpg)

**Library API**
- [ ] Library browsing API: artists/albums/tracks/genres (paginated, sortable, filterable)
- [ ] Library maintenance API: delete cascade, orphan detection, storage stats

**Playback & Streaming**
- [ ] Audio streaming: HTTP range requests, MIME detection, per-user concurrent limit
- [ ] Transcoding: FFmpeg subprocess, quality presets, disk cache with LRU eviction
- [ ] Playback state: Redis-backed per-user state, delta updates
- [ ] Play tracking: play log (min 30s threshold, skip detection), play history API
- [ ] Lyrics service: serve embedded lyrics, LRCLib external fetch fallback

**Subsonic**
- [ ] Subsonic core: XML/JSON response encoder, auth middleware
- [ ] Subsonic library + search endpoints
- [ ] Subsonic playback + system endpoints
- [ ] Subsonic playlists + user endpoints
