/**
 * Tells Subsonic clients when a picture they show changed through no person's edit: a worker found an artist's picture, a
 * scan extracted an album's cover, a repair moved a stored picture to a new version. The shown picture is the one a person
 * set when they set one, else the found one (`userHeroUrl || heroUrl`, `userCoverUrl || coverUrl`), so a found picture that
 * lands under a person's own changes nothing a client shows. A person's own edit moves the marker in routes/enrichment.ts.
 *
 * A writer calls `notePictureChange` with the picture it replaced and the one it stored. Notes gather for a quiet window
 * (`PICTURE_CHANGE_WINDOW_MS`, from the first note of a run) and then move the library-changed marker once, and only when
 * at least one noted picture really changed what is shown and belongs to an artist or album a client lists
 * (services/libraryChanged.ts). A run that touches a thousand pictures costs one marker, not a thousand; a run longer than
 * the window costs one per window. A note is held in memory: a process that stops inside the window forgets it, and a
 * marker write that fails (logged) drops the notes it was for; either way the client sees the new picture at the next
 * change of the library.
 */
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { anyAlbumIsListed, anyArtistIsListed, markLibraryChangedIfListed } from "./libraryChanged";

export const PICTURE_CHANGE_WINDOW_MS = 15_000;

/** How many ids one check of "does a client list any of these" takes. */
const CHECK_SIZE = 500;

export type PictureKind = "artist" | "album";

/** The picture an artist or album shows: the person's own when set, else the found one; null for none. */
export const shownPicture = (found: string | null | undefined, own: string | null | undefined): string | null => own || found || null;

interface Noted {
    kind: PictureKind;
    id: string;
    was: string | null;
    now: string | null;
}

let pending = new Map<string, Noted>();
let timer: NodeJS.Timeout | null = null;

/**
 * A found picture was stored for an artist (`kind` "artist": `heroUrl`) or album (`coverUrl`): `was` is the found one it
 * replaced, `now` the one stored, `own` the person's own picture for the same row (null when none). Nothing is noted when
 * what is shown stays the same.
 */
export function notePictureChange(
    kind: PictureKind,
    id: string,
    change: { was: string | null | undefined; now: string | null | undefined; own?: string | null },
): void {
    const was = shownPicture(change.was, change.own);
    const now = shownPicture(change.now, change.own);
    const key = `${kind}:${id}`;
    const earlier = pending.get(key);
    // Two changes of one picture in a window are judged as one: from what it showed before the first to what it shows now.
    const noted: Noted = { kind, id, was: earlier ? earlier.was : was, now };
    if (!earlier && was === now) return;
    pending.set(key, noted);
    if (!timer) {
        timer = setTimeout(() => {
            timer = null;
            void flushShownPictureChanges();
        }, PICTURE_CHANGE_WINDOW_MS);
        // A pending note never keeps a process alive: shutdown does not wait for the window.
        timer.unref();
    }
}

/** Moves the marker now for the notes held, when any of them shows a client something new. Waits for the marker. */
export async function flushShownPictureChanges(): Promise<void> {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    const noted = [...pending.values()].filter((n) => n.was !== n.now);
    pending = new Map();
    if (noted.length === 0) return;

    const listed = async (kind: PictureKind, anyListed: (ids: string[]) => Promise<boolean>) => {
        const ids = noted.filter((n) => n.kind === kind).map((n) => n.id);
        for (let i = 0; i < ids.length; i += CHECK_SIZE) if (await anyListed(ids.slice(i, i + CHECK_SIZE))) return true;
        return false;
    };
    try {
        await markLibraryChangedIfListed(
            async () => (await listed("artist", anyArtistIsListed)) || (await listed("album", anyAlbumIsListed)),
            "found pictures changed",
        );
    } catch (e) {
        // markLibraryChangedIfListed logs its own failures; this only keeps a run from failing over a marker.
        logger.error("Failed to record found pictures changed:", e);
    }
}

/**
 * `prisma.<model>.updateMany` for a column that holds a picture, with the notes it owes: every row whose `column` equals
 * `from` is given `to`, and a row whose shown picture changed is noted. For the one-time repairs that rewrite a stored
 * address wherever it stands.
 */
export async function rewritePictureColumn(
    model: PictureKind,
    column: "heroUrl" | "userHeroUrl" | "coverUrl" | "userCoverUrl",
    from: string,
    to: string,
): Promise<number> {
    const rows: Array<{ id: string; found: string | null; own: string | null }> = [];
    let count: number;
    if (model === "artist") {
        const read = await prisma.artist.findMany({ where: { [column]: from }, select: { id: true, heroUrl: true, userHeroUrl: true } });
        rows.push(...read.map((r) => ({ id: r.id, found: r.heroUrl, own: r.userHeroUrl })));
        count = (await prisma.artist.updateMany({ where: { [column]: from }, data: { [column]: to } })).count;
    } else {
        const read = await prisma.album.findMany({ where: { [column]: from }, select: { id: true, coverUrl: true, userCoverUrl: true } });
        rows.push(...read.map((r) => ({ id: r.id, found: r.coverUrl, own: r.userCoverUrl })));
        count = (await prisma.album.updateMany({ where: { [column]: from }, data: { [column]: to } })).count;
    }
    const writesOwn = column === "userHeroUrl" || column === "userCoverUrl";
    for (const row of rows) {
        const now = writesOwn ? { found: row.found, own: to } : { found: to, own: row.own };
        notePictureChange(model, row.id, { was: shownPicture(row.found, row.own), now: shownPicture(now.found, now.own) });
    }
    return count;
}
