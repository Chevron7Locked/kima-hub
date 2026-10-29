import { Router } from "express";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { getSimilarArtists } from "../services/artistSimilarity";
import { listenBrainzService } from "../services/listenBrainz";
import { musicBrainzService } from "../services/musicbrainz";
import { resolveArtistMbid } from "../services/artistCorrection";
import { deezerService } from "../services/deezer";
import { wikidataService } from "../services/wikidata";
import { redisClient } from "../utils/redis";
import { requireAuthOrToken } from "../middleware/auth";
import {
    withAlbumArtwork,
    findAlbumArtwork,
    findArtistArtwork,
} from "../services/artwork";
import { safeError } from "../utils/errors";
import { proxyPreviewStream } from "../utils/previewProxy";
import { failureCause } from "../utils/outcome";

const router = Router();
router.use(requireAuthOrToken);

// Cache TTL for discovery content (shorter since it's not owned)
const DISCOVERY_CACHE_TTL = 24 * 60 * 60; // 24 hours

// MusicBrainz ids are UUIDs; anything else is a plain name.
const MBID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /artists/preview/:artistName/:trackTitle/stream - Proxy Deezer preview audio as same-origin media
router.get("/preview/:artistName/:trackTitle/stream", async (req, res) => {
    try {
        const { artistName, trackTitle } = req.params;
        const previewUrl = await deezerService.getFreshTrackPreview(
            artistName,
            trackTitle
        );

        if (!previewUrl) {
            return res.status(404).json({ error: "Preview not found" });
        }

        await proxyPreviewStream(res, previewUrl, {
            notFoundMessage: "Preview not found",
            logLabel: "Preview stream",
            rangeHeader: req.headers.range,
        });
    } catch (error) {
        safeError(res, "Track preview stream", error);
    }
});

