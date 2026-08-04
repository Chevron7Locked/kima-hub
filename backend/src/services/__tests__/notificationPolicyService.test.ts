/**
 * R27 — `hasAlreadyNotified`'s unbounded per-user history scan.
 *
 * The duplicate-notification check loaded every column of every terminal
 * DownloadJob the user has ever had, with no `select` and no `take` -- cost
 * grew with lifetime history on a query that runs once per job. Fixed to
 * select only the column the comparison reads (plus `id`, which the debug
 * log on a match uses) and bound the scan to the user's most recent
 * DUPLICATE_CHECK_WINDOW terminal jobs, ordered by `completedAt`.
 *
 * `completedAt` is nullable -- not every terminal row is guaranteed to have
 * it (rows written before `endJob()` existed, or by a terminal write that
 * bypasses it, can be null) -- and Postgres sorts NULLS FIRST on a bare
 * `DESC`, which would let null rows crowd out real dated ones inside the
 * bounded window. The `nulls: "last"` below is what prevents that; the test
 * pins the exact call contract sent to Prisma. Prisma's `SortOrderInput`
 * (`{ sort, nulls }`) is confirmed present on the installed 5.22.0 generated
 * client's `DownloadJobOrderByWithRelationInput.completedAt` type, no
 * preview flag required. The DB-side NULLS LAST sort itself isn't
 * observable through a mocked Prisma client -- verified empirically instead
 * against a real Postgres instance with a legacy null-`completedAt` slice
 * seeded in, confirming the null rows sort after dated ones and are no
 * longer returned ahead of them.
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

    it("still finds a matching duplicate ahead of an unrelated legacy row with no completedAt-derived ordering info in the returned set", async () => {
        // The window is bounded and ordered in SQL, not in JS -- once rows
        // come back, hasAlreadyNotified just walks them in whatever order
        // Prisma returned. This pins that the walk itself doesn't depend on
        // completedAt (it isn't even selected), so a legacy null-completedAt
        // row sitting anywhere in the window can't hide a real match.
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
