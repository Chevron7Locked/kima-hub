/**
 * The July 2026 identity-key upgrade computed artist and album keys and sort names in SQL. This suite's database is
 * SQL_ASCII, like production's, so rows built with those same SQL functions come out as the upgrade left them: a name
 * outside English letters keyed by its own id, a mixed name keyed by its English letters only, sort names with their
 * capitals. The one-time repair recomputes them the way the scanner does; where two rows want one key the older keeps
 * it and the other is named as a duplicate; a punctuation-only album is keyed the way the scanner looks it up; a row
 * the SQL got right is left alone. Real database.
 */

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { repairIdentityKeys } from "../identityKeyRepair";
import { albumIdentityKey } from "../albumIdentity";
import { artistIdentityKey, artistSortName, normalizeArtistName } from "../artistIdentity";

const P = "zz_keyrepair_";
// Rare words, so the keys cannot meet another suite's rows. Fully non-Latin names are what the upgrade keyed by id.
const KINO = "Киножж";
const TAIKO = "太鼓太鼓";
const MIXED = "Ленинград Leningrad zzkr";
const EDITED = "Аквариумжж";
const SHOWN = "БГжж";
const TWIN1 = "Мумий Тролльжж";
const TWIN2 = "мумий тролльжж";
const LATIN = "Zzkr Björk Band";

async function cleanup() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** An artist as the July upgrade's SQL keyed it. */
async function upgradedArtist(id: string, name: string, displayName: string | null = null) {
    await prisma.$executeRaw`
        INSERT INTO "Artist" (id, name, "displayName", "identityKey", "normalizedName", "sortName")
        VALUES (${id}, ${name}, ${displayName}, coalesce(nullif(kima_identity_key(${name}), ''), ${id}),
                lower(unaccent(${name})), kima_sort_name(coalesce(${displayName}, ${name})))`;
}

/** An album as the July upgrade's SQL keyed it. */
async function upgradedAlbum(id: string, artistId: string, title: string, displayTitle: string | null = null) {
    await prisma.$executeRaw`
        INSERT INTO "Album" (id, "artistId", title, "displayTitle", "rgMbid", "primaryType", "identityKey", "sortName")
        VALUES (${id}, ${artistId}, ${title}, ${displayTitle}, ${`${id}-rg`}, 'Album',
                coalesce(nullif(kima_album_identity_key(${title}), ''), ${id}), kima_sort_name(coalesce(${displayTitle}, ${title})))`;
}

const artist = (id: string) => prisma.artist.findUniqueOrThrow({ where: { id: `${P}${id}` } });
const album = (id: string) => prisma.album.findUniqueOrThrow({ where: { id: `${P}${id}` } });
const ours = (taken: string[]) => taken.filter((t) => t.includes(P));

/** Marks the check not yet run, as on an install from before it. */
async function notYetChecked() {
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", identityKeysCheckedAt: null }, update: { identityKeysCheckedAt: null } });
    invalidateSystemSettingsCache();
}

let latinBefore: unknown;

beforeAll(async () => {
    await cleanup();
    await upgradedArtist(`${P}kino`, KINO);
    await upgradedAlbum(`${P}taiko`, `${P}kino`, TAIKO);
    await upgradedAlbum(`${P}edited-album`, `${P}kino`, "Звездажж", "Солнцежж");
    // Two albums of one artist that the SQL keyed apart (both by id) but that are one title.
    await upgradedAlbum(`${P}a1`, `${P}kino`, "Группажж");
    await upgradedAlbum(`${P}a2`, `${P}kino`, "группажж");
    await upgradedArtist(`${P}mixed`, MIXED);
    await upgradedArtist(`${P}edited`, EDITED, SHOWN);
    await upgradedArtist(`${P}bangs`, "!!!");
    await upgradedAlbum(`${P}dots`, `${P}bangs`, "...");
    await upgradedArtist(`${P}twin1`, TWIN1);
    await upgradedArtist(`${P}twin2`, TWIN2);
    await upgradedArtist(`${P}latin`, LATIN);
    await upgradedAlbum(`${P}latin-album`, `${P}latin`, "Zzkr Café Songs");
    latinBefore = [await artist("latin"), await album("latin-album")];
    await notYetChecked();
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("repairIdentityKeys", () => {
    it("starts from what the upgrade's SQL left on a SQL_ASCII database", async () => {
        expect((await artist("kino")).identityKey).toBe(`${P}kino`);
        expect((await artist("mixed")).identityKey).toBe("leningradzzkr");
        expect((await album("taiko")).identityKey).toBe(`${P}taiko`);
        expect((await artist("kino")).sortName).toBe(KINO);
    });

    it("corrects keys, lookup names and sort names the way the scanner computes them", async () => {
        // Two rows a page, so the pass reads page after page.
        const result = await repairIdentityKeys({ pageSize: 2 });
        expect(result).not.toBeNull();

        for (const [id, name] of [["kino", KINO], ["mixed", MIXED]]) {
            const row = await artist(id);
            expect(row.identityKey).toBe(artistIdentityKey(name));
            expect(row.normalizedName).toBe(normalizeArtistName(name));
            expect(row.sortName).toBe(artistSortName(name));
        }
        expect((await artist("kino")).sortName).toBe("киножж");
        const taiko = await album("taiko");
        expect(taiko.identityKey).toBe(albumIdentityKey(TAIKO));
        expect(taiko.identityKey).toBe(TAIKO);

        // An edited name or title files the row under the edit, as the metadata editor does.
        expect((await artist("edited")).sortName).toBe(artistSortName(SHOWN));
        const editedAlbum = await album("edited-album");
        expect(editedAlbum.identityKey).toBe(albumIdentityKey("Звездажж"));
        expect(editedAlbum.sortName).toBe("солнцежж");

        expect(ours(result!.taken).sort()).toEqual([`album ${P}a2 (группажж)`, `artist ${P}twin2 (${TWIN2})`]);
    });

    it("gives the older of two rows the key they both want, and corrects the other's sort name", async () => {
        expect((await artist("twin1")).identityKey).toBe(artistIdentityKey(TWIN1));
        expect((await artist("twin2")).identityKey).toBe(`${P}twin2`);
        expect((await artist("twin2")).sortName).toBe(artistSortName(TWIN2));
        expect((await album("a1")).identityKey).toBe(albumIdentityKey("Группажж"));
        expect((await album("a2")).identityKey).toBe(`${P}a2`);
        expect((await album("a2")).sortName).toBe("группажж");
    });

    it("keys a punctuation-only album as the scanner looks it up, and leaves a punctuation-only artist's key", async () => {
        expect((await album("dots")).identityKey).toBe(`untitled-${P}bangs`);
        expect((await artist("bangs")).identityKey).toBe(`${P}bangs`);
    });

    it("leaves rows the SQL got right exactly as they were", async () => {
        expect([await artist("latin"), await album("latin-album")]).toEqual(latinBefore);
    });

    it("runs once: marked done, it does nothing on the next start", async () => {
        expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).identityKeysCheckedAt).not.toBeNull();
        invalidateSystemSettingsCache();
        expect(await repairIdentityKeys()).toBeNull();
    });

    it("run again, changes nothing it corrected and names the same duplicates", async () => {
        const rows = () => prisma.artist.findMany({ where: { id: { startsWith: P } }, orderBy: { id: "asc" } });
        const before = await rows();
        await notYetChecked();
        const result = await repairIdentityKeys();
        expect(await rows()).toEqual(before);
        expect(ours(result!.taken).sort()).toEqual([`album ${P}a2 (группажж)`, `artist ${P}twin2 (${TWIN2})`]);
    });
});