// GET /artists/discover/:nameOrMbid - Get artist details for discovery (not in library yet)
router.get("/discover/:nameOrMbid", async (req, res) => {
    try {
        const { nameOrMbid } = req.params;

        // Check Redis cache first for discovery content
        const cacheKey = `discovery:artist:${nameOrMbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[Discovery] Cache hit for artist: ${nameOrMbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch {
            // A failed cache read falls through to a fresh lookup.
        }

        const isMbid = MBID_PATTERN.test(nameOrMbid);

        let mbid: string | null = isMbid ? nameOrMbid : null;
        let artistName: string = isMbid ? "" : nameOrMbid;
        // A page built while MusicBrainz failed is served but not cached.
        let complete = true;

        // If we have a name but no MBID, search for it
        if (!mbid && artistName) {
            const found = await resolveArtistMbid(artistName, undefined, {
                interactive: true,
            });
            if (found.kind === "answered") {
                mbid = found.value.mbid;
                artistName = found.value.name;
            } else if (found.kind === "absent") {
                logger.debug(
                    `[Discovery] no artist named ${artistName} on MusicBrainz`
                );
            } else {
                // A failed search is not "no such artist": serve the page
                // without the MBID-backed data and say so in the log.
                complete = false;
                logger.debug(
                    `[Discovery] MB artist search ${found.kind} for ${artistName}: ${failureCause(found)}`
                );
            }
        }

        // With an MBID but no name, ask MusicBrainz. Similar-artist tiles link MBIDs
        // of merged or deleted artists, so `absent` (and a failed call) answer 404.
        if (mbid && !artistName) {
            const mbArtist = await musicBrainzService.getArtist(mbid, undefined, {
                interactive: true,
            });
            if (mbArtist.kind === "answered") {
                artistName = mbArtist.value.name;
            } else if (mbArtist.kind === "absent") {
                logger.debug(`MusicBrainz does not know artist ${mbid}`);
            } else {
                complete = false;
                logger.debug(
                    `MusicBrainz artist lookup ${mbArtist.kind} for ${mbid}: ${failureCause(mbArtist)}`
                );
            }
        }

        if (!artistName) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Bio: Wikidata first, Wikipedia abstract via the MB sitelink
        // second — both live inside wikidataService.getArtistInfo.
        const wdInfo = mbid
            ? await withTimeout(
                  wikidataService.getArtistInfo(artistName, mbid, { interactive: true }),
                  8000,
                  "Wikidata getArtistInfo timed out"
              ).catch(() => null)
            : null;
        const bio = wdInfo?.summary || null;

        // Artist artwork (parallel)
        const artworkPromise = findArtistArtwork({
            name: artistName,
            mbid: mbid || undefined,
            interactive: true,
        })
            .then((r) => r?.url ?? null)
            .catch(() => null);

        // Discography from MusicBrainz (parallel)
        const discographyPromise = (async (): Promise<any[]> => {
            if (!mbid) return [];
            const rgs = await musicBrainzService.getReleaseGroups(mbid, undefined, undefined, {
                interactive: true,
            });
            if (rgs.kind !== "answered") {
                if (rgs.kind !== "absent") complete = false;
                logger.debug(
                    `[Discovery] discography for ${artistName}: ${
                        rgs.kind === "absent"
                            ? "MusicBrainz has no release-groups"
                            : failureCause(rgs)
                    }`
                );
                return [];
            }
            try {
                // Filter albums - only show studio albums and EPs
                const filteredReleaseGroups = rgs.value.filter(
                    (rg: any) => {
                        const isPrimaryType =
                            rg["primary-type"] === "Album" ||
                            rg["primary-type"] === "EP";
                        if (!isPrimaryType) return false;

                        const secondaryTypes = rg["secondary-types"] || [];
                        const hasExcludedType = secondaryTypes.some(
                            (type: string) =>
                                [
                                    "Live",
                                    "Compilation",
                                    "Soundtrack",
                                    "Remix",
                                    "DJ-mix",
                                    "Mixtape/Street",
                                ].includes(type)
                        );

                        return !hasExcludedType;
                    }
                );

                const candidates = filteredReleaseGroups.map((rg: any) => ({
                    id: rg.id,
                    rgMbid: rg.id,
                    mbid: rg.id,
                    title: rg.title,
                    type: rg["primary-type"],
                    year: rg["first-release-date"]
                        ? parseInt(rg["first-release-date"].substring(0, 4))
                        : null,
                    releaseDate: rg["first-release-date"] || null,
                    coverUrl: null as string | null,
                    owned: false,
                }));

                const enriched = await withAlbumArtwork(
                    candidates,
                    (a: any) => ({
                        rgMbid: a.rgMbid,
                        artistName,
                        albumTitle: a.title,
                    }),
                    (a: any, coverUrl: string | null) => ({ ...a, coverUrl }),
                );

                enriched.sort((a: any, b: any) => {
                    if (a.year && b.year) return b.year - a.year;
                    if (a.year) return -1;
                    if (b.year) return 1;
                    return 0;
                });
                return enriched;
            } catch (error) {
                logger.error(
                    `Failed to get discography for ${artistName}:`,
                    error
                );
            }
            return [];
        })();

        // Every album here is one the listener does not own.
        const [image, albums] = await Promise.all([
            artworkPromise,
            discographyPromise,
        ]);

        // Similar artists: ListenBrainz, then Deezer, nudged by the library's matching;
        // images through the artwork cascade (Fanart, Deezer).
        const similarList = await getSimilarArtists(
            mbid || "",
            artistName,
            10,
            { interactive: true }
        );
        const similarArtists = await Promise.all(
            similarList.map(async (s) => {
                const image =
                    (
                        await findArtistArtwork({
                            name: s.name,
                            mbid: s.mbid || undefined,
                            interactive: true,
                        })
                    )?.url ?? null;

                return {
                    id: s.mbid || s.name,
                    name: s.name,
                    mbid: s.mbid || null,
                    url: s.url,
                    image,
                };
            })
        );

        // Genres from the MusicBrainz artist record.
        let tags: string[] = [];
        if (mbid) {
            const mbArtist = await musicBrainzService.getArtist(mbid, [
                "genres",
            ], { interactive: true });
            if (mbArtist.kind === "answered") {
                tags = (mbArtist.value.genres || [])
                    .sort((a: any, b: any) => (b.count || 0) - (a.count || 0))
                    .slice(0, 5)
                    .map((g: any) => g.name)
                    .filter(Boolean);
            } else if (mbArtist.kind !== "absent") {
                logger.debug(
                    `MB genres ${mbArtist.kind} for ${artistName}: ${failureCause(mbArtist)}`
                );
            }
        }

        // Popular tracks: global popularity, not the local echo. Same tiers
        // as the library artist page (LB sitewide top recordings, then Deezer),
        // but with no owned library to join against, every row is unowned and
        // previewable.
        let topTracks: any[] = [];
        if (mbid) {
            try {
                topTracks = (
                    await listenBrainzService.getTopRecordingsForArtist(mbid, req.user!.id, 10)
                ).map((r) => ({
                    id: r.recordingMbid,
                    title: r.title,
                    duration: Math.round(r.lengthMs / 1000) || 0,
                    playCount: r.playCount,
                    listeners: r.listeners,
                    userPlayCount: 0,
                    popularitySource: "listenbrainz",
                    album: {
                        id: null,
                        title: r.releaseName || "Unknown Album",
                    },
                }));
            } catch (lbError) {
                logger.debug(
                    `[Discovery] LB top recordings failed for ${artistName}:`,
                    lbError
                );
            }
        }
        if (topTracks.length === 0) {
            try {
                topTracks = (await deezerService.getArtistTopTracks(artistName, 10)).map(
                    (r) => ({
                        id: `dz:${r.title.toLowerCase()}`,
                        title: r.title,
                        duration: Math.round(r.durationMs / 1000) || 0,
                        playCount: r.rank,
                        listeners: 0,
                        userPlayCount: 0,
                        popularitySource: "deezer",
                        previewUrl: r.previewUrl,
                        album: {
                            id: null,
                            title: r.album || "Unknown Album",
                            coverUrl: r.coverUrl,
                            coverArt: r.coverUrl,
                        },
                    })
                );
            } catch (dzError) {
                logger.debug(
                    `[Discovery] Deezer top tracks failed for ${artistName}:`,
                    dzError
                );
            }
        }

        const response = {
            mbid,
            name: artistName,
            image,
            bio, // Wikidata/Wikipedia abstract
            summary: bio, // Alias for consistency
            tags,
            genres: tags, // Alias for consistency
            listeners: 0,
            playcount: 0,
            url: mbid ? `https://musicbrainz.org/artist/${mbid}` : null,
            albums,
            // Global popularity tiers above (LB sitewide, then Deezer); empty
            // only when both clouds were unavailable.
            topTracks,
            similarArtists,
        };

        // Cache discovery response for 24 hours
        if (complete) {
            try {
                await redisClient.setex(
                    cacheKey,
                    DISCOVERY_CACHE_TTL,
                    JSON.stringify(response)
                );
                logger.debug(`[Discovery] Cached artist: ${artistName}`);
            } catch {
                // A failed cache write only means the next request looks it up again.
            }
        }

        res.json(response);
    } catch (error) {
        safeError(res, "Artist discovery", error);
    }
});

