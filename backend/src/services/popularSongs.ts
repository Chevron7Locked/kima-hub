/**
 * An artist's popular songs: the one answer the web artist page and Subsonic `getTopSongs` both give.
 *
 * The order is three tiers, each listing only what the tiers before it left out:
 * 1. global popularity (ListenBrainz sitewide, for a person who has saved a ListenBrainz token; otherwise Deezer's artist
 *    top), joined to the artist's playable songs by recording id, then by title;
 * 2. this person's own listens of the artist's playable songs, most played first (the listens module);
 * 3. first-release date, earliest first: MusicBrainz's date for the album, else the album's year.
 * Both sources are read to the same depth (50), so a person's web list and Subsonic list put the owned songs in the same
 * order whatever the limit. The web asks for `previews`: songs the source ranks that the library lacks, shown as a
 * preview. Subsonic asks for owned songs only.
 *
 * A source that is down must not slow the page: each outside question is raced against `deadlineMs`, and a source that
 * misses it, answers with a server error or a rate limit, or cannot be reached is skipped for a minute (a Redis marker,
 * so every process agrees). A refusal of this person's token is theirs alone and marks nothing. The sources' own caches
 * (ListenBrainz 6 hours, Deezer 24 hours) serve as this module's cache.
 *
 * Playable songs only, by the playable-song rule; plays of anything else rank nothing.
 */

import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { isMbid } from "./artistIdentity";
import { nameKey } from "./nameFold";
import { listenBrainzService } from "./listenBrainz";
import { deezerService } from "./deezer";
import { musicBrainzService } from "./musicbrainz";
import { playCounts } from "./stats/listens";

/** How many songs each source is asked for, whatever the caller's limit. */
const SOURCE_DEPTH = 50;
/** How long one outside question may take before the answer is built without it. */
const DEFAULT_DEADLINE_MS = 3000;
/** How long a source that failed is skipped. */
const DOWN_SECONDS = 60;

export type PopularSource = "global" | "own" | "release";

/** A ranked song the library lacks, to be previewed. */
export interface PopularPreview {
    /** The source's own id for the song; unique within one list. */
    key: string;
    previewUrl: string | null;
    albumTitle: string | null;
    coverUrl: string | null;
    durationMs: number;
}

export interface PopularSong {
    /** The playable song's id; null for a preview-only song. */
    trackId: string | null;
    title: string;
    /** The tier that placed it. */
    source: PopularSource;
    /** Sitewide plays (ListenBrainz) or Deezer's rank; for the own tier, this person's plays. */
    playCount: number;
    /** Sitewide listeners (ListenBrainz); 0 from any other tier. */
    listeners: number;
    /** This person's own plays of the song. */
    userPlayCount: number;
    /** The first-release date the song was placed by (release tier only); null when nothing dated it. */
    releaseDate?: string | null;
    preview: PopularPreview | null;
}

export interface PopularSongsArgs {
    artist: { id: string; name: string; mbid: string | null };
    userId: string;
    limit: number;
    /** Also list songs a source ranks that the library lacks. */
    previews: boolean;
    /** Per outside question; the default fits an artist page. */
    deadlineMs?: number;
}

interface Ranked {
    key: string;
    title: string;
    albumTitle?: string | null;
    coverUrl?: string | null;
    previewUrl?: string | null;
    durationMs?: number;
    listeners: number;
    playCount: number;
}

interface OwnedSong {
    id: string;
    title: string;
    recordingMbid: string | null;
    trackNo: number | null;
    discNumber: number | null;
    album: { id: string; year: number | null; rgMbid: string };
}

