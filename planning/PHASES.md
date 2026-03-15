# Kima 2.0 -- Phases

| Phase | Name | Status | Appetite | Started | Completed |
|-------|------|--------|----------|---------|-----------|
| 0 | Foundation (Go scaffold, DB, Redis, config, health, tests) | Complete | 1-2 weeks | 2026-03-14 | 2026-03-15 |
| 1 | Core Library (auth, scanner, library API, streaming, playback) | Active | 2-3 weeks | 2026-03-15 | -- |
| 2 | Enrichment (state machine, phases, ONNX, DSP, failure tracking) | Planned | 3-4 weeks | -- | -- |
| 3 | Discovery & Vibes (taste profiles, similarity, mixes, radio, discovery) | Planned | 2-3 weeks | -- | -- |
| 4 | Integrations (Lidarr, Soulseek, Spotify/Deezer import, LastFM, MusicBrainz) | Planned | 2-3 weeks | -- | -- |
| 5 | Compatibility & Polish (Subsonic, sharing, notifications, maintenance) | Planned | 2-3 weeks | -- | -- |
| 6 | OurSpace Integration (social layer -- separate project) | Deferred | TBD | -- | -- |
| 7 | Frontend Rewrite (SvelteKit -- parallel track) | Planned | 9-12 weeks | -- | -- |

---

## Phase Rules

1. **One phase active at a time.** Do not write Phase N+1 code until Phase N is complete.
2. **Appetite is a budget, not a deadline.** If you blow through it, investigate scope creep before continuing.
3. **Phase completion criteria:** all KANBAN tasks for the phase are in Done, integration tests pass, design doc status updated to "Implemented."
4. **Exception:** Frontend (Phase 7) can run in parallel with backend phases since it's a separate codebase.

---

## Phase 0 Goal Statement
When Phase 0 is complete: the Go project compiles, connects to PostgreSQL and Redis, runs migrations, serves health check endpoints, has testcontainers infrastructure for integration tests, and has the full directory structure from the requirements doc Section 1.2. No business logic -- just plumbing.

## Design Doc Coverage

| Phase | Design Doc |
|-------|-----------|
| 0 | Requirements doc Sections 1, 22-25 |
| 1 | Requirements doc Sections 5, 7, 12, 13 |
| 2 | `2026-03-13-enrichment-architecture-design.md` |
| 3 | `2026-03-14-relationship-similarity-design.md` |
| 4 | `2026-03-13-soulseek-acquisition-design.md` + Requirements doc Section 9 |
| 5 | `2026-03-14-search-system-design.md` + Requirements doc Sections 13, 15-19 |
| 6 | Requirements doc Section 9.1.11 (OurSpace) |
| 7 | Frontend migration research doc |
