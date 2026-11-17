/**
 * Closing the release window records silence as a decline, never as a missing
 * answer. Tested on a two-question release, against the real database.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { UnknownChoiceError, changelogFor, dismissRelease, pendingReleases, setChoice } from "../releases";
import { GPU_CHOICE_KEY } from "../releases/catalog";
import * as catalog from "../releases/catalog";
import { prisma } from "../../utils/db";

jest.mock("../releases/moodMixes", () => ({ MOOD_MIX_RELEASE: "1.11.0", moodMixState: jest.fn() }));
// The GPU choice is part of the tested catalog; pin the platform answer so the
// suite sees it on arm/macOS runners too, as on the linux/x86_64 target.
jest.mock("../gpuRuntime", () => ({ gpuSupported: () => true }));
// Settings are read through the settings module; one test replaces its answer to prove that is where they come from.
let mockSettingsAnswer: Record<string, unknown> | null = null;
jest.mock("../../utils/systemSettings", () => {
    const actual = jest.requireActual("../../utils/systemSettings");
    return {
        ...actual,
        readSystemSettingsFresh: (...fields: string[]) =>
            mockSettingsAnswer
                ? Promise.resolve(Object.fromEntries(fields.map((f) => [f, mockSettingsAnswer![f]])))
                : actual.readSystemSettingsFresh(...fields),
    };
});

const { moodMixState } = require("../releases/moodMixes");

const P = "zz-releases-";
const USER = `${P}admin`;
const MEMBER = `${P}member`;
const TRACK = `${P}t1`;

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

/** What this server's settings row said before the file ran, put back afterwards (the row is shared). */
let settingsBefore: { createdAt: Date; albumsRefiledAt: Date | null } | null = null;

