/**
 * Tells Subsonic clients when something they show changed through no person's edit: a worker found an artist's picture, a
 * scan extracted an album's cover, a repair moved a stored picture to a new version, an enrichment filled an album's year or
 * an artist's genres. What is shown is the person's own value when they set one, else the found one (`userHeroUrl ||
 * heroUrl`, `userCoverUrl || coverUrl`, an album's `displayYear ?? originalYear ?? year`, the genres of `getMergedGenres`),
 * so a found value that lands under a person's own changes nothing a client shows. A person's own edit moves the marker in
 * routes/enrichment.ts, which asks `artistShownChange`, `albumShownChange` and `songTitleChanged` what the edit changed.
 *
 * A writer calls `notePictureChange`, `noteYearChange` or `noteGenresChange` with what it replaced and what it stored. Notes
 * gather for a quiet window (`SHOWN_CHANGE_WINDOW_MS`, from the first note of a run) and then move the library-changed
 * marker once, and only when at least one noted value really changed what is shown and belongs to an artist or album a
 * client lists (services/libraryChanged.ts). A run that touches a thousand rows costs one marker, not a thousand; a run
 * longer than the window costs one per window. A batch writer, and each enrichment cycle, flushes at its end. A note is held
 * in memory: a process that stops inside the window forgets it, and a marker write that fails (logged) drops the notes it was
 * for; either way the client sees the new value at the next change of the library.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getEffectiveYear } from "../utils/dateFilters";
import { getMergedGenres } from "../utils/metadataOverrides";
import { anyAlbumIsListed, anyArtistIsListed, markLibraryChangedIfListed } from "./libraryChanged";

export const SHOWN_CHANGE_WINDOW_MS = 15_000;

/** How many ids one check of "does a client list any of these" takes. */
const CHECK_SIZE = 500;

export type ShownKind = "artist" | "album";

/** The picture an artist or album shows: the person's own when set, else the found one; null for none. */
export const shownPicture = (found: string | null | undefined, own: string | null | undefined): string | null => own || found || null;

/** What one note is about: a row's shown picture, an album's shown year, or the genres a row shows. */
type Field = "picture" | "year" | "genres";

interface Noted {
    kind: ShownKind;
    field: Field;
    id: string;
    was: string | null;
    now: string | null;
}

let pending = new Map<string, Noted>();
let timer: NodeJS.Timeout | null = null;

function note(kind: ShownKind, field: Field, id: string, was: string | null, now: string | null): void {
    const key = `${kind}:${field}:${id}`;
    const earlier = pending.get(key);
    // Two changes of one value in a window are judged as one: from what it showed before the first to what it shows now.
    const noted: Noted = { kind, field, id, was: earlier ? earlier.was : was, now };
    if (!earlier && was === now) return;
    pending.set(key, noted);
    if (!timer) {
        timer = setTimeout(() => {
            timer = null;
            void flushShownChanges();
        }, SHOWN_CHANGE_WINDOW_MS);
        // A pending note never keeps a process alive: shutdown does not wait for the window.
        timer.unref();
    }
}

/**
 * A found picture was stored for an artist (`kind` "artist": `heroUrl`) or album (`coverUrl`): `was` is the found one it
 * replaced, `now` the one stored, `own` the person's own picture for the same row (null when none). Nothing is noted when
 * what is shown stays the same.
 */
export function notePictureChange(
    kind: ShownKind,
    id: string,
    change: { was: string | null | undefined; now: string | null | undefined; own?: string | null },
): void {
    note(kind, "picture", id, shownPicture(change.was, change.own), shownPicture(change.now, change.own));
}

/** The three year columns of an album, as stored. */
export type AlbumYears = { displayYear?: number | null; originalYear?: number | null; year?: number | null };

/** The year an album shows, `displayYear ?? originalYear ?? year`; null for none. */
const shownYear = (years: AlbumYears): string | null => (getEffectiveYear(years) || null)?.toString() ?? null;

/** The two genre lists of an artist or album, as stored. */
export type GenreLists = { genres?: unknown; userGenres?: unknown };

/** The genres a row shows (the person's list, else the enriched one), as one text that compares whole and in order. */
const shownGenres = (lists: GenreLists): string => JSON.stringify(getMergedGenres(lists));

/** An album's year columns changed (an enrichment filled one): noted when the year shown differs. */
export function noteYearChange(albumId: string, change: { was: AlbumYears; now: AlbumYears }): void {
    note("album", "year", albumId, shownYear(change.was), shownYear(change.now));
}

/** An artist's or album's genre lists changed: noted when the genres shown differ. */
export function noteGenresChange(kind: ShownKind, id: string, change: { was: GenreLists; now: GenreLists }): void {
    note(kind, "genres", id, shownGenres(change.was), shownGenres(change.now));
}

/** The title or name a row shows: the person's own when set, else the stored one. */
const shownTitle = (stored: string, own: string | null | undefined): string => own || stored;

