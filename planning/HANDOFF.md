# Kima -- Current State

**Updated:** 2026-03-16
**Current Focus:** v1 maintenance (production readiness pass)
**Branch:** main

## Active Task

None -- production readiness pass complete. Waiting for next v1 task.

## Last Session (2026-03-16)

Production readiness pass across v1 codebase. Four commits:

**Tier 1 -- Critical (OOM, DoS, SSRF, auth, tests):**
- `GET /playlists` OOM: replaced deep 5-level Prisma include with `_count` + 4-item mosaic select. Pre-existing `coverArt`/`coverUrl` field mismatch fixed as bonus.
- `recently-listened` DoS: capped `limit` to max 100
- N+1 Deezer API calls: wrapped 3 separate `Promise.all` loops with `pLimit(3)` in library.ts
- SSRF in systemSettings: applied `validateUrlForFetch` to `test-lidarr`, `lidarr-profiles`, `test-audiobookshelf`
- `requireAdmin` double-auth in systemSettings: removed redundant `router.use(requireAuth)` before `router.use(requireAdmin)` (requireAdmin already calls authenticateRequest internally)
- `webhookEventStore.test.ts`: was hitting real PostgreSQL in CI, rewrote as mocked unit test -- 10/10 passing

**Tier 2+3 -- High (UMAP, cache TTL, timer cleanup):**
- UMAP `nNeighbors` scaling: replaced hard cap of 15 with `Math.min(50, Math.max(5, Math.round(Math.sqrt(rows.length))))` -- proportional local/global structure balance
- Circular layout cache TTL: reduced from 24h to 1h so UMAP upgrade happens naturally after enrichment adds more tracks
- Timer cleanup on unmount: added `useEffect` cleanup for `saveTimerRef` (VibeMap.tsx) and `searchTimerRef` (vibe/page.tsx)

**Tier 4 -- Medium (already done in Tier 1 -- double-auth was part of systemSettings fix):**
- Separate commit `70cba5b` for systemSettings double-auth removal

## Next Session Goal

TBD -- user to direct next v1 task.

## Open Questions

- None blocking.
- Mixes system rework (memory: project_mixes_rework.md) -- 35+ auto-generated mixes disconnected from CLAP/vibe system. Candidate for next v1 work.

## Recent Decisions

- `validateUrlForFetch` from `backend/src/utils/ssrf.ts` is the canonical SSRF defense -- apply to all endpoints that accept user-supplied URLs
- `requireAdmin` already calls `authenticateRequest` internally -- never combine `requireAuth` + `requireAdmin` on the same router
- `pLimit(3)` is the standard concurrency cap for external API calls (already installed, CJS compatible)
- UMAP `nNeighbors` scales with sqrt(library size), capped 5-50

## Key Files

- v1 backend: `backend/src/`
- v1 frontend: `frontend/`
- Planning: `planning/KANBAN.md`, `planning/decisions/`
- Memory: `/home/chevron7/.claude/projects/-mnt-storage-Projects-lidify/memory/MEMORY.md`

## What NOT to Touch

- Kima 2.0 Go rewrite (`kima/`) -- separate concern, deferred for now
- OurSpace -- deferred

---

## How This Planning System Works (For Agents)

**You are expected to maintain these planning files.** They are not human-maintained artifacts -- they are agent-maintained, human-reviewed.

### Session Start
1. Read this file (`planning/HANDOFF.md`) first. It tells you the current state.
2. Read `planning/KANBAN.md` for the task board. The top Backlog item is the next task.
3. Do NOT start implementing until the user confirms the approach.

### During Work
4. Work on one task at a time (WIP limit of 1 in KANBAN).
5. If implementation diverges from a design doc, update the design doc in the same commit.
6. If you make a non-obvious architectural decision, write a `planning/decisions/DEC-NNN.md`.

### Session End
When the user says "update planning files," "wrap up," or the session is ending:
7. **Update this file** -- rewrite the Active Task, Last Session, Next Session Goal, and Open Questions sections to reflect current state.
8. **Update KANBAN.md** -- move completed tasks to Done, ensure In Progress and Backlog are accurate.
9. **Write a session journal** at `planning/sessions/YYYY-MM-DD.md` -- summarize what was done, decisions made, surprises, and next steps.
10. Commit all planning file updates.

### Periodic Review
When the user says "review planning files" or "check planning status":
11. Check git history against KANBAN -- are Done items actually committed? Are In Progress items reflected in recent commits?
12. Report findings to the user. Update files as needed.

### What Only the Human Does
- Decides what to work on (backlog ordering)
- Reviews agent output (quality gate)
- Notices when something feels off
- Says "update planning files" at session end