/** A song title without what follows a dash or bracket ("Song - Radio Edit", "Song (Live)"), folded by nameKey. */
function bareTitle(title: string): string {
    // A spaced dash or a bracket starts the suffix; the dash inside "Re-Wired" or "Mid-Air" does not.
    const bare = title.replace(/\s+[-–]\s+.*$|\s*\(.*$/, "");
    return nameKey(bare) || bare.trim().toLowerCase();
}

const fullTitle = (title: string) => nameKey(title) || title.trim().toLowerCase();

/** A 4xx other than 429 is the server saying no to this request, not being down. */
function isRefusal(error: unknown): boolean {
    const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
    return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

class Deadline extends Error {}

/**
 * `ask`'s answer, or null when the source is marked down, misses `deadlineMs` or fails (unless the failure is a refusal,
 * which only skips this question). The question keeps running after a missed deadline, so what it learns still lands in
 * the source's own cache.
 */
async function fromSource<T>(source: string, deadlineMs: number, ask: () => Promise<T>): Promise<T | null> {
    const marker = `popular:down:${source}`;
    try {
        if (await redisClient.get(marker)) return null;
    } catch (err) {
        logger.warn(`[popularSongs] could not read the ${source} marker`, err);
    }
    const asked = ask();
    asked.catch(() => undefined); // a loser of the race that fails later has nobody to tell
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            asked,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Deadline()), deadlineMs);
            }),
        ]);
    } catch (err) {
        if (err instanceof Deadline) {
            logger.warn(`[popularSongs] ${source} missed its ${deadlineMs} ms deadline; skipping it for ${DOWN_SECONDS} s`);
            // Slow is not down: if the late answer does arrive, its cache is warm, so lift the marker.
            asked.then(() => redisClient.del(marker)).catch(() => undefined);
        } else if (isRefusal(err)) {
            logger.warn(`[popularSongs] ${source} refused the request`, err);
            return null;
        } else {
            logger.warn(`[popularSongs] ${source} failed; skipping it for ${DOWN_SECONDS} s`, err);
        }
        try {
            await redisClient.set(marker, "1", "EX", DOWN_SECONDS);
        } catch (markError) {
            logger.warn(`[popularSongs] could not mark ${source} down`, markError);
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Global popularity, best first, to SOURCE_DEPTH: ListenBrainz when it has something for this person, else Deezer. */
async function globalRanking(args: PopularSongsArgs, deadlineMs: number): Promise<Ranked[]> {
    if (isMbid(args.artist.mbid)) {
        const mbid = args.artist.mbid;
        const lb = await fromSource("listenbrainz", deadlineMs, () =>
            listenBrainzService.getTopRecordingsForArtist(mbid, args.userId, SOURCE_DEPTH),
        );
        if (lb && lb.length > 0) {
            return lb.map((r) => ({
                key: r.recordingMbid,
                title: r.title,
                albumTitle: r.releaseName,
                durationMs: r.lengthMs,
                listeners: r.listeners,
                playCount: r.playCount,
            }));
        }
    }
    const dz = await fromSource("deezer", deadlineMs, () => deezerService.getArtistTopTracks(args.artist.name, SOURCE_DEPTH));
    return (dz ?? []).map((r) => ({
        key: r.title.toLowerCase(),
        title: r.title,
        albumTitle: r.album,
        coverUrl: r.coverUrl,
        previewUrl: r.previewUrl,
        durationMs: r.durationMs,
        listeners: 0,
        playCount: r.rank,
    }));
}

/** MusicBrainz's first-release date for each of the artist's albums, by release-group id; empty when it will not say. */
async function releaseDates(mbid: string | null, deadlineMs: number): Promise<Map<string, string>> {
    const dates = new Map<string, string>();
    if (!isMbid(mbid)) return dates;
    const fetched = await fromSource("musicbrainz", deadlineMs, () => musicBrainzService.getReleaseGroups(mbid, ["album"], 50, { interactive: true }));
    if (fetched?.kind !== "answered") return dates;
    for (const rg of fetched.value as Array<{ id: string; "first-release-date"?: string }>) {
        if (rg["first-release-date"]) dates.set(rg.id, rg["first-release-date"]);
    }
    return dates;
}

export async function popularSongs(args: PopularSongsArgs): Promise<PopularSong[]> {
    const deadlineMs = args.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const playable = { ...PLAYABLE_SONG, album: { ...PLAYABLE_SONG.album, artistId: args.artist.id } };

    const [owned, listens, ranked] = await Promise.all([
        prisma.track.findMany({
            where: playable,
            select: {
                id: true,
                title: true,
                recordingMbid: true,
                trackNo: true,
                discNumber: true,
                album: { select: { id: true, year: true, rgMbid: true } },
            },
            orderBy: [{ album: { year: { sort: "desc", nulls: "last" } } }, { albumId: "asc" }, { discNumber: "asc" }, { trackNo: "asc" }, { id: "asc" }],
        }),
        playCounts(args.userId, { song: playable }),
        globalRanking(args, deadlineMs),
    ]);
    const plays = new Map(listens.map((l) => [l.trackId, l.plays]));
    const byId = new Map<string, OwnedSong>(owned.map((t) => [t.id, t]));
    const byMbid = new Map<string, OwnedSong>();
    const byTitle = new Map<string, OwnedSong>();
    const byBareTitle = new Map<string, OwnedSong>();
    for (const t of owned) {
        if (t.recordingMbid && !byMbid.has(t.recordingMbid)) byMbid.set(t.recordingMbid, t);
        const full = fullTitle(t.title);
        if (full && !byTitle.has(full)) byTitle.set(full, t);
        const bare = bareTitle(t.title);
        if (bare && !byBareTitle.has(bare)) byBareTitle.set(bare, t);
    }

    const listed = new Set<string>();
    const list: PopularSong[] = [];
    const ownedSong = (t: OwnedSong, source: PopularSource, extra: Partial<PopularSong>): PopularSong => ({
        trackId: t.id,
        title: t.title,
        source,
        playCount: 0,
        listeners: 0,
        userPlayCount: plays.get(t.id) ?? 0,
        preview: null,
        ...extra,
    });

    // 1. Global popularity. Two ranked rows can join to one owned song (a radio edit and the album cut): the higher stays.
    const previewed = new Set<string>();
    for (const r of ranked) {
        const song = byMbid.get(r.key) ?? byTitle.get(fullTitle(r.title)) ?? byBareTitle.get(bareTitle(r.title));
        if (song) {
            if (listed.has(song.id)) continue;
            listed.add(song.id);
            list.push(ownedSong(song, "global", { playCount: r.playCount, listeners: r.listeners }));
        } else if (args.previews && !previewed.has(r.key)) {
            previewed.add(r.key);
            list.push({
                trackId: null,
                title: r.title,
                source: "global",
                playCount: r.playCount,
                listeners: r.listeners,
                userPlayCount: 0,
                preview: {
                    key: r.key,
                    previewUrl: r.previewUrl ?? null,
                    albumTitle: r.albumTitle ?? null,
                    coverUrl: r.coverUrl ?? null,
                    durationMs: r.durationMs ?? 0,
                },
            });
        }
    }

    // 2. This person's own plays.
    for (const l of listens) {
        const song = byId.get(l.trackId);
        if (!song || listed.has(song.id)) continue;
        listed.add(song.id);
        list.push(ownedSong(song, "own", { playCount: l.plays }));
    }

    // 3. First-release date, only asked for when the first two tiers left room.
    if (list.length < args.limit) {
        const rest = owned.filter((t) => !listed.has(t.id));
        if (rest.length > 0) {
            const dates = await releaseDates(args.artist.mbid, deadlineMs);
            const dated = rest.map((t) => {
                const date = dates.get(t.album.rgMbid) ?? (t.album.year ? `${t.album.year}-01-01` : null);
                return { t, date };
            });
            dated.sort(
                (a, b) =>
                    (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
                    a.t.album.id.localeCompare(b.t.album.id) ||
                    (a.t.discNumber ?? 1) - (b.t.discNumber ?? 1) ||
                    (a.t.trackNo ?? Number.MAX_SAFE_INTEGER) - (b.t.trackNo ?? Number.MAX_SAFE_INTEGER) ||
                    a.t.id.localeCompare(b.t.id),
            );
            for (const { t, date } of dated) list.push(ownedSong(t, "release", { releaseDate: date }));
        }
    }

    return list.slice(0, args.limit);
}
