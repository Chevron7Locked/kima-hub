/**
 * A download event that meets another transaction's write on the same job is run again, and a conflict on every
 * run reaches the caller as the conflict itself. The conflicts are real: another transaction holds the job's row,
 * the event's transaction waits for it, and the holder's commit makes Postgres refuse the waiter.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { untilWaiting } from "./helpers/moodRows";

useLidarrCancelScenario();
jest.setTimeout(60_000);

const USER = "sdm_conflict_user";
const JOB = "sdm_conflict_job";
const TX = { timeout: 30_000, maxWait: 30_000 };
/** Prisma writes a model update as `UPDATE "public"."DownloadJob" SET ...`; the holders' own statements never match. */
const EVENT_WRITE = `."DownloadJob" SET`;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() =>
    prisma.downloadJob.create({
        data: { id: JOB, userId: USER, subject: JOB, type: "album", status: "processing", attempts: 1, lidarrRef: "dl-c" },
    }),
);

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

interface Holder {
    /** Resolves once this transaction has the job's row. */
    held: Promise<void>;
    /** Changes the row and commits, which makes Postgres refuse a transaction that was waiting for it. */
    release: () => Promise<void>;
}

function holdJob(): Holder {
    let letGo!: () => void;
    const letGoPromise = new Promise<void>((resolve) => (letGo = resolve));
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const done = prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM "DownloadJob" WHERE id = $1 FOR UPDATE`, JOB);
        locked();
        await letGoPromise;
        await tx.$executeRawUnsafe(`UPDATE "DownloadJob" SET "updatedAt" = now() WHERE id = $1`, JOB);
    }, TX);
    return {
        held,
        release: async () => {
            letGo();
            await done;
        },
    };
}

/** Counts the event's own transactions: the ones the download manager runs Serializable. */
function serializableRuns(): () => number {
    const spy = jest.spyOn(prisma, "$transaction");
    return () =>
        spy.mock.calls.filter(([, options]) => (options as { isolationLevel?: string } | undefined)?.isolationLevel === "Serializable")
            .length;
}

async function until(done: () => boolean): Promise<void> {
    const giveUp = Date.now() + 20_000;
    while (!done()) {
        if (Date.now() > giveUp) throw new Error("the event's transaction never ran again");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/**
 * Starts `event` while a holder has the job, then makes each of its first `times` runs lose to a holder that
 * already has the row when the run starts and commits once the run is waiting for it.
 */
async function loseRuns<T>(start: () => Promise<T>, times: number): Promise<{ outcome: Promise<unknown>; runs: () => number }> {
    const runs = serializableRuns();
    let holder = holdJob();
    await holder.held;
    const outcome = start().then(
        (value) => value,
        (error: unknown) => error,
    );
    for (let n = 1; n <= times; n++) {
        await until(() => runs() >= n);
        await untilWaiting(EVENT_WRITE);
        const next = n < times ? holdJob() : null;
        await holder.release();
        if (next) {
            await next.held;
            holder = next;
        }
    }
    return { outcome, runs };
}

describe("onImportFailed meeting another transaction's write", () => {
    it("runs again after a real conflict and counts the failed download once", async () => {
        const { outcome, runs } = await loseRuns(() => simpleDownloadManager.onImportFailed("dl-c", "Import failed"), 1);

        const result = await outcome;

        expect(runs()).toBe(2);
        expect(result).toEqual({ searchAgain: true, jobId: JOB, retryingAlbumIds: [] });
        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: JOB } });
        expect(row.attempts).toBe(2);
        expect((row.metadata as any).previousDownloadIds).toEqual(["dl-c"]);
    });

    it("throws the conflict itself, not nothing, when every run meets one", async () => {
        const { outcome, runs } = await loseRuns(() => simpleDownloadManager.onImportFailed("dl-c", "Import failed"), 3);

        const error = await outcome;

        expect(runs()).toBe(3);
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as { code?: string }).code).toBe("P2034");
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: JOB } })).attempts).toBe(1);
    });
});