async function wipe() {
    await prisma.user.deleteMany({ where: { id: { in: [USER, MEMBER] } } }); // acknowledgements, choices and the mix go too
    await prisma.track.deleteMany({ where: { id: TRACK } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** When this server was set up, and whether its album re-file has finished. */
const settingsRow = (createdAt: string, albumsRefiledAt: Date | null = null) =>
    prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", createdAt: new Date(createdAt), albumsRefiledAt },
        update: { createdAt: new Date(createdAt), albumsRefiledAt },
    });

/** Whether the library holds a song analysed before the releases (an upgraded install) or none (a fresh one). */
const libraryAnalysedBefore = (older: boolean) =>
    prisma.track.update({ where: { id: TRACK }, data: { analyzedAt: older ? new Date("2025-01-01T00:00:00Z") : null } });

/** When the user's saved mood mix was first saved. */
const mixSavedAt = (when: string) => prisma.userMoodMix.update({ where: { userId: USER }, data: { createdAt: new Date(when) } });

const acknowledge = (version: string) => prisma.releaseAcknowledgement.create({ data: { userId: USER, version } });
const choices = (userId = USER) => prisma.releaseChoice.findMany({ where: { userId }, orderBy: { key: "asc" } });
const noMix = () => moodMixState.mockResolvedValue({ mix: null, decision: null, playlist: null });

beforeAll(async () => {
    settingsBefore = await prisma.systemSettings.findUnique({
        where: { id: "default" },
        select: { createdAt: true, albumsRefiledAt: true },
    });
    await wipe();
});

afterAll(async () => {
    await wipe();
    if (settingsBefore) await prisma.systemSettings.update({ where: { id: "default" }, data: settingsBefore });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
});

beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(catalog, "findRelease").mockReturnValue(ASKING);
    await wipe();
    // The role is read only for items that require an admin; the shipped catalog has one.
    await prisma.user.createMany({
        data: [
            { id: USER, username: USER, passwordHash: "x", role: "admin" },
            { id: MEMBER, username: MEMBER, passwordHash: "x", role: "user" },
        ],
    });
    // Saved before 1.11, so 1.11's mood-mix question is theirs.
    await prisma.userMoodMix.create({
        data: {
            userId: USER, mood: "happy", trackIds: [], coverUrls: [],
            generatedAt: new Date("2026-09-01T00:00:00Z"), createdAt: new Date("2026-09-01T00:00:00Z"),
        },
    });
    // Set up before every release, so it reads as an upgrade, with the library enriched from before them.
    await settingsRow("2026-01-01T00:00:00Z");
    await prisma.artist.create({ data: { id: `${P}art`, name: "Releases Artist", identityKey: `${P}art` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art`, title: "Record", identityKey: `${P}alb`, rgMbid: `${P}alb`, primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: TRACK, albumId: `${P}alb`, title: "Song", trackNo: 1, duration: 200,
            filePath: `/tmp/${TRACK}.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
    await libraryAnalysedBefore(true);
    noMix();
});

/** One release's items as this user is shown them on the changelog page, where every release stays. */
const keysIn = async (version: string) =>
    (await changelogFor(USER)).releases.find((r) => r.version === version)!.items.map((i) => i.key);

/** 1.12.4's re-file as this user's changelog lists it, or undefined when it is not offered. */
const refileOnChangelog = async (userId = USER) =>
    (await changelogFor(userId)).releases.find((r) => r.version === "1.12.4")!.items.find((i) => i.key === "albums.refile");

/** Runs `fn` with a later release, holding a copy of 1.12.4's re-file as `later.refile`, as the newest. */
async function withLaterRefileRelease(fn: () => Promise<void>) {
    const refile = catalog.RELEASES.find((r) => r.version === "1.12.4")!.items.find((i) => i.key === "albums.refile")!;
    catalog.RELEASES.unshift({ version: "9.0.0", title: "Kima 9", summary: "Later.", date: "2099-01-01", items: [{ ...refile, key: "later.refile" }] });
    try {
        await fn();
    } finally {
        catalog.RELEASES.shift();
    }
}

describe("dismissRelease", () => {
    it("records a decision for every unanswered choice, not an absence", async () => {
        const out = await dismissRelease(USER, "9.9.9");
        expect(out.recordedDefaults).toEqual(["social.network", "commons.contribute"]);
        expect((await choices()).map((c) => c.key)).toEqual(["commons.contribute", "social.network"]);
    });

    it("records those decisions as off, and as decided by dismissal", async () => {
        await dismissRelease(USER, "9.9.9");
        const rows = await choices();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row).toMatchObject({ enabled: false, decidedBy: ChoiceDecidedBy.DISMISSED, version: "9.9.9" });
        }
    });

    it("leaves an explicit yes alone -- closing the window is not a retraction", async () => {
        await prisma.releaseChoice.create({
            data: { userId: USER, version: "9.9.9", key: "social.network", enabled: true, decidedBy: ChoiceDecidedBy.EXPLICIT },
        });
        const out = await dismissRelease(USER, "9.9.9");
        expect(out.recordedDefaults).toEqual(["commons.contribute"]);
        expect(await choices()).toMatchObject([
            { key: "commons.contribute", enabled: false, decidedBy: ChoiceDecidedBy.DISMISSED },
            { key: "social.network", enabled: true, decidedBy: ChoiceDecidedBy.EXPLICIT },
        ]);
    });

    it("settles an earlier dismissal again without making a second row", async () => {
        await dismissRelease(USER, "9.9.9");
        await dismissRelease(USER, "9.9.9");
        expect(await choices()).toHaveLength(2);
        expect(await prisma.releaseAcknowledgement.count({ where: { userId: USER } })).toBe(1);
    });

    it("marks the release acknowledged", async () => {
        await dismissRelease(USER, "9.9.9");
        expect(await prisma.releaseAcknowledgement.findUnique({ where: { userId_version: { userId: USER, version: "9.9.9" } } })).not.toBeNull();
    });

    it("does nothing for a version it does not know", async () => {
        jest.spyOn(catalog, "findRelease").mockReturnValue(undefined);
        const out = await dismissRelease(USER, "0.0.0");
        expect(out.recordedDefaults).toEqual([]);
        expect(await prisma.releaseAcknowledgement.count({ where: { userId: USER } })).toBe(0);
        expect(await choices()).toEqual([]);
    });

    it("records no decision for a question the person was never asked", async () => {
        // An admin-only choice, closed by a member: a decline there would be a decision that was never theirs.
        jest.spyOn(catalog, "findRelease").mockReturnValue({
            ...ASKING,
            items: ASKING.items.map((i) => (i.key === "commons.contribute" ? { ...i, requires: "admin" as const } : i)),
        });

        const out = await dismissRelease(MEMBER, "9.9.9");

        expect(out.recordedDefaults).toEqual(["social.network"]);
        expect((await choices(MEMBER)).map((c) => c.key)).toEqual(["social.network"]);
    });
});

