/** Seed artists for discovery (recent plays, else the library) and album ownership checks. */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { lidarrService } from '../lidarr';
import { subWeeks } from 'date-fns';
import { normalizeForMatching, stringSimilarity } from '../../utils/normalization';
import { LIBRARY_LOCATION } from '../libraryFilters';
import { hasRealArtistId } from './discoverEvidence';
import { playCounts } from '../stats/listens';

export interface SeedArtist {
    name: string;
    /** absent or null when MusicBrainz has not resolved this artist yet. */
    mbid?: string | null;
}

/**
 * Owned-album snapshot, rebuilt once per TTL instead of queried per candidate.
 * `albums` holds every Album row regardless of location; callers that need
 * LIBRARY only filter on it.
 */
interface OwnedAlbumIndex {
    albums: Array<{ artistName: string; title: string; location: string; rgMbid: string }>;
    ownedAlbumArtists: Array<{ artistName: string; rgMbid: string }>;
    albumTitleByRgMbid: Map<string, string>;
}

export class DiscoverySeeding {
    private readonly DEFAULT_SEED_COUNT = 10;
    private readonly MIN_PLAYS_THRESHOLD = 5;
    private readonly RECENT_PLAYS_LIMIT = 50;
    private readonly OWNED_INDEX_TTL_MS = 5 * 60 * 1000; // one discovery run's worth of candidate checks
    private ownedIndexCache: (OwnedAlbumIndex & { builtAt: number }) | null = null;
    private ownedIndexLoad: Promise<OwnedAlbumIndex> | null = null;

    /** Seed artists from the user's last four weeks of plays, a play in the last two weeks counting double; the library's most engaged artists when there are too few plays. */
    async getSeedArtists(userId: string, seedCount?: number): Promise<SeedArtist[]> {
        const limit = seedCount ?? this.DEFAULT_SEED_COUNT;
        const twoWeeksAgo = subWeeks(new Date(), 2);
        const fourWeeksAgo = subWeeks(new Date(), 4);

        const recentPlays = await playCounts(userId, {
            since: fourWeeksAgo,
            song: { album: { location: LIBRARY_LOCATION } },
            sources: ['LIBRARY'],
        });

        const weightedPlays = recentPlays
            .map(play => {
                const weight = play.lastPlayedAt >= twoWeeksAgo ? 2 : 1;
                return {
                    trackId: play.trackId,
                    weightedCount: play.plays * weight,
                    rawCount: play.plays,
                };
            })
            .filter(p => p.rawCount >= this.MIN_PLAYS_THRESHOLD) // Filter <5 plays
            .sort((a, b) => b.weightedCount - a.weightedCount)
            .slice(0, this.RECENT_PLAYS_LIMIT);

        if (weightedPlays.length < this.MIN_PLAYS_THRESHOLD) {
            return this.getFallbackSeedArtists(limit);
        }

        const tracks = await prisma.track.findMany({
            where: {
                id: { in: weightedPlays.map((p) => p.trackId) },
                album: { location: LIBRARY_LOCATION },
            },
            include: { album: { include: { artist: true } } },
        });

        // Most played first: the rows come back in the database's order, so the plays' rank is walked, not the rows'.
        const trackById = new Map(tracks.map((track) => [track.id, track]));
        const artistMap = new Map<string, SeedArtist>();
        for (const { trackId } of weightedPlays) {
            const track = trackById.get(trackId);
            if (!track) continue;
            const artist = track.album.artist;
            if (!artistMap.has(track.album.artistId) && hasRealArtistId(artist.mbid)) {
                artistMap.set(track.album.artistId, {
                    name: artist.name,
                    mbid: artist.mbid,
                });
            }
        }

        const artists = Array.from(artistMap.values()).slice(0, limit);
        logger.debug(`[DiscoverySeeding] Found ${artists.length} recency-weighted seed artists`);
        return artists;
    }

