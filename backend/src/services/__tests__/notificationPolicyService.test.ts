/**
 * A download notifies once per album: a job is silent when another job for the
 * same artist and album already notified, checked over the user's recent jobs.
 * A failed job notifies whatever its error says. Jobs are real rows.
 */

import { prisma } from "../../utils/db";
import { notificationPolicyService } from "../notificationPolicyService";

const P = "zz-notifPolicy-";
const USER = `${P}u1`;
const OTHER_USER = `${P}u2`;
const JOB = `${P}job`;

const BOC = { artistName: "Boards of Canada", albumTitle: "Geogaddi" };

async function wipe() {
    await prisma.downloadJob.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
}

/** A download job of USER, the one being judged unless another id is given. */
function seedJob(overrides: Record<string, unknown> = {}) {
    return prisma.downloadJob.create({
        data: {
            id: JOB,
            userId: USER,
            subject: "Geogaddi",
            type: "album",
            status: "completed",
            error: null,
            metadata: BOC,
            ...overrides,
        } as never,
    });
}
const evaluate = (eventType: "complete" | "failed" | "cancel" = "complete") =>
    notificationPolicyService.evaluateNotification(JOB, eventType);

beforeAll(wipe);
afterAll(wipe);
beforeEach(async () => {
    await wipe();
    await prisma.user.createMany({
        data: [
            { id: USER, username: USER, passwordHash: "x" },
            { id: OTHER_USER, username: OTHER_USER, passwordHash: "x" },
        ],
    });
});

describe("notificationPolicyService.hasAlreadyNotified (via evaluateNotification)", () => {
    it("suppresses the notification when a recent terminal job for the same artist+album already notified", async () => {
        await seedJob();
        await seedJob({ id: `${P}job-0`, metadata: { ...BOC, notificationSent: true }, completedAt: new Date() });

        expect(await evaluate()).toEqual({
            shouldNotify: false,
            reason: "Another job for same album already sent notification",
        });
    });

    it("takes one album spelled with another apostrophe or accent for the same album", async () => {
        await seedJob({ metadata: { artistName: "Sigur Rós", albumTitle: "Ágætis byrjun" } });
        await seedJob({
            id: `${P}job-0`,
            metadata: { artistName: "Sigur Ros", albumTitle: "Agaetis Byrjun", notificationSent: true },
            completedAt: new Date(),
        });

        expect((await evaluate()).shouldNotify).toBe(false);
    });

    it("finds a matching job anywhere in the window", async () => {
        await seedJob();
        await seedJob({
            id: `${P}job-legacy`,
            metadata: { artistName: "Unrelated Artist", albumTitle: "Unrelated Album" },
            completedAt: new Date(Date.now() - 1000),
        });
        await seedJob({
            id: `${P}job-recent`,
            metadata: { ...BOC, notificationSent: true },
            completedAt: new Date(Date.now() - 60_000),
        });

        expect((await evaluate()).shouldNotify).toBe(false);
    });

    it("notifies when no other terminal job for the same artist+album sent a notification", async () => {
        await seedJob();
        await seedJob({ id: `${P}job-0`, metadata: BOC, completedAt: new Date() }); // same album, never notified

        expect((await evaluate()).shouldNotify).toBe(true);
    });

    it("is not silenced by another person's notification, or by a job still running", async () => {
        await seedJob();
        await seedJob({ id: `${P}job-theirs`, userId: OTHER_USER, metadata: { ...BOC, notificationSent: true }, completedAt: new Date() });
        await seedJob({ id: `${P}job-busy`, status: "processing", metadata: { ...BOC, notificationSent: true } });

        expect((await evaluate()).shouldNotify).toBe(true);
    });

    it("looks at the 100 most recent jobs, so an older match is out of reach", async () => {
        await seedJob();
        const now = Date.now();
        await seedJob({ id: `${P}job-old`, metadata: { ...BOC, notificationSent: true }, completedAt: new Date(now - 10_000_000) });
        await prisma.downloadJob.createMany({
            data: Array.from({ length: 100 }, (_, i) => ({
                id: `${P}fill-${i}`, userId: USER, subject: "x", type: "album", status: "completed",
                metadata: { artistName: `Other ${i}`, albumTitle: `Album ${i}` }, completedAt: new Date(now - i * 1000),
            })),
        });

        expect((await evaluate()).shouldNotify).toBe(true);
    });

    it("lets jobs with no completion time fall behind dated ones, so they cannot crowd a real match out of the window", async () => {
        // A bare "desc" sorts NULLS FIRST in Postgres, which would let legacy null-completedAt rows
        // fill the window and hide the dated match.
        await seedJob();
        await seedJob({ id: `${P}job-dated`, metadata: { ...BOC, notificationSent: true }, completedAt: new Date() });
        await prisma.downloadJob.createMany({
            data: Array.from({ length: 100 }, (_, i) => ({
                id: `${P}legacy-${i}`, userId: USER, subject: "x", type: "album", status: "completed",
                metadata: { artistName: `Other ${i}`, albumTitle: `Album ${i}` }, completedAt: null,
            })),
        });

        expect((await evaluate()).shouldNotify).toBe(false);
    });
});

describe("failed downloads", () => {
    it.each([
        "All releases and albums exhausted: Lidarr returned nothing",
        "Lidarr's music folder /music has no default profiles. Set them in Lidarr, or choose them in Kima's Lidarr settings",
        "something nobody listed",
    ])("notifies for %p", async (error) => {
        await seedJob({ status: "failed", error });

        expect(await evaluate("failed")).toMatchObject({ shouldNotify: true, notificationType: "download_failed" });
    });

    it("stays silent for a Discover job", async () => {
        await seedJob({ status: "failed", error: "x", metadata: { downloadType: "discovery" } });

        expect((await evaluate("failed")).shouldNotify).toBe(false);
    });

    it.each(["complete", "failed"] as const)("stays silent for a pending song's retry, which the user asked for (%s)", async (event) => {
        await seedJob({
            status: event === "complete" ? "completed" : "failed",
            error: event === "complete" ? null : "x",
            metadata: { downloadType: "pending-track-retry" },
        });

        expect((await evaluate(event)).shouldNotify).toBe(false);
    });

    it("stays silent for a cancel, the user having asked for it", async () => {
        await seedJob({ status: "failed", error: "Cancelled by user" });

        expect((await evaluate("cancel")).shouldNotify).toBe(false);
    });

    it("says nothing for a job that is not there", async () => {
        expect(await evaluate("failed")).toEqual({ shouldNotify: false, reason: "Job not found" });
    });
});