describe("setChoice", () => {
    it("marks a deliberate answer as explicit, either way", async () => {
        await setChoice({ userId: USER, version: "9.9.9", key: "social.network", enabled: true });
        expect(await choices()).toMatchObject([{ key: "social.network", enabled: true, decidedBy: ChoiceDecidedBy.EXPLICIT }]);

        await setChoice({ userId: USER, version: "9.9.9", key: "social.network", enabled: false });
        expect(await choices()).toMatchObject([{ key: "social.network", enabled: false, decidedBy: ChoiceDecidedBy.EXPLICIT }]);
    });

    it("turns an earlier dismissal into an explicit answer", async () => {
        await dismissRelease(USER, "9.9.9");

        await setChoice({ userId: USER, version: "9.9.9", key: "commons.contribute", enabled: true });

        expect((await choices()).find((c) => c.key === "commons.contribute")).toMatchObject({
            enabled: true,
            decidedBy: ChoiceDecidedBy.EXPLICIT,
        });
    });

    it("refuses a key the release does not offer as a choice, and writes nothing", async () => {
        // `moods.mixes.rebuild` is a real catalog key, but an action, not a
        // choice — recording it here would settle the mood-mix question
        // without the checks `decideMoodMixes` makes ("keep" on a retired mix).
        await expect(
            setChoice({ userId: USER, version: "9.9.9", key: "moods.mixes.rebuild", enabled: false }),
        ).rejects.toBeInstanceOf(UnknownChoiceError);
        await expect(
            setChoice({ userId: USER, version: "9.9.9", key: "no.such.key", enabled: true }),
        ).rejects.toBeInstanceOf(UnknownChoiceError);
        expect(await choices()).toEqual([]);
    });

    it("refuses a version it does not know", async () => {
        jest.spyOn(catalog, "findRelease").mockReturnValue(undefined);
        await expect(
            setChoice({ userId: USER, version: "0.0.0", key: "social.network", enabled: true }),
        ).rejects.toBeInstanceOf(UnknownChoiceError);
        expect(await choices()).toEqual([]);
    });

    it("accepts a choice the release actually asks", async () => {
        await setChoice({ userId: USER, version: "9.9.9", key: "commons.contribute", enabled: true });
        expect(await choices()).toHaveLength(1);
    });
});

