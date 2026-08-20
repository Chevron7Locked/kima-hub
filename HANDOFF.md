# Handoff: getting this branch production ready

Branch `port/backend-security`, **126 commits ahead of `main`, nothing pushed, nothing deployed**.

Your job is to get this to production. Two different kinds of work, and it matters which is
which:

- **Certain and concrete:** nothing is built, deployed, pushed, or tested at production scale.
  That is section 3's "not verified" list and section 6's order. Do it first; none of it is
  speculative.
- **Speculative:** the bug taxonomy in section 2. Every category is real and every one had
  siblings, but hunting is open-ended. It is worth a lot and it is not a substitute for the
  above.

The gap to close is between "green in dev on 59 tracks" and "correct in a built image on
9,088 tracks".

Read section 1 first. It is the part that will change how you work.

---

## 1. What this session actually taught, and what to do differently

**Around twenty distinct defects were fixed across thirteen commits. Two of them I
introduced while fixing others.** The count is approximate because several commits bundle
closely-related fixes — the exact number matters less than the shape: not one was exotic, and
every single one was in an error path, a cleanup path, or a race. The code nobody exercises,
because the happy path works.

Three lessons, in order of how much they cost:

### Do not diagnose from reading code. Measure.

I diagnosed the queue bug twice from reading source, found something that genuinely looked
guilty both times, shipped a fix both times, and was wrong both times. The failure rate was
about one in two, so a passing run after each "fix" meant nothing.

What actually found it: adding four lines of instrumentation to the test to record the queue
length before and after each step. First captured failure said `queueBefore: 8, queueAfter: 1`
and the bug was obvious. That took one run.

**If a bug is intermittent, instrument before you touch the code.** A plausible cause plus a
green run is not evidence. It is the shape of evidence, which is worse, because it feels like
progress.

### One green run proves nothing

For anything timing-dependent, run it six times. The queue fix was confirmed by six
consecutive clean runs against a prior ~50% failure rate. Earlier "fixes" passed once and
failed the next run on identical code.

### Fix what you find, don't file it

Twice I found a real bug, wrote it up as an observation, and moved on — leaving triage to
someone else. That is not a smaller version of fixing it; it is a different, worse thing. If
you can see it and you can fix it, fix it. The operator's words: *"these arent common or
uncommon or rare design choices. theyre bugs"*.

The corollary: when you are wrong, say so in one line and move on. Two of those defects were mine.
Saying that plainly costs nothing and is the only way the record stays worth reading.

---

## 2. The bug taxonomy

Every category below is backed by at least one confirmed, fixed instance in this repo. When
hunting, work the category, not the file — each of these had siblings.

### A. Someone else's bad input, reported as this server breaking

A user-supplied id goes to an upstream service or straight into Prisma. It gets rejected, the
throw propagates, and the handler's catch answers `500 Internal server error`. The honest
answer is 404 or 400. A 500 says "I am broken" when the truth is "that id is not a thing".

- `routes/artists.ts` `/album/:mbid` — non-UUID forwarded to MusicBrainz → 500. Now validates
  the id shape first, and treats ANY upstream 4xx as not-found. Fixed in `8e274689`.
- `routes/podcasts.ts` `/preview/:itunesId` — a cuid forwarded to iTunes → 500. Fixed in `f9ed99d2`.

**Test for it:** hit every `:param` route with a malformed id and with a well-formed id that
does not exist. Neither may produce a 5xx.

### B. Non-idempotent deletes

`prisma.x.delete()` throws when the row is absent; handlers turn that into 500. Deleting
something already gone is a success — the caller wanted it absent and it is.

- `routes/playbackState.ts` DELETE 500'd on the second call. `deleteMany()` fixed it (`862aa6c0`).
- This one was severe out of proportion to its size: that endpoint is the *recovery path* the
  client calls when its stored state is stale. The 500 meant stale state could never be
  cleared, so every sign-in restored it, failed, and failed to clean up. **A broken recovery
  path turns a transient fault into a permanent one — weight these higher than they look.**

Same shape: `update()` where `upsert()` is needed.

### C. Unhandled promise rejections

`.then()` with no `.catch()` on an API call. No error boundary catches it — it is an async
callback. In `lib/audio-state-context.tsx` the track-restore branch had a catch and the
podcast and audiobook branches did not, so restoring an unsubscribed podcast threw on every
sign-in (`862aa6c0`).

### D. Retrying a permanent failure forever

404 means gone. There is nothing to retry, and no backoff will help. The player kept saving
progress and refetching an unsubscribed podcast indefinitely — 14 errors in seconds, and the
stored id outlived the subscription so it resumed on every future load (`f9ed99d2`).

**The rule:** on 404, drop the reference and forget the stored id. On anything else — timeout,
5xx, dead wifi — log and keep the state, because that is a reason to try later, not to throw
away what the user was doing.

