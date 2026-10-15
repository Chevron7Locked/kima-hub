/**
 * Album metadata enrichment from MusicBrainz: release group identity, then
 * genres, label and original year from its catalogue.
 */

import { logger } from "../utils/logger";
import { isMbid } from "./artistIdentity";
import { titlesAgree } from "./albumIdentity";
import { resolveArtistMbidFromDiscography } from "./artistCorrection";
import { prisma } from "../utils/db";
import { musicBrainzService } from "./musicbrainz";
import { topVoted } from "../utils/votes";
import { failureCause } from "../utils/outcome";
import { findAlbumArtwork, findArtistArtwork } from "./artwork";
import { downloadAndStoreImage, isNativePath } from "./imageStorage";
import {
    DuplicateMbidError,
    reassignAlbumRgMbid,
    reassignArtistMbid,
} from "./mbidReassign";
import { getSimilarArtists } from "./artistSimilarity";
import { wikidataService } from "./wikidata";

interface EnrichmentSettings {
    enabled: boolean;
    sources: {
        musicbrainz: boolean;
    };
}

interface ArtistEnrichmentData {
    mbid?: string;
    bio?: string;
    genres?: string[];
    tags?: string[];
    similarArtists?: string[];
    heroUrl?: string;
    formed?: number;
    confidence: number;
}

interface AlbumEnrichmentData {
    rgMbid?: string;
    releaseDate?: Date;
    albumType?: string;
    genres?: string[];
    tags?: string[];
    label?: string;
    coverUrl?: string;
    trackCount?: number;
    confidence: number;
}

class EnrichmentService {
    private defaultSettings: EnrichmentSettings = {
        enabled: false, // Opt-in by default
        sources: {
            musicbrainz: true,
        },
    };