describe("pendingReleases: only the newest release", () => {
    const newest = () => [...catalog.RELEASES].sort((x, y) => (x.date < y.date ? -1 : 1)).at(-1)!.version;

    beforeEach(() => {
        jest.restoreAllMocks();
        noMix();
    });

    it("shows a new user only the newest release, not every one before it", async () => {
        expect((await pendingReleases(USER)).map((r) => r.version)).toEqual([newest()]);
    });

    it("shows someone who skipped versions only the newest", async () => {
        await acknowledge("1.10.1");
        expect((await pendingReleases(USER)).map((r) => r.version)).toEqual([newest()]);
    });

    it("shows nothing once the newest is closed, even with older ones never closed", async () => {
        await acknowledge(newest());
        expect(await pendingReleases(USER)).toEqual([]);
    });

    it("shows another person the newest release even when this one has closed it", async () => {
        await acknowledge(newest());
        expect((await pendingReleases(MEMBER)).map((r) => r.version)).toEqual([newest()]);
    });

    it("never brings back 1.11's unanswered retired mix question in the window; the changelog keeps it", async () => {
        await acknowledge(newest());
        moodMixState.mockResolvedValue({
            mix: { id: "m", name: "Your Focus Mode Mix", mood: "focus", trackCount: 3, retired: true },
            decision: null,
            playlist: null,
        });
        expect(await pendingReleases(USER)).toEqual([]);
        expect(await keysIn("1.11.0")).toContain("moods.mixes.retired");
    });
});

describe("an older release's unfinished work is open on the changelog, skipped or not", () => {
    const item = async (version: string, key: string) =>
        (await changelogFor(USER)).releases.find((r) => r.version === version)!.items.find((i) => i.key === key)!;

    beforeEach(() => {
        jest.restoreAllMocks();
        noMix();
    });

    it("counts a skipped 1.11's wipe as open for an admin upgrading from 1.10", async () => {
        await acknowledge("1.10.1");
        expect(await item("1.11.0", "engine.wipe")).toMatchObject({ open: true, done: false, requires: "admin" });
        expect((await changelogFor(USER)).openCount).toBeGreaterThan(0);
    });

    it("counts an unanswered mood-mix question as open and says who it is for", async () => {
        moodMixState.mockResolvedValue({
            mix: { id: "m", name: "Your Focus Mode Mix", mood: "focus", trackCount: 3, retired: true },
            decision: null,
            playlist: null,
        });
        expect(await item("1.11.0", "moods.mixes.retired")).toMatchObject({ open: true, requires: "retiredMoodMix" });
    });

    it("opens an older release's re-file at once, and leaves the newest release's actions to its window until it is closed", async () => {
        expect((await item("1.12.4", "albums.refile")).open).toBe(true);
        await withLaterRefileRelease(async () => {
            expect((await item("9.0.0", "later.refile")).open).toBeUndefined();
            await acknowledge("9.0.0");
            expect((await item("9.0.0", "later.refile")).open).toBe(true);
        });
    });
});

