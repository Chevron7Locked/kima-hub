/**
 * The July 2026 identity-key upgrade computed artist and album keys and sort names in SQL. On a SQL_ASCII database
 * Postgres sees no letters outside English: a name in another script (太鼓, Кино) folded to nothing and the row was
 * keyed by its own id, a mixed name ("Ленинград Leningrad") kept only its English letters, and sort names kept their
 * capitals. The scanner, which computes these in TypeScript, then cannot find those rows by name and files new copies.
 * Once per install, this recomputes every artist's and album's key, lookup name and sort name the way the scanner does
 * and writes any that differ. Where two rows want one key, the older row (lower id) gets it and the other keeps its old
 * key and is named in the log as a duplicate, never merged; its sort name and lookup name are corrected regardless. An
 * artist whose name has no letters or digits keeps its key.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { artistIdentityKey, artistSortName, normalizeArtistName } from "./artistIdentity";
import { albumIdentityKey } from "./albumIdentity";

const isTaken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** The name a sort name follows: the edited one when set, as the metadata editor does (routes/enrichment.ts). */
const shownName = (edited: string | null, canonical: string) => (edited?.trim() ? edited : canonical);

/**
 * Corrects the rows whose stored keys differ from Kima's, once per install; null when it already ran. `taken` names
 * the duplicates that kept their old key.
 */
export async function repairIdentityKeys(
    { pageSize = 1000 }: { pageSize?: number } = {},
): Promise<{ artists: number; albums: number; taken: string[] } | null> {
    // Read fresh: the check marks itself done in the settings row, which is cached.
    const settings = await getSystemSettings(true);
    // No settings row yet is a new install: the scanner keyed every row.
    if (!settings || settings.identityKeysCheckedAt) return null;

    const taken: string[] = [];
    let artists = 0;
    let albums = 0;

    for (let after: string | undefined; ; ) {
        const page = await prisma.artist.findMany({
            select: { id: true, name: true, displayName: true, identityKey: true, normalizedName: true, sortName: true },
            // Past the last id read, not from it: a row deleted meanwhile cannot end the pass early.
            where: after ? { id: { gt: after } } : {},
            orderBy: { id: "asc" },
            take: pageSize,
        });
        for (const row of page) {
            const key = artistIdentityKey(row.name);
            const names = { normalizedName: normalizeArtistName(row.name), sortName: artistSortName(shownName(row.displayName, row.name)) };
            // A name with no letters or digits has no key; it keeps the one it has.
            const identityKey = key || row.identityKey;
            if (identityKey === row.identityKey && names.normalizedName === row.normalizedName && names.sortName === row.sortName) continue;
            // Only while the row is as read: a scan or edit meanwhile wins.
            try {
                artists += (await prisma.artist.updateMany({ where: row, data: { identityKey, ...names } })).count;
            } catch (error) {
                if (!isTaken(error)) throw error;
                taken.push(`artist ${row.id} (${row.name})`);
                artists += (await prisma.artist.updateMany({ where: row, data: names })).count;
            }
        }
        if (page.length < pageSize) break;
        after = page[page.length - 1].id;
    }

    for (let after: string | undefined; ; ) {
        const page = await prisma.album.findMany({
            select: { id: true, artistId: true, title: true, displayTitle: true, identityKey: true, sortName: true },
            // Past the last id read, not from it: a row deleted meanwhile cannot end the pass early.
            where: after ? { id: { gt: after } } : {},
            orderBy: { id: "asc" },
            take: pageSize,
        });
        for (const row of page) {
            // A title with no letters or digits is keyed the way the scanner looks it up (resolveAlbum).
            const identityKey = albumIdentityKey(row.title) || `untitled-${row.artistId}`;
            const sortName = artistSortName(shownName(row.displayTitle, row.title));
            if (identityKey === row.identityKey && sortName === row.sortName) continue;
            try {
                albums += (await prisma.album.updateMany({ where: row, data: { identityKey, sortName } })).count;
            } catch (error) {
                if (!isTaken(error)) throw error;
                taken.push(`album ${row.id} (${row.title})`);
                albums += (await prisma.album.updateMany({ where: row, data: { sortName } })).count;
            }
        }
        if (page.length < pageSize) break;
        after = page[page.length - 1].id;
    }

    await prisma.systemSettings.update({ where: { id: settings.id }, data: { identityKeysCheckedAt: new Date() } });
    if (artists || albums) logger.info(`[IdentityKeys] Corrected ${artists} artists and ${albums} albums`);
    if (taken.length) {
        logger.warn(`[IdentityKeys] Duplicates kept their old key; the older row holds the right one: ${taken.join(", ")}`);
    }
    return { artists, albums, taken };
}
