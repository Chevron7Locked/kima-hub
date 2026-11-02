/**
 * Closing the release window records silence as a decline, never as a missing
 * answer. Tested on a two-question release.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { UnknownChoiceError, changelogFor, dismissRelease, pendingReleases, setChoice } from "../releases";
import { GPU_CHOICE_KEY } from "../releases/catalog";
import * as catalog from "../releases/catalog";

jest.mock("../../utils/db", () => {
    const tx = {
        releaseChoice: { findUnique: jest.fn(), upsert: jest.fn() },
        releaseAcknowledgement: { upsert: jest.fn() },
    };
    return {
        prisma: {
            releaseAcknowledgement: { findMany: jest.fn(), findFirst: jest.fn(), upsert: tx.releaseAcknowledgement.upsert },
            releaseChoice: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
            // pendingReleases reads the role only for items that require an
            // admin; the shipped catalog has one, so these tests answer as one.
            user: { findUnique: jest.fn().mockResolvedValue({ role: "admin" }) },
            // When the user's saved mood mix was first saved: before 1.11, so 1.11's question is theirs.
            userMoodMix: { findUnique: jest.fn().mockResolvedValue({ createdAt: new Date("2026-09-01T00:00:00Z") }) },
            // When this server was set up: before every release, so it reads as an upgrade.
            systemSettings: { findUnique: jest.fn().mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z") }) },
            // Whether the library has enrichment from before a release's date.
            $queryRaw: jest.fn().mockResolvedValue([{ older: true }]),
            $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
            __tx: tx,
        },
    };
});

jest.mock("../releases/moodMixes", () => ({ MOOD_MIX_RELEASE: "1.11.0", moodMixState: jest.fn() }));
// The GPU choice is part of the tested catalog; pin the platform answer so the
// suite sees it on arm/macOS runners too, as on the linux/x86_64 target.
jest.mock("../gpuPlatform", () => ({ gpuSupported: () => true }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prisma } = require("../../utils/db");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { moodMixState } = require("../releases/moodMixes");
const tx = prisma.__tx;

/** A release that asks two things, so dismissal has something to settle. */
const ASKING = {
    version: "9.9.9",
    title: "Test release",
    summary: "",
    date: "2026-01-01",
    items: [
        { kind: "note" as const, key: "n", title: "", summary: "", body: "" },
        {
            kind: "choice" as const,
            key: "social.network",
            title: "",
            summary: "",
            body: "",
            defaultValue: false as const,
        },
        {
            kind: "choice" as const,
            key: "commons.contribute",
            title: "",
            summary: "",
            body: "",
            defaultValue: false as const,
        },
    ],
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(catalog, "findRelease").mockReturnValue(ASKING);
    tx.releaseChoice.findUnique.mockResolvedValue(null);
    prisma.releaseAcknowledgement.findMany.mockResolvedValue([]);
    prisma.releaseAcknowledgement.findFirst.mockResolvedValue(null);
    moodMixState.mockResolvedValue({ mix: null, decision: null, playlist: null });
});

/** One release's items as this user is shown them on the changelog page, where every release stays. */
const keysIn = async (version: string) =>
    (await changelogFor("u1")).releases.find((r) => r.version === version)!.items.map((i) => i.key);

describe("dismissRelease", () => {
    it("records a decision for every unanswered choice, not an absence", async () => {
        const out = await dismissRelease("u1", "9.9.9");
        expect(out.recordedDefaults).toEqual(["social.network", "commons.contribute"]);
        expect(tx.releaseChoice.upsert).toHaveBeenCalledTimes(2);
    });

    it("records those decisions as off, and as decided by dismissal", async () => {
        await dismissRelease("u1", "9.9.9");
        for (const call of tx.releaseChoice.upsert.mock.calls) {
            expect(call[0].create).toMatchObject({
                enabled: false,
                decidedBy: ChoiceDecidedBy.DISMISSED,
            });
        }
    });

    it("leaves an explicit yes alone -- closing the window is not a retraction", async () => {
        tx.releaseChoice.findUnique.mockImplementation(async ({ where }: never) => {
            const key = (where as { userId_key: { key: string } }).userId_key.key;
            return key === "social.network" ? { decidedBy: ChoiceDecidedBy.EXPLICIT } : null;
        });
        const out = await dismissRelease("u1", "9.9.9");
        expect(out.recordedDefaults).toEqual(["commons.contribute"]);
        expect(tx.releaseChoice.upsert).toHaveBeenCalledTimes(1);
    });

    it("marks the release acknowledged", async () => {
        await dismissRelease("u1", "9.9.9");
        expect(tx.releaseAcknowledgement.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: { userId: "u1", version: "9.9.9" } }),
        );
    });

    it("does nothing for a version it does not know", async () => {
        jest.spyOn(catalog, "findRelease").mockReturnValue(undefined);
        const out = await dismissRelease("u1", "0.0.0");
        expect(out.recordedDefaults).toEqual([]);
        expect(tx.releaseAcknowledgement.upsert).not.toHaveBeenCalled();
    });
});

