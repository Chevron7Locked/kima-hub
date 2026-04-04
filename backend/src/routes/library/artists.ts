import { Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { lastFmService } from "../../services/lastfm";
import { deezerService } from "../../services/deezer";
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
import pLimit from "p-limit";

const ARTIST_SORT_MAP: Record<string, any> = {
  name: { name: "asc" as const },
  "name-desc": { name: "desc" as const },
  tracks: { totalTrackCount: "desc" as const },
};

const MAX_LIMIT = 10000;

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

    const limit = Math.min(parseInt(limitParam as string, 10) || 50, MAX_LIMIT);
    const offset = parseInt(offsetParam as string, 10) || 0;

    const orderBy = ARTIST_SORT_MAP[sortBy as string] ?? {
      name: "asc" as const,
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

    const [artists, total] = await prisma.$transaction(
      async (tx) => {
        if (sortBy === "name" || sortBy === "name-desc") {
          const whereSql = buildArtistListWhereSql(filter as string, query as string);
          const direction = sortBy === "name-desc"
            ? Prisma.sql`DESC`
            : Prisma.sql`ASC`;

          const artistsByName = await tx.$queryRaw<
            {
              id: string;
              mbid: string | null;
              name: string;
              heroUrl: string | null;
              userHeroUrl: string | null;
              libraryAlbumCount: number;
              discoveryAlbumCount: number;
              totalTrackCount: number;
            }[]
          >`
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
              LOWER(REGEXP_REPLACE(TRIM(a.name), '^the\\s+', '', 'i')) ${direction},
              LOWER(TRIM(a.name)) ${direction},
              a.id ASC
            LIMIT ${limit}
            OFFSET ${offset}
          `;

          const countRows = await tx.$queryRaw<{ total: bigint }[]>`
            SELECT COUNT(*)::bigint AS total
            FROM "Artist" a
            ${whereSql}
          `;

          return [artistsByName, Number(countRows[0]?.total ?? 0)] as const;
        }

        const findManyArgs: Parameters<typeof tx.artist.findMany>[0] = {
          where,
          take: limit,
          orderBy,
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

        return Promise.all([
          tx.artist.findMany(findManyArgs),
          tx.artist.count({ where }),
        ]);
      },
      { timeout: 30000 },
    );

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
        mbid: artist.mbid?.startsWith("temp-") ? null : artist.mbid,
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

router.post("/artist-counts/backfill", async (_req, res) => {
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

    const decodedName = decodeURIComponent(idParam);
    const artist = await prisma.artist.findFirst({
      where: {
        OR: [
          { id: idParam },
          { name: { equals: decodedName, mode: "insensitive" } },
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

    let effectiveMbid = artist.mbid;
    if (!effectiveMbid || (effectiveMbid.startsWith("temp-") && artist.enrichmentStatus !== "unresolvable")) {
      logger.debug(
        ` Artist has temp/no MBID, searching MusicBrainz for ${artist.name}...`,
      );
      try {
        const searchResults = await musicBrainzService.searchArtist(
          artist.name,
          1,
        );
        if (searchResults.length > 0) {
          effectiveMbid = searchResults[0].id;
          logger.debug(`  Found MBID: ${effectiveMbid}`);

          try {
            await prisma.artist.update({
              where: { id: artist.id },
              data: { mbid: effectiveMbid },
            });
          } catch (mbidError: any) {
            if (mbidError.code === "P2002") {
              logger.debug(
                `MBID ${effectiveMbid} already exists for another artist, skipping update`,
              );
            } else {
              logger.error(`  ✗ Failed to update MBID:`, mbidError);
            }
          }
        } else {
          logger.debug(`  ✗ No MusicBrainz match found for ${artist.name}`);
        }
      } catch (error) {
        logger.error(` MusicBrainz search failed:`, error);
      }
    }

    const dbAlbums = artist.albums.map((album) => ({
      ...album,
      owned: true,
      coverArt: album.coverUrl,
      source: "database" as const,
    }));

    logger.debug(
      `[Artist] Found ${dbAlbums.length} albums from database (actual owned files)`,
    );

    const shouldFetchDiscography =
      effectiveMbid && !effectiveMbid.startsWith("temp-");

    if (shouldFetchDiscography) {
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
          releaseGroups = await musicBrainzService.getReleaseGroups(
            effectiveMbid,
            ["album", "ep"],
            100,
          );
          await redisClient.setex(
            discoCacheKey,
            24 * 60 * 60,
            JSON.stringify(releaseGroups),
          );
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

        const mbAlbums = await Promise.all(
          filteredReleaseGroups.map(async (rg: any) => {
            let coverUrl = null;

            const cacheKey = `caa:${rg.id}`;
            try {
              const cached = await redisClient.get(cacheKey);
              if (cached && cached !== "NOT_FOUND") {
                coverUrl = cached;
              }
            } catch (err) {
              // Redis error, continue without cover
            }

            return {
              id: rg.id,
              rgMbid: rg.id,
              title: rg.title,
              year: rg["first-release-date"]
                ? parseInt(rg["first-release-date"].substring(0, 4))
                : null,
              type: rg["primary-type"],
              coverUrl,
              coverArt: coverUrl,
              artistId: artist.id,
              owned: ownedRgMbids.has(rg.id),
              trackCount: 0,
              tracks: [],
              source: "musicbrainz" as const,
            };
          }),
        );

        const dbAlbumTitles = new Set(
          dbAlbums.map((a) => a.title.toLowerCase()),
        );
        const mbAlbumsFiltered = mbAlbums.filter(
          (a) => !dbAlbumTitles.has(a.title.toLowerCase()),
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
    let topTracks = allTracks.slice(0, 10);

    const userId = req.user!.id;
    const trackIds = allTracks.map((t) => t.id);
    const userPlays = await prisma.play.groupBy({
      by: ["trackId"],
      where: {
        userId,
        trackId: { in: trackIds },
      },
      _count: {
        id: true,
      },
    });
    const userPlayCounts = new Map(
      userPlays.map((p) => [p.trackId, p._count.id]),
    );

    const topTracksCacheKey = `top-tracks:${artist.id}`;
    try {
      const cachedTopTracks = await redisClient.get(topTracksCacheKey);
      let lastfmTopTracks: any[] = [];

      if (cachedTopTracks && cachedTopTracks !== "NOT_FOUND") {
        lastfmTopTracks = JSON.parse(cachedTopTracks);
        logger.debug(
          `[Artist] Using cached top tracks (${lastfmTopTracks.length})`,
        );
      } else {
        const validMbid =
          effectiveMbid && !effectiveMbid.startsWith("temp-")
            ? effectiveMbid
            : "";
        lastfmTopTracks = await lastFmService.getArtistTopTracks(
          validMbid,
          artist.name,
          10,
        );
        await redisClient.setex(
          topTracksCacheKey,
          24 * 60 * 60,
          JSON.stringify(lastfmTopTracks),
        );
        logger.debug(`[Artist] Cached ${lastfmTopTracks.length} top tracks`);
      }

      const normalizeTitle = (title: string): string => {
        return title
          .toLowerCase()
          .replace(/\s*\((?:cover|remix|remaster(?:ed)?|deluxe|bonus track|acoustic|instrumental|radio edit|clean|explicit|feat\.?\s[^)]*|ft\.?\s[^)]*|[^)]*\s(?:remix|mix|version|edit))\)/gi, '')
          .trim();
      };

      const stripSuffixes = (title: string): string => {
        return title
          .toLowerCase()
          .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')
          .replace(/\s+-\s*(?:remaster(?:ed)?|deluxe|single|bonus|acoustic|live|remix|clean|explicit|anniversary|expanded|special|mono|stereo)(?:\s[^-]*)?$/gi, '')
          .trim();
      };

      const isLiveTrack = (title: string): boolean => {
        return /\(live[^)]*\)/i.test(title) || /\s-\s*live\b/i.test(title);
      };

      const tracksByExactTitle = new Map<string, (typeof allTracks)[0]>();
      const tracksByNormTitle = new Map<string, (typeof allTracks)[0]>();
      const tracksByStrippedTitle = new Map<string, (typeof allTracks)[0]>();
      for (const track of allTracks) {
        if (isLiveTrack(track.title)) continue;
        const exact = track.title.toLowerCase();
        const norm = normalizeTitle(track.title);
        const stripped = stripSuffixes(track.title);
        if (!tracksByExactTitle.has(exact)) {
          tracksByExactTitle.set(exact, track);
        }
        if (!tracksByNormTitle.has(norm)) {
          tracksByNormTitle.set(norm, track);
        }
        if (!tracksByStrippedTitle.has(stripped)) {
          tracksByStrippedTitle.set(stripped, track);
        }
      }

      const combinedTracks: any[] = [];

      for (const lfmTrack of lastfmTopTracks) {
        if (isLiveTrack(lfmTrack.name)) continue;

        const exactKey = lfmTrack.name.toLowerCase();
        const normKey = normalizeTitle(lfmTrack.name);
        const strippedKey = stripSuffixes(lfmTrack.name);
        const matchedTrack = tracksByExactTitle.get(exactKey) || tracksByNormTitle.get(normKey) || tracksByStrippedTitle.get(strippedKey);

        if (matchedTrack) {
          combinedTracks.push({
            ...matchedTrack,
            playCount: lfmTrack.playcount ? parseInt(lfmTrack.playcount) : 0,
            listeners: lfmTrack.listeners ? parseInt(lfmTrack.listeners) : 0,
            userPlayCount: userPlayCounts.get(matchedTrack.id) || 0,
            album: {
              ...matchedTrack.album,
              coverArt: matchedTrack.album.coverUrl,
            },
          });
        } else {
          combinedTracks.push({
            id: `lastfm-${artist.mbid || artist.name}-${lfmTrack.name}`,
            title: lfmTrack.name,
            playCount: lfmTrack.playcount ? parseInt(lfmTrack.playcount) : 0,
            listeners: lfmTrack.listeners ? parseInt(lfmTrack.listeners) : 0,
            duration: lfmTrack.duration
              ? Math.floor(parseInt(lfmTrack.duration) / 1000)
              : 0,
            url: lfmTrack.url,
            album: {
              title: lfmTrack.album?.["#text"] || "Unknown Album",
              coverArt: artist.heroUrl || null,
            },
            userPlayCount: 0,
          });
        }
      }

      topTracks = combinedTracks.slice(0, 10);
    } catch (error) {
      logger.error(
        `Failed to get Last.fm top tracks for ${artist.name}:`,
        error,
      );
      topTracks = topTracks.map((t) => ({
        ...t,
        userPlayCount: userPlayCounts.get(t.id) || 0,
        album: {
          ...t.album,
          coverArt: t.album.coverUrl,
        },
      }));
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

      const similarNames = enrichedSimilar
        .slice(0, 10)
        .map((s) => s.name.toLowerCase());
      const similarMbids = enrichedSimilar
        .slice(0, 10)
        .map((s) => s.mbid)
        .filter(Boolean) as string[];

      const libraryMatches = await prisma.artist.findMany({
        where: {
          OR: [
            { normalizedName: { in: similarNames } },
            ...(similarMbids.length > 0
              ? [{ mbid: { in: similarMbids } }]
              : []),
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
                  location: "LIBRARY",
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

      const deezerLimit = pLimit(3);
      const similarWithImages = await Promise.all(
        enrichedSimilar.slice(0, 10).map((s) => deezerLimit(async () => {
          const libraryArtist =
            (s.mbid && libraryByMbid.get(s.mbid)) ||
            libraryByName.get(s.name.toLowerCase());

          let image = libraryArtist?.heroUrl || null;

          if (!image) {
            try {
              const cacheKey = `deezer-artist-image:${s.name}`;
              const cached = await redisClient.get(cacheKey);
              if (cached && cached !== "NOT_FOUND") {
                image = cached;
              } else {
                image = await deezerService.getArtistImage(s.name);
                if (image) {
                  await redisClient.setex(cacheKey, 24 * 60 * 60, image);
                }
              }
            } catch (err) {
              // Deezer failed, leave null
            }
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

      similarArtists = similarWithImages;
    } else {
      const cachedSimilar = await redisClient.get(similarCacheKey);
      if (cachedSimilar && cachedSimilar !== "NOT_FOUND") {
        similarArtists = JSON.parse(cachedSimilar);
        logger.debug(
          `[Artist] Using cached similar artists (${similarArtists.length})`,
        );
      } else {
        logger.debug(`[Artist] Fetching similar artists from Last.fm...`);

        try {
          const validMbid =
            effectiveMbid && !effectiveMbid.startsWith("temp-")
              ? effectiveMbid
              : "";
          const lastfmSimilar = await lastFmService.getSimilarArtists(
            validMbid,
            artist.name,
            10,
          );

          const similarNames = lastfmSimilar.map((s: any) =>
            s.name.toLowerCase(),
          );
          const similarMbids = lastfmSimilar
            .map((s: any) => s.mbid)
            .filter(Boolean) as string[];

          const libraryMatches = await prisma.artist.findMany({
            where: {
              OR: [
                { normalizedName: { in: similarNames } },
                ...(similarMbids.length > 0
                  ? [{ mbid: { in: similarMbids } }]
                  : []),
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
                      location: "LIBRARY",
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

          const lastfmDeezerLimit = pLimit(3);
          const similarWithImages = await Promise.all(
            lastfmSimilar.map((s: any) => lastfmDeezerLimit(async () => {
              const libraryArtist =
                (s.mbid && libraryByMbid.get(s.mbid)) ||
                libraryByName.get(s.name.toLowerCase());

              let image = libraryArtist?.heroUrl || null;

              if (!image) {
                try {
                  image = await deezerService.getArtistImage(s.name);
                } catch (err) {
                  // Deezer failed, leave null
                }
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

          similarArtists = similarWithImages;

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

    res.json({
      ...artist,
      mbid: artist.mbid?.startsWith("temp-") ? null : artist.mbid,
      coverArt: heroUrl,
      bio: getArtistDisplaySummary(artist),
      genres: getMergedGenres(artist),
      albums: albumsWithOwnership,
      topTracks,
      similarArtists,
    });
  } catch (error) {
    logger.error("Get artist error:", error);
    res.status(500).json({ error: "Failed to fetch artist" });
  }
});

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

    const { config } = await import("../../config");
    const path = await import("path");
    const fs = await import("fs");

    let deletedFiles = 0;
    const artistFoldersToDelete = new Set<string>();

    for (const album of artist.albums) {
      for (const track of album.tracks) {
        if (track.filePath) {
          try {
            const absolutePath = path.join(
              config.music.musicPath,
              track.filePath,
            );

            if (fs.existsSync(absolutePath)) {
              fs.unlinkSync(absolutePath);
              deletedFiles++;

              const pathParts = track.filePath.split(path.sep);
              if (pathParts.length >= 2) {
                const actualArtistFolder =
                  pathParts[0].toLowerCase() === "soulseek"
                    ? path.join(
                        config.music.musicPath,
                        pathParts[0],
                        pathParts[1],
                      )
                    : path.join(config.music.musicPath, pathParts[0]);
                artistFoldersToDelete.add(actualArtistFolder);
              } else if (pathParts.length === 1) {
                const actualArtistFolder = path.join(
                  config.music.musicPath,
                  pathParts[0],
                );
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

    const commonPaths = [
      path.join(config.music.musicPath, artist.name),
      path.join(config.music.musicPath, "Soulseek", artist.name),
      path.join(config.music.musicPath, "discovery", artist.name),
    ];

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
    if (artist.mbid && !artist.mbid.startsWith("temp-")) {
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