type ArtistShown = GenreLists & { name: string; displayName?: string | null; heroUrl?: string | null; userHeroUrl?: string | null };

type AlbumShown = AlbumYears &
    GenreLists & { title: string; displayTitle?: string | null; coverUrl?: string | null; userCoverUrl?: string | null };

/**
 * What a person's edit or reset of an artist changed in what a client lists (its name, picture or genres): the first
 * that differs, or null. The caller moves the library-changed marker for a non-null answer.
 */
export function artistShownChange(was: ArtistShown, now: ArtistShown): "name" | "picture" | "genres" | null {
    if (shownTitle(was.name, was.displayName) !== shownTitle(now.name, now.displayName)) return "name";
    if (shownPicture(was.heroUrl, was.userHeroUrl) !== shownPicture(now.heroUrl, now.userHeroUrl)) return "picture";
    if (shownGenres(was) !== shownGenres(now)) return "genres";
    return null;
}

/** As `artistShownChange`, for an album's title, cover, year or genres. */
export function albumShownChange(was: AlbumShown, now: AlbumShown): "title" | "cover" | "year" | "genres" | null {
    if (shownTitle(was.title, was.displayTitle) !== shownTitle(now.title, now.displayTitle)) return "title";
    if (shownPicture(was.coverUrl, was.userCoverUrl) !== shownPicture(now.coverUrl, now.userCoverUrl)) return "cover";
    if (shownYear(was) !== shownYear(now)) return "year";
    if (shownGenres(was) !== shownGenres(now)) return "genres";
    return null;
}

/** Whether a person's edit or reset of a song changed the title a client lists. */
export function songTitleChanged(
    was: { title: string; displayTitle?: string | null },
    now: { title: string; displayTitle?: string | null },
): boolean {
    return shownTitle(was.title, was.displayTitle) !== shownTitle(now.title, now.displayTitle);
}

/** Moves the marker now for the notes held, when any of them shows a client something new. Waits for the marker. */
export async function flushShownChanges(): Promise<void> {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    const noted = [...pending.values()].filter((n) => n.was !== n.now);
    pending = new Map();
    if (noted.length === 0) return;

    const listed = async (kind: ShownKind, anyListed: (ids: string[]) => Promise<boolean>) => {
        const ids = [...new Set(noted.filter((n) => n.kind === kind).map((n) => n.id))];
        for (let i = 0; i < ids.length; i += CHECK_SIZE) if (await anyListed(ids.slice(i, i + CHECK_SIZE))) return true;
        return false;
    };
    try {
        await markLibraryChangedIfListed(
            async () => (await listed("artist", anyArtistIsListed)) || (await listed("album", anyAlbumIsListed)),
            "shown details found",
        );
    } catch (e) {
        // markLibraryChangedIfListed logs its own failures; this only keeps a run from failing over a marker.
        logger.error("Failed to record shown details found:", e);
    }
}

/** The picture columns of each model: the found one and the person's own. */
const PICTURE_COLUMNS = {
    artist: { table: "Artist", found: "heroUrl", own: "userHeroUrl" },
    album: { table: "Album", found: "coverUrl", own: "userCoverUrl" },
} as const;

/**
 * `prisma.<model>.updateMany` for a column that holds a picture, with the notes it owes: every row whose `column` equals
 * `from` is given `to`, and a row whose shown picture changed is noted. For the one-time repairs that rewrite a stored
 * address wherever it stands. One statement writes the rows and answers them, so each note describes a row as it was
 * when written, whatever else changed it meanwhile.
 */
export async function rewritePictureColumn(
    model: ShownKind,
    column: "heroUrl" | "userHeroUrl" | "coverUrl" | "userCoverUrl",
    from: string,
    to: string,
): Promise<number> {
    const { table, found, own } = PICTURE_COLUMNS[model];
    if (column !== found && column !== own) throw new Error(`rewritePictureColumn: ${column} is not a picture column of ${model}`);
    // `table` and `column` come from the closed sets above, never from a caller's text.
    const rows = await prisma.$queryRaw<Array<{ id: string; found: string | null; own: string | null }>>(Prisma.sql`
        UPDATE ${Prisma.raw(`"${table}"`)} SET ${Prisma.raw(`"${column}"`)} = ${to}
         WHERE ${Prisma.raw(`"${column}"`)} = ${from}
     RETURNING id, ${Prisma.raw(`"${found}"`)} AS found, ${Prisma.raw(`"${own}"`)} AS own`);
    const writesOwn = column === own;
    for (const row of rows) {
        // The written column held `from` before; the other one is as it is now.
        const before = writesOwn ? { found: row.found, own: from } : { found: from, own: row.own };
        notePictureChange(model, row.id, { was: shownPicture(before.found, before.own), now: shownPicture(row.found, row.own) });
    }
    return rows.length;
}