describe("setChoice", () => {
    it("marks a deliberate answer as explicit, either way", async () => {
        await setChoice({ userId: "u1", version: "9.9.9", key: "social.network", enabled: true });
        expect(prisma.releaseChoice.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ enabled: true, decidedBy: ChoiceDecidedBy.EXPLICIT }),
            }),
        );
        await setChoice({ userId: "u1", version: "9.9.9", key: "social.network", enabled: false });
        expect(prisma.releaseChoice.upsert).toHaveBeenLastCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({ enabled: false, decidedBy: ChoiceDecidedBy.EXPLICIT }),
            }),
        );
    });

    it("refuses a key the release does not offer as a choice, and writes nothing", async () => {
        // `moods.mixes.rebuild` is a real catalog key, but an action, not a
        // choice — recording it here would settle the mood-mix question
        // without the checks `decideMoodMixes` makes ("keep" on a retired mix).
        await expect(
            setChoice({ userId: "u1", version: "9.9.9", key: "moods.mixes.rebuild", enabled: false }),
        ).rejects.toBeInstanceOf(UnknownChoiceError);
        await expect(
            setChoice({ userId: "u1", version: "9.9.9", key: "no.such.key", enabled: true }),
        ).rejects.toBeInstanceOf(UnknownChoiceError);
        expect(prisma.releaseChoice.upsert).not.toHaveBeenCalled();
    });

    it("refuses a version it does not know", async () => {
        jest.spyOn(catalog, "findRelease").mockReturnValue(undefined);
        await expect(
            setChoice({ userId: "u1", version: "0.0.0", key: "social.network", enabled: true }),
        ).rejects.toBeInstanceOf(UnknownChoiceError);
        expect(prisma.releaseChoice.upsert).not.toHaveBeenCalled();
    });

    it("accepts a choice the release actually asks", async () => {
        await setChoice({ userId: "u1", version: "9.9.9", key: "commons.contribute", enabled: true });
        expect(prisma.releaseChoice.upsert).toHaveBeenCalledTimes(1);
    });
});

describe("pendingReleases: only the newest release", () => {
    const newest = () => [...catalog.RELEASES].sort((x, y) => (x.date < y.date ? -1 : 1)).at(-1)!.version;

    beforeEach(() => jest.restoreAllMocks());

    it("shows a new user only the newest release, not every one before it", async () => {
        expect((await pendingReleases("u1")).map((r) => r.version)).toEqual([newest()]);
    });

    it("shows someone who skipped versions only the newest", async () => {
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([{ version: "1.10.1" }]);
        expect((await pendingReleases("u1")).map((r) => r.version)).toEqual([newest()]);
    });

    it("shows nothing once the newest is closed, even with older ones never closed", async () => {
        prisma.releaseAcknowledgement.findFirst.mockResolvedValue({ version: newest() });
        expect(await pendingReleases("u1")).toEqual([]);
    });

    it("never brings back 1.11's unanswered retired mix question in the window; the changelog keeps it", async () => {
        prisma.releaseAcknowledgement.findFirst.mockResolvedValue({ version: newest() });
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([]);
        moodMixState.mockResolvedValue({
            mix: { id: "m", name: "Your Focus Mode Mix", mood: "focus", trackCount: 3, retired: true },
            decision: null,
            playlist: null,
        });
        expect(await pendingReleases("u1")).toEqual([]);
        expect(await keysIn("1.11.0")).toContain("moods.mixes.retired");
    });
});

