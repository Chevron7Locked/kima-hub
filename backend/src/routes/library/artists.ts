import { Router } from "express";
import fs from "fs";
import path from "path";
import { artistNamed, isMbid, normalizeArtistName } from "../../services/artistIdentity";
import { deleteArtists } from "../../services/library/albumDelete";
import { AlbumLocation } from "@prisma/client";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { getSimilarArtists } from "../../services/artistSimilarity";
import { musicBrainzService } from "../../services/musicbrainz";
import { lidarrService } from "../../services/lidarr";
import { dataCacheService } from "../../services/dataCache";
import {
  backfillAllArtistCounts,
  isBackfillNeeded,
  getBackfillProgress,
  isBackfillInProgress,
} from "../../services/artistCountsService";
import {
  getMergedGenres,
  getArtistDisplaySummary,
} from "../../utils/metadataOverrides";
import { safeError } from "../../utils/errors";
import { failureCause } from "../../utils/outcome";
import pLimit from "p-limit";
import { toAudioFeaturesDTO } from "../../utils/audioFeatures";
import { LINKED_OUT_REFUSAL, isBehindLinkOut, resolveWithinMusicRoot } from "./trackPath";
import { config } from "../../config";
import { parseLimit, parseOffset } from "./paging";
import { runAsRequestWork } from "../../utils/stopCheck";
import { findArtistArtwork, withAlbumArtwork } from "../../services/artwork";
import {
  CollectionFilter,
  PLAYABLE_ALBUM_WHERE,
  artistHasPlayableSongSql,
  collectionFilter,
  yourDiscoverRgMbids,
} from "../../services/libraryFilters";
import { editionlessKey } from "../../services/albumIdentity";
import { getEffectiveYear } from "../../utils/dateFilters";
import { PLAYABLE_SONG } from "../../utils/playableSong";
import { popularSongs } from "../../services/popularSongs";

/**
 * The artist list's order for `sortBy`; anything unknown sorts by name. Names sort on `sortName` (article-stripped,
 * unaccented, lowercased; indexed). The id breaks ties so pages tile.
 */
function artistOrder(sortBy: unknown): Prisma.Sql {
  if (sortBy === "name-desc") return Prisma.sql`a."sortName" DESC, a.id ASC`;
  if (sortBy === "tracks") return Prisma.sql`a."totalTrackCount" DESC, a.id ASC`;
  return Prisma.sql`a."sortName" ASC, a.id ASC`;
}

// One row of the artist list query.
type ArtistListRow = {
  id: string;
  mbid: string | null;
  name: string;
  heroUrl: string | null;
  userHeroUrl: string | null;
  libraryAlbumCount: number;
  discoveryAlbumCount: number;
  totalTrackCount: number;
};

type SimilarArtistSource = {
  name: string;
  mbid?: string | null;
  match: number;
};

