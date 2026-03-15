# Kima 2.0 -- Current State

**Updated:** 2026-03-15
**Current Phase:** Phase 1 -- Core Library
**Phase Status:** Active, backlog populated, no tasks started

## Active Task

None -- Phase 1 backlog is ready, waiting to begin first task.

## Last Session (2026-03-15)

Phase 0 (Foundation) completed in full:
- Go module scaffolded (`github.com/Chevron7Locked/kima-go`) with all 14 internal/pkg/api/cmd directories
- pgxpool + go-redis + caarlos0/env config + slog logging all wired
- golang-migrate with embedded SQL, full 21-table schema migration
- Schema integration tests (9 sub-tests): tables, extensions (pg_trgm/vector/unaccent), music_simple FTS config, HNSW indexes, GENERATED columns, constraints, idempotency
- testcontainers (pgvector:pg16 + redis:7-alpine) for all integration tests
- Health endpoints (/health, /health/ready) with consumer-defined interfaces for testability
- CORS, rate limiting, logging middleware -- all with behavior tests
- golangci-lint: errcheck/govet/staticcheck/depguard/funlen/gocognit + full import boundary enforcement via depguard
- CI: Lint + Test jobs with race detector; branch ruleset requires both to pass
- Structure enforcement: file length limits (400/600), api/v1 80-line limit, junk-drawer name detection
- GitHub repo live at `Chevron7Locked/kima-go`, branch rulesets enforced
- Phase 1 backlog populated from requirements doc Sections 5, 7, 12, 13

## Next Session Goal

Begin Phase 1, starting with sqlc setup then auth service. First task: configure sqlc and write SQL queries for all library entities.

## Open Questions

- None blocking Phase 1 start.
- Radio mode (Section 7.2.6) deferred -- requires artist relationship graph from Phase 3. Confirm when Phase 3 is planned.
- External cover art (Deezer/MusicBrainz CAA/LastFM fallbacks) deferred to Phase 4.

## Recent Decisions

- **Go 1.26.1**: installed at `/home/chevron7/go126/`. Use full path + explicit GOROOT/GOPATH in shell commands since PATH doesn't persist between tool calls.
- **chi router**: chosen over stdlib 1.22+ mux for middleware ecosystem. `go-chi/chi` v5.
- **Consumer-defined interfaces**: health handler uses `DBPinger`/`CachePinger` interfaces, not concrete types. Same pattern used throughout for testability.
- **cache.Pinger wrapper**: `pkg/cache` exports `Pinger` struct wrapping `*redis.Client` to satisfy the `CachePinger` interface without the health package importing Redis.
- **Migrations package**: `migrations/` at project root with `//go:embed *.sql` -- cannot embed from outside package directory, so dedicated package exports `var FS embed.FS`.
- **Test philosophy**: tests must fail if the behavior they describe is wrong. No smoke tests, no tests that pass against stubs. Error paths tested via mock interfaces.
- **Structural enforcement**: custom `scripts/check-structure.sh` for file length limits (400/600 lines), api/v1 80-line cap, junk-drawer name detection. Not expressible in golangci-lint.

## Key Files

- Design docs: `docs/plans/2026-03-1[3-4]-*-design.md`
- Requirements: `docs/plans/2026-03-12-kima-2.0-go-rewrite-requirements.md`
- KANBAN: `planning/KANBAN.md` -- Phase 1 backlog (21 tasks)
- Memory: `/home/chevron7/.claude/projects/-mnt-storage-Projects-lidify/memory/MEMORY.md`
- Go binary: `/home/chevron7/go126/bin/go` (GOROOT=/home/chevron7/go126, GOPATH=/home/chevron7/gopath)

## What NOT to Touch

- Frontend SvelteKit migration -- separate concern, local agent handling
- Vibe page redesign -- actively being revised (frontend)
- OurSpace -- Phase 6, deferred
- Live site TypeScript code -- scoring fix doc exists, agents can patch independently

---

## How This Planning System Works (For Agents)

**You are expected to maintain these planning files.** They are not human-maintained artifacts -- they are agent-maintained, human-reviewed.

### Session Start
1. Read this file (`planning/HANDOFF.md`) first. It tells you the current state.
2. Read `planning/KANBAN.md` for the task board. The top Backlog item is the next task.
3. Read the relevant design doc for the active phase (see `docs/STATUS.md` for the index).
4. Do NOT start implementing until the user confirms the approach.

### During Work
5. Work on one task at a time (WIP limit of 1 in KANBAN).
6. If implementation diverges from a design doc, update the design doc in the same commit.
7. If you make a non-obvious architectural decision, write a `planning/decisions/DEC-NNN.md`.

### Session End
When the user says "update planning files," "wrap up," or the session is ending:
8. **Update this file** -- rewrite the Active Task, Last Session, Next Session Goal, and Open Questions sections to reflect current state.
9. **Update KANBAN.md** -- move completed tasks to Done, ensure In Progress and Backlog are accurate.
10. **Write a session journal** at `planning/sessions/YYYY-MM-DD.md` -- summarize what was done, decisions made, surprises, and next steps.
11. Commit all planning file updates.

### Periodic Review
When the user says "review planning files" or "check planning status":
12. Check git history against KANBAN -- are Done items actually committed? Are In Progress items reflected in recent commits?
13. Check `docs/STATUS.md` -- are any "Implementing" docs drifting from what was actually built?
14. Check phase appetite in `planning/PHASES.md` -- is the active phase on track?
15. Report findings to the user. Update files as needed.

### Phase Transitions
When a phase completes:
16. Mark all phase tasks as Done in KANBAN.
17. Update PHASES.md -- set status to Complete with date.
18. Update `docs/STATUS.md` -- design doc status to "Implemented."
19. Populate the next phase's backlog in KANBAN from the design doc.
20. Update this file with the new phase context.

### What Only the Human Does
- Decides what to work on (backlog ordering)
- Reviews agent output (quality gate)
- Notices when something feels off ("this phase is taking too long")
- Says "update planning files" at session end
