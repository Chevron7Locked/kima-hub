/**
 * A synthetic music library for integration tests that need "the whole set" to
 * differ from "the first rows": 3,000 tracks over 500 albums and 125 artists,
 * written to the real test database with a fixed random seed, so every run
 * builds the same library.
 *
 * Track ids run `<prefix>trk_00000` .. `<prefix>trk_02999` and are handed out in
 * order of ENERGY (lowest first). A query that reads "the first N rows" would
 * therefore see only the quietest tracks, and any energy-based clause would
 * show a first-rows bias as ids bunched at the front of the range. Every other
 * reading (valence, arousal, bpm, danceability, acousticness, instrumentalness)
 * is independent of the id.
 *
 * Shape of the data (all fractions are of tracks unless noted):
 *   - 3% have a file missing (missingSince set), 3% are corrupt, 4% are still
 *     analysisStatus "pending" (readings present, status not completed), and 2%
 *     are "completed" with every reading null.
 *   - 1-3 genres per track from a 56-name list (Genre/TrackGenre tables); each
 *     artist has 1-3 genres in Artist.genres (10% also userGenres); each album
 *     has 1-2 in Album.genres.
 *   - album years 1960-2024 (originalYear missing on 30% of albums); 4% of
 *     albums are DISCOVER, not LIBRARY.
 *   - two users. user1 plays 25 tracks (none with a missing file) 40..16 times
 *     (distinct counts, so the top 20 is unambiguous), 3 plays on 5% of tracks, 1-2 plays on 25%. user2
 *     plays 35% of tracks 1-8 times.
 *
 * `seedSyntheticMoods` adds learned mood scores and tempo confidence on top, from a seed of its own.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { MOODS, MOOD_HEADS } from "../../services/moods/heads";

export const TRACK_COUNT = 3000;
const ALBUM_COUNT = 500;
const TRACKS_PER_ALBUM = TRACK_COUNT / ALBUM_COUNT;
const ARTIST_COUNT = 125;

export const PARTY_GENRES = [
    "dance", "electronic", "pop", "disco", "house", "techno", "edm", "funk", "electro",
    "dance pop", "club", "eurodance", "trance", "dubstep", "drum and bass", "hip hop",
];
export const WORKOUT_GENRES = [
    "rock", "metal", "hard rock", "alternative rock", "punk", "hip hop", "rap", "trap", "hardcore",
    "metalcore", "industrial", "drum and bass", "hardstyle", "nu metal", "electronic", "edm", "house",
    "techno", "pop punk", "dubstep",
];
export const FOCUS_GENRES = [
    "classical", "instrumental", "jazz", "piano", "ambient", "post-rock", "math rock", "soundtrack", "score",
    "contemporary classical", "minimal", "modern classical", "neoclassical",
];
const OTHER_GENRES = [
    "folk", "blues", "soul", "country", "reggae", "latin", "indie", "alternative", "singer-songwriter", "acoustic",
    "ballad", "k-pop", "gospel", "ska",
];
/** Stored names; a few are capitalised on purpose, since every genre lookup is case-insensitive. */
const CAPITALISED: Record<string, string> = { "hip hop": "Hip Hop", edm: "EDM", "drum and bass": "Drum and Bass" };
export const GENRE_NAMES = [
    ...new Set([...PARTY_GENRES, ...WORKOUT_GENRES, ...FOCUS_GENRES, ...OTHER_GENRES]),
].map((g) => CAPITALISED[g] ?? g);