// Flags each similar artist that is in the library (with its owned album count)
// and gives it an image: the library's own, else whatever findArtistArtwork finds.
export async function resolveSimilarArtists(similar: SimilarArtistSource[]) {
  // normalizeArtistName writes normalizedName and folds accents and
  // ampersands, so lowercasing alone would miss "Sigur Rós" or "Hall & Oates".
  const similarNames = similar.map((s) => normalizeArtistName(s.name));
  const similarMbids = similar
    .map((s) => s.mbid)
    .filter(Boolean) as string[];

  // A library artist is one with an album it can play; a Discover-only or emptied one is outside the library.
  const libraryMatches = await prisma.artist.findMany({
    where: {
      albums: { some: PLAYABLE_ALBUM_WHERE },
      OR: [
        { normalizedName: { in: similarNames } },
        ...(similarMbids.length > 0 ? [{ mbid: { in: similarMbids } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      normalizedName: true,
      mbid: true,
      heroUrl: true,
      _count: {
        select: {
          albums: { where: PLAYABLE_ALBUM_WHERE },
        },
      },
    },
  });

  const libraryByName = new Map(
    libraryMatches.map((a) => [a.normalizedName || normalizeArtistName(a.name), a]),
  );
  const libraryByMbid = new Map(
    libraryMatches.filter((a) => a.mbid).map((a) => [a.mbid!, a]),
  );

  const imageLimit = pLimit(3);
  return Promise.all(
    similar.map((s) => imageLimit(async () => {
      const libraryArtist =
        (s.mbid && libraryByMbid.get(s.mbid)) ||
        libraryByName.get(normalizeArtistName(s.name));

      let image = libraryArtist?.heroUrl || null;
      if (!image) {
        image =
          (await findArtistArtwork({ name: s.name, mbid: s.mbid || undefined }))
            ?.url ?? null;
      }

      return {
        id: libraryArtist?.id || s.name,
        name: s.name,
        mbid: s.mbid || null,
        coverArt: image,
        albumCount: 0,
        ownedAlbumCount: libraryArtist?._count?.albums || 0,
        weight: s.match,
        inLibrary: !!libraryArtist,
      };
    })),
  );
}

const router = Router();

/**
 * The artists the collection's "show" choice lists (collectionAlbumWhere): "owned" those with a library album that has
 * a playable song, "discovery" those with one of this listener's Discover albums and no library album, "all" either.
 */
function artistListWhereSql(show: CollectionFilter, yourDiscover: string[], query: string): Prisma.Sql {
  const library = artistHasPlayableSongSql("a");
  const discover = Prisma.sql`EXISTS (
    SELECT 1 FROM "Album" al
    WHERE al."artistId" = a.id AND al.location = 'DISCOVER' AND al."rgMbid" = ANY(${yourDiscover}::text[])
      AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = al.id)
  )`;
  const clauses: Prisma.Sql[] = [
    show === "owned"
      ? library
      : show === "discovery"
        ? Prisma.sql`(${discover} AND NOT ${library})`
        : Prisma.sql`(${library} OR ${discover})`,
  ];
  const key = normalizeArtistName(query);
  if (key) {
    clauses.push(Prisma.sql`position(${key} in a."normalizedName") > 0`);
  }
  return Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`;
}

router.get("/artists", async (req, res) => {
  try {
    const { query = "", filter = "owned", sortBy = "name" } = req.query;

    const limit = parseLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);

    const order = artistOrder(sortBy);
    const show = collectionFilter(filter);
    const yourDiscover = show === "owned" ? [] : await yourDiscoverRgMbids(req.user!.id);
    const whereSql = artistListWhereSql(show, yourDiscover, query as string);

    const [artists, countRows] = await Promise.all([
      prisma.$queryRaw<ArtistListRow[]>`
        SELECT
          a.id,
          a.mbid,
          a.name,
          a."heroUrl",
          a."userHeroUrl",
          a."libraryAlbumCount",
          a."discoveryAlbumCount",
          a."totalTrackCount"
        FROM "Artist" a
        ${whereSql}
        ORDER BY ${order}
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(*)::bigint AS total
        FROM "Artist" a
        ${whereSql}
      `,
    ]);
    const total = Number(countRows[0]?.total ?? 0);

    const imageMap = await dataCacheService.getArtistImagesBatch(
      artists.map((a) => ({
        id: a.id,
        heroUrl: a.heroUrl,
        userHeroUrl: a.userHeroUrl,
      })),
    );

    // Under "discovery" and "all" an artist's Discover albums are this listener's, not every listener's.
    const yourDiscoverCounts = new Map<string, number>();
    if (show !== "owned" && artists.length > 0) {
      const rows = await prisma.album.groupBy({
        by: ["artistId"],
        where: {
          artistId: { in: artists.map((a) => a.id) },
          location: "DISCOVER",
          rgMbid: { in: yourDiscover },
          tracks: { some: {} },
        },
        _count: { _all: true },
      });
      for (const row of rows) yourDiscoverCounts.set(row.artistId, row._count._all);
    }

    const artistsWithImages = artists.map((artist) => {
      const coverArt = imageMap.get(artist.id) || artist.heroUrl || null;

      const yours = yourDiscoverCounts.get(artist.id) ?? 0;
      const albumCount =
        show === "discovery" ? yours : show === "all" ? artist.libraryAlbumCount + yours : artist.libraryAlbumCount;

      return {
        id: artist.id,
        mbid: isMbid(artist.mbid) ? artist.mbid : null,
        name: artist.name,
        heroUrl: coverArt,
        coverArt,
        albumCount,
        trackCount: artist.totalTrackCount,
      };
    });

    res.json({
      artists: artistsWithImages,
      total,
      offset,
      limit,
    });
  } catch (error) {
    safeError(res, "Get artists", error);
  }
});

router.get("/artist-counts/status", async (_req, res) => {
  try {
    const [needsBackfill, progress] = await Promise.all([
      isBackfillNeeded(),
      getBackfillProgress(),
    ]);

    res.json({
      needsBackfill,
      ...progress,
    });
  } catch (error: any) {
    logger.error("[ArtistCounts] Status check error:", error?.message);
    res.status(500).json({ error: "Failed to check status" });
  }
});

router.post("/artist-counts/backfill", async (_req, res) => {
  try {
    // Asked during a run, the recount goes over the artists once more when it finishes, so the ask is kept.
    const queued = isBackfillInProgress();

    res.json(
      queued
        ? { message: "Backfill queued: it runs once more when the current one finishes", status: "queued" }
        : { message: "Backfill started", status: "processing" },
    );

    // Request-started work: the shutdown waits for the batch under way, and the recount stops after it.
    runAsRequestWork((stop) =>
      backfillAllArtistCounts((attempted, total) => {
        if (attempted % 100 === 0) {
          logger.debug(`[ArtistCounts] Progress: ${attempted}/${total}`);
        }
      }, stop),
    ).catch((error) => {
      logger.error("[ArtistCounts] Backfill failed:", error);
    });
  } catch (error: any) {
    logger.error("[ArtistCounts] Backfill trigger error:", error?.message);
    res.status(500).json({ error: "Failed to start backfill" });
  }
});

router.post("/backfill-genres", async (_req, res) => {
  try {
    const artistsToBackfill = await prisma.artist.findMany({
      where: {
        enrichmentStatus: "completed",
        OR: [{ genres: { equals: Prisma.DbNull } }, { genres: { equals: [] } }],
      },
      select: { id: true, name: true, mbid: true },
      take: 50,
    });

    if (artistsToBackfill.length === 0) {
      return res.json({
        message: "No artists need genre backfill",
        count: 0,
      });
    }

    const result = await prisma.artist.updateMany({
      where: {
        id: { in: artistsToBackfill.map((a) => a.id) },
      },
      data: {
        enrichmentStatus: "pending",
        lastEnriched: null,
      },
    });

    logger.info(
      `[Backfill] Reset ${result.count} artists for genre enrichment`,
    );

    res.json({
      message: `Reset ${result.count} artists for genre enrichment`,
      count: result.count,
      artists: artistsToBackfill.map((a) => a.name).slice(0, 10),
    });
  } catch (error: any) {
    logger.error("[Backfill] Genre backfill error:", error?.message);
    res.status(500).json({ error: "Failed to backfill genres" });
  }
});

/** An artist as a route names one: by id, by name (case and accents ignored) or by MusicBrainz id. */
const artistRef = (idParam: string) => ({
  OR: [{ id: idParam }, artistNamed(idParam), { mbid: idParam }],
});

// One artist's play queue, in the order clients play it as given: owned albums by year desc, then title; disc
// then track within an album (no disc tag is disc one). Only tracks it can stream.
router.get("/artists/:id/play-tracks", async (req, res) => {
  try {
    const idParam = req.params.id;

    const artist = await prisma.artist.findFirst({
      where: artistRef(idParam),
      select: {
        id: true,
        name: true,
        albums: {
          where: { location: "LIBRARY" },
          select: {
            id: true,
            title: true,
            coverUrl: true,
            displayYear: true,
            year: true,
            tracks: {
              where: PLAYABLE_SONG,
              select: {
                id: true,
                title: true,
                displayTitle: true,
                trackNo: true,
                discNumber: true,
                duration: true,
              },
            },
          },
        },
      },
    });

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    const albums = artist.albums
      .slice()
      .sort((a, b) => {
        const aYear = a.displayYear ?? a.year ?? 0;
        const bYear = b.displayYear ?? b.year ?? 0;
        return aYear !== bYear
          ? bYear - aYear
          : a.title.localeCompare(b.title);
      });

    const tracks = albums.flatMap((album) =>
      album.tracks
        .slice()
        .sort((a, b) => {
          const aDisc = a.discNumber ?? 1;
          const bDisc = b.discNumber ?? 1;
          if (aDisc !== bDisc) return aDisc - bDisc;
          return (a.trackNo ?? Number.MAX_SAFE_INTEGER) - (b.trackNo ?? Number.MAX_SAFE_INTEGER);
        })
        .map((track) => ({
          id: track.id,
          title: track.title,
          trackNo: track.trackNo,
          discNumber: track.discNumber,
          duration: track.duration,
          album: { id: album.id, title: album.title, coverArt: album.coverUrl },
          artist: { id: artist.id, name: artist.name },
        })),
    );

    res.json({ artist: { id: artist.id, name: artist.name }, tracks });
  } catch (error) {
    logger.error("Get artist play tracks error:", error);
    res.status(500).json({ error: "Failed to fetch artist play tracks" });
  }
});

router.get("/artists/:id", async (req, res) => {
  try {
    const idParam = req.params.id;

    // The page shows the artist's library albums with their playable songs; their Discover albums live in Discover.
    const artistInclude = {
      albums: {
        where: { location: AlbumLocation.LIBRARY },
        orderBy: { year: Prisma.SortOrder.desc },
        include: {
          tracks: {
            where: PLAYABLE_SONG,
            orderBy: { trackNo: Prisma.SortOrder.asc },
            include: {
              album: {
                select: {
                  id: true,
                  title: true,
                  coverUrl: true,
                },
              },
            },
          },
        },
      },
      ownedAlbums: true,
    };

    const artist = await prisma.artist.findFirst({
      where: artistRef(idParam),
      include: artistInclude,
    });

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    let albumsWithOwnership = [];
    const ownedRgMbids = new Set(artist.ownedAlbums.map((o) => o.rgMbid));

    // An album with no playable song has nothing to show or play, so the page leaves it out; it still counts as the
    // library's below, so its MusicBrainz copy is not offered as one to get.
    const libraryAlbums = artist.albums;
    // The id belongs to enrichment; a page view never searches for or stores one.
    const dbAlbums = libraryAlbums.filter((album) => album.tracks.length > 0).map((album) => ({
      ...album,
      tracks: album.tracks.map((t) => ({
        ...t,
        audioFeatures: toAudioFeaturesDTO(t),
      })),
      owned: true,
      coverArt: album.coverUrl,
      source: "database" as const,
    }));

    // Inline guard, not a boolean intermediate: the type predicate has to be in
    // the condition for the id to narrow to string inside the block.
    if (isMbid(artist.mbid)) {
      try {
        const discoCacheKey = `discography:${artist.mbid}`;
        let releaseGroups: any[] = [];

        const cachedDisco = await redisClient.get(discoCacheKey);
        if (cachedDisco && cachedDisco !== "NOT_FOUND") {
          releaseGroups = JSON.parse(cachedDisco);
        } else {
          const fetched = await musicBrainzService.getReleaseGroups(
            artist.mbid,
            ["album", "ep"],
            100,
            { interactive: true },
          );
          if (fetched.kind === "answered") {
            releaseGroups = fetched.value;
            await redisClient.setex(
              discoCacheKey,
              24 * 60 * 60,
              JSON.stringify(releaseGroups),
            );
          } else if (fetched.kind !== "absent") {
            // An artist MusicBrainz has no albums for shows the database's. A failed question is not "no
            // discography": the catch below serves database albums and logs the real cause.
            throw new Error(
              `Discography lookup ${fetched.kind}: ${failureCause(fetched)}`,
            );
          }
        }

        const excludedSecondaryTypes = [
          "Live",
          "Compilation",
          "Soundtrack",
          "Remix",
          "DJ-mix",
          "Mixtape/Street",
          "Demo",
          "Interview",
          "Audio drama",
          "Audiobook",
          "Spokenword",
        ];

        const filteredReleaseGroups = releaseGroups.filter((rg: any) => {
          if (!rg["secondary-types"] || rg["secondary-types"].length === 0) {
            return true;
          }
          return !rg["secondary-types"].some((type: string) =>
            excludedSecondaryTypes.includes(type),
          );
        });

        const mbAlbums = filteredReleaseGroups.map((rg: any) => ({
          id: rg.id,
          rgMbid: rg.id,
          title: rg.title,
          year: rg["first-release-date"]
            ? parseInt(rg["first-release-date"].substring(0, 4))
            : null,
          type: rg["primary-type"],
          coverUrl: null as string | null,
          coverArt: null as string | null,
          artistId: artist.id,
          owned: ownedRgMbids.has(rg.id),
          trackCount: 0,
          tracks: [],
          source: "musicbrainz" as const,
        }));

        const inLibrary = new Set(libraryAlbums.map((a) => a.rgMbid).filter(Boolean));
        const inLibraryTitles = new Set(libraryAlbums.map((a) => editionlessKey(a.title)));
        const mbAlbumsFiltered = await withAlbumArtwork(
          mbAlbums.filter((a) => !inLibrary.has(a.rgMbid) && !inLibraryTitles.has(editionlessKey(a.title))),
          (album) => ({ rgMbid: album.rgMbid, artistName: artist.name, albumTitle: album.title }),
          (album, coverUrl) => ({ ...album, coverUrl, coverArt: coverUrl }),
        );

        albumsWithOwnership = [...dbAlbums, ...mbAlbumsFiltered];

      } catch (error) {
        logger.error(`Failed to fetch MusicBrainz discography:`, error);
        albumsWithOwnership = dbAlbums;
      }
    } else {
      albumsWithOwnership = dbAlbums;
    }

    const allTracks = artist.albums.flatMap((a) => a.tracks);

    // The popular songs are the popular-songs module's answer, with a preview for each ranked song the library lacks.
    const trackById = new Map(allTracks.map((t) => [t.id, t]));
    const popular = await popularSongs({
      artist: { id: artist.id, name: artist.name, mbid: artist.mbid },
      userId: req.user!.id,
      limit: 10,
      previews: true,
    });
    const topTracks = popular.flatMap((song): object[] => {
      const popularitySource = song.source === "global" ? { popularitySource: "global" } : {};
      if (song.trackId === null) {
        const preview = song.preview!;
        return [
          {
            id: `dz:${preview.key}`,
            title: song.title,
            duration: Math.round(preview.durationMs / 1000),
            playCount: song.playCount,
            listeners: song.listeners,
            userPlayCount: 0,
            ...popularitySource,
            previewUrl: preview.previewUrl,
            album: {
              id: null,
              title: preview.albumTitle || "Unknown Album",
              coverUrl: preview.coverUrl,
              coverArt: preview.coverUrl,
            },
          },
        ];
      }
      const track = trackById.get(song.trackId);
      if (!track) return [];
      return [
        {
          ...track,
          playCount: song.playCount,
          listeners: song.listeners,
          userPlayCount: song.userPlayCount,
          ...popularitySource,
          ...(song.source === "release" ? { releaseDate: song.releaseDate } : {}),
          album: { ...track.album, coverArt: track.album.coverUrl },
        },
      ];
    });

    const heroUrl = await dataCacheService.getArtistImage(
      artist.id,
      artist.name,
      artist.mbid,
    );

    let similarArtists: any[] = [];
    const similarCacheKey = `similar-artists-list:${artist.id}`;

    const enrichedSimilar = artist.similarArtistsJson as Array<{
      name: string;
      mbid: string | null;
      match: number;
    }> | null;

    // The engine's list is cached; whether each artist is in the library is read on every request, so it follows
    // the library.
    if (enrichedSimilar && enrichedSimilar.length > 0) {
      similarArtists = await resolveSimilarArtists(enrichedSimilar.slice(0, 10));
    } else {
      try {
        const cachedSimilar = await redisClient.get(similarCacheKey);
        let similar: SimilarArtistSource[];
        if (cachedSimilar) {
          similar = JSON.parse(cachedSimilar);
        } else {
          similar = await getSimilarArtists(isMbid(artist.mbid) ? artist.mbid : "", artist.name, 10);
          await redisClient.setex(similarCacheKey, 24 * 60 * 60, JSON.stringify(similar));
        }
        similarArtists = await resolveSimilarArtists(similar);
      } catch (error) {
        logger.error(`[Artist] Failed to fetch similar artists:`, error);
        similarArtists = [];
      }
    }

    // Both album sections on the artist page are year-ordered. The array above is assembled
    // database-first then MusicBrainz, so its raw order is acquisition order: an artist's
    // unowned albums came back looking random, and the web renders this order directly.
    const albumsByYear = [...albumsWithOwnership].sort((a, b) => {
      const av = getEffectiveYear(a) ?? -1;
      const bv = getEffectiveYear(b) ?? -1;
      if (av !== bv) return bv - av;
      return String(a.title).localeCompare(String(b.title));
    });

    res.json({
      ...artist,
      mbid: isMbid(artist.mbid) ? artist.mbid : null,
      coverArt: heroUrl,
      bio: getArtistDisplaySummary(artist),
      genres: getMergedGenres(artist),
      albums: albumsByYear,
      topTracks,
      similarArtists,
    });
  } catch (error) {
    logger.error("Get artist error:", error);
    res.status(500).json({ error: "Failed to fetch artist" });
  }
});

/** Files a deleted album leaves behind that nobody needs once its songs are gone: art, tags, rips' side files, system files. */
const LEFTOVER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".nfo", ".cue", ".lrc", ".log"]);
const LEFTOVER_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/**
 * Whether everything under `dir` is leftovers. Any other file, any link, an empty folder inside it (one another program
 * made, such as Lidarr for an artist it watches) or anything unreadable says no.
 */
function onlyLeftovers(dir: string, inner = false): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (inner && entries.length === 0) return false;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!onlyLeftovers(path.join(dir, entry.name), true)) return false;
      } else if (!LEFTOVER_NAMES.has(entry.name.toLowerCase()) && !LEFTOVER_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * After an artist's song files are deleted: each folder that held them goes, with what is left in it, when that is
 * only leftovers, and so does each parent the same holds for, up to the music root. A folder is never removed for its
 * name, so music filed by genre or in shared folders keeps everyone else's files.
 */
function removeEmptiedFolders(songPaths: string[]): void {
  const root = path.resolve(config.music.musicPath);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return;
  }
  const folders = [...new Set(songPaths.map((p) => path.dirname(p)))].sort((a, b) => b.length - a.length);
  for (const folder of folders) {
    for (let dir = folder; dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      if (!fs.existsSync(dir)) continue;
      try {
        const real = fs.realpathSync(dir);
        if (!real.startsWith(realRoot + path.sep) || !onlyLeftovers(real)) break;
        fs.rmSync(real, { recursive: true, force: true });
      } catch (err: any) {
        logger.warn(`[DELETE] Could not tidy folder ${dir}: ${err?.message ?? err}`);
        break;
      }
    }
  }
}

router.delete("/artists/:id", async (req, res) => {
  try {
    const artist = await prisma.artist.findUnique({
      where: { id: req.params.id },
      include: {
        albums: {
          include: {
            tracks: true,
          },
        },
      },
    });

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    if (artist.albums.some((a) => a.tracks.some((t) => t.filePath && isBehindLinkOut(t.filePath)))) {
      return res.status(409).json({ error: LINKED_OUT_REFUSAL });
    }

    // The database first: files removed before a delete that then fails would leave rows with no files. A file that
    // will not go is logged below and never undoes the delete.
    await deleteArtists([artist.id]);

    let deletedFiles = 0;
    const deletedPaths: string[] = [];

    for (const album of artist.albums) {
      for (const track of album.tracks) {
        if (!track.filePath) continue;
        try {
          const absolutePath = resolveWithinMusicRoot(track.filePath);
          if (!absolutePath) {
            logger.warn(`[DELETE] Refused out-of-root track path: ${track.filePath}`);
            continue;
          }
          if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            deletedFiles++;
          }
          deletedPaths.push(absolutePath);
        } catch (err) {
          logger.warn("[DELETE] Could not delete file:", err);
        }
      }
    }
    removeEmptiedFolders(deletedPaths);

    let lidarrDeleted = false;
    let lidarrError: string | null = null;
    if (isMbid(artist.mbid)) {
      try {
        const lidarrResult = await lidarrService.deleteArtist(
          artist.mbid,
          true,
        );
        if (lidarrResult.success) {
          lidarrDeleted = true;
        } else {
          logger.warn(`[DELETE] Lidarr deletion note: ${lidarrResult.message}`);
          lidarrError = lidarrResult.message;
        }
      } catch (err: any) {
        logger.warn(
          "[DELETE] Could not delete from Lidarr:",
          err?.message || err,
        );
        lidarrError = err?.message || "Unknown error";
      }
    }

    res.json({
      message: "Artist deleted successfully",
      deletedFiles,
      lidarrDeleted,
      lidarrError,
    });
  } catch (error) {
    safeError(res, "Delete artist", error);
  }
});

export default router;