    /** The artists with the most albums and tracks, for users with too little play history. Ties go by name, then id. */
    private async getFallbackSeedArtists(limit: number): Promise<SeedArtist[]> {
        logger.debug('[DiscoverySeeding] Insufficient play history, falling back to library');

        // Score: album count + track count / 10, over library albums; an artist with no real MBID cannot seed.
        const rows = await prisma.$queryRaw<Array<{ name: string; mbid: string }>>`
            SELECT ar.name, ar.mbid
            FROM "Artist" ar
            JOIN "Album" al ON al."artistId" = ar.id AND al.location = ${LIBRARY_LOCATION}::"AlbumLocation"
            LEFT JOIN "Track" t ON t."albumId" = al.id
            WHERE ar.mbid IS NOT NULL AND ar.mbid NOT LIKE 'temp-%'
            GROUP BY ar.id, ar.name, ar.mbid
            ORDER BY COUNT(DISTINCT al.id) + COUNT(t.id) / 10.0 DESC, ar.name ASC, ar.id ASC
            LIMIT ${limit}
        `;

        logger.debug(`[DiscoverySeeding] Selected ${rows.length} fallback artists by engagement score`);

        return rows.map((r) => ({ name: r.name, mbid: r.mbid }));
    }

    /** The owned-album snapshot, cached for OWNED_INDEX_TTL_MS. */
    async getOwnedAlbumIndex(): Promise<OwnedAlbumIndex> {
        const now = Date.now();
        if (this.ownedIndexCache && now - this.ownedIndexCache.builtAt < this.OWNED_INDEX_TTL_MS) {
            return this.ownedIndexCache;
        }
        // Single-flight: concurrent candidate checks on a cold/expired cache share
        // one DB load instead of each firing the full-table album/ownedAlbum scan.
        if (!this.ownedIndexLoad) {
            this.ownedIndexLoad = this.buildOwnedAlbumIndex().finally(() => {
                this.ownedIndexLoad = null;
            });
        }
        return this.ownedIndexLoad;
    }

    private async buildOwnedAlbumIndex(): Promise<OwnedAlbumIndex> {
        const now = Date.now();
        const [albumRows, ownedAlbumRows] = await Promise.all([
            prisma.album.findMany({
                select: { rgMbid: true, title: true, location: true, artist: { select: { name: true } } },
            }),
            prisma.ownedAlbum.findMany({
                select: { rgMbid: true, artist: { select: { name: true } } },
            }),
        ]);

        // An OwnedAlbum names no title of its own. Its album row has one; with that row gone, a suggestion's record of the
        // same release group still does.
        const albumTitles = new Map(albumRows.map((a) => [a.rgMbid, a.title]));
        const untitled = ownedAlbumRows.map((o) => o.rgMbid).filter((rg) => !albumTitles.has(rg));
        const suggested = untitled.length > 0
            ? await prisma.discoveryAlbum.findMany({
                where: { rgMbid: { in: untitled } },
                select: { rgMbid: true, albumTitle: true },
            })
            : [];
        for (const record of suggested) {
            if (!albumTitles.has(record.rgMbid)) albumTitles.set(record.rgMbid, record.albumTitle);
        }

        const albums = albumRows.map((a) => ({
            artistName: a.artist.name,
            title: a.title,
            location: a.location as string,
            rgMbid: a.rgMbid,
        }));

        this.ownedIndexCache = {
            builtAt: now,
            albums,
            ownedAlbumArtists: ownedAlbumRows.map((o) => ({
                artistName: o.artist.name,
                rgMbid: o.rgMbid,
            })),
            albumTitleByRgMbid: albumTitles,
        };
        return this.ownedIndexCache;
    }

