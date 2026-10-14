import { Router } from "express";
import fs from "fs";
import path from "path";
import { normalizeArtistName } from "../../services/artistIdentity";
import { requireAdmin } from "../../middleware/auth";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { getSimilarArtists } from "../../services/artistSimilarity";
import { musicBrainzService } from "../../services/musicbrainz";
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
import { isMbid } from "../../services/artistIdentity";
import { failureCause } from "../../utils/outcome";
import pLimit from "p-limit";
import { toAudioFeaturesDTO } from "../../utils/audioFeatures";
import { resolveWithinMusicRoot } from "./trackPath";
import { parseLimit } from "./paging";
import { findArtistArtwork, withAlbumArtwork } from "../../services/artwork";
import { listenBrainzService } from "../../services/listenBrainz";
import { deezerService } from "../../services/deezer";
import { LIBRARY_LOCATION } from "../../services/libraryFilters";
import { editionlessKey } from "../../services/albumIdentity";
import { getEffectiveYear } from "../../utils/dateFilters";

// Alphabetical sorts use `sortName` (article-stripped, unaccented,
// lowercased; indexed). `name`/`name-desc` take the raw-SQL branch below,
// which orders on the same column, and must keep agreeing with this map.
const ARTIST_SORT_MAP: Record<string, any> = {
  name: { sortName: "asc" as const },
  "name-desc": { sortName: "desc" as const },
  tracks: { totalTrackCount: "desc" as const },
};

// The shape both artist-list branches return: the raw-SQL name-sort query
// and the Prisma `select` below produce it independently.
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
async function resolveSimilarArtists(similar: SimilarArtistSource[]) {
  // normalizeArtistName writes normalizedName and folds accents and
  // ampersands, so lowercasing alone would miss "Sigur Rós" or "Hall & Oates".
  const similarNames = similar.map((s) => normalizeArtistName(s.name));
  const similarMbids = similar
    .map((s) => s.mbid)
    .filter(Boolean) as string[];

  const libraryMatches = await prisma.artist.findMany({
    where: {
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
          albums: {
            where: {
              location: LIBRARY_LOCATION,
              tracks: { some: {} },
            },
          },
        },
      },
    },
  });

  const libraryByName = new Map(
    libraryMatches.map((a) => [
      a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
      a,
    ]),
  );
  const libraryByMbid = new Map(
    libraryMatches.filter((a) => a.mbid).map((a) => [a.mbid!, a]),
  );

  const imageLimit = pLimit(3);
  return Promise.all(
    similar.map((s) => imageLimit(async () => {
      const libraryArtist =
        (s.mbid && libraryByMbid.get(s.mbid)) ||
        libraryByName.get(s.name.toLowerCase());

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

function buildArtistListWhereSql(filter: string, query: string): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  if (filter === "owned") {
    clauses.push(
      Prisma.sql`(a."libraryAlbumCount" > 0 OR EXISTS (SELECT 1 FROM "OwnedAlbum" oa WHERE oa."artistId" = a.id))`,
    );
  } else if (filter === "discovery") {
    clauses.push(
      Prisma.sql`(a."discoveryAlbumCount" > 0 AND a."libraryAlbumCount" = 0)`,
    );
  } else {
    clauses.push(
      Prisma.sql`(a."libraryAlbumCount" > 0 OR a."discoveryAlbumCount" > 0)`,
    );
  }

  if (query) {
    clauses.push(Prisma.sql`a."name" ILIKE ${`%${query}%`}`);
  }

  if (clauses.length === 0) {
    return Prisma.empty;
  }

  return Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`;
}

router.get("/artists", async (req, res) => {
  try {
    const {
      query = "",
      limit: limitParam = "50",
      offset: offsetParam = "0",
      filter = "owned",
      cursor,
      sortBy = "name",
    } = req.query;

    const limit = parseLimit(limitParam, 50);
    const offset = parseInt(offsetParam as string, 10) || 0;

    const orderBy = ARTIST_SORT_MAP[sortBy as string] ?? {
      sortName: "asc" as const,
    };

    let where: any = {};

    if (filter === "owned") {
      where.OR = [
        { libraryAlbumCount: { gt: 0 } },
        { ownedAlbums: { some: {} } },
      ];
    } else if (filter === "discovery") {
      where.discoveryAlbumCount = { gt: 0 };
      where.libraryAlbumCount = 0;
    } else {
      where.OR = [
        { libraryAlbumCount: { gt: 0 } },
        { discoveryAlbumCount: { gt: 0 } },
      ];
    }

    if (query) {
      where.name = { contains: query as string, mode: "insensitive" };
    }

    let artists: ArtistListRow[];
    let total: number;

    if (sortBy === "name" || sortBy === "name-desc") {
      const whereSql = buildArtistListWhereSql(filter as string, query as string);
      const direction = sortBy === "name-desc"
        ? Prisma.sql`DESC`
        : Prisma.sql`ASC`;

      artists = await prisma.$queryRaw<ArtistListRow[]>`
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
        ORDER BY
          a."sortName" ${direction},
          a.id ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const countRows = await prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(*)::bigint AS total
        FROM "Artist" a
        ${whereSql}
      `;
      total = Number(countRows[0]?.total ?? 0);
    } else {
      const findManyArgs: Parameters<typeof prisma.artist.findMany>[0] = {
        where,
        take: limit,
        orderBy: [orderBy, { id: "asc" }],
        select: {
          id: true,
          mbid: true,
          name: true,
          heroUrl: true,
          userHeroUrl: true,
          libraryAlbumCount: true,
          discoveryAlbumCount: true,
          totalTrackCount: true,
        },
      };

      if (cursor) {
        findManyArgs.cursor = { id: cursor as string };
        findManyArgs.skip = 1;
      } else {
        findManyArgs.skip = offset;
      }

      [artists, total] = await Promise.all([
        prisma.artist.findMany(findManyArgs),
        prisma.artist.count({ where }),
      ]);
    }

    const imageMap = await dataCacheService.getArtistImagesBatch(
      artists.map((a) => ({
        id: a.id,
        heroUrl: a.heroUrl,
        userHeroUrl: a.userHeroUrl,
      })),
    );

    const artistsWithImages = artists.map((artist) => {
      const coverArt = imageMap.get(artist.id) || artist.heroUrl || null;

      const albumCount =
        filter === "discovery"
          ? artist.discoveryAlbumCount
          : filter === "all"
            ? artist.libraryAlbumCount + artist.discoveryAlbumCount
            : artist.libraryAlbumCount;

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

    const nextCursor =
      artists.length === limit ? artists[artists.length - 1].id : null;

    res.json({
      artists: artistsWithImages,
      total,
      offset,
      limit,
      nextCursor,
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

router.post("/artist-counts/backfill", requireAdmin, async (_req, res) => {
  try {
    if (isBackfillInProgress()) {
      return res.json({
        message: "Backfill already in progress",
        status: "processing",
      });
    }

    res.json({ message: "Backfill started", status: "processing" });

    backfillAllArtistCounts((processed, total) => {
      if (processed % 100 === 0) {
        logger.debug(`[ArtistCounts] Progress: ${processed}/${total}`);
      }
    }).catch((error) => {
      logger.error("[ArtistCounts] Backfill failed:", error);
    });
  } catch (error: any) {
    logger.error("[ArtistCounts] Backfill trigger error:", error?.message);
    res.status(500).json({ error: "Failed to start backfill" });
  }
});

router.post("/backfill-genres", requireAdmin, async (_req, res) => {
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

// The play queue for one artist, in one response: what a Play All tap needs
// and nothing else, in the canonical order clients consume as-given — owned
// albums by year desc, title asc, disc/track within album (untagged disc =
// disc one). Only playable library rows ride the queue, the same predicate
// the search doors use, so the player never loads a row it cannot stream.
router.get("/artists/:id/play-tracks", async (req, res) => {
  try {
    const idParam = req.params.id;

    const artist = await prisma.artist.findFirst({
      where: {
        OR: [
          { id: idParam },
          { name: { equals: idParam, mode: "insensitive" } },
          { mbid: idParam },
        ],
      },
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
              where: { corrupt: false, missingSince: null },
              select: {
                id: true,
                title: true,
                trackNo: true,
                discNumber: true,
                duration: true,
              },
              orderBy: [{ trackNo: Prisma.SortOrder.asc }],
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

    const artistInclude = {
      albums: {
        orderBy: { year: Prisma.SortOrder.desc },
        include: {
          tracks: {
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
      where: {
        OR: [
          { id: idParam },
          { name: { equals: idParam, mode: "insensitive" } },
          { mbid: idParam },
        ],
      },
      include: artistInclude,
    });

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    let albumsWithOwnership = [];
    const ownedRgMbids = new Set(artist.ownedAlbums.map((o) => o.rgMbid));

    // The id belongs to enrichment; a page view never searches for or stores one.
    const effectiveMbid = artist.mbid;

    const dbAlbums = artist.albums.map((album) => ({
      ...album,
      tracks: album.tracks.map((t) => ({
        ...t,
        audioFeatures: toAudioFeaturesDTO(t),
      })),
      owned: true,
      coverArt: album.coverUrl,
      source: "database" as const,
    }));

    logger.debug(
      `[Artist] Found ${dbAlbums.length} albums from database (actual owned files)`,
    );

    // Inline guard, not a boolean intermediate: the type predicate has to be in
    // the condition for effectiveMbid to narrow to string inside the block.
    if (isMbid(effectiveMbid)) {
      try {
        const discoCacheKey = `discography:${effectiveMbid}`;
        let releaseGroups: any[] = [];

        const cachedDisco = await redisClient.get(discoCacheKey);
        if (cachedDisco && cachedDisco !== "NOT_FOUND") {
          releaseGroups = JSON.parse(cachedDisco);
          logger.debug(
            `[Artist] Using cached discography (${releaseGroups.length} albums)`,
          );
        } else {
          logger.debug(`[Artist] Fetching discography from MusicBrainz...`);
          const fetched = await musicBrainzService.getReleaseGroups(
            effectiveMbid,
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
          } else if (fetched.kind === "absent") {
            logger.debug(
              `[Artist] MusicBrainz has no release-groups for ${effectiveMbid}`,
            );
          } else {
            // A failed question is not "no discography" — the catch
            // below serves database albums and logs the real cause.
            throw new Error(
              `Discography lookup ${fetched.kind}: ${failureCause(fetched)}`,
            );
          }
        }

        logger.debug(
          `  Got ${releaseGroups.length} albums from MusicBrainz (before filtering)`,
        );

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

        logger.debug(
          `  Filtered to ${filteredReleaseGroups.length} studio albums/EPs`,
        );

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

        const inLibrary = new Set(dbAlbums.map((a) => a.rgMbid).filter(Boolean));
        const inLibraryTitles = new Set(dbAlbums.map((a) => editionlessKey(a.title)));
        const mbAlbumsFiltered = await withAlbumArtwork(
          mbAlbums.filter((a) => !inLibrary.has(a.rgMbid) && !inLibraryTitles.has(editionlessKey(a.title))),
          (album) => ({ rgMbid: album.rgMbid, artistName: artist.name, albumTitle: album.title }),
          (album, coverUrl) => ({ ...album, coverUrl, coverArt: coverUrl }),
        );

        albumsWithOwnership = [...dbAlbums, ...mbAlbumsFiltered];

        logger.debug(
          `  Total albums: ${albumsWithOwnership.length} (${dbAlbums.length} owned from database, ${mbAlbumsFiltered.length} from MusicBrainz)`,
        );
        logger.debug(
          `  Owned: ${
            albumsWithOwnership.filter((a) => a.owned).length
          }, Available: ${albumsWithOwnership.filter((a) => !a.owned).length}`,
        );
      } catch (error) {
        logger.error(`Failed to fetch MusicBrainz discography:`, error);
        albumsWithOwnership = dbAlbums;
      }
    } else {
      logger.debug(
        `[Artist] No valid MBID, using ${dbAlbums.length} albums from database`,
      );
      albumsWithOwnership = dbAlbums;
    }

    const allTracks = artist.albums.flatMap((a) => a.tracks);
    let topTracks: any[];

    const userId = req.user!.id;

    // Popular tracks: real global popularity, not an echo of the user's own
    // listens. ListenBrainz sitewide top recordings first (needs the user's
    // scrobble token), Deezer's artist-top as the no-token fallback; both are
    // joined against the owned library so owned rows play and unowned rows
    // preview. When both sources are unavailable the local floor applies:
    // the user's most played by this artist, then MB first-release date.
    let popularitySource = "local";
    {
      const ownedByMbid = new Map<string, any>();
      const ownedByTitle = new Map<string, any>();
      for (const t of allTracks) {
        if (t.recordingMbid) ownedByMbid.set(t.recordingMbid, t);
        const bare = t.title.replace(/\s*[-–(].*$/, "").trim().toLowerCase();
        if (bare && !ownedByTitle.has(bare)) ownedByTitle.set(bare, t);
      }
      const joinOwned = (
        rows: Array<{
          key: string;
          title: string;
          albumName?: string | null;
          coverUrl?: string | null;
          previewUrl?: string | null;
          durationMs?: number;
          listeners: number;
          playCount: number;
        }>
      ): any[] => {
        const seen = new Set<string>();
        const joined: any[] = [];
        for (const r of rows) {
          const owned =
            ownedByMbid.get(r.key) ||
            ownedByTitle.get(r.title.toLowerCase()) ||
            ownedByTitle.get(
              r.title.replace(/\s*[-–(].*$/, "").trim().toLowerCase()
            );
          // Two global rows can join to the same owned track (the Radio Edit
          // and the album cut of one song): keep the first, higher-ranked one.
          const dedupeKey = owned ? owned.id : `dz:${r.key}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          if (owned) {
            joined.push({
              ...owned,
              playCount: r.playCount,
              listeners: r.listeners,
              userPlayCount: owned.playCount ?? 0,
              popularitySource: "global",
              album: { ...owned.album, coverArt: owned.album?.coverUrl },
            });
          } else {
            joined.push({
              id: `dz:${r.key}`,
              title: r.title,
              duration: Math.round((r.durationMs || 0) / 1000) || 0,
              playCount: r.playCount,
              listeners: r.listeners,
              userPlayCount: 0,
              popularitySource: "global",
              previewUrl: r.previewUrl || null,
              album: {
                id: null,
                title: r.albumName || "Unknown Album",
                coverUrl: r.coverUrl || null,
                coverArt: r.coverUrl || null,
              },
            });
          }
        }
        return joined;
      };

      let global: any[] = [];
      if (isMbid(effectiveMbid)) {
        try {
          const lb = await listenBrainzService.getTopRecordingsForArtist(effectiveMbid, userId, 10);
          if (lb.length > 0) {
            global = joinOwned(
              lb.map((r) => ({
                key: r.recordingMbid,
                title: r.title,
                albumName: r.releaseName,
                durationMs: r.lengthMs,
                listeners: r.listeners,
                playCount: r.playCount,
              }))
            );
            popularitySource = "listenbrainz";
          }
        } catch (lbError) {
          logger.warn(
            `[Artist] ListenBrainz top recordings failed for ${artist.name}:`,
            lbError
          );
        }
      }
      if (global.length === 0) {
        try {
          const dz = await deezerService.getArtistTopTracks(artist.name, 10);
          if (dz.length > 0) {
            global = joinOwned(
              dz.map((r) => ({
                key: r.title.toLowerCase(),
                title: r.title,
                albumName: r.album,
                coverUrl: r.coverUrl,
                previewUrl: r.previewUrl,
                durationMs: r.durationMs,
                listeners: 0,
                playCount: r.rank,
              }))
            );
            popularitySource = "deezer";
          }
        } catch (dzError) {
          logger.warn(
            `[Artist] Deezer top tracks failed for ${artist.name}:`,
            dzError
          );
        }
      }
      topTracks = global;
      logger.debug(
        `[Artist] Popular tracks from ${popularitySource} (${global.length})`,
      );
    }
    if (topTracks.length === 0) {
      const played = await prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          duration: number;
          albumId: string;
          albumTitle: string;
          albumCoverUrl: string | null;
          artistId: string;
          artistName: string;
          playCount: bigint;
        }>
      >`
        SELECT t.id, t.title, t.duration,
               t."albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
               a."artistId", ar.name AS "artistName",
               COUNT(p.id)::bigint AS "playCount"
        FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        JOIN "Play" p ON p."trackId" = t.id AND p."userId" = ${userId}
        WHERE a."artistId" = ${artist.id}
        GROUP BY t.id, t.title, t.duration, t."albumId", a.title, a."coverUrl", a."artistId", ar.name
        HAVING COUNT(p.id) > 0
        ORDER BY COUNT(p.id) DESC, MAX(p."playedAt") DESC
        LIMIT 10
      `;
      if (played.length > 0) {
        topTracks = played.map((t) => ({
          ...t,
          playCount: Number(t.playCount),
          listeners: 0,
          userPlayCount: Number(t.playCount),
          album: {
            id: t.albumId,
            title: t.albumTitle,
            artistId: t.artistId,
            coverUrl: t.albumCoverUrl,
            artist: { id: t.artistId, name: t.artistName, mbid: "" },
            coverArt: t.albumCoverUrl,
          },
        }));
        logger.debug(
          `[Artist] Top tracks from local listens (${played.length})`,
        );
      } else {
        // Cold start: earliest-released tracks per MusicBrainz, falling back
        // to the plain first-10 slice when MB has nothing.
        try {
          const fetched = isMbid(effectiveMbid)
            ? await musicBrainzService.getReleaseGroups(effectiveMbid, ["album"], 50)
            : null;
          const rgs = fetched?.kind === "answered" ? fetched.value : [];
          const releaseDateByRg = new Map<string, string>();
          for (const rg of rgs as Array<{
            id: string;
            "first-release-date"?: string;
          }>) {
            if (rg["first-release-date"]) {
              releaseDateByRg.set(rg.id, rg["first-release-date"]);
            }
          }
          const dated = allTracks
            .map((t) => {
              const album = artist.albums.find((a) => a.id === t.albumId);
              const date =
                (album && releaseDateByRg.get(album.rgMbid)) ||
                (album?.year ? `${album.year}-01-01` : "9999");
              return { t, date: String(date) };
            })
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(0, 10)
            .map(({ t, date }) => ({
              ...t,
              playCount: 0,
              listeners: 0,
              userPlayCount: 0,
              releaseDate: date === "9999" ? null : date,
              album: {
                ...t.album,
                coverArt: t.album.coverUrl,
              },
            }));
          topTracks = dated;
          logger.debug(
            `[Artist] No local plays; top tracks by MB first-release-date (${dated.length})`,
          );
        } catch (mbError) {
          logger.warn(
            `[Artist] MB first-release fallback failed for ${artist.name}:`,
            mbError,
          );
          topTracks = allTracks.slice(0, 10).map((t) => ({
            ...t,
            playCount: 0,
            listeners: 0,
            userPlayCount: 0,
            album: {
              ...t.album,
              coverArt: t.album.coverUrl,
            },
          }));
        }
      }
    }

    const heroUrl = await dataCacheService.getArtistImage(
      artist.id,
      artist.name,
      effectiveMbid,
    );

    let similarArtists: any[] = [];
    const similarCacheKey = `similar-artists:${artist.id}`;

    const enrichedSimilar = artist.similarArtistsJson as Array<{
      name: string;
      mbid: string | null;
      match: number;
    }> | null;

    if (enrichedSimilar && enrichedSimilar.length > 0) {
      logger.debug(
        `[Artist] Using ${enrichedSimilar.length} similar artists from enriched JSON`,
      );

      similarArtists = await resolveSimilarArtists(enrichedSimilar.slice(0, 10));
    } else {
      const cachedSimilar = await redisClient.get(similarCacheKey);
      if (cachedSimilar && cachedSimilar !== "NOT_FOUND") {
        similarArtists = JSON.parse(cachedSimilar);
        logger.debug(
          `[Artist] Using cached similar artists (${similarArtists.length})`,
        );
      } else {
        logger.debug(`[Artist] Fetching similar artists (ListenBrainz, then Deezer)...`);

        try {
          const validMbid =
            isMbid(effectiveMbid)
              ? effectiveMbid
              : "";
          const similar = await getSimilarArtists(
            validMbid,
            artist.name,
            10,
          );

          similarArtists = await resolveSimilarArtists(similar);

          await redisClient.setex(
            similarCacheKey,
            24 * 60 * 60,
            JSON.stringify(similarArtists),
          );
          logger.debug(
            `[Artist] Cached ${similarArtists.length} similar artists`,
          );
        } catch (error) {
          logger.error(`[Artist] Failed to fetch similar artists:`, error);
          similarArtists = [];
        }
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

router.delete("/artists/:id", requireAdmin, async (req, res) => {
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

    let deletedFiles = 0;
    const artistFoldersToDelete = new Set<string>();

    for (const album of artist.albums) {
      for (const track of album.tracks) {
        if (track.filePath) {
          try {
            const absolutePath = resolveWithinMusicRoot(track.filePath);
            if (!absolutePath) {
              logger.warn(
                `[DELETE] Refused out-of-root track path: ${track.filePath}`,
              );
              continue;
            }

            if (fs.existsSync(absolutePath)) {
              fs.unlinkSync(absolutePath);
              deletedFiles++;

              const pathParts = track.filePath.split(path.sep);
              // Everything added to this set is handed to rmSync(recursive,
              // force) below, so the segments are resolved rather than joined --
              // the same rule the file path above follows. A refused folder is
              // simply not queued.
              const actualArtistFolder =
                pathParts.length >= 2
                  ? pathParts[0].toLowerCase() === "soulseek"
                    ? resolveWithinMusicRoot(pathParts[0], pathParts[1])
                    : resolveWithinMusicRoot(pathParts[0])
                  : pathParts.length === 1
                    ? resolveWithinMusicRoot(pathParts[0])
                    : null;
              if (actualArtistFolder) {
                artistFoldersToDelete.add(actualArtistFolder);
              }
            }
          } catch (err) {
            logger.warn("[DELETE] Could not delete file:", err);
          }
        }
      }
    }

    for (const artistFolder of artistFoldersToDelete) {
      try {
        if (fs.existsSync(artistFolder)) {
          logger.debug(`[DELETE] Attempting to delete folder: ${artistFolder}`);

          fs.rmSync(artistFolder, {
            recursive: true,
            force: true,
          });
          logger.debug(
            `[DELETE] Successfully deleted artist folder: ${artistFolder}`,
          );
        }
      } catch (err: any) {
        logger.error(
          `[DELETE] Failed to delete artist folder ${artistFolder}:`,
          err?.message || err,
        );

        try {
          const files = fs.readdirSync(artistFolder);
          for (const file of files) {
            const filePath = path.join(artistFolder, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.isDirectory()) {
                fs.rmSync(filePath, {
                  recursive: true,
                  force: true,
                });
              } else {
                fs.unlinkSync(filePath);
              }
              logger.debug(`[DELETE] Deleted: ${filePath}`);
            } catch (fileErr: any) {
              logger.error(
                `[DELETE] Could not delete ${filePath}:`,
                fileErr?.message,
              );
            }
          }
          fs.rmdirSync(artistFolder);
          logger.debug(
            `[DELETE] Deleted artist folder after manual cleanup: ${artistFolder}`,
          );
        } catch (cleanupErr: any) {
          logger.error(
            `[DELETE] Cleanup also failed for ${artistFolder}:`,
            cleanupErr?.message,
          );
        }
      }
    }

    // artist.name is a tag value, not a path segment the scanner produced -- an
    // artist tagged "../../tmp" would otherwise reach rmSync(recursive, force)
    // just below. A refused path drops out of the list rather than throwing:
    // an artist with one bad row must still be deletable.
    const commonPaths = [
      resolveWithinMusicRoot(artist.name),
      resolveWithinMusicRoot("Soulseek", artist.name),
      resolveWithinMusicRoot("discovery", artist.name),
    ].filter((p): p is string => p !== null);

    for (const commonPath of commonPaths) {
      if (fs.existsSync(commonPath) && !artistFoldersToDelete.has(commonPath)) {
        try {
          fs.rmSync(commonPath, { recursive: true, force: true });
          logger.debug(
            `[DELETE] Deleted additional artist folder: ${commonPath}`,
          );
        } catch (err: any) {
          logger.error(
            `[DELETE] Could not delete ${commonPath}:`,
            err?.message,
          );
        }
      }
    }

    let lidarrDeleted = false;
    let lidarrError: string | null = null;
    if (isMbid(artist.mbid)) {
      try {
        const { lidarrService } = await import("../../services/lidarr");
        const lidarrResult = await lidarrService.deleteArtist(
          artist.mbid,
          true,
        );
        if (lidarrResult.success) {
          logger.debug(`[DELETE] Lidarr: ${lidarrResult.message}`);
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

    try {
      await prisma.ownedAlbum.deleteMany({
        where: { artistId: artist.id },
      });
    } catch (err) {
      logger.warn("[DELETE] Could not delete OwnedAlbum records:", err);
    }

    logger.debug(
      `[DELETE] Deleting artist from database: ${artist.name} (${artist.id})`,
    );
    await prisma.artist.delete({
      where: { id: artist.id },
    });

    logger.debug(
      `[DELETE] Successfully deleted artist: ${
        artist.name
      } (${deletedFiles} files${lidarrDeleted ? ", removed from Lidarr" : ""})`,
    );

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
