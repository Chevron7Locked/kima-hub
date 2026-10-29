/**
 * getNextWork reads `TrackStage` only: a question is due when it has no answer,
 * or failed, is retryable and its retry time has passed. Track status columns
 * play no part. Runs against the migrated test database.
 */

import { putStage } from "../../__tests__/helpers/trackStage";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import {
  getNextWork,
  STAGE_QUEUES,
  STAGE_ORDER,
  PREREQUISITE_STAGE,
  type StageName,
} from "../unifiedEnrichment";

jest.mock("../../utils/logger", () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const PREFIX = "gnw";
const id = (n: string) => `${PREFIX}_${n}`;
const ALL_TRACKS = [
  id("bad"), id("notdue"), id("blocked"), id("stuck"), id("inflight"),
  ...Array.from({ length: 20 }, (_, i) => id(`ok${i}`)),
];

/** Seed the FK chain TrackStage.trackId points at, plus the given tracks. */
async function seedLibrary(trackIds: string[]): Promise<void> {
  await prisma.artist.create({
    data: { id: id("art"), name: "Gnw Artist", identityKey: id("a") },
  });
  await prisma.album.create({
    data: {
      id: id("alb"), rgMbid: id("rg"), artistId: id("art"),
      title: "Gnw Album", primaryType: "Album",
    },
  });
  for (const trackId of trackIds) {
    await prisma.track.create({
      data: {
        id: trackId, albumId: id("alb"), title: `Track ${trackId}`, trackNo: 1,
        duration: 180, filePath: `/tmp/${trackId}.flac`,
        fileModified: new Date(), fileSize: 1000,
      },
    });
  }
}

async function wipe(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
  await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

describe("getNextWork", () => {
  beforeEach(async () => {
    await wipe();
    await seedLibrary(ALL_TRACKS);
    // Steady state: every track answered for every stage, so the ONLY work
    // in the library is the record each test overwrites below.
    for (const trackId of ALL_TRACKS) {
      for (const stage of STAGE_ORDER) {
        await putStage(trackId, stage, "done", { attempt: 1 });
      }
    }
  });

  afterAll(async () => {
    await wipe();
    // Importing the real modules opens connections the unit under test never
    // uses: the enrichment queues, the state singleton's clients, and the
    // shared Redis client. Left open, Jest outlives the suite on them.
    await closeEngineConnections();
  });

  it("returns the 20 due records and skips terminal, not-yet-due and blocked ones", async () => {
    // Terminal: failed and NOT retryable — must never be offered again.
    await putStage(id("bad"), "analysis", "failed", { retryable: false, attempt: 3 });
    // Temporary: failed, retryable, but its backoff has not elapsed yet.
    await putStage(id("notdue"), "analysis", "failed", {
      retryable: true, attempt: 1, nextRetryAt: new Date(Date.now() + 10 * 60_000),
    });
    // Parked for a human — not due until re-decided.
    await putStage(id("blocked"), "analysis", "blocked", { attempt: 2 });
    // 20 tracks whose analysis answer is missing (never asked).
    for (let i = 0; i < 20; i++) await putStage(id(`ok${i}`), "analysis", "pending");

    const work = await getNextWork(20);

    expect(work).toHaveLength(20);
    const offered = new Set(work.map((w) => w.trackId));
    expect(offered.has(id("bad"))).toBe(false);
    expect(offered.has(id("notdue"))).toBe(false);
    expect(offered.has(id("blocked"))).toBe(false);
    expect(offered.has(id("ok0"))).toBe(true);
  });

  it("offers a retry once the record's nextRetryAt is due", async () => {
    await putStage(id("ok0"), "analysis", "failed", {
      retryable: true, attempt: 1, nextRetryAt: new Date(Date.now() - 60_000),
    });

    const work = await getNextWork(5);

    expect(work.map((w) => w.trackId)).toEqual([id("ok0")]);
    expect(work[0]?.stage).toBe("analysis");
  });

  it("keys work by track+stage with a fresh jobId per attempt", async () => {
    await putStage(id("ok0"), "analysis", "failed", { attempt: 2, retryable: true });
    await putStage(id("ok1"), "recording", "pending");

    const work = await getNextWork(10);
    const analysis = work.find((w) => w.trackId === id("ok0") && w.stage === "analysis");
    const recording = work.find((w) => w.trackId === id("ok1") && w.stage === "recording");

    // jobKey identifies the question; jobId identifies THIS attempt, so a
    // retry never reuses the key a failed job still holds.
    expect(analysis?.jobKey).toBe(`track-${id("ok0")}-analysis`);
    expect(analysis?.jobId).toBe(`track-${id("ok0")}-analysis-3`);
    expect(recording?.jobKey).toBe(`track-${id("ok1")}-recording`);
    expect(recording?.jobId).toBe(`track-${id("ok1")}-recording-1`);
  });

  it("never embeds a track whose analysis stage is not done", async () => {
    // Analysis failed terminally; embedding still says 'pending'. Gating must
    // read the analysis RECORD, not offer embedding anyway.
    await putStage(id("bad"), "analysis", "failed", { retryable: false, attempt: 3 });
    await putStage(id("bad"), "embedding", "pending");

    const work = await getNextWork(20);

    expect(work.find((w) => w.trackId === id("bad") && w.stage === "embedding")).toBeUndefined();
    // And the chain really is what stopped it: with analysis answered, the
    // embedding becomes owed again.
    await putStage(id("bad"), "analysis", "done", { attempt: 4 });
    const after = await getNextWork(20);
    expect(after.find((w) => w.trackId === id("bad") && w.stage === "embedding")).toBeDefined();
  });

  it("does not gate a track's stage on another track's failure", async () => {
    // Track A's analysis is dead; track B's analysis is done and its embedding
    // is owed. Each track's stages gate independently, so B must still be
    // offered.
    await putStage(id("bad"), "analysis", "failed", { retryable: false, attempt: 3 });
    await putStage(id("ok0"), "embedding", "pending");

    const work = await getNextWork(10);
    const embedding = work.filter((w) => w.stage === "embedding");

    expect(embedding.map((w) => w.trackId)).toContain(id("ok0"));
    expect(embedding.map((w) => w.trackId)).not.toContain(id("bad"));
  });

  it("counts a finished record neither as outstanding nor as finished work", async () => {
    // Everything is already answered: the sweep must find nothing rather than
    // re-offering a done record.
    const work = await getNextWork(20);
    expect(work).toHaveLength(0);
  });

  it("re-offers a stale working record once its claim lease elapses", async () => {
    // A job claimed before an analyzer crash is a 'working' record whose
    // lease (nextRetryAt, set at claim) has come round. It must be offered
    // again -- with the attempt advanced in the jobId -- or the track would
    // sit in 'working' forever, since nothing else ever moves it.
    await putStage(id("stuck"), "analysis", "working", {
      attempt: 1, retryable: true, nextRetryAt: new Date(Date.now() - 60_000),
    });
    // A freshly claimed record (lease still in the future) is NOT offered.
    await putStage(id("inflight"), "analysis", "working", {
      attempt: 0, retryable: true, nextRetryAt: new Date(Date.now() + 10 * 60_000),
    });

    const work = await getNextWork(10);

    expect(work.map((w) => w.trackId)).toEqual([id("stuck")]);
    expect(work[0]?.status).toBe("working");
    // The re-offer must carry a fresh attempt so it never reuses the key
    // the dead attempt's job still holds.
    expect(work[0]?.jobId).toBe(`track-${id("stuck")}-analysis-2`);
  });

  it("gates each stage only on its own declared prerequisite, not the linear chain", async () => {
    // MusicBrainz never answered this track's recording question, but the
    // file is fine: analysis reads only the audio, so a failed recording
    // stage does not gate it.
    await putStage(id("ok0"), "recording", "failed", { attempt: 1, retryable: true });
    await putStage(id("ok0"), "analysis", "pending");

    const work = await getNextWork(20);

    expect(work.find((w) => w.trackId === id("ok0") && w.stage === "analysis")).toBeDefined();
  });

  it("never gates fingerprint on any other stage, and recording only on the settled fingerprint", async () => {
    // A terminally failed analysis does not hold back fingerprint or recording.
    // Recording waits until the fingerprint question is settled: done, or
    // closed as a permanent failure.
    await putStage(id("ok0"), "analysis", "failed", { retryable: false, attempt: 3 });
    await putStage(id("ok0"), "recording", "pending");
    await putStage(id("ok0"), "fingerprint", "pending");

    let work = await getNextWork(20);

    expect(
      work
        .filter((w) => w.trackId === id("ok0"))
        .map((w) => w.stage)
        .sort(),
    ).toEqual(["fingerprint"]);

    // The fingerprint answers (either way) — the recording question is due.
    await putStage(id("ok0"), "fingerprint", "failed", {
      retryable: false,
      nextRetryAt: null,
    });
    work = await getNextWork(20);
    expect(
      work
        .filter((w) => w.trackId === id("ok0"))
        .map((w) => w.stage)
        .sort(),
    ).toEqual(["recording"]);
  });

  it("maps each stage to exactly one queue", () => {
    const queues = new Set<string>();
    for (const stage of STAGE_ORDER) {
      const queue = STAGE_QUEUES[stage as StageName];
      expect(queue).toBeTruthy();
      // One producer per queue: no two stages may share a queue, or the same
      // work gets created in two places.
      expect(queues.has(queue)).toBe(false);
      queues.add(queue);
    }
    expect(queues.size).toBe(STAGE_ORDER.length);

    // And the graph is declared, so gating reads the record, not a column:
    // recording waits for the fingerprint question to be SETTLED (an answer
    // either way), embedding for analysis's OUTPUT (a done answer).
    expect(PREREQUISITE_STAGE.recording).toEqual({
        stage: "fingerprint", wait: "settled",
    });
    expect(PREREQUISITE_STAGE.analysis).toBeNull();
    expect(PREREQUISITE_STAGE.embedding).toEqual({
        stage: "analysis", wait: "output",
    });
    expect(PREREQUISITE_STAGE.fingerprint).toBeNull();
  });
});