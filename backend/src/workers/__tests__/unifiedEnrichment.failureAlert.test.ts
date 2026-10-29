/**
 * The enrichment failure alert is one row per admin. Repeating the same counts
 * adds nothing, new counts replace the row and mark it unread, and the row goes
 * away once nothing has failed. Drives the real function against the real table.
 */

import { prisma } from "../../utils/db";
import { syncEnrichmentFailureAlert } from "../../workers/unifiedEnrichment";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const PREFIX = "efa";
const id = (n: string) => `${PREFIX}_${n}`;

async function makeUsers(): Promise<void> {
    await prisma.user.create({
        data: { id: id("admin"), username: id("admin"), passwordHash: "x", role: "admin", tokenVersion: 0 },
    });
    await prisma.user.create({
        data: { id: id("plain"), username: id("plain"), passwordHash: "x", role: "user", tokenVersion: 0 },
    });
}

/** The counts are global, so the slate must be globally clean; this checkout's
 *  per-worker test DB is the slate. */
async function clearAllFailures(): Promise<void> {
    await prisma.enrichmentFailure.deleteMany({});
    await prisma.trackStage.deleteMany({ where: { status: "failed" } });
}

async function addFailure(n: string): Promise<void> {
    await prisma.enrichmentFailure.create({
        data: { entityType: "artist", entityId: id(n), entityName: n, errorMessage: "MusicBrainz 503" },
    });
}

const rows = (userId: string) =>
    prisma.notification.findMany({
        where: { userId },
        select: { id: true, type: true, title: true, message: true, read: true },
    });

async function wipe(): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.enrichmentFailure.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
}

beforeEach(async () => {
    await wipe();
    await clearAllFailures();
    await makeUsers();
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

describe("enrichment failure alert", () => {
    it("sends nothing when nothing has failed", async () => {
        await syncEnrichmentFailureAlert();
        expect(await rows(id("admin"))).toHaveLength(0);
        expect(await rows(id("plain"))).toHaveLength(0);
    });

    it("alerts admins only, once, however often it runs", async () => {
        await addFailure("a1");
        for (let i = 0; i < 5; i++) await syncEnrichmentFailureAlert();

        const admin = await rows(id("admin"));
        expect(admin).toHaveLength(1);
        expect(admin[0]).toMatchObject({ type: "error", title: "Enrichment failures" });
        expect(admin[0].message).toContain("1 item could not be enriched: 1 artist.");
        expect(await rows(id("plain"))).toHaveLength(0);
    });

    it("leaves a read alert read while the counts stay the same", async () => {
        await addFailure("a1");
        await syncEnrichmentFailureAlert();
        await prisma.notification.updateMany({ where: { userId: id("admin") }, data: { read: true } });

        await syncEnrichmentFailureAlert();
        expect((await rows(id("admin")))[0].read).toBe(true);
    });

    it("replaces the alert and marks it unread when the counts change", async () => {
        await addFailure("a1");
        await syncEnrichmentFailureAlert();
        const [first] = await rows(id("admin"));
        await prisma.notification.updateMany({ where: { userId: id("admin") }, data: { read: true } });

        await addFailure("a2");
        await syncEnrichmentFailureAlert();
        const after = await rows(id("admin"));
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe(first.id);
        expect(after[0].message).toContain("2 items");
        expect(after[0].read).toBe(false);
    });

    it("removes the alert once nothing has failed", async () => {
        await addFailure("a1");
        await syncEnrichmentFailureAlert();
        await clearAllFailures();

        await syncEnrichmentFailureAlert();
        expect(await rows(id("admin"))).toHaveLength(0);
    });
});
