# Kanban

**WIP limit: 1 task in In Progress at any time.**

---

## In Progress

(none)

---

## Backlog (ordered -- top is next)

### Phase 1: Core Library

**Auth & Users**
- [ ] sqlc setup: configure sqlc.yaml, write SQL queries for all library entities (tracks, albums, artists, plays, users), run generate -- creates `internal/library/queries/` and `internal/user/queries/`
- [ ] User auth service: JWT (access+refresh with token versioning), Redis session, API key -- `internal/user/auth.go`
- [ ] 2FA service: TOTP enrollment + verification, 10 hashed recovery codes -- `internal/user/totp.go`
- [ ] User management: register (first-user admin flow), login, password change, settings CRUD, onboarding status -- `internal/user/service.go`
- [ ] Auth middleware chain: Session -> API Key -> JWT -> query param token -- `api/middleware/auth.go`
- [ ] User API handlers: register, login, refresh, 2FA, settings, admin user management -- `api/v1/users*.go`

**Library Scanner**
- [ ] Metadata extraction service: `dhowden/tag` + ffprobe fallback, all formats (MP3 FLAC M4A OGG WAV WMA APE), embedded artwork, embedded lyrics (plain + LRC) -- `internal/library/metadata.go`
- [ ] Library scanner: goroutine pool, incremental mtime tracking, per-directory progress via SSE, asynq background job -- `internal/library/scanner.go`
- [ ] Artist/album matching: MBID-first, Unicode normalization + fuzzy threshold, VA detection heuristics, featured artist parsing ("feat."/"ft."/"&"/"with") -- `internal/library/matcher.go`
- [ ] Cover art pipeline: Embedded -> local folder (cover.jpg) -- store locally, no external sources in Phase 1 -- `internal/library/artwork.go`

**Library API**
- [ ] Library browsing API: artists/albums/tracks/genres (paginated, sortable, filterable by genre/decade/mood), recently added, recently played, random shuffle -- `api/v1/library*.go`
- [ ] Library maintenance API: delete cascade (track/album/artist), orphan detection, corrupt track detection, storage stats -- `api/v1/maintenance.go`

**Playback & Streaming**
- [ ] Audio streaming: HTTP range requests, MIME detection, per-user concurrent limit (configurable, default 2), stream session tracking + cleanup -- `internal/playback/stream.go`
- [ ] Transcoding: FFmpeg subprocess via os/exec, quality presets (original/320/192/128kbps), disk cache with configurable max size + LRU eviction -- `internal/playback/transcode.go`
- [ ] Playback state: Redis-backed per-user state (track, position, queue, shuffle, repeat), delta updates, 5MB limit -- `internal/playback/state.go`
- [ ] Play tracking: play log (min 30s threshold, skip detection), play history API (paginated, date filtered), aggregate stats (top tracks/artists/albums, listening time) -- `internal/playback/plays.go`
- [ ] Lyrics service: serve embedded lyrics from DB, LRCLib external fetch fallback, cache in DB -- `internal/playback/lyrics.go`

**Subsonic**
- [ ] Subsonic core: XML/JSON response encoder, auth middleware (MD5 token, API key, basic), separate rate limit (1500 req/min) -- `internal/subsonic/`
- [ ] Subsonic library + search endpoints: getIndexes, getArtists, getArtist, getAlbum, getSong, getAlbumList, getMusicDirectory, getGenres, getSimilarSongs, search2, search3, getRandomSongs, getSongsByGenre -- `internal/subsonic/library.go`
- [ ] Subsonic playback + system endpoints: ping, getLicense, getMusicFolders, scan, stream, download, getCoverArt, getNowPlaying, scrobble, playQueue, bookmarks, getLyrics, getLyricsBySongId -- `internal/subsonic/playback.go`
- [ ] Subsonic playlists + user endpoints: getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist, getStarred, star, unstar, setRating, getUser, getUsers, createUser, updateUser, deleteUser, changePassword -- `internal/subsonic/social.go`

**Deferred from Phase 1 (Phase 3+):**
- Radio mode (Section 7.2.6) -- requires artist relationship graph (Phase 3)
- Play event signals (EWMA taste profile, transition graph) -- Phase 3
- File watching (fsnotify) -- Phase 3
- External cover art (Deezer, MB CAA, LastFM) -- Phase 4
- Shadow artist entities -- Phase 3
- OurSpace opt-in/out flow -- Phase 6 (hub_user_id column already in schema)

---

## Done

### Phase 0: Foundation (completed 2026-03-15)
- [x] Initialize Go module with directory structure from requirements doc Section 1.2 -- `kima/` at project root, all 14 internal/pkg/api/cmd dirs created
- [x] Set up pgx v5 connection pool with pgxpool and health check -- `pkg/db/db.go`
- [x] Set up Redis connection with go-redis/v9 -- `pkg/cache/cache.go`
- [x] Configure caarlos0/env/v11 for environment-based config -- `pkg/config/config.go`
- [x] Set up slog structured logging (JSON in prod, text in dev) -- `cmd/kima/main.go` newLogger()
- [x] Set up golang-migrate migration runner with embedded SQL files -- `pkg/db/db.go` + `migrations/` package
- [x] Set up HTTP server with graceful shutdown (errgroup + signal handling) -- `cmd/kima/main.go`
- [x] Set up Prometheus metrics endpoint -- `/metrics` via promhttp
- [x] Configure rate limiting middleware -- `api/middleware/ratelimit.go`
- [x] Configure CORS middleware -- `api/middleware/cors.go`
- [x] Implement health check endpoints (/health, /health/ready) -- `api/v1/health.go`
- [x] Set up SPA routing fallback -- placeholder in main.go, will embed SvelteKit in Phase 5
- [x] Set up testcontainers-go with pgvector/pgvector:pg16 + Redis -- `pkg/testutil/containers.go`
- [x] Write initial schema migration (21 tables, HNSW indexes, FTS config, GENERATED columns) -- `migrations/000001_initial.up.sql`
- [x] Integration tests for schema correctness (9 sub-tests: tables, extensions, FTS config, indexes, constraints, GENERATED columns, idempotency) -- `pkg/db/migration_test.go`
- [x] Set up golangci-lint with import boundaries (depguard), complexity limits (funlen/gocognit), correctness linters -- `.golangci.yml`
- [x] CI: lint job (golangci-lint + structure check) + test job (race detector, testcontainers) -- `.github/workflows/ci.yml`
- [x] Structure enforcement script: file length limits (400/600), api/v1 80-line limit, junk-drawer name detection -- `scripts/check-structure.sh`
- [x] GitHub repo created (`Chevron7Locked/kima-go`), branch ruleset requiring Lint + Test status checks