    /**
     * Get enrichment settings for a user
     */
    async getSettings(userId: string): Promise<EnrichmentSettings> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { enrichmentSettings: true },
        });

        if (user?.enrichmentSettings) {
            let userSettings: any;
            if (typeof user.enrichmentSettings === "string") {
                userSettings = JSON.parse(user.enrichmentSettings);
            } else {
                userSettings = user.enrichmentSettings;
            }

            return {
                ...this.defaultSettings,
                ...userSettings,
                sources: {
                    ...this.defaultSettings.sources,
                    ...(userSettings.sources || {}),
                },
            };
        }

        return this.defaultSettings;
    }

    /**
     * Enrich a single artist with metadata from multiple sources
     */
    async enrichArtist(
        artistId: string,
        settings?: EnrichmentSettings
    ): Promise<ArtistEnrichmentData | null> {
        const config = settings || this.defaultSettings;
        if (!config.enabled) {
            return null;
        }

        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: { id: true, name: true, mbid: true },
        });

        if (!artist) {
            // Null reaches the route's 404 branch; a throw would answer 500.
            logger.debug(`Artist ${artistId} not found; nothing to enrich`);
            return null;
        }

        logger.debug(`Enriching artist: ${artist.name}`);

        const enrichmentData: ArtistEnrichmentData = {
            confidence: 0,
        };

        // Step 1: Get/verify MBID from MusicBrainz
        if (
            config.sources.musicbrainz &&
            !isMbid(artist.mbid)
        ) {
            const found = await resolveArtistMbidFromDiscography(
                artist.id,
                artist.name
            );
            if (found.kind === "answered") {
                enrichmentData.mbid = found.value.mbid;
                enrichmentData.confidence += 0.4;
                logger.debug(`  Found MBID: ${enrichmentData.mbid} (${found.evidence.by})`);
            } else if (found.kind === "absent") {
                logger.debug(`  No verified MusicBrainz match for ${artist.name}`);
            } else {
                logger.error(`  MusicBrainz lookup ${found.kind}: ${failureCause(found)}`);
            }
        }

        // Step 2: bio from Wikidata, similar artists from the local
        // centroid / ListenBrainz path — runs unconditionally, there is no
        // per-source toggle for it.
        try {
            const artistMbid = enrichmentData.mbid || artist.mbid;
            if (isMbid(artistMbid)) {
                const wd = await wikidataService.getArtistInfo(
                    artist.name,
                    artistMbid
                );
                if (wd?.summary) {
                    enrichmentData.bio = wd.summary;
                    enrichmentData.confidence += 0.3;
                }
                const similar = await getSimilarArtists(
                    artistMbid,
                    artist.name,
                    10
                );
                enrichmentData.similarArtists = similar.map(
                    (a) => a.name
                );
                logger.debug(`  Found ${similar.length} similar artists`);
            }
        } catch (error) {
            logger.error(` Similarity/bio lookup failed:`, error);
        }

        // Step 3: Get artist image from multiple sources (Deezer → Fanart → MusicBrainz)
        try {
            const artistMbid = enrichmentData.mbid || artist.mbid;
            const imageResult = await findArtistArtwork({
                name: artist.name,
                mbid: isMbid(artistMbid) ? artistMbid : undefined,
            });

            if (imageResult) {
                enrichmentData.heroUrl = imageResult.url;
                enrichmentData.confidence += 0.2;
                logger.debug(`  Found artist image from ${imageResult.source}`);
            }
        } catch (error) {
            logger.error(
                `  ✗ Artist image lookup failed:`,
                error instanceof Error ? error.message : error
            );
        }

        logger.debug(
            `  Enrichment confidence: ${(
                enrichmentData.confidence * 100
            ).toFixed(0)}%`
        );

        return enrichmentData;
    }

    /**
     * Enrich a single album with metadata from multiple sources
     */
    async enrichAlbum(
        albumId: string,
        settings?: EnrichmentSettings
    ): Promise<AlbumEnrichmentData | null> {
        const config = settings || this.defaultSettings;
        if (!config.enabled) {
            return null;
        }

        const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: {
                artist: {
                    select: { name: true, mbid: true },
                },
            },
        });

        if (!album) {
            logger.debug(`Album ${albumId} not found; nothing to enrich`);
            return null;
        }

        logger.debug(
            `[Enrichment] Processing album: ${album.artist.name} - ${album.title}`
        );

        const enrichmentData: AlbumEnrichmentData = {
            confidence: 0,
        };

        // Identify the release group via the artist's discography (needs a real artist
        // MBID) or a title-checked search, then take genres, label and original year
        // from its catalogue in one cached two-request chain.
        if (config.sources.musicbrainz) {
            if (
                album.artist.mbid &&
                isMbid(album.artist.mbid)
            ) {
                const discography =
                    await musicBrainzService.getReleaseGroups(
                        album.artist.mbid,
                        ["album", "ep"],
                        50
                    );

                if (discography.kind === "answered") {
                    // Match titles with titlesAgree: exact, punctuation-insensitive, then without
                    // edition markers, since MusicBrainz files a deluxe or remaster as a release
                    // inside a plainly named group. The album keeps its own title either way.
                    const wanted = album.title;
                    const match =
                        discography.value.find(
                            (rg: any) =>
                                rg.title.toLowerCase() === wanted.toLowerCase()
                        ) ||
                        discography.value.find((rg: any) =>
                            titlesAgree(rg.title, wanted)
                        );

                    if (match) {
                        enrichmentData.rgMbid = match.id;
                        enrichmentData.albumType = match["primary-type"];
                        enrichmentData.releaseDate = match["first-release-date"]
                            ? new Date(match["first-release-date"])
                            : undefined;
                        enrichmentData.confidence += 0.5;
                        logger.debug(`  Found MBID: ${enrichmentData.rgMbid}`);
                    }
                } else if (discography.kind === "absent") {
                    logger.debug(
                        `  MusicBrainz has no release-groups for ${album.artist.name}`
                    );
                } else {
                    logger.error(
                        `  Discography lookup ${discography.kind}: ${failureCause(discography)}`
                    );
                }
            }

            // Untagged libraries have placeholder artist ids, so the discography path never
            // runs for them; search by name instead. The search's best hit is unchecked, so
            // it must pass titlesAgree too, or confident wrong ids get stamped on albums.
            if (!enrichmentData.rgMbid) {
                const hit = await musicBrainzService.searchAlbum(
                    album.title,
                    album.artist.name
                );

                if (
                    hit.kind === "answered" &&
                    titlesAgree(hit.value.title, album.title)
                ) {
                    enrichmentData.rgMbid = hit.value.id;
                    enrichmentData.confidence += 0.3;
                    logger.debug(
                        `  Found MBID by search: ${enrichmentData.rgMbid} ("${hit.value.title}")`
                    );
                } else if (hit.kind === "answered") {
                    logger.debug(
                        `  Rejected search hit "${hit.value.title}" for "${album.title}" — titles do not agree`
                    );
                } else if (hit.kind === "absent") {
                    logger.debug(`  No MusicBrainz hit for "${album.title}"`);
                } else {
                    logger.debug(
                        `  MusicBrainz album search ${hit.kind}: ${failureCause(hit)}`
                    );
                }
            }

            if (enrichmentData.rgMbid) {
                const chain = await musicBrainzService.getAlbumCatalogue(
                    enrichmentData.rgMbid
                );
                if (chain.kind === "answered") {
                    if (chain.value.genres.length > 0) {
                        enrichmentData.genres = topVoted(chain.value.genres, 5);
                    }
                    if (chain.value.label) {
                        enrichmentData.label = chain.value.label;
                        logger.debug(`  Found label: ${enrichmentData.label}`);
                    }
                    if (
                        chain.value.originalYear != null &&
                        !enrichmentData.releaseDate
                    ) {
                        enrichmentData.releaseDate = new Date(
                            `${chain.value.originalYear}-01-01`
                        );
                    }
                } else if (chain.kind !== "absent") {
                    logger.debug(
                        `  Album catalogue ${chain.kind}: ${failureCause(chain)}`
                    );
                }
            }
        }

        // Get cover art from multiple sources (Deezer → MusicBrainz → Fanart)
        try {
            const coverResult = await findAlbumArtwork({
                rgMbid: enrichmentData.rgMbid,
                artistName: album.artist.name,
                albumTitle: album.title,
            });

            if (coverResult) {
                enrichmentData.coverUrl = coverResult.url;
                enrichmentData.confidence += 0.2;
                logger.debug(`  Found cover art from ${coverResult.source}`);
            }
        } catch (error) {
            logger.error(
                `  ✗ Album cover lookup failed:`,
                error instanceof Error ? error.message : error
            );
        }

        logger.debug(
            `  Enrichment confidence: ${(
                enrichmentData.confidence * 100
            ).toFixed(0)}%`
        );

        return enrichmentData;
    }

    /**
     * Apply enrichment data to an artist in the database
     */
    async applyArtistEnrichment(
        artistId: string,
        data: ArtistEnrichmentData
    ): Promise<void> {
        const updateData: any = {};

        // Reassign canonical MBID via shared helper (catches P2002 -> log+skip)
        if (data.mbid && data.mbid.trim() !== "") {
            try {
                await reassignArtistMbid(artistId, data.mbid.trim());
            } catch (err) {
                if (err instanceof DuplicateMbidError) {
                    logger.debug(
                        `MBID ${data.mbid} already in use, skipping artist mbid reassign`
                    );
                } else {
                    throw err;
                }
            }
        }

        if (data.bio) updateData.summary = data.bio;
        if (data.heroUrl) {
            if (!isNativePath(data.heroUrl)) {
                const current = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: { heroUrl: true },
                });
                // An existing local image wins over an external URL.
                if (!current?.heroUrl || !isNativePath(current.heroUrl)) {
                    const localPath = await downloadAndStoreImage(
                        data.heroUrl,
                        artistId,
                        "artist"
                    );
                    updateData.heroUrl = localPath || data.heroUrl;
                }
            } else {
                updateData.heroUrl = data.heroUrl;
            }
        }
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.artist.update({
                where: { id: artistId },
                data: updateData,
            });
            logger.debug(
                `   Saved ${data.genres?.length || 0} genres for artist`
            );
        }
    }

    /**
     * Apply enrichment data to an album in the database
     */
    async applyAlbumEnrichment(
        albumId: string,
        data: AlbumEnrichmentData
    ): Promise<void> {
        const updateData: any = {};

        // Reassign canonical rgMbid via shared helper (handles Album update + OwnedAlbum migration)
        if (data.rgMbid && data.rgMbid.trim() !== "") {
            try {
                await reassignAlbumRgMbid(albumId, data.rgMbid.trim(), { source: "search" });
            } catch (err) {
                if (err instanceof DuplicateMbidError) {
                    logger.debug(
                        `rgMbid ${data.rgMbid} already in use, skipping album rgMbid reassign`
                    );
                } else {
                    throw err;
                }
            }
        }

        if (data.coverUrl) {
            // Download cover locally if it's an external URL
            if (!isNativePath(data.coverUrl)) {
                const localPath = await downloadAndStoreImage(
                    data.coverUrl,
                    albumId,
                    "album"
                );
                updateData.coverUrl = localPath || data.coverUrl;
            } else {
                updateData.coverUrl = data.coverUrl;
            }
        }
        if (data.releaseDate) {
            updateData.originalYear = data.releaseDate.getUTCFullYear();
            updateData.year = data.releaseDate.getUTCFullYear();
        }
        if (data.label) updateData.label = data.label;
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.album.update({
                where: { id: albumId },
                data: updateData,
            });
            logger.debug(
                `   Saved album data: ${
                    data.genres?.length || 0
                } genres, label: ${data.label || "none"}`
            );
        }
    }

}

export const enrichmentService = new EnrichmentService();