describe("the 1.11 mood-mix items, on the changelog", () => {
    const mixState = (mix: object | null, extra: object = {}) =>
        moodMixState.mockResolvedValue({ mix, decision: null, playlist: null, ...extra });
    const CURRENT = { id: "m", name: "Your Upbeat Mix", mood: "happy", trackCount: 3, retired: false };
    const RETIRED = { id: "m", name: "Your Focus Mode Mix", mood: "focus", trackCount: 3, retired: true };
    const keysOf111 = () => keysIn("1.11.0");

    beforeEach(async () => {
        jest.restoreAllMocks();
        await acknowledge("1.10.1");
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
        await mixSavedAt("2026-10-20T00:00:00Z");
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

    it("offers admins of an upgraded library to re-file their albums in 1.12.4, and no one else", async () => {
        const refile = catalog.RELEASES.find((r) => r.version === "1.12.4")!.items.find((i) => i.key === "albums.refile");
        expect(refile).toMatchObject({ kind: "action", run: "refileAlbums", requires: "admin", installedBeforeOnly: true });

        jest.restoreAllMocks();
        noMix();
        // Still offered once the upgrade's re-analysis leaves no song analysed before the release.
        await libraryAnalysedBefore(false);
        expect(await refileOnChangelog()).toBeDefined();
        // Not offered to a server set up after the release.
        await settingsRow("2026-12-01T00:00:00Z");
        expect(await refileOnChangelog()).toBeUndefined();
        await settingsRow("2026-01-01T00:00:00Z");
        await libraryAnalysedBefore(true);
        expect(await refileOnChangelog(MEMBER)).toBeUndefined();
    });

    it("stops asking about the re-file once a clean run is recorded", async () => {
        jest.restoreAllMocks();
        noMix();
        expect((await refileOnChangelog())!.open).toBe(true);
        await settingsRow("2026-01-01T00:00:00Z", new Date());
        expect((await refileOnChangelog())!.open).toBe(false);
    });

    it("leaves a recorded re-file out of the newest release's window", async () => {
        jest.restoreAllMocks();
        noMix();
        await withLaterRefileRelease(async () => {
            const keys = async () => (await pendingReleases(USER))[0].items.map((i) => i.key);
            expect(await keys()).toContain("later.refile");
            await settingsRow("2026-01-01T00:00:00Z", new Date());
            expect(await keys()).not.toContain("later.refile");
        });
    });

    it("offers the wipe to an upgraded library and not to a fresh install", async () => {
        jest.restoreAllMocks();
        noMix();
        const keys = () => keysIn("1.11.0");
        expect(await keys()).toContain("engine.wipe");
        await libraryAnalysedBefore(false);
        expect(await keys()).not.toContain("engine.wipe");
    });

    it("gives every item a one-line summary and links only to a page inside the app or an https address", () => {
        for (const item of catalog.RELEASES.flatMap((r) => r.items)) {
            expect(item.summary.length).toBeGreaterThan(0);
            expect(item.summary).not.toMatch(/\n/);
            for (const link of item.links ?? []) expect(link.href).toMatch(/^(\/[a-z]|https:\/\/)/);
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
        noMix();
        await acknowledge("1.10.1");
        const adminKeys = await keysIn("1.11.0");
        expect(adminKeys).toContain(GPU_CHOICE_KEY);

        const memberKeys = (await changelogFor(MEMBER)).releases.find((r) => r.version === "1.11.0")!.items.map((i) => i.key);
        expect(memberKeys).not.toContain(GPU_CHOICE_KEY);
    });
});

/** The settings row is read through the settings module: what it answers decides, whatever the table holds. */
describe("the release questions read the settings through the settings module", () => {
    const answer = (fields: Record<string, unknown>) => {
        mockSettingsAnswer = fields;
        jest.spyOn(prisma.systemSettings, "findUnique").mockImplementation((() => {
            throw new Error("the settings table was read directly");
        }) as never);
    };
    // Offered: listed on the changelog and still open there.
    const refileOffered = async () => (await refileOnChangelog())?.open === true;

    beforeEach(() => {
        jest.restoreAllMocks();
        noMix();
    });
    afterEach(() => {
        mockSettingsAnswer = null;
        jest.restoreAllMocks();
    });

    it("shows the GPU choice as the switch stands", async () => {
        await prisma.releaseChoice.create({
            data: { userId: USER, version: "1.11.0", key: GPU_CHOICE_KEY, enabled: false, decidedBy: ChoiceDecidedBy.EXPLICIT },
        });
        answer({ gpuOnnxEnabled: true, createdAt: new Date("2026-01-01T00:00:00Z"), albumsRefiledAt: null });

        const gpu = (await changelogFor(USER)).releases.find((r) => r.version === "1.11.0")!.items.find((i) => i.key === GPU_CHOICE_KEY)!;
        expect(gpu.answer).toMatchObject({ enabled: true });
    });

    it("stops offering the re-file once the settings say a clean run is recorded", async () => {
        answer({ createdAt: new Date("2026-01-01T00:00:00Z"), albumsRefiledAt: null });
        expect(await refileOffered()).toBe(true);

        answer({ createdAt: new Date("2026-01-01T00:00:00Z"), albumsRefiledAt: new Date() });
        expect(await refileOffered()).toBe(false);
    });

    it("does not offer the re-file to a server the settings say was set up after the release", async () => {
        answer({ createdAt: new Date("2026-12-01T00:00:00Z"), albumsRefiledAt: null });
        expect(await refileOffered()).toBe(false);
    });
});