### E. Stale identifiers outliving what they point at

An id in `localStorage` or in server-side playback state, never cleared when its target
disappears. Distinct from D because it survives restarts and spans devices: unsubscribe on
your phone, and your laptop fails on it forever.

### F. Stale closures deciding destructive things

A `useCallback` reads `state.X` to choose a branch that destroys data. If the callback has not
been rebuilt since the state changed, it acts on a stale value.

- **The worst bug of the session.** `addToQueue` in `lib/audio-controls-context.tsx` had a
  branch that REPLACED the whole queue with one track, taken when it believed the queue was
  empty — judged from a closure. Measured: an 8-track album collapsing to 1. Intermittent,
  because it depended on whether a re-render had happened between pressing play and clicking
  add. Fixed in `4b3c6b5c` by reading a ref synced in `useLayoutEffect`.

**Hunt:** any callback whose *destructive* branch is selected from closed-over state.

### G. Refs synced by `useEffect`, used to guard a race

`useEffect(() => { ref.current = x }, [x])` runs after commit, so the ref trails by a render.
Guarding a race with it leaves a window — I shipped exactly that and it failed half the runs.

Order of preference: a functional update (`setX(prev => ...)`) sees the true value atomically;
`useLayoutEffect` is synchronous after commit and safe; `useEffect` is not.

### H. A late response overwriting newer local state

A request issued at mount resolves seconds later and clobbers what the user did meanwhile.
Both in `lib/audio-state-context.tsx`:

- Session restore called `setQueue(serverState.queue)` unconditionally.
- The cross-device poller adopted the server's queue whenever it *differed* from local. But
  saving is debounced, so "differs" includes "my own change has not uploaded yet". The test
  must be **is the remote genuinely NEWER than my local change**, never "is it different".

### I. Scheduler and timer faults

- **A scheduler that starves itself.** A 5-second busy interval under a 10-second minimum gap:
  every productive cycle's next tick was refused for being early, the refusal was
  indistinguishable from "ran, found nothing", so the caller backed off to 60 seconds. Real
  cadence with work outstanding: 65s. Embedding 59 tracks took ten minutes for **fifty seconds
  of actual work**. Fixed in `41f781ee` — now 26 seconds, no idle gaps.
- **Rearming a timer from two places.** A `return` inside a `try` still runs the `finally`. I
  scheduled in both, so each declined cycle started a second chain. Chains doubled: 181MB →
  2.2GB → out of memory in two minutes (`73fdc732`). **Mine.**
- **Work that does not count as work.** The same `didWork` flag ignored two phases, so a cycle
  that queued 100 embedding jobs reported itself idle and slept.

### J. States with no exit but a process restart

A row parked in `processing` / `validating` / `enriching` where the only thing that clears it
is a once-per-boot recovery pass. `scanStatus='validating'` stranded 58 of 59 tracks. Anything
written as an in-progress marker needs a reaper on a timer, keyed on a timestamp column that
means what you think — `updatedAt` did not, because unrelated bulk writes touch it (`6b00c81a`).

### K. Two of our own endpoints that will not compose

`/podcasts/discover/top` returned `itunesId` as a number; `/podcasts/subscribe` accepts an
`itunesId`; the column is `String?`. Browse then subscribe — the obvious pairing — answered
500. Sibling endpoints stringified the same field and three did not (`ea87d619`).

**Hunt "discover then act" pairs** — an endpoint that hands you an object, and another that
takes an id from it. Confirmed to exist and worth checking: `/podcasts/discover/top` and
`/podcasts/preview/:itunesId` both feed `/podcasts/subscribe` (that pair is where the bug was).
Others plausibly exist around `/browse/playlists/*` → playlist import, `/search` → play, and
`/releases` / `/discover` → whatever acts on them, but I have NOT confirmed those wire together
— check before hunting.

### L. Dev/prod divergence

`services/umapProjection.ts` loaded `../workers/umapWorker.js`, which only exists after a
build. The vibe map worked in production and was dead on every dev instance (`1854bda8`). The
inverse is the dangerous one for you: works in dev, breaks in the image.

### M. A handler registered on the thing that triggers the error when it unmounts

`app/vibe/page.tsx` suppressed a luma.gl teardown error with a listener registered on that
page — removed on unmount, and unmount is what fires the error. So leaving the vibe map threw
on whichever page you went to next, where it looked like a fault in *that* page. Moved to the
root (`4b3c6b5c`).

### N. Side effects inside a state updater

`setX(prev => { doSomething(); return next })` — Strict Mode double-invokes updaters. Bit this
codebase via `hooks/useActivityPanel.ts`, which dispatched a window event inside the updater and
left the panel unable to open. **That instance is already fixed** (it now uses a ref and calls
the side effect outside the updater) — the category is here because siblings are likely, not
because that one is outstanding.