const MOOD_TAGS = [
    "energetic", "upbeat", "happy", "aggressive", "dark", "intense", "sad", "melancholic", "calm", "workout",
    "powerful", "moody", "atmospheric",
];
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function mulberry32(seed: number) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>, size = 1000) {
    for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

export interface LibraryHandle {
    prefix: string;
    user1: string;
    user2: string;
}

export const trackId = (prefix: string, i: number) => `${prefix}trk_${String(i).padStart(5, "0")}`;

/** Writes the library under `prefix`. Call `removeSyntheticLibrary(prefix)` when done. */
export async function seedSyntheticLibrary(prefix: string): Promise<LibraryHandle> {
    await removeSyntheticLibrary(prefix);
    const rng = mulberry32(20261021);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
    const subset = <T,>(xs: T[], min: number, max: number) => {
        const n = min + Math.floor(rng() * (max - min + 1));
        const pool = [...xs];
        const out: T[] = [];
        while (out.length < n && pool.length) out.push(...pool.splice(Math.floor(rng() * pool.length), 1));
        return out;
    };
    const r4 = (x: number) => Math.round(x * 10000) / 10000;

    const user1 = `${prefix}user1`;
    const user2 = `${prefix}user2`;
    await prisma.user.createMany({
        data: [user1, user2].map((id) => ({ id, username: id, passwordHash: "x" })),
    });

    // Genres: reuse a name another suite already left, remove only what this one made.
    const existing = new Set((await prisma.genre.findMany({ select: { name: true } })).map((g) => g.name));
    await prisma.genre.createMany({
        data: GENRE_NAMES.filter((n) => !existing.has(n)).map((name) => ({ id: `${prefix}gen_${name}`, name })),
    });
    const genreIdByName = new Map((await prisma.genre.findMany({ select: { id: true, name: true } })).map((g) => [g.name, g.id]));

    // Artists and albums.
    const artistRows: (Prisma.ArtistCreateManyInput & { id: string })[] = [];
    for (let a = 0; a < ARTIST_COUNT; a++) {
        const name = `Synthetic Artist ${a}`;
        artistRows.push({
            id: `${prefix}art_${a}`,
            name,
            normalizedName: name.toLowerCase(),
            identityKey: `${prefix}ak_${a}`,
            genres: subset(GENRE_NAMES.map((g) => g.toLowerCase()), 1, 3),
            userGenres: rng() < 0.1 ? subset(GENRE_NAMES.map((g) => g.toLowerCase()), 1, 2) : undefined,
        });
    }
    await prisma.artist.createMany({ data: artistRows });

    const albumRows: (Prisma.AlbumCreateManyInput & { rgMbid: string })[] = [];
    for (let b = 0; b < ALBUM_COUNT; b++) {
        const year = 1960 + Math.floor(rng() * 65);
        const hasOriginal = rng() >= 0.3;
        albumRows.push({
            id: `${prefix}alb_${b}`,
            rgMbid: `${prefix}rg_${b}`,
            artistId: `${prefix}art_${Math.floor(b / (ALBUM_COUNT / ARTIST_COUNT))}`,
            identityKey: `${prefix}ik_${b}`,
            title: `Synthetic Album ${b}`,
            primaryType: "Album",
            year,
            originalYear: hasOriginal ? (rng() < 0.2 ? year - 1 - Math.floor(rng() * 9) : year) : null,
            coverUrl: rng() < 0.8 ? `/covers/${b}.jpg` : null,
            location: rng() < 0.04 ? ("DISCOVER" as const) : ("LIBRARY" as const),
            genres: subset(GENRE_NAMES.map((g) => g.toLowerCase()), 1, 2),
        });
    }
    await prisma.album.createMany({ data: albumRows });
    await prisma.ownedAlbum.createMany({
        data: artistRows.map((a, i) => ({ artistId: a.id, rgMbid: albumRows[i * (ALBUM_COUNT / ARTIST_COUNT)].rgMbid, source: "test" })),
    });
    // Artist i is similar to the ten artists after it.
    const similar: Prisma.SimilarArtistCreateManyInput[] = [];
    for (let a = 0; a < 40; a++)
        for (let k = 1; k <= 10; k++)
            similar.push({ fromArtistId: `${prefix}art_${a}`, toArtistId: `${prefix}art_${a + k}`, weight: 1 - k / 20 });
    await prisma.similarArtist.createMany({ data: similar });

    // Raw tracks, then ids handed out in energy order.
    const albumOrder = Array.from({ length: TRACK_COUNT }, (_, i) => i);
    for (let i = albumOrder.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [albumOrder[i], albumOrder[j]] = [albumOrder[j], albumOrder[i]];
    }
    type Raw = Record<string, any>;
    const raws: Raw[] = [];
    for (let i = 0; i < TRACK_COUNT; i++) {
        const kind = rng();
        const nullReadings = kind >= 0.07 && kind < 0.09;
        const energy = r4(rng());
        raws.push({
            energy: nullReadings ? null : energy,
            sortEnergy: energy,
            valence: nullReadings ? null : r4(rng()),
            arousal: nullReadings ? null : r4(rng()),
            danceability: nullReadings ? null : r4(rng()),
            acousticness: nullReadings ? null : r4(rng()),
            instrumentalness: nullReadings ? null : r4(rng()),
            bpm: nullReadings ? null : Math.round((60 + rng() * 120) * 10) / 10,
            keyScale: nullReadings ? null : rng() < 0.45 ? "minor" : "major",
            key: nullReadings ? null : pick(KEYS),
            moodTags: nullReadings ? [] : MOOD_TAGS.filter(() => rng() < 0.12),
            analysisMode: nullReadings ? null : rng() < 0.7 ? "enhanced" : "standard",
            analysisStatus: kind < 0.04 ? "pending" : "completed",
            missing: kind >= 0.09 && kind < 0.12,
            corrupt: kind >= 0.12 && kind < 0.15,
        });
    }
    raws.sort((a, b) => a.sortEnergy - b.sortEnergy);

    const trackRows = raws.map((r, i) => {
        const albumIdx = Math.floor(albumOrder[i] / TRACKS_PER_ALBUM);
        return {
            id: trackId(prefix, i),
            albumId: `${prefix}alb_${albumIdx}`,
            title: `Synthetic Track ${i}`,
            trackNo: (albumOrder[i] % TRACKS_PER_ALBUM) + 1,
            duration: 200,
            filePath: `/tmp/${prefix}${i}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            energy: r.energy,
            valence: r.valence,
            arousal: r.arousal,
            danceability: r.danceability,
            acousticness: r.acousticness,
            instrumentalness: r.instrumentalness,
            bpm: r.bpm,
            keyScale: r.keyScale,
            key: r.key,
            moodTags: r.moodTags,
            analysisMode: r.analysisMode,
            analysisStatus: r.analysisStatus,
            missingSince: r.missing ? new Date() : null,
            corrupt: r.corrupt,
        };
    });
    await inChunks(trackRows, (data) => prisma.track.createMany({ data }));

    const trackGenres: Prisma.TrackGenreCreateManyInput[] = [];
    for (const t of trackRows) {
        for (const g of subset(GENRE_NAMES, 1, 3)) trackGenres.push({ trackId: t.id, genreId: genreIdByName.get(g)! });
    }
    await inChunks(trackGenres, (data) => prisma.trackGenre.createMany({ data }));

    // Plays.
    const plays: { userId: string; trackId: string }[] = [];
    const addPlays = (userId: string, id: string, n: number) => {
        for (let k = 0; k < n; k++) plays.push({ userId, trackId: id });
    };
    const top = new Set<number>();
    while (top.size < 25) {
        const idx = Math.floor(rng() * TRACK_COUNT);
        if (!trackRows[idx].missingSince) top.add(idx);
    }
    [...top].forEach((idx, rank) => addPlays(user1, trackId(prefix, idx), 40 - rank));
    for (let i = 0; i < TRACK_COUNT; i++) {
        if (!top.has(i)) {
            const u = rng();
            if (u < 0.05) addPlays(user1, trackId(prefix, i), 3);
            else if (u < 0.3) addPlays(user1, trackId(prefix, i), 1 + Math.floor(rng() * 2));
        }
        if (rng() < 0.35) addPlays(user2, trackId(prefix, i), 1 + Math.floor(rng() * 8));
    }
    await inChunks(plays, (data) => prisma.play.createMany({ data }));

    return { prefix, user1, user2 };
}

/**
 * Gives every track under `prefix` a sound vector of the mood heads' model, its 22 learned mood scores (independent
 * normal logits, mean -1, SD 1.5) and a tempo confidence (uniform 0-4, none on a tenth of tracks), from a seed of its
 * own so `seedSyntheticLibrary`'s readings stay as they are. The library's mood statistics are left to the caller.
 */
export async function seedSyntheticMoods(prefix: string): Promise<void> {
    const rng = mulberry32(20261024);
    const gaussian = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    const ids = Array.from({ length: TRACK_COUNT }, (_, i) => trackId(prefix, i));
    const analyzedAt = new Date("2026-10-23T00:00:00Z");
    const unit = `[1${",0".repeat(MOOD_HEADS.dims - 1)}]`;
    await prisma.$executeRaw`
        INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
        SELECT id, ${unit}::vector, ${MOOD_HEADS.model}, ${analyzedAt} FROM unnest(${ids}::text[]) AS id
    `;
    const rows = ids.map((id) => ({
        track_id: id,
        embedded_at: analyzedAt,
        weights: MOOD_HEADS.version,
        ...Object.fromEntries(MOODS.map((mood) => [mood, r4(-1 + 1.5 * gaussian())])),
    })) as Prisma.TrackMoodCreateManyInput[];
    await inChunks(rows, (data) => prisma.trackMood.createMany({ data }));
    const confidence = ids.map(() => (rng() < 0.1 ? null : r4(4 * rng())));
    await prisma.$executeRaw`
        UPDATE "Track" t SET "bpmConfidence" = c.confidence
        FROM unnest(${ids}::text[], ${confidence}::float8[]) AS c(id, confidence)
        WHERE t.id = c.id
    `;
}

/** Removes everything `seedSyntheticLibrary(prefix)` wrote (and nothing else). */
export async function removeSyntheticLibrary(prefix: string) {
    await prisma.play.deleteMany({ where: { userId: { startsWith: prefix } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.genre.deleteMany({ where: { id: { startsWith: prefix } } });
}

/** One track as stored, with the things a clause is written against. */
export interface Row {
    id: string;
    missingSince: Date | null;
    corrupt: boolean;
    analysisStatus: string;
    analysisMode: string | null;
    energy: number | null;
    valence: number | null;
    arousal: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    bpm: number | null;
    /** Set only by `seedSyntheticMoods`. */
    bpmConfidence: number | null;
    key: string | null;
    keyScale: string | null;
    moodTags: string[];
    album: {
        id: string;
        artistId: string;
        year: number | null;
        originalYear: number | null;
        location: string;
        artist: { id: string; name: string; normalizedName: string; genres: unknown; userGenres: unknown };
    };
    /** Names from the Genre/TrackGenre tables. */
    genreNames: string[];
    genreIds: string[];
    /** Plays by every user / by user1. */
    plays: number;
    playsUser1: number;
}

/** Every stored track under `prefix`, in id order, read back from the database. */
export async function loadRows(prefix: string, user1: string): Promise<Row[]> {
    const tracks = await prisma.track.findMany({
        where: { id: { startsWith: prefix } },
        orderBy: { id: "asc" },
        include: {
            album: { include: { artist: true } },
            trackGenres: { include: { genre: true } },
            _count: { select: { plays: true } },
        },
    });
    const byUser1 = await prisma.play.groupBy({ by: ["trackId"], where: { userId: user1 }, _count: { trackId: true } });
    const u1 = new Map(byUser1.map((p) => [p.trackId, p._count.trackId]));
    return tracks.map((t) => ({
        id: t.id,
        missingSince: t.missingSince,
        corrupt: t.corrupt,
        analysisStatus: t.analysisStatus,
        analysisMode: t.analysisMode,
        energy: t.energy,
        valence: t.valence,
        arousal: t.arousal,
        danceability: t.danceability,
        acousticness: t.acousticness,
        instrumentalness: t.instrumentalness,
        bpm: t.bpm,
        bpmConfidence: t.bpmConfidence,
        key: t.key,
        keyScale: t.keyScale,
        moodTags: t.moodTags,
        album: {
            id: t.album.id,
            artistId: t.album.artistId,
            year: t.album.year,
            originalYear: t.album.originalYear,
            location: t.album.location,
            artist: t.album.artist,
        },
        genreNames: t.trackGenres.map((g) => g.genre.name),
        genreIds: t.trackGenres.map((g) => g.genreId),
        plays: t._count.plays,
        playsUser1: u1.get(t.id) ?? 0,
    }));
}

/**
 * Where `ids` sit among `matching` (the ids that satisfy a clause, in id
 * order): the lowest and highest position as a fraction of the match, and how
 * many distinct ids there were.
 */
export function spanOf(ids: Iterable<string>, matching: string[]) {
    const pos = new Map(matching.map((id, i) => [id, i]));
    const distinct = new Set(ids);
    const at = [...distinct].map((id) => pos.get(id)).filter((p): p is number => p !== undefined);
    return {
        distinct: distinct.size,
        unknown: distinct.size - at.length,
        lowest: at.length ? Math.min(...at) / matching.length : 1,
        highest: at.length ? Math.max(...at) / matching.length : 0,
    };
}
