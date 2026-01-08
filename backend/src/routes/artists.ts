import { Router } from "express";
import { logger } from "../utils/logger";
import { lastFmService } from "../services/lastfm";
import { musicBrainzService } from "../services/musicbrainz";
import { fanartService } from "../services/fanart";
import { deezerService } from "../services/deezer";
import { redisClient } from "../utils/redis";
import { normalizeToArray } from "../utils/normalize";

const router = Router();

// Cache TTL for discovery content (shorter since it's not owned)
const DISCOVERY_CACHE_TTL = 24 * 60 * 60; // 24 hours

// GET /artists/preview/:artistName/:trackTitle - Get Deezer preview URL for a track
router.get("/preview/:artistName/:trackTitle", async (req, res) => {
    try {
        const { artistName, trackTitle } = req.params;
        const decodedArtist = decodeURIComponent(artistName);
        const decodedTrack = decodeURIComponent(trackTitle);

        logger.debug(
            `Getting preview for "${decodedTrack}" by ${decodedArtist}`
        );

        const previewUrl = await deezerService.getTrackPreview(
            decodedArtist,
            decodedTrack
        );

        if (previewUrl) {
            res.json({ previewUrl });
        } else {
            res.status(404).json({ error: "Preview not found" });
        }
    } catch (error: any) {
        logger.error("Preview fetch error:", error);
        res.status(500).json({
            error: "Failed to fetch preview",
            message: error.message,
        });
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
        } catch (err) {
            // Redis errors are non-critical
        }

        // Check if it's an MBID (UUID format) or name
        const isMbid =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                nameOrMbid
            );

        let mbid: string | null = isMbid ? nameOrMbid : null;
        let artistName: string = isMbid ? "" : decodeURIComponent(nameOrMbid);

        // If we have a name but no MBID, search for it
        if (!mbid && artistName) {
            const mbResults = await musicBrainzService.searchArtist(
                artistName,
                1
            );
            if (mbResults.length > 0) {
                mbid = mbResults[0].id;
                artistName = mbResults[0].name;
            }
        }

        // If we have MBID but no name, get it from MusicBrainz
        if (mbid && !artistName) {
            const mbArtist = await musicBrainzService.getArtist(mbid);
            artistName = mbArtist.name;
        }

        if (!artistName) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Get artist info from Last.fm
        const lastFmInfo = await lastFmService.getArtistInfo(
            artistName,
            mbid || undefined
        );

        // Filter out generic "multiple artists" biographies from Last.fm
        // These occur when Last.fm groups artists with the same name
        let bio = lastFmInfo?.bio?.summary || null;
        if (bio) {
            const lowerBio = bio.toLowerCase();
            if (
                (lowerBio.includes("there are") &&
                    (lowerBio.includes("artist") ||
                        lowerBio.includes("band")) &&
                    lowerBio.includes("with the name")) ||
                lowerBio.includes("there is more than one artist") ||
                lowerBio.includes("multiple artists")
            ) {
                // This is a disambiguation page - don't show it
                logger.debug(
                    `  Filtered out disambiguation biography for ${artistName}`
                );
                bio = null;
            }
        }

        // Get top tracks from Last.fm
        let topTracks: any[] = [];
        if (mbid || artistName) {
            try {
                topTracks = await lastFmService.getArtistTopTracks(
                    mbid || "",
                    artistName,
                    10
                );
            } catch (error) {
                logger.debug(`Failed to get top tracks for ${artistName}`);
            }
        }

        // Get artist image
        let image = null;

        // Try Fanart.tv first (if we have MBID)
        if (mbid) {
            try {
                image = await fanartService.getArtistImage(mbid);
                logger.debug(`Fanart.tv image for ${artistName}`);
            } catch (error) {
                logger.debug(
                    `✗ Failed to get Fanart.tv image for ${artistName}`
                );
            }
        }

        // Fallback to Deezer
        if (!image) {
            try {
                image = await deezerService.getArtistImage(artistName);
                if (image) {
                    logger.debug(`Deezer image for ${artistName}`);
                }
            } catch (error) {
                logger.debug(` Failed to get Deezer image for ${artistName}`);
            }
        }

        // Fallback to Last.fm (but filter placeholders)
        // NORMALIZATION: lastFmInfo.image could be a single object or array
        if (!image && lastFmInfo?.image) {
            const images = normalizeToArray(lastFmInfo.image);
            const lastFmImage = lastFmService.getBestImage(images);
            // Filter out Last.fm placeholder
            if (
                lastFmImage &&
                !lastFmImage.includes("2a96cbd8b46e442fc41c2b86b821562f")
            ) {
                image = lastFmImage;
                logger.debug(`Last.fm image for ${artistName}`);
            } else {
                logger.debug(` Last.fm returned placeholder for ${artistName}`);
            }
        }

        // Get discography from MusicBrainz
        let albums: any[] = [];
        if (mbid) {
            try {
                const releaseGroups = await musicBrainzService.getReleaseGroups(
                    mbid
                );

                // Filter albums - only show studio albums and EPs
                // Exclude live albums, compilations, soundtracks, remixes, etc.
                const filteredReleaseGroups = releaseGroups.filter(
                    (rg: any) => {
                        // Must be Album or EP
                        const isPrimaryType =
                            rg["primary-type"] === "Album" ||
                            rg["primary-type"] === "EP";
                        if (!isPrimaryType) return false;

                        // Exclude secondary types (live, compilation, soundtrack, remix, etc.)
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

                // Process albums with Deezer fallback
                albums = await Promise.all(
                    filteredReleaseGroups.map(async (rg: any) => {
                        // Default to Cover Art Archive URL
                        let coverUrl = `https://coverartarchive.org/release-group/${rg.id}/front-500`;

                        // For first 10 albums, try Deezer as fallback if Cover Art Archive doesn't have it
                        // (to avoid too many requests)
                        const index = filteredReleaseGroups.indexOf(rg);
                        if (index < 10) {
                            try {
                                const response = await fetch(coverUrl, {
                                    method: "HEAD",
                                    signal: AbortSignal.timeout(2000),
                                });
                                if (!response.ok) {
                                    // Cover Art Archive doesn't have it, try Deezer
                                    const deezerCover =
                                        await deezerService.getAlbumCover(
                                            artistName,
                                            rg.title
                                        );
                                    if (deezerCover) {
                                        coverUrl = deezerCover;
                                    }
                                }
                            } catch (error) {
                                // Silently fail and keep Cover Art Archive URL
                            }
                        }

                        return {
                            id: rg.id, // MBID - used for linking
                            rgMbid: rg.id, // Release group MBID - used for downloads
                            mbid: rg.id, // Fallback MBID
                            title: rg.title,
                            type: rg["primary-type"],
                            year: rg["first-release-date"]
                                ? parseInt(
                                      rg["first-release-date"].substring(0, 4)
                                  )
                                : null,
                            releaseDate: rg["first-release-date"] || null,
                            coverUrl,
                            owned: false, // Discovery albums are never owned
                        };
                    })
                );

                // Sort albums
                albums.sort((a: any, b: any) => {
                    // Sort by year descending (newest first)
                    if (a.year && b.year) return b.year - a.year;
                    if (a.year) return -1;
                    if (b.year) return 1;
                    return 0;
                });
            } catch (error) {
                logger.error(
                    `Failed to get discography for ${artistName}:`,
                    error
                );
            }
        }

        // Get similar artists from Last.fm and fetch images
        // NORMALIZATION: lastFmInfo.similar.artist could be a single object or array
        const similarArtistsRaw = normalizeToArray(lastFmInfo?.similar?.artist);
        const similarArtists = await Promise.all(
            similarArtistsRaw.slice(0, 10).map(async (artist: any) => {
                // NORMALIZATION: artist.image could be a single object or array
                const images = normalizeToArray(artist.image);
                const similarImage = images.find(
                    (img: any) => img.size === "large"
                )?.[" #text"];

                let image = null;

                // Try Fanart.tv first (if we have MBID)
                if (artist.mbid) {
                    try {
                        image = await fanartService.getArtistImage(artist.mbid);
                    } catch (error) {
                        // Silently fail
                    }
                }

                // Fallback to Deezer
                if (!image) {
                    try {
                        const deezerImage = await deezerService.getArtistImage(
                            artist.name
                        );
                        if (deezerImage) {
                            image = deezerImage;
                        }
                    } catch (error) {
                        // Silently fail
                    }
                }

                // Last fallback to Last.fm (but filter placeholders)
                if (
                    !image &&
                    similarImage &&
                    !similarImage.includes("2a96cbd8b46e442fc41c2b86b821562f")
                ) {
                    image = similarImage;
                }

                return {
                    id: artist.mbid || artist.name,
                    name: artist.name,
                    mbid: artist.mbid || null,
                    url: artist.url,
                    image,
                };
            })
        );

        // NORMALIZATION: lastFmInfo.tags.tag could be a single object or array
        const tags = normalizeToArray(lastFmInfo?.tags?.tag)
            .map((t: any) => t?.name)
            .filter(Boolean);

        const response = {
            mbid,
            name: artistName,
            image,
            bio, // Use filtered bio instead of raw Last.fm bio
            summary: bio, // Alias for consistency
            tags,
            genres: tags, // Alias for consistency
            listeners: parseInt(lastFmInfo?.stats?.listeners || "0"),
            playcount: parseInt(lastFmInfo?.stats?.playcount || "0"),
            url: lastFmInfo?.url || null,
            albums: albums.map((album) => ({ ...album, owned: false })), // Mark all as not owned
            topTracks: topTracks.map((track) => ({
                id: `lastfm-${mbid || artistName}-${track.name}`,
                title: track.name,
                playCount: parseInt(track.playcount || "0"),
                listeners: parseInt(track.listeners || "0"),
                duration: parseInt(track.duration || "0"),
                url: track.url,
                album: { title: track.album?.["#text"] || "Unknown Album" },
            })),
            similarArtists,
        };

        // Cache discovery response for 24 hours
        try {
            await redisClient.setEx(
                cacheKey,
                DISCOVERY_CACHE_TTL,
                JSON.stringify(response)
            );
            logger.debug(`[Discovery] Cached artist: ${artistName}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error: any) {
        logger.error("Artist discovery error:", error);
        res.status(500).json({
            error: "Failed to fetch artist details",
            message: error.message,
        });
    }
});

// GET /artists/album/:mbid - Get album details for discovery (not in library yet)
router.get("/album/:mbid", async (req, res) => {
    try {
        const { mbid } = req.params;

        // Check Redis cache first for discovery content
        const cacheKey = `discovery:album:${mbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[Discovery] Cache hit for album: ${mbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        let releaseGroup: any = null;
        let release: any = null;
        let releaseGroupId: string = mbid;

        // Try as release-group first, then as release
        try {
            releaseGroup = await musicBrainzService.getReleaseGroup(mbid);
        } catch (error: any) {
            // If 404, try as a release instead
            if (error.response?.status === 404) {
                logger.debug(
                    `${mbid} is not a release-group, trying as release...`
                );
                release = await musicBrainzService.getRelease(mbid);
                releaseGroupId = release["release-group"]?.id || mbid;

                // Now get the release group to get the type and first-release-date
                if (releaseGroupId) {
                    try {
                        releaseGroup = await musicBrainzService.getReleaseGroup(
                            releaseGroupId
                        );
                    } catch (err) {
                        logger.error(
                            `Failed to get release-group ${releaseGroupId}`
                        );
                    }
                }
            } else {
                throw error;
            }
        }

        if (!releaseGroup && !release) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Get the artist name and MBID from either release-group or release
        const artistCredit =
            releaseGroup?.["artist-credit"] || release?.["artist-credit"];
        const artistName = artistCredit?.[0]?.name || "Unknown Artist";
        const artistMbid = artistCredit?.[0]?.artist?.id;
        const albumTitle = releaseGroup?.title || release?.title;

        // Get album info from Last.fm
        let lastFmInfo = null;
        try {
            lastFmInfo = await lastFmService.getAlbumInfo(
                artistName,
                albumTitle
            );
        } catch (error) {
            logger.debug(`Failed to get Last.fm info for ${albumTitle}`);
        }

        // Get tracks - if we have release, use it directly; otherwise get first release from group
        let tracks: any[] = [];
        if (release) {
            tracks = release.media?.[0]?.tracks || [];
        } else if (releaseGroup?.releases && releaseGroup.releases.length > 0) {
            const firstRelease = releaseGroup.releases[0];
            try {
                const releaseDetails = await musicBrainzService.getRelease(
                    firstRelease.id
                );
                tracks = releaseDetails.media?.[0]?.tracks || [];
            } catch (error) {
                logger.error(
                    `Failed to get tracks for release ${firstRelease.id}`
                );
            }
        }

        // Get album cover art - try Cover Art Archive first
        let coverUrl = null;
        let coverArtUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
        if (!release) {
            coverArtUrl = `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`;
        }

        // Check if Cover Art Archive actually has the image
        try {
            const response = await fetch(coverArtUrl, { method: "HEAD" });
            if (response.ok) {
                coverUrl = coverArtUrl;
                logger.debug(`Cover Art Archive has cover for ${albumTitle}`);
            } else {
                logger.debug(
                    `✗ Cover Art Archive 404 for ${albumTitle}, trying Deezer...`
                );
            }
        } catch (error) {
            logger.debug(
                `✗ Cover Art Archive check failed for ${albumTitle}, trying Deezer...`
            );
        }

        // Fallback to Deezer if Cover Art Archive doesn't have it
        if (!coverUrl) {
            try {
                const deezerCover = await deezerService.getAlbumCover(
                    artistName,
                    albumTitle
                );
                if (deezerCover) {
                    coverUrl = deezerCover;
                    logger.debug(`Deezer has cover for ${albumTitle}`);
                } else {
                    // Final fallback to Cover Art Archive URL (might 404, but better than nothing)
                    coverUrl = coverArtUrl;
                }
            } catch (error) {
                logger.debug(` Deezer lookup failed for ${albumTitle}`);
                // Final fallback to Cover Art Archive URL
                coverUrl = coverArtUrl;
            }
        }

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
            bio: lastFmInfo?.wiki?.summary || null,
            // NORMALIZATION: Already applied here correctly
            tags: normalizeToArray(lastFmInfo?.tags?.tag) 
                .map((t: any) => t?.name) 
                .filter(Boolean),
            tracks: tracks.map((track: any, index: number) => ({
                id: `mb-${releaseGroupId}-${track.id || index}`,
                title: track.title,
                trackNo: track.position || index + 1,
                duration: track.length ? Math.floor(track.length / 1000) : 0,
                artist: { name: artistName },
            })),
            similarAlbums: [], // Similar album recommendations not yet implemented
            owned: false,
            source: "discovery",
        };

        // Cache discovery response for 24 hours
        try {
            await redisClient.setEx(
                cacheKey,
                DISCOVERY_CACHE_TTL,
                JSON.stringify(response)
            );
            logger.debug(`[Discovery] Cached album: ${albumTitle}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error: any) {
        logger.error("Album discovery error:", error);
        res.status(500).json({
            error: "Failed to fetch album details",
            message: error.message,
        });
    }
});

export default router;