---

## 3. What is verified, and what is not

**Verified:**
- Backend typecheck clean; **814 tests pass**; `npm run build` succeeds; `dist/workers/umapWorker.js` emitted.
- Frontend `npm run build` compiles.
- Dogfood walkthrough green **6 consecutive runs** (see section 4).
- Enrichment memory flat 179–214MB over ~7 minutes after the leak fix.
- Embedding 59 tracks: 26s, no idle gaps, 2.3 tracks/sec.
- Corrupt-file gate: a garbage `.flac` is refused and retired; a good file analyses and embeds.
- On the production library (read-only): of 68 tracks marked failed, **12 are false positives** —
  a whole album rejected for a malformed cover image, not bad audio. Fixed in `1c410ac1`, **not
  yet re-run against production**.

**NOT verified — this is the real work:**

1. **Nothing is deployed.** Production runs `chevron7locked/kima:nightly`, built **2026-07-15**.
   Every change here reached the test stack by `rsync`. The image has never been built with
   this code.
2. **Nothing is pushed.**
3. **Scale.** Production has **9,088 tracks**; everything was measured on **59**. The scheduler
   change makes cycles run ~10× more often, and each runs full-table aggregates on the same
   connection pool that serves audio streaming. **This is the largest unknown and it sits
   directly under a change I made.**
4. **Audiobooks never exercised.** Blocked on credentials — see section 5.
5. **Memory soak was 7 minutes**, not hours, and on a 59-track library.
6. **Podcast journey depends on the public internet** (iTunes). It distinguishes "the app
   broke" from "the directory was unreachable", but a CI run will be flaky without network.
7. **The 12 false-positive tracks in production are still marked failed.** The fix does not
   retroactively reset them; they need a re-analysis pass.
8. **Two fixes in `4b3c6b5c` are unvalidated against any symptom.** The session-restore queue
   guard and the sync-poller freshness check were both written while chasing the queue bug and
   neither fixed it. They are correct on their own terms and were kept, but nothing
   demonstrates they resolve a real failure. Do not treat them as proven.

---

## 3b. Found and NOT fixed

Short list, kept honest about how much I actually checked. The first is confirmed by
observation; the second I only read in the source and never saw happen.

**1. `/api/system/features` says a service is enabled when it cannot work.** CONFIRMED — I
watched it report `audiobookshelfEnabled: true` while `AudiobookshelfService.ensureInitialized`
threw "Audiobookshelf not configured" on every call. The flag reflects the settings boolean
only, not whether the credentials resolve, so the UI offers audiobooks while everything behind
them fails. `services/featureDetection.ts` and `services/audiobookshelf.ts`. Note the two
disagree by design right now: I set the enable flag directly in the database with a key the
instance could not decrypt, which is exactly the state a user reaches by pasting a bad key.

**2. The activity panel's z-index sits above the modal tier.** UNVERIFIED — `app/globals.css`
sets `--z-panel: 100` and `--z-modal: 80`, so a panel opened over a dialog should cover it.
I never opened one over the other to see. Check before believing it; the tokens may not be
the whole story.

Two things I looked at and concluded were NOT bugs, recorded so nobody re-investigates:

- **Unsubscribing leaves the `Podcast` row in the database.** It removes your subscription and
  keeps the feed metadata, so re-subscribing reuses the row. Sensible for a shared catalogue.
- **The podcast page shows episodes you cannot play when unsubscribed.** It renders
  `PreviewEpisodes` with "Subscribe to Unlock All Episodes", which is correct. I briefly
  reported this as a bug and was wrong — I was looking at a still-subscribed session.

---

## 4. The dogfood walkthrough

`frontend/tests/e2e/dogfood/` — one continuous browser session, ten journeys, sign-in to
sign-out. `npm run test:dogfood`.

```
KIMA_UI_BASE_URL=http://127.0.0.1:3212 \
KIMA_TEST_USERNAME=kima_e2e KIMA_TEST_PASSWORD=dogfood-e2e-pw \
npx playwright test tests/e2e/dogfood --reporter=list
```

**Why it finds what the other 2,752 lines of E2E do not:** every other spec logs in, jumps to
one page, asserts, and throws the browser away. A full reload between actions wipes React
state, so nothing that needs state to accumulate can happen. This one navigates by clicking,
keeps one session, and holds the whole thing to "no 5xx, no uncaught exception, no sideways
scroll, anywhere". Roughly half the defects above were found by it or while verifying a fix it
prompted; the rest came from measuring the enrichment pipeline directly.

Things worth knowing before you change it:
- It **fails** rather than skips when data is missing. A gate that skips its way to green is
  worse than no gate.
- It writes `test-results/dogfood-report.md` — every step, what data it saw, what was NOT
  covered and why.