// GET /artists/album/:mbid - Get album details for discovery (not in library yet)
router.get("/album/:mbid", async (req, res) => {
    try {
        const { mbid } = req.params;

        // MusicBrainz ids are UUIDs; anything else cannot exist, so answer 404
        // without spending a rate-limited request.
        if (!MBID_PATTERN.test(mbid)) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Check Redis cache first for discovery content
        const cacheKey = `discovery:album:${mbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[Discovery] Cache hit for album: ${mbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch {
            // A failed cache read falls through to a fresh lookup.
        }

        let releaseGroup: any = null;
        let release: any = null;
        let releaseGroupId: string = mbid;
        // A page built while MusicBrainz failed is served but not cached.
        let complete = true;

        // Try as release-group first, then as release.
        const rgOutcome = await musicBrainzService.getReleaseGroup(mbid);
        if (rgOutcome.kind === "answered") {
            releaseGroup = rgOutcome.value;
        } else if (
            rgOutcome.kind === "absent" ||
            rgOutcome.kind === "permanent"
        ) {
            // Any "you asked for something that isn't there" answer means
            // this is not a release-group, so try it as a release.
            logger.debug(`${mbid} is not a release-group, trying as release...`);
            const relOutcome = await musicBrainzService.getRelease(mbid);
            if (relOutcome.kind === "answered") {
                release = relOutcome.value;
            } else if (relOutcome.kind === "absent") {
                // A well-formed id that MusicBrainz knows nothing about as
                // either a release-group or a release is simply an album
                // that does not exist.
                return res.status(404).json({ error: "Album not found" });
            } else {
                // A failed call is not "album not found": the page cannot
                // be built honestly without the data, so say what happened.
                logger.debug(
                    `MB release lookup ${relOutcome.kind} for ${mbid}: ${failureCause(relOutcome)}`
                );
                return res
                    .status(503)
                    .json({ error: "MusicBrainz is not answering" });
            }
            releaseGroupId = release["release-group"]?.id || mbid;

            // The release group carries the type and first-release date.
            const rg2 = await musicBrainzService.getReleaseGroup(releaseGroupId);
            if (rg2.kind === "answered") {
                releaseGroup = rg2.value;
            } else {
                if (rg2.kind !== "absent") complete = false;
                logger.debug(
                    `Failed to get release-group ${releaseGroupId}: ${
                        rg2.kind === "absent"
                            ? "no such release-group"
                            : failureCause(rg2)
                    }`
                );
            }
        } else {
            // Neither answer nor "not there" — the lookup itself failed;
            // that is a server-side problem, not a missing album.
            logger.debug(
                `MB release-group lookup ${rgOutcome.kind} for ${mbid}: ${failureCause(rgOutcome)}`
            );
            return res
                .status(503)
                .json({ error: "MusicBrainz is not answering" });
        }

        // Get the artist name and MBID from either release-group or release
        const artistCredit =
            releaseGroup?.["artist-credit"] || release?.["artist-credit"];
        const artistName = artistCredit?.[0]?.name || "Unknown Artist";
        const artistMbid = artistCredit?.[0]?.artist?.id;
        const albumTitle = releaseGroup?.title || release?.title;

        // Tracks come from the release if we have one, else the group's first release.
        let tracks: any[] = [];
        if (release) {
            tracks = release.media?.[0]?.tracks || [];
        } else if (releaseGroup?.releases && releaseGroup.releases.length > 0) {
            const firstRelease = releaseGroup.releases[0];
            const releaseDetails = await musicBrainzService.getRelease(
                firstRelease.id
            );
            if (releaseDetails.kind === "answered") {
                tracks = releaseDetails.value.media?.[0]?.tracks || [];
            } else {
                if (releaseDetails.kind !== "absent") complete = false;
                logger.error(
                    `Failed to get tracks for release ${firstRelease.id}: ${
                        releaseDetails.kind === "absent"
                            ? "no data on MusicBrainz"
                            : failureCause(releaseDetails)
                    }`
                );
            }
        }

        // Album cover art: ask the artwork cascade and accept null. A URL
        // that was never verified renders a broken box the browser eats
        // silently, and the failure never reaches this server.
        const coverUrl =
            (
                await findAlbumArtwork({
                    rgMbid: releaseGroupId,
                    artistName,
                    albumTitle,
                })
            )?.url ?? null;

        // Format response
        const releaseMbid = release?.id || null;

        const response = {
            id: releaseGroupId,
            rgMbid: releaseGroupId,
            mbid: releaseMbid || releaseGroupId,
            releaseMbid,
            title: albumTitle,
            artist: {
                name: artistName,
                id: artistMbid || artistName,
                mbid: artistMbid,
            },
            year: releaseGroup?.["first-release-date"]
                ? parseInt(releaseGroup["first-release-date"].substring(0, 4))
                : release?.date
                ? parseInt(release.date.substring(0, 4))
                : null,
            type: releaseGroup?.["primary-type"] || "Album",
            coverUrl,
            coverArt: coverUrl, // Alias for compatibility
            bio: releaseGroup?.annotation || release?.annotation || null,
            tags: (releaseGroup?.tags || [])
                .map((t: any) => t?.name)
                .filter(Boolean)
                .slice(0, 5),
            tracks: tracks.map((track: any, index: number) => ({
                id: `mb-${releaseGroupId}-${track.id || index}`,
                title: track.title,
                trackNo: track.position || index + 1,
                discNumber: null,
                discSubtitle: null,
                duration: track.length ? Math.floor(track.length / 1000) : 0,
                artist: { name: artistName },
            })),
            owned: false,
            source: "discovery",
        };

        // Cache discovery response for 24 hours
        if (complete) {
            try {
                await redisClient.setex(
                    cacheKey,
                    DISCOVERY_CACHE_TTL,
                    JSON.stringify(response)
                );
                logger.debug(`[Discovery] Cached album: ${albumTitle}`);
            } catch {
                // A failed cache write only means the next request looks it up again.
            }
        }

        res.json(response);
    } catch (error) {
        safeError(res, "Album discovery", error);
    }
});

export default router;