describe("an older release's unfinished work is open on the changelog, skipped or not", () => {
    const item = async (version: string, key: string) =>
        (await changelogFor("u1")).releases.find((r) => r.version === version)!.items.find((i) => i.key === key)!;

    beforeEach(() => {
        jest.restoreAllMocks();
        prisma.user.findUnique.mockResolvedValue({ role: "admin" });
        prisma.$queryRaw.mockResolvedValue([{ older: true }]);
    });

    it("counts a skipped 1.11's wipe as open for an admin upgrading from 1.10", async () => {
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([{ version: "1.10.1" }]);
        expect(await item("1.11.0", "engine.wipe")).toMatchObject({ open: true, done: false, requires: "admin" });
        expect((await changelogFor("u1")).openCount).toBeGreaterThan(0);
    });

    it("counts an unanswered mood-mix question as open and says who it is for", async () => {
        moodMixState.mockResolvedValue({
            mix: { id: "m", name: "Your Focus Mode Mix", mood: "focus", trackCount: 3, retired: true },
            decision: null,
            playlist: null,
        });
        expect(await item("1.11.0", "moods.mixes.retired")).toMatchObject({ open: true, requires: "retiredMoodMix" });
    });

    it("leaves the newest release's actions to its window until it is closed", async () => {
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z"), albumsRefiledAt: null });
        expect((await item("1.12.0", "albums.refile")).open).toBeUndefined();
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([{ version: "1.12.0" }]);
        expect((await item("1.12.0", "albums.refile")).open).toBe(true);
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z") });
    });
});

describe("the 1.11 mood-mix items, on the changelog", () => {
    const mixState = (mix: object | null, extra: object = {}) =>
        moodMixState.mockResolvedValue({ mix, decision: null, playlist: null, ...extra });
    const CURRENT = { id: "m", name: "Your Upbeat Mix", mood: "happy", trackCount: 3, retired: false };
    const RETIRED = { id: "m", name: "Your Focus Mode Mix", mood: "focus", trackCount: 3, retired: true };
    const keysOf111 = () => keysIn("1.11.0");

    beforeEach(() => {
        jest.restoreAllMocks();
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([{ version: "1.10.1" }]);
    });

    it("asks a user with a current mix to rebuild/keep, not the retired question", async () => {
        mixState(CURRENT);
        const keys = await keysOf111();
        expect(keys).toContain("moods.mixes");
        expect(keys).not.toContain("moods.mixes.retired");
    });

    it("asks a user with a retired mix to save/remove, not rebuild/keep", async () => {
        mixState(RETIRED);
        const keys = await keysOf111();
        expect(keys).toContain("moods.mixes.retired");
        expect(keys).not.toContain("moods.mixes");
    });

    it("drops both for a mix saved after 1.11 shipped", async () => {
        mixState(CURRENT);
        prisma.userMoodMix.findUnique.mockResolvedValueOnce({ createdAt: new Date("2026-10-20T00:00:00Z") });
        const keys = await keysOf111();
        expect(keys).not.toContain("moods.mixes");
        expect(keys).not.toContain("moods.mixes.retired");
    });

    it("drops both for a user without a mix, leaving the rest of the release", async () => {
        mixState(null);
        const keys = await keysOf111();
        expect(keys).not.toContain("moods.mixes");
        expect(keys).not.toContain("moods.mixes.retired");
        expect(keys).toContain("stats.page");
        // The shared catalog is not edited in place for the next user.
        expect(catalog.RELEASES.find((r) => r.version === "1.11.0")!.items.map((i) => i.key)).toEqual(
            expect.arrayContaining(["moods.mixes", "moods.mixes.retired"]),
        );
    });
});

