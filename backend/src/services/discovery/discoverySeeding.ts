/** Seed artists for discovery (recent plays, else the library) and album ownership checks. */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { lidarrService } from '../lidarr';
import { subWeeks } from 'date-fns';
import { normalizeForMatching, stringSimilarity } from '../../utils/normalization';
import { LIBRARY_LOCATION } from '../libraryFilters';
import { hasRealArtistId, sameArtist } from './discoverEvidence';
import { playCounts } from '../stats/listens';
import { ownedIndexVersion } from './ownedIndexVersion';

export interface SeedArtist {
    name: string;
    /** absent or null when MusicBrainz has not resolved this artist yet. */
    mbid?: string | null;
}

/**
 * Owned-album snapshot, rebuilt once per TTL instead of queried per candidate.
 * Only an album that is in the library counts as owned: `albums` holds LIBRARY rows alone, and `ownedAlbumArtists`
 * leaves out a record whose release group is only a Discover album ("Discover is only Discover").
 */
interface OwnedAlbumIndex {
    albums: Array<{ artistName: string; artistMbid: string | null; title: string; rgMbid: string }>;
    ownedAlbumArtists: Array<{ artistName: string; artistMbid: string | null; rgMbid: string }>;
    albumTitleByRgMbid: Map<string, string>;
}

export class DiscoverySeeding {
    private readonly DEFAULT_SEED_COUNT = 10;
    private readonly MIN_PLAYS_THRESHOLD = 5;
    private readonly RECENT_PLAYS_LIMIT = 50;
    private readonly OWNED_INDEX_TTL_MS = 5 * 60 * 1000; // one discovery run's worth of candidate checks
    /** The snapshot, with when and under which `ownedIndexVersion` it was read. */
    private ownedIndexCache: (OwnedAlbumIndex & { builtAt: number; version: number }) | null = null;
    private ownedIndexLoad: { version: number; promise: Promise<OwnedAlbumIndex> } | null = null;

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

        // Score: album count + track count / 10, over library albums; an artist with no real MBID cannot seed
        // (hasRealArtistId's rule: no MBID, or a temp- placeholder).
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

    /** The owned-album snapshot, cached for OWNED_INDEX_TTL_MS or until `forgetOwnedIndex`. */
    async getOwnedAlbumIndex(): Promise<OwnedAlbumIndex> {
        const now = Date.now();
        // A snapshot read under an older version predates a write that called `forgetOwnedIndex`, and so does a load
        // still reading under one; neither is used for a read that starts now.
        const version = ownedIndexVersion();
        if (this.ownedIndexCache && this.ownedIndexCache.version === version && now - this.ownedIndexCache.builtAt < this.OWNED_INDEX_TTL_MS) {
            return this.ownedIndexCache;
        }
        // Single-flight: concurrent candidate checks on a cold/expired cache share
        // one DB load instead of each firing the full-table album/ownedAlbum scan.
        if (!this.ownedIndexLoad || this.ownedIndexLoad.version !== version) {
            const load = {
                version,
                promise: this.buildOwnedAlbumIndex()
                    .then((index) => {
                        // Kept unless a newer load already stored a snapshot.
                        if (!this.ownedIndexCache || this.ownedIndexCache.version <= version) {
                            this.ownedIndexCache = { ...index, builtAt: now, version };
                        }
                        return index;
                    })
                    .finally(() => {
                        if (this.ownedIndexLoad === load) this.ownedIndexLoad = null;
                    }),
            };
            this.ownedIndexLoad = load;
        }
        return this.ownedIndexLoad.promise;
    }

    private async buildOwnedAlbumIndex(): Promise<OwnedAlbumIndex> {
        const [albumRows, ownedAlbumRows] = await Promise.all([
            prisma.album.findMany({
                select: { rgMbid: true, title: true, location: true, artist: { select: { name: true, mbid: true } } },
            }),
            prisma.ownedAlbum.findMany({
                select: { rgMbid: true, artist: { select: { name: true, mbid: true } } },
            }),
        ]);

        // A release group that is only a Discover album is not owned, even where an ownership record names it.
        const libraryRows = albumRows.filter((a) => a.location === LIBRARY_LOCATION);
        const libraryRgs = new Set(libraryRows.map((a) => a.rgMbid));
        const discoverOnlyRgs = new Set(
            albumRows.filter((a) => a.location !== LIBRARY_LOCATION && !libraryRgs.has(a.rgMbid)).map((a) => a.rgMbid)
        );
        const ownedRows = ownedAlbumRows.filter((o) => !discoverOnlyRgs.has(o.rgMbid));

        // An OwnedAlbum names no title of its own. Its library album row has one; with that row gone, a suggestion's
        // record of the same release group still does.
        const albumTitles = new Map(libraryRows.map((a) => [a.rgMbid, a.title]));
        const untitled = ownedRows.map((o) => o.rgMbid).filter((rg) => !albumTitles.has(rg));
        const suggested = untitled.length > 0
            ? await prisma.discoveryAlbum.findMany({
                where: { rgMbid: { in: untitled } },
                select: { rgMbid: true, albumTitle: true },
            })
            : [];
        for (const record of suggested) {
            if (!albumTitles.has(record.rgMbid)) albumTitles.set(record.rgMbid, record.albumTitle);
        }

        const albums = libraryRows.map((a) => ({
            artistName: a.artist.name,
            artistMbid: a.artist.mbid,
            title: a.title,
            rgMbid: a.rgMbid,
        }));

        return {
            albums,
            ownedAlbumArtists: ownedRows.map((o) => ({
                artistName: o.artist.name,
                artistMbid: o.artist.mbid,
                rgMbid: o.rgMbid,
            })),
            albumTitleByRgMbid: albumTitles,
        };
    }

    /**
     * Whether an album is owned: OwnedAlbum, Album, past discovery, pending downloads, Lidarr, then fuzzy names. The
     * fuzzy names never take an owned album of a namesake: another real MusicBrainz id than `artistMbid` is another
     * artist (sameArtist).
     */
    async isAlbumOwned(
        albumMbid: string,
        userId: string,
        artistName?: string,
        albumTitle?: string,
        artistMbid?: string | null
    ): Promise<boolean> {
        // Exact MBID checks. Only a library album is owned: a Discover album is not, and an ownership record counts
        // unless the album it names is in Discover (a record whose album row is gone still counts).
        const albumsOfRelease = await prisma.album.findMany({
            where: { rgMbid: albumMbid },
            select: { location: true },
        });
        if (albumsOfRelease.some((a) => a.location === LIBRARY_LOCATION)) return true;

        if (albumsOfRelease.length === 0) {
            const ownedAlbum = await prisma.ownedAlbum.findFirst({
                where: { rgMbid: albumMbid },
            });
            if (ownedAlbum) return true;
        }

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
                const candidates: Array<{ artistName: string; artistMbid: string | null; title: string }> = [...albums];
                for (const owned of ownedAlbumArtists) {
                    const title = albumTitleByRgMbid.get(owned.rgMbid);
                    if (title) candidates.push({ artistName: owned.artistName, artistMbid: owned.artistMbid, title });
                }

                const similarArtistNames = (owner: string) =>
                    normalizeForMatching(owner).startsWith(artistFirstWord) &&
                    stringSimilarity(normArtist, normalizeForMatching(owner)) >= 75;

                for (const album of candidates) {
                    if (
                        sameArtist(album, { artistName, artistMbid }, similarArtistNames) &&
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
