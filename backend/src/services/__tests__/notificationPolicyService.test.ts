/**
 * A download notifies once per album: a job is silent when another job for the
 * same artist and album already notified, checked over the user's recent jobs.
 * A failed job notifies whatever its error says.
 */

import { prisma } from "../../utils/db";
import { notificationPolicyService } from "../notificationPolicyService";

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

function makeJob(overrides: Record<string, any> = {}) {
    return {
        id: "job-1",
        userId: "user-1",
        status: "completed",
        error: null,
        metadata: { artistName: "Boards of Canada", albumTitle: "Geogaddi" },
        ...overrides,
    };
}

describe("notificationPolicyService.hasAlreadyNotified (via evaluateNotification)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("scans only id+metadata, bounded and ordered by completedAt desc with nulls last", async () => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(makeJob());
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);

        await notificationPolicyService.evaluateNotification("job-1", "complete");

        expect(prisma.downloadJob.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: { not: "job-1" },
                    userId: "user-1",
                    status: { in: ["completed", "failed", "exhausted"] },
                },
                select: { id: true, metadata: true },
                // Regression pin: a bare "desc" sorts NULLS FIRST in Postgres,
                // which would let legacy null-completedAt rows crowd out real
                // dated ones inside the bounded window.
                orderBy: { completedAt: { sort: "desc", nulls: "last" } },
                take: 100,
            })
        );
    });

    it("suppresses the notification when a recent terminal job for the same artist+album already notified", async () => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(makeJob());
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-0",
                metadata: {
                    artistName: "Boards of Canada",
                    albumTitle: "Geogaddi",
                    notificationSent: true,
                },
            },
        ]);

        const decision = await notificationPolicyService.evaluateNotification(
            "job-1",
            "complete"
        );

        expect(decision).toEqual({
            shouldNotify: false,
            reason: "Another job for same album already sent notification",
        });
    });

    it("takes one album spelled with another apostrophe or accent for the same album", async () => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            makeJob({ metadata: { artistName: "Sigur Rós", albumTitle: "Ágætis byrjun" } }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            { id: "job-0", metadata: { artistName: "Sigur Ros", albumTitle: "Agaetis Byrjun", notificationSent: true } },
        ]);
        expect((await notificationPolicyService.evaluateNotification("job-1", "complete")).shouldNotify).toBe(false);
    });

    it("finds a matching job anywhere in the returned window", async () => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(makeJob());
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-legacy",
                metadata: { artistName: "Unrelated Artist", albumTitle: "Unrelated Album" },
            },
            {
                id: "job-recent",
                metadata: {
                    artistName: "Boards of Canada",
                    albumTitle: "Geogaddi",
                    notificationSent: true,
                },
            },
        ]);

        const decision = await notificationPolicyService.evaluateNotification(
            "job-1",
            "complete"
        );

        expect(decision.shouldNotify).toBe(false);
    });

    it("notifies when no other terminal job for the same artist+album sent a notification", async () => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(makeJob());
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);

        const decision = await notificationPolicyService.evaluateNotification(
            "job-1",
            "complete"
        );

        expect(decision.shouldNotify).toBe(true);
    });
});

describe("failed downloads", () => {
    it.each([
        "All releases and albums exhausted: Lidarr returned nothing",
        "Lidarr's music folder /music has no default profiles. Set them in Lidarr, or choose them in Kima's Lidarr settings",
        "something nobody listed",
    ])("notifies for %p", async (error) => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(makeJob({ status: "failed", error }));
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);

        const decision = await notificationPolicyService.evaluateNotification("job-1", "failed");

        expect(decision).toMatchObject({ shouldNotify: true, notificationType: "download_failed" });
    });

    it("stays silent for a Discover job", async () => {
        (prisma.downloadJob.findUnique as jest.Mock).mockResolvedValue(
            makeJob({ status: "failed", error: "x", metadata: { downloadType: "discovery" } })
        );

        expect((await notificationPolicyService.evaluateNotification("job-1", "failed")).shouldNotify).toBe(false);
    });
});