describe("catalog", () => {
    it("asks about mood mixes in 1.11.0 only, and says what closing means", () => {
        const find = (key: string) =>
            catalog.RELEASES.find((r) => r.version === "1.11.0")!.items.find(
                (i): i is Extract<catalog.ReleaseItem, { kind: "action" }> => i.key === key,
            );
        expect(find("moods.mixes")).toMatchObject({ kind: "action", requires: "savedMoodMix" });
        expect(find("moods.mixes")?.ifClosed).toMatch(/stays as it is/);
        expect(find("moods.mixes.retired")).toMatchObject({ kind: "action", requires: "retiredMoodMix" });
        expect(find("moods.mixes.retired")?.ifClosed).toMatch(/nothing is deleted/);
        expect(find("moods.mixes.retired")?.body).toMatch(/can't show it/);
        expect(
            catalog.RELEASES.find((r) => r.version === "1.10.1")!.items.some((i) => i.key === "moods.mixes"),
        ).toBe(false);
    });

    it("opens 1.11.0 on Kevin's note and asks admins to wipe and re-run enrichment", () => {
        const release = catalog.RELEASES.find((r) => r.version === "1.11.0")!;
        expect(release.note?.from).toBe("Kevin");
        expect(release.note?.body).toMatch(/complete wipe and rerun/);
        const wipe = release.items.find((i) => i.key === "engine.wipe");
        expect(wipe).toMatchObject({ kind: "action", run: "wipeEnrichment", requires: "admin" });
        expect(catalog.RELEASES.find((r) => r.version === "1.10.1")!.items.some((i) => i.key === "engine.wipe")).toBe(false);
    });

    it("offers admins of an upgraded library to re-file their albums in 1.12.0, and no one else", async () => {
        const refile = catalog.RELEASES.find((r) => r.version === "1.12.0")!.items.find((i) => i.key === "albums.refile");
        expect(refile).toMatchObject({ kind: "action", run: "refileAlbums", requires: "admin", installedBeforeOnly: true });

        jest.restoreAllMocks();
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([]);
        moodMixState.mockResolvedValue({ mix: null, decision: null, playlist: null });
        const keys = async () => (await pendingReleases("u1")).find((r) => r.version === "1.12.0")!.items.map((i) => i.key);
        prisma.user.findUnique.mockResolvedValue({ role: "admin" });
        // Still offered once the upgrade's re-analysis leaves no song analysed before the release.
        prisma.$queryRaw.mockResolvedValue([{ older: false }]);
        expect(await keys()).toContain("albums.refile");
        // Not offered to a server set up after the release.
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-12-01T00:00:00Z") });
        expect(await keys()).not.toContain("albums.refile");
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z") });
        prisma.$queryRaw.mockResolvedValue([{ older: true }]);
        prisma.user.findUnique.mockResolvedValue({ role: "user" });
        expect(await keys()).not.toContain("albums.refile");
        prisma.user.findUnique.mockResolvedValue({ role: "admin" });
    });

    it("stops asking about the re-file once a clean run is recorded", async () => {
        jest.restoreAllMocks();
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([]);
        prisma.user.findUnique.mockResolvedValue({ role: "admin" });
        moodMixState.mockResolvedValue({ mix: null, decision: null, playlist: null });
        const keys = async () => (await pendingReleases("u1")).find((r) => r.version === "1.12.0")!.items.map((i) => i.key);
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z"), albumsRefiledAt: null });
        expect(await keys()).toContain("albums.refile");
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z"), albumsRefiledAt: new Date() });
        expect(await keys()).not.toContain("albums.refile");
        prisma.systemSettings.findUnique.mockResolvedValue({ createdAt: new Date("2026-01-01T00:00:00Z") });
    });

    it("offers the wipe to an upgraded library and not to a fresh install", async () => {
        jest.restoreAllMocks();
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([]);
        prisma.user.findUnique.mockResolvedValue({ role: "admin" });
        moodMixState.mockResolvedValue({ mix: null, decision: null, playlist: null });
        const keys = () => keysIn("1.11.0");
        prisma.$queryRaw.mockResolvedValue([{ older: true }]);
        expect(await keys()).toContain("engine.wipe");
        prisma.$queryRaw.mockResolvedValue([{ older: false }]);
        expect(await keys()).not.toContain("engine.wipe");
    });

    it("gives every item a one-line summary and links only to pages inside the app", () => {
        for (const item of catalog.RELEASES.flatMap((r) => r.items)) {
            expect(item.summary.length).toBeGreaterThan(0);
            expect(item.summary).not.toMatch(/\n/);
            for (const link of item.links ?? []) expect(link.href).toMatch(/^\/[a-z]/);
        }
    });

    it("asks about play repair in 1.10.1 only", () => {
        const keysOf = (v: string) =>
            catalog.RELEASES.find((r) => r.version === v)!.items.map((i) => i.key);
        expect(keysOf("1.10.1")).toContain("plays.repair");
        expect(keysOf("1.11.0")).not.toContain("plays.repair");
    });

    it("asks the GPU question in 1.11.0, off by default, admins only", () => {
        const gpu = catalog.RELEASES.find((r) => r.version === "1.11.0")!.items.find(
            (i) => i.key === GPU_CHOICE_KEY,
        );
        expect(gpu).toMatchObject({
            kind: "choice",
            defaultValue: false,
            requires: "admin",
        });
    });

    it("shows the GPU question to admins and hides it from everyone else", async () => {
        jest.restoreAllMocks();
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([{ version: "1.10.1" }]);
        prisma.user.findUnique.mockResolvedValue({ role: "admin" });
        moodMixState.mockResolvedValue({ mix: null, decision: null, playlist: null });
        const adminKeys = await keysIn("1.11.0");
        expect(adminKeys).toContain(GPU_CHOICE_KEY);

        prisma.user.findUnique.mockResolvedValue({ role: "user" });
        const userKeys = await keysIn("1.11.0");
        expect(userKeys).not.toContain(GPU_CHOICE_KEY);
    });
});
