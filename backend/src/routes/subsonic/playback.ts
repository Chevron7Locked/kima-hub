import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { ListenSource, Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { isFileGone } from "../../utils/errors";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { getAudioStreamingService } from "../../services/audioStreaming";
import { config } from "../../config";
import { firstArtistGenre, mapSong, serveFromTranscodeParams, type SubsonicServe, wrap } from "./mappers";
import { planSubsonicSong } from "./streamPlan";
import { normalizeArtistName } from "../../services/artistIdentity";
import { accentBlind, containsAccentBlindSql } from "../../services/textMatch";
import { sameName } from "../../services/discovery/discoverEvidence";
import { resolveWithinMusicRoot } from "../library/trackPath";
import { coverFileForSize, resolveInCoversDir } from "../../services/imageStorage";
import { sendStoredFile } from "../../utils/sendStoredFile";
import { recordPlay } from "../../services/playRecording";
import { PLAYABLE_SONG, playableSongSql } from "../../utils/playableSong";
import { getLiveState, publicUserId, reportLive } from "../../services/liveListening";
import { one, many } from "../../utils/subsonicParams";

export const playbackRouter = Router();

type SongTrack = { mime: string | null; filePath: string | null };

/** Streams a playable song: the file as it is ("direct") or the MP3 `choose` names for it. Any other song is not found. */
async function streamTrackById(
    req: Request,
    res: Response,
    id: string,
    choose: (track: SongTrack, absolutePath: string) => Promise<"direct" | SubsonicServe> | "direct" | SubsonicServe,
) {
    const track = await prisma.track.findFirst({ where: { id, ...PLAYABLE_SONG } });
    if (!track || !track.filePath) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const absolutePath = resolveWithinMusicRoot(track.filePath);
    if (!absolutePath) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const streamingService = getAudioStreamingService(
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );

    try {
        const pick = await choose(track, absolutePath);
        const { filePath, mimeType } = pick === "direct"
            ? await streamingService.getStreamFilePath(track.id, "original", track.fileModified, absolutePath)
            : await streamingService.getStreamFilePath(track.id, pick.quality, track.fileModified, absolutePath, 0, {
                  mp3Only: pick.mp3Only,
                  keepUnderKbps: pick.capKbps ?? undefined,
              });
        await streamingService.streamFileWithRangeSupport(req, res, filePath, mimeType);
    } catch (err) {
        if (!isFileGone(err) || res.headersSent) throw err;
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }
}

// ===================== NOW PLAYING =====================

playbackRouter.all("/getNowPlaying.view", wrap(async (req, res) => {
    const staleCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const states = await prisma.playbackState.findMany({
        where: {
            playbackType: "track",
            trackId: { not: null },
            updatedAt: { gte: staleCutoff },
        },
        include: {
            user: { select: { username: true } },
        },
        orderBy: { updatedAt: "desc" },
    });

    const trackIds = states
        .map((state) => state.trackId)
        .filter((trackId): trackId is string => Boolean(trackId));

    const tracks = trackIds.length > 0
        ? await prisma.track.findMany({
              where: { id: { in: trackIds }, ...PLAYABLE_SONG },
              include: {
                  album: {
                      include: {
                          artist: {
                              select: {
                                  id: true,
                                  name: true,
                                  displayName: true,
                                  genres: true,
                                  userGenres: true,
                              },
                          },
                      },
                  },
              },
          })
        : [];

    const trackById = new Map(tracks.map((track) => [track.id, track]));

    // One state per listener; the limit counts only the songs shown, so unplayable ones never crowd them out.
    const entries = states.flatMap((state) => {
        if (!state.trackId) return [];
        const track = trackById.get(state.trackId);
        if (!track) return [];

        const artistName = track.album.artist.displayName || track.album.artist.name;
        const genre = firstArtistGenre(track.album.artist.genres, track.album.artist.userGenres);
        const minutesAgo = Math.max(0, Math.floor((Date.now() - state.updatedAt.getTime()) / 60000));

        return [{
            ...mapSong(track, track.album, artistName, track.album.artist.id, genre),
            "@_username": state.user.username,
            "@_minutesAgo": minutesAgo,
            "@_playerName": "Kima",
            "@_playerId": 0,
        }];
    });

    const shown = entries.slice(0, 50);
    return subsonicOk(req, res, {
        nowPlaying: shown.length > 0 ? { entry: shown } : {},
    });
}));

// ===================== STREAMING =====================

playbackRouter.all(["/hls.view", "/hls.m3u8"], wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const streamParams = new URLSearchParams();
    streamParams.set("id", id);

    const firstBitRate = one(req, "bitRate");
    if (firstBitRate?.trim()) {
        const numeric = firstBitRate.split("@")[0];
        streamParams.set("maxBitRate", numeric);
    }

    for (const passthroughKey of ["u", "p", "t", "s", "v", "c", "f", "apiKey"]) {
        const value = one(req, passthroughKey);
        if (value) {
            streamParams.set(passthroughKey, value);
        }
    }

    const streamUrl = `${req.protocol}://${req.get("host")}/rest/stream.view?${streamParams.toString()}`;
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:-1,${id}\n${streamUrl}\n`;

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(playlist);
}));

playbackRouter.all("/getTranscodeStream.view", wrap(async (req, res) => {
    const mediaId = one(req, "mediaId");
    const mediaType = one(req, "mediaType")?.toLowerCase();
    const transcodeParams = one(req, "transcodeParams");

    if (!mediaId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaId");
    }
    if (!mediaType) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaType");
    }
    if (!transcodeParams) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: transcodeParams");
    }

    if (mediaType === "song") {
        const serve = serveFromTranscodeParams(transcodeParams);
        if (!serve) {
            return subsonicError(req, res, SubsonicError.GENERIC, "Invalid transcodeParams: ask getTranscodeDecision again");
        }
        return streamTrackById(req, res, mediaId, () => serve);
    }

    if (mediaType === "podcast") {
        const episode = await prisma.podcastEpisode.findUnique({
            where: { id: mediaId },
            select: { audioUrl: true },
        });
        if (!episode?.audioUrl) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Podcast episode not found");
        }
        return res.redirect(302, episode.audioUrl);
    }

    return subsonicError(req, res, SubsonicError.GENERIC, "Unsupported mediaType");
}));

playbackRouter.all("/stream.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    // The same rule as getTranscodeDecision (planSubsonicSong). A refusal is not an error here: older clients send a
    // format by habit and expect a stream, so they get what no format would have given them, and under a cap below
    // Kima's smallest MP3 they get that smallest one.
    const format = one(req, "format");
    const maxBitRate = one(req, "maxBitRate");
    const choose = async (track: SongTrack, absolutePath: string): Promise<"direct" | SubsonicServe> => {
        let plan = await planSubsonicSong(format, maxBitRate, track, absolutePath);
        if ("refused" in plan) plan = await planSubsonicSong(undefined, maxBitRate, track, absolutePath);
        if ("refused" in plan) return { quality: "low", mp3Only: false, capKbps: null };
        return plan.direct ? "direct" : plan.serve;
    };

    // Play logging is handled exclusively by scrobble.view to avoid double-counting.
    // Subsonic clients call scrobble.view on track completion; logging here would produce
    // two Play rows per listen for clients that implement both behaviors (Symfonium, DSub).

    await streamTrackById(req, res, id, choose);
}));

playbackRouter.all("/download.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    return streamTrackById(req, res, id, () => "direct");
}));

// ===================== COVER ART =====================

playbackRouter.all("/getCoverArt.view", wrap(async (req, res) => {
    const rawId = one(req, "id");
    if (!rawId) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    // Strip client-applied prefixes (ar-, al-, tr-)
    const id = rawId.replace(/^(ar-|al-|tr-)/, "");

    let coverUrl: string | null = null;

    // Clients send any prefix for any entity, so try album, artist and track in
    // turn; `ar-` skips the album lookup.
    if (!rawId.startsWith("ar-")) {
        const album = await prisma.album.findUnique({
            where: { id },
            select: { coverUrl: true, userCoverUrl: true },
        });
        if (album) {
            coverUrl = album.userCoverUrl || album.coverUrl;
        }
    }

    // Try artist
    if (!coverUrl) {
        const artist = await prisma.artist.findUnique({
            where: { id },
            select: { heroUrl: true },
        });
        if (artist) {
            coverUrl = artist.heroUrl;
        }
    }

    // Try track's album as last resort
    if (!coverUrl) {
        const track = await prisma.track.findUnique({
            where: { id },
            include: { album: { select: { coverUrl: true, userCoverUrl: true } } },
        });
        if (track?.album) {
            coverUrl = track.album.userCoverUrl || track.album.coverUrl;
        }
    }

    if (!coverUrl) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art not found");
    }

    // External URLs are publicly accessible — redirect directly
    if (coverUrl.startsWith("http://") || coverUrl.startsWith("https://")) {
        return res.redirect(302, coverUrl);
    }

    // Native paths use "native:" prefix; resolve against the covers cache directory
    if (coverUrl.startsWith("native:")) {
        const nativePath = coverUrl.slice("native:".length);
        if (!nativePath) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art not found");
        }

        const resolvedPath = resolveInCoversDir(nativePath);
        if (!resolvedPath) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art not found");
        }

        if (!fs.existsSync(resolvedPath)) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art file not found");
        }

        // `size` is the width to scale to (Subsonic spec), within the limits the web cover route holds to; without
        // one, or outside them, the stored file is sent whole. A scaled copy is always a JPEG.
        const file = await coverFileForSize(resolvedPath, nativePath, one(req, "size"));

        const ext = path.extname(file).toLowerCase();
        const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const headers = { "Content-Type": contentType, "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" };
        return sendStoredFile(res, file, { headers }, () => void subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art file not found"));
    }

    // Unknown URL format — redirect as a last resort
    return res.redirect(302, coverUrl);
}));

// ===================== SCROBBLE =====================

playbackRouter.all("/scrobble.view", wrap(async (req, res) => {
    // A client may send several plays at once: `id` repeated, each with its own `time` in the same order.
    // Paired by position before blanks go, so a blank id or time never moves a later play onto the wrong time.
    const times = many(req, "time", { keepBlank: true });
    const plays = many(req, "id", { keepBlank: true })
        .map((id, i) => ({ id, time: times[i] }))
        .filter((p) => p.id !== "");
    const ids = plays.map((p) => p.id);
    if (ids.length === 0) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const userId = req.user!.id;
    // submission=false is "now playing": it starts the public live trip, never a play.
    const submission = one(req, "submission") !== "false";

    // Only a playable song can have been played here; any other is answered ok and not recorded, since a client
    // that saw an error would retry it.
    const durations = new Map(
        (
            await prisma.track.findMany({ where: { id: { in: ids }, ...PLAYABLE_SONG }, select: { id: true, duration: true } })
        ).map((t) => [t.id, t.duration]),
    );

    const nowPlaying = ids[ids.length - 1];
    const duration = durations.get(nowPlaying);
    if (!submission && duration !== undefined && config.publicVibe && userId === (await publicUserId())) {
        // A repeat "now playing" for the current track is a resume, not a restart.
        const live = getLiveState();
        const position = live.trackId === nowPlaying && live.status !== "stopped" ? live.position : 0;
        reportLive({ status: "playing", trackId: nowPlaying, position, duration: duration * 1000, queue: [] });
    }

    if (submission) {
        for (const { id, time } of plays) {
            if (!durations.has(id)) continue;
            // A client's scrobble counts as played (client-attested); the 30-second
            // floor and the duplicate window in playRecording.ts still apply.
            // `time` is epoch milliseconds: a value that is not a whole number above zero is no time at all, and a
            // client's clock can run ahead, so a play is never dated after now.
            const now = Date.now();
            const timeMs = time !== undefined && /^\d+$/.test(time) ? Number(time) : 0;
            const playedAt = new Date(timeMs > 0 ? Math.min(timeMs, now) : now);
            await recordPlay({
                userId,
                trackId: id,
                clientAttestedComplete: true,
                source: ListenSource.SUBSONIC,
                playedAt,
            }).catch((err: unknown) => logger.warn("[Subsonic] scrobble play-log failed:", err));
        }
    }

    return subsonicOk(req, res);
}));
// savePlayQueue.view / getPlayQueue.view live in queue.ts.


// ===================== BOOKMARKS =====================

playbackRouter.all("/getBookmarks.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const bookmarks = await prisma.subsonicBookmark.findMany({
        where: { userId, track: PLAYABLE_SONG },
        include: { track: { include: { album: { include: { artist: true } } } } },
    });

    const bookmarkEntries = bookmarks.map((b) => {
        const track = b.track;
        const album = track.album;
        const artist = album.artist;
        return {
            "@_position": b.position,
            "@_username": req.user!.username,
            "@_comment": b.comment || undefined,
            "@_created": b.created.toISOString(),
            "@_changed": b.changed.toISOString(),
            entry: mapSong(
                track,
                album,
                artist.displayName || artist.name,
                artist.id,
                firstArtistGenre(artist.genres, artist.userGenres),
            ),
        };
    });

    return subsonicOk(req, res, {
        bookmarks: bookmarkEntries.length ? { bookmark: bookmarkEntries } : {},
    });
}));

playbackRouter.all("/createBookmark.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const id = one(req, "id");
    const positionRaw = one(req, "position");
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    if (positionRaw === undefined || positionRaw === "") {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: position");
    }

    const position = parseInt(positionRaw, 10);
    if (isNaN(position)) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Invalid parameter: position");
    }

    const comment = one(req, "comment") || undefined;

    if (!(await prisma.track.findFirst({ where: { id, ...PLAYABLE_SONG }, select: { id: true } }))) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    await prisma.subsonicBookmark.upsert({
        where: { userId_trackId: { userId, trackId: id } },
        create: { userId, trackId: id, position, comment: comment ?? null },
        update: { position, comment: comment ?? null, changed: new Date() },
    });

    return subsonicOk(req, res);
}));

playbackRouter.all("/deleteBookmark.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const id = one(req, "id");
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    await prisma.subsonicBookmark.deleteMany({
        where: { userId, trackId: id },
    });

    return subsonicOk(req, res);
}));

// ===================== LYRICS =====================

/** The most songs one getLyrics weighs: those spelled exactly as asked first, then those with lyrics, then the smallest ids. */
const LYRICS_CANDIDATES_MAX = 200;

playbackRouter.all("/getLyrics.view", wrap(async (req, res) => {
    const artist = one(req, "artist")?.trim();
    const title = one(req, "title")?.trim();

    if (!artist && !title) {
        return subsonicOk(req, res, { lyrics: {} });
    }

    // The artist is matched whole, by the name the file carries or the name shown (the two a search finds it by).
    let artistIds: string[] | undefined;
    if (artist) {
        const wanted = normalizeArtistName(artist);
        const named = await prisma.artist.findMany({
            where: { OR: [{ normalizedName: wanted }, { displayName: { not: null } }] },
            select: { id: true, normalizedName: true, displayName: true },
        });
        artistIds = named
            .filter((a) => a.normalizedName === wanted || normalizeArtistName(a.displayName) === wanted)
            .map((a) => a.id);
        if (artistIds.length === 0) return subsonicOk(req, res, { lyrics: {} });
    }

    // The title is matched as part of the title shown or of the file's, in any letter case and any script, with or
    // without accents ("cafe" finds "Café").
    const hits = await prisma.$queryRaw<{ id: string; title: string; displayTitle: string | null; hasLyrics: boolean }[]>`
        SELECT t.id, t.title, t."displayTitle", (tl.track_id IS NOT NULL) AS "hasLyrics"
          FROM "Track" t JOIN "Album" al ON al.id = t."albumId" LEFT JOIN track_lyrics tl ON tl.track_id = t.id
         WHERE ${playableSongSql("t", "al")}
           ${title ? Prisma.sql`AND ${containsAccentBlindSql([Prisma.sql`t.title`, Prisma.sql`t."displayTitle"`], title)}` : Prisma.empty}
           ${artistIds ? Prisma.sql`AND al."artistId" = ANY(${artistIds}::text[])` : Prisma.empty}
         ORDER BY ${title ? Prisma.sql`(lower(unaccent(t.title)) = ${accentBlind(title)} OR lower(unaccent(t."displayTitle")) = ${accentBlind(title)}) DESC,` : Prisma.empty}
                  (tl.track_id IS NOT NULL) DESC, t.id LIMIT ${LYRICS_CANDIDATES_MAX}`;

    // The best match: a song whose title, as shown or in the file, is the one asked for (the same name as far as case,
    // accents and apostrophes go) before one that only holds it ("tune" is not "tune extended"), then one with lyrics,
    // then the smallest id. Lyrics never come from a song other than the best match, so an exact song with none answers
    // empty rather than another song's words.
    const exact = (t: { title: string; displayTitle: string | null }) =>
        title ? sameName(t.displayTitle, title) || sameName(t.title, title) : false;
    const [best] = hits.sort(
        (x, y) =>
            Number(exact(y)) - Number(exact(x)) ||
            Number(y.hasLyrics) - Number(x.hasLyrics) ||
            (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    if (!best?.hasLyrics) return subsonicOk(req, res, { lyrics: {} });

    const track = await prisma.track.findUnique({
        where: { id: best.id },
        include: { trackLyrics: true, album: { include: { artist: true } } },
    });

    if (!track?.trackLyrics) {
        return subsonicOk(req, res, { lyrics: {} });
    }

    const lyricsText = track.trackLyrics.plain_lyrics || track.trackLyrics.synced_lyrics || undefined;
    const result: Record<string, unknown> = {
        // Prefer the user-facing name, matching every other Subsonic mapper.
        "@_artist": track.album.artist.displayName || track.album.artist.name,
        "@_title": track.displayTitle || track.title,
    };
    if (lyricsText) {
        result["#text"] = lyricsText;
    }

    return subsonicOk(req, res, { lyrics: result });
}));