    /** Whether an album is owned: OwnedAlbum, Album, past discovery, pending downloads, Lidarr, then fuzzy names. */
    async isAlbumOwned(
        albumMbid: string,
        userId: string,
        artistName?: string,
        albumTitle?: string
    ): Promise<boolean> {
        // Exact MBID checks
        const ownedAlbum = await prisma.ownedAlbum.findFirst({
            where: { rgMbid: albumMbid },
        });
        if (ownedAlbum) return true;

        const existingAlbum = await prisma.album.findFirst({
            where: { rgMbid: albumMbid },
        });
        if (existingAlbum) return true;

        const previousDiscovery = await prisma.discoveryAlbum.findFirst({
            where: { rgMbid: albumMbid, userId },
        });
        if (previousDiscovery) return true;

        const pendingDownload = await prisma.downloadJob.findFirst({
            where: {
                targetMbid: albumMbid,
                status: { in: ['pending', 'processing'] },
            },
        });
        if (pendingDownload) return true;

        const inLidarr = await lidarrService.isAlbumAvailable(albumMbid);
        if (inLidarr) return true;

        const recentlyRecommended = await this.wasRecentlyRecommended(albumMbid, userId);
        if (recentlyRecommended) return true;

        const unavailable = await this.isAlbumUnavailable(albumMbid, userId);
        if (unavailable) return true;

        if (artistName && albumTitle) {
            const normArtist = normalizeForMatching(artistName);
            const artistFirstWord = normArtist.split(' ')[0];

            // Allow 2+ character names (handles U2, AC/DC, M83, etc.)
            if (artistFirstWord && artistFirstWord.length >= 2) {
                // Scan the cached owned-album snapshot in-memory instead of a
                // startsWith/contains query per candidate. Library albums and OwnedAlbum records both count:
                // an owned album whose album row is gone is still owned.
                const { albums, ownedAlbumArtists, albumTitleByRgMbid } = await this.getOwnedAlbumIndex();
                // Both sides normalised the same way: no leading article, no edition suffix.
                const normTitle = normalizeForMatching(albumTitle);
                const candidates: Array<{ artistName: string; title: string }> = albums.filter(
                    (a) => a.location === LIBRARY_LOCATION
                );
                for (const owned of ownedAlbumArtists) {
                    const title = albumTitleByRgMbid.get(owned.rgMbid);
                    if (title) candidates.push({ artistName: owned.artistName, title });
                }

                for (const album of candidates) {
                    if (
                        normalizeForMatching(album.artistName).startsWith(artistFirstWord) &&
                        stringSimilarity(normArtist, normalizeForMatching(album.artistName)) >= 75 &&
                        stringSimilarity(normTitle, normalizeForMatching(album.title)) >= 75
                    ) {
                        logger.debug(`[DiscoverySeeding] Fuzzy match: ${artistName} - ${albumTitle} = ${album.artistName} - ${album.title}`);
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /** Whether the album was recommended to this user in the last 12 weeks. */
    private async wasRecentlyRecommended(albumMbid: string, userId: string): Promise<boolean> {
        const EXCLUSION_WEEKS = 12;
        const exclusionCutoff = subWeeks(new Date(), EXCLUSION_WEEKS);

        const recentDiscovery = await prisma.discoveryAlbum.findFirst({
            where: {
                rgMbid: albumMbid,
                userId,
                weekStartDate: { gte: exclusionCutoff },
            },
        });

        if (recentDiscovery) {
            logger.debug(`[DiscoverySeeding] Album ${albumMbid} excluded - discovered within last ${EXCLUSION_WEEKS} weeks`);
            return true;
        }

        return false;
    }

    /** Whether the album failed to download for this user in the last 4 weeks. */
    private async isAlbumUnavailable(albumMbid: string, userId: string): Promise<boolean> {
        const UNAVAILABLE_RETRY_WEEKS = 4;
        const retryCutoff = subWeeks(new Date(), UNAVAILABLE_RETRY_WEEKS);

        const recentFailure = await prisma.unavailableAlbum.findFirst({
            where: {
                albumMbid,
                userId,
                weekStartDate: { gte: retryCutoff },
            },
        });

        if (recentFailure) {
            logger.debug(`[DiscoverySeeding] Album ${albumMbid} unavailable - failed within last ${UNAVAILABLE_RETRY_WEEKS} weeks`);
            return true;
        }

        return false;
    }
}

export const discoverySeeding = new DiscoverySeeding();
