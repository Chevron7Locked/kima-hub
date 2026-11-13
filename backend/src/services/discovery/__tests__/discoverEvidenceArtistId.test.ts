/**
 * Discover's evidence for an album (discoverEvidence, over loadDiscoverRecords) matches a record by artist and title with
 * the one artist-identity rule: two real MusicBrainz ids that differ are a namesake and never match; a missing or `temp-`
 * id on either side still matches by name. A release-group id match needs no artist. Real database.
 */
import { prisma } from "../../../utils/db";
import { discoverDownloaded, discoverEvidence, loadDiscoverRecords } from "../discoverEvidence";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const MARK = "zz-evidence-id";
const USER = `${MARK}-user`;
const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";
const PLACEHOLDER = "temp-1793617784650-0.5";
/** Ids that make an artist known by name only. */
const NO_REAL_ID: [string | null][] = [[null], [PLACEHOLDER]];
/** The same artist's id, or none the rule can read. */
const SAME_OR_NONE: [string | null][] = [[ARTIST], ...NO_REAL_ID];

async function cleanup() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** A Discover download of "Ed O'Brien - Blue Morpho", or the listener's own request of it, under `artistMbid`. */
async function job(artistMbid: string | null, own = false) {
    const batch = own
        ? null
        : await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date("2026-11-02"), targetSongCount: 10, status: "completed" } });
    await prisma.downloadJob.create({
        data: {
            userId: USER,
            subject: "Ed O'Brien - Blue Morpho",
            type: "album",
            status: "completed",
            artistMbid,
            discoveryBatchId: batch?.id ?? null,
            metadata: { artistName: "Ed O'Brien", albumTitle: "Blue Morpho", downloadType: own ? "album" : "discovery" },
        },
    });
}

/** A suggestion of "Ed O'Brien - Blue Morpho" in the given status, under `artistMbid`. */
const suggestion = (artistMbid: string | null, status: "ACTIVE" | "LIKED") =>
    prisma.discoveryAlbum.create({
        data: {
            userId: USER,
            rgMbid: "temp-suggested-id",
            artistName: "Ed O'Brien",
            artistMbid,
            albumTitle: "Blue Morpho",
            weekStartDate: new Date("2026-11-02"),
            status,
        },
    });

/** The album, as the scanner or the sort knows it: another release-group id than the record's, so only the names can match. */
const album = (artistMbid: string | null, artistName = "Ed O'Brien") => ({
    artistName,
    artistMbid,
    title: "Blue Morpho",
    rgMbid: "temp-scanned-id",
});

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user" } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("discoverEvidence matches a record by artist and title with the artist-identity rule", () => {
    it("does not take a namesake's Discover download as this album's", async () => {
        await job(NAMESAKE);
        const records = await loadDiscoverRecords();
        expect(discoverEvidence(album(ARTIST), records)).toBeNull();
        expect(discoverDownloaded(album(ARTIST), records)).toBe(false);
    });

    it("does not take a namesake's liked suggestion as this album's", async () => {
        await suggestion(NAMESAKE, "LIKED");
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBeNull();
    });

    it("does not take a namesake's own request as this album's", async () => {
        await job(NAMESAKE, true);
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBeNull();
    });

    it("keeps a namesake's liked mark from hiding this artist's Discover download", async () => {
        await suggestion(NAMESAKE, "LIKED");
        await job(ARTIST);
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBe("downloaded");
    });

    it.each(SAME_OR_NONE)("takes a Discover download whose artist id is %s", async (id) => {
        await job(id);
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBe("downloaded");
    });

    it.each(NO_REAL_ID)("takes a Discover download for an album whose artist id is %s", async (id) => {
        await job(ARTIST);
        expect(discoverEvidence(album(id), await loadDiscoverRecords())).toBe("downloaded");
    });

    it.each(SAME_OR_NONE)("takes a liked suggestion whose artist id is %s", async (id) => {
        await suggestion(id, "LIKED");
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBe("liked");
    });

    it.each(SAME_OR_NONE)("takes the listener's own request whose artist id is %s", async (id) => {
        await job(id, true);
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBe("requested");
    });

    it("matches a credit's first artist by the same rule", async () => {
        await job(ARTIST);
        const records = await loadDiscoverRecords();
        expect(discoverEvidence(album(ARTIST, "Ed O'Brien feat. Someone"), records)).toBe("downloaded");
        expect(discoverEvidence(album(NAMESAKE, "Ed O'Brien feat. Someone"), records)).toBeNull();
    });

    it("still matches by release-group id whatever the artist id", async () => {
        await job(NAMESAKE);
        await prisma.downloadJob.updateMany({ where: { userId: USER }, data: { targetMbid: "temp-scanned-id" } });
        expect(discoverEvidence(album(ARTIST), await loadDiscoverRecords())).toBe("downloaded");
    });
});