- Journey 5 **destroys and rebuilds all embeddings**, with a throughput floor of 4s/track
  (~10× the measured 0.42s) so a return to the starved scheduler fails the build.
- Journey 7 opens a **separate touch-emulated context** and asserts `(pointer: coarse)` matches
  before measuring. A resized desktop window is not a phone and would test rules a phone never
  applies.
- It needs `--use-gl=angle --use-angle=swiftshader`: headless Chromium has **no WebGL at all**,
  measured, and deck.gl dies without it.
- Every entry in `IGNORED_CONSOLE` is coverage handed back. Each one is matched to a specific
  message with its reason written next to it. **Do not broaden them into general patterns.**

### Running against a dev instance from another machine

Next.js dev blocks cross-origin access to its dev resources, so driving `next dev` from another
host renders a blank page with **no error**. Use an SSH tunnel so it is same-origin:
`ssh -f -N -L 3212:127.0.0.1:3212 media-server`.

---

## 5. Environment

- **Test stack** on `media-server`: `/home/server/kima-test`, frontend `next dev` on **3212**,
  backend `tsx watch` on **3211**, Postgres `kima_test_pg` (5456), Redis `kima_test_redis` (6391),
  analyzers `kima_test_audio` / `kima_test_clap`. Backend log `/tmp/kima-test-be.log`, frontend
  `/tmp/kima-test-fe.log`. 59 tracks.
- **Production** on the same box: `kima-hub` container, port **3030**, image
  `chevron7locked/kima:nightly`. 9,088 tracks. **This test creates playlists, subscribes to
  podcasts and wipes embeddings — never point it here.**
- **E2E user**: `kima_e2e` / `dogfood-e2e-pw` on the test stack only. Created for this; the
  existing `admin` account was left alone.
- Deploys to the test stack were `rsync` of individual files. `tsx watch` and `next dev` pick
  them up; give the frontend ~10s and a warm request before testing.

### Audiobooks — blocked, needs the operator

Production has Audiobookshelf enabled with a 449-char key. **Copying it does not work**: the
key is encrypted at rest per-instance (`utils/systemSettings.ts`), so ciphertext from
production cannot be decrypted by the test stack. It silently falls through to "not
configured". I reverted my attempt; the test stack is Audiobookshelf-disabled with the field
cleared, as found.

To run that journey you need **a fresh API token issued from Audiobookshelf for the test
instance**. Do not decrypt the production secret.

Related, and a real bug someone should fix: `/api/system/features` reported
`audiobookshelfEnabled: true` while the service could not initialise at all. The flag reflects
the settings boolean, not whether the credentials work — so the UI offers audiobooks while
everything behind them fails.

---

## 6. Suggested order

1. **Build the image and deploy it to the test stack.** Everything so far ran in dev mode.
   Category L exists precisely because dev and prod differ, and the production path has never
   been run.
2. **Run the walkthrough against the built image**, six times.
3. **Get a scale answer.** Restore a copy of the 9,088-track production database onto the test
   stack and watch enrichment for an hour: memory, cycle cadence, and query time on the pool
   that also serves streaming. Item 3 in section 3 is the biggest risk in this branch and it is
   under a change I made.
4. **Work the taxonomy.** Five read-only audit agents were dispatched against categories A/B,
   C–H, I/J, L and K. If their findings are appended to this file as section 8, start there;
   if section 8 is absent, the run did not complete and the categories are unswept — do them
   yourself. Treat every report as a LEAD, not a fact. Each was asked to label findings
   REACHABLE / UNCERTAIN / THEORETICAL, and to trace to specific lines, precisely because I was
   wrong twice diagnosing this class from reading code. Reproduce before fixing.
5. **Get the audiobook key** and run that journey.
6. **Re-analyse the 12 false-positive production tracks** once the artwork fix is deployed.
7. **Push.**

## 7. Commits from this session

```
4b3c6b5c fix(queue): adding a track to the queue sometimes destroyed the queue
862aa6c0 fix(player): a removed podcast broke sign-in, and the cleanup broke too
586b9484 fix(podcasts): double-clicking the episode you are on did nothing
f9ed99d2 fix(player): unsubscribing while listening left the app retrying forever
ea87d619 fix(podcasts): subscribing to a podcast found through discovery returned 500
73fdc732 fix(enrichment): my own scheduler fix was spawning parallel timer chains
c7cfae41 test(e2e): make data collection a journey, not an assumption
1854bda8 fix(vibe): the map was dead on every unbuilt checkout
41f781ee perf(enrichment): stop starving the embedder between cycles
886b30b8 test(e2e): a dogfood walkthrough to gate deployments
8e274689 fix(artists): a bad album id reported itself as a server fault
1c410ac1 fix(analyzer): stop condemning a track because its cover art is broken
6b00c81a fix(enrichment): make the corrupt-file check actually gate analysis
```
