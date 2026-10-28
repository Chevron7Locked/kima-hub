import { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
import { createLidarrClient } from "./lidarrClient";
import { sourcePauseController } from "./sourcePauseController";
import { lidarrHealthMonitor } from "./lidarrHealth";
import { UserFacingError } from "../utils/errors";
import type {
    LidarrAlbum,
    LidarrArtist,
    LidarrTrack,
    LidarrTag,
    LidarrRootFolder,
    LidarrAddArtistRequest,
    LidarrQueueItem,
    LidarrQueueResponse,
    LidarrHistoryRecord,
} from "../types/lidarr";

/** Why an acquisition failed, which decides the fallback. */
export enum AcquisitionErrorType {
    ALBUM_NOT_FOUND = "ALBUM_NOT_FOUND",
    NO_RELEASES_AVAILABLE = "NO_RELEASES_AVAILABLE",
    ALREADY_OWNED = "ALREADY_OWNED",
    LIDARR_UNAVAILABLE = "LIDARR_UNAVAILABLE",
}

/** An acquisition failure carrying its type and whether the fallback may try again. */
export class AcquisitionError extends Error {
    public readonly type: AcquisitionErrorType;
    public readonly isRecoverable: boolean;
    public readonly originalError?: Error;

    constructor(
        message: string,
        type: AcquisitionErrorType,
        isRecoverable: boolean = true,
        originalError?: Error
    ) {
        super(message);
        this.name = "AcquisitionError";
        this.type = type;
        this.isRecoverable = isRecoverable;
        this.originalError = originalError;
        
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AcquisitionError);
        }
    }
}

const DISCOVERY_TAG_LABEL = "lidify-discovery";

// Lidarr ends a search with "{n} reports downloaded"; n counts grabs, not results.
const NOTHING_GRABBED = /\b0 reports downloaded/;
// Lidarr's rejections for a release no better than the files it already has.
const EXISTING_FILES = /^Existing files\b/i;

/** A multi-album release: Lidarr's discography flag, or a title advertising N releases. */
export function looksLikeBundle(r: { discography?: boolean; title?: string }): boolean {
    return r.discography === true || /\(\s*\d+\s+releases?\b/i.test(r.title ?? "");
}

/**
 * Does the bundle's title claim the wanted album? Title mention, or a year range
 * ("2017-2024") containing the album's release year, which is how Lidarr links a
 * discography release to albums.
 */
export function bundleCoversAlbum(releaseTitle: string | undefined, albumTitle: string, albumYear?: number): boolean {
    const rt = (releaseTitle ?? "").toLowerCase();
    if (rt.includes(albumTitle.toLowerCase())) return true;
    if (albumYear && albumYear > 0) {
        const m = rt.match(/(\d{4})\s*(?:-|–|—|to)\s*(\d{4})/);
        if (m && albumYear >= Number(m[1]) && albumYear <= Number(m[2])) return true;
    }
    return false;
}

function formatBytes(n?: number): string {
    if (!n && n !== 0) return "unknown size";
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
const RELEASE_SEARCH_TIMEOUT_MS = 90_000;

type SearchCommand = { commandId: number; status: string; message: string };

/** Connection failures, 5xx and Lidarr's SQLite lock clear on their own. */
function isTransient(error: any): boolean {
    if (error?.response) return error.response.status >= 500;
    return error?.isAxiosError === true || /database is locked/i.test(error?.message ?? "");
}

class LidarrService {
    private client: AxiosInstance | null = null;
    private enabled: boolean;
    private initialized: boolean = false;
    private qualityProfileId: number | null = null;
    private metadataProfileId: number | null = null;

    private readonly API_TIMEOUT_DEFAULT = 30000;

    private readonly COMMAND_POLL_TIMEOUT_DEFAULT = 30000;
    private readonly COMMAND_POLL_INTERVAL = 2000;

    private readonly METADATA_FETCH_MAX_ATTEMPTS = 10;
    private readonly METADATA_FETCH_DELAY = 2000;
    private readonly ARTIST_REFRESH_WAIT_MS = 5000;

    private artistCache: { data: LidarrArtist[]; fetchedAt: number } | null = null;
    private readonly ARTIST_CACHE_TTL = 30_000; // 30 seconds

    private artistAddInFlight = new Map<string, Promise<LidarrArtist | null>>();

    private readonly ARTIST_ADD_SETTLE_MS = 2000;

    constructor() {
        this.enabled = config.lidarr?.enabled || false;

        if (this.enabled && config.lidarr) {
            this.client = this.createClient(config.lidarr.url, config.lidarr.apiKey);
        }
    }

    /** An outage seen by any request triggers a health check at once. */
    private createClient(baseURL: string, apiKey: string): AxiosInstance {
        const client = createLidarrClient(baseURL, apiKey, this.API_TIMEOUT_DEFAULT);
        client.interceptors.response.use(undefined, (error) => {
            if (isTransient(error)) lidarrHealthMonitor.reportFailure();
            return Promise.reject(error);
        });
        return client;
    }

    private async ensureInitialized() {
        if (this.initialized) return;

        try {
            const settings = await getSystemSettings();
            this.qualityProfileId = settings?.lidarrQualityProfileId ?? null;
            this.metadataProfileId = settings?.lidarrMetadataProfileId ?? null;

            if (settings && settings.lidarrEnabled) {
                const url = settings.lidarrUrl || config.lidarr?.url;
                const apiKey = settings.lidarrApiKey || config.lidarr?.apiKey;

                if (url && apiKey) {
                    logger.debug("Lidarr configured from database");
                    this.client = this.createClient(url, apiKey);
                    this.enabled = true;
                } else {
                    logger.warn("  Lidarr enabled but missing URL or API key");
                    this.enabled = false;
                }
            } else if (config.lidarr) {
                logger.debug("Lidarr configured from .env");
                this.enabled = true;
            } else {
                logger.debug("  Lidarr not enabled");
                this.enabled = false;
            }
        } catch (error) {
            logger.error("Failed to load Lidarr settings:", error);
        }

        this.initialized = true;
    }

    private async requireClient(): Promise<AxiosInstance> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) throw new Error("Lidarr not enabled");
        return this.client;
    }

    async isEnabled(): Promise<boolean> {
        await this.ensureInitialized();
        return this.enabled;
    }

    reinitialize(): void {
        this.initialized = false;
        this.client = null;
        this.enabled = false;
    }

    /** The full artist list, cached for 30 s so an import fetches it a few times rather than once per album. */
    private async getArtistList(): Promise<LidarrArtist[]> {
        if (this.artistCache && (Date.now() - this.artistCache.fetchedAt) < this.ARTIST_CACHE_TTL) {
            return this.artistCache.data;
        }
        if (!this.client) throw new Error("Lidarr client not initialized");
        const response = await this.client.get("/api/v1/artist");
        this.artistCache = { data: response.data, fetchedAt: Date.now() };
        return this.artistCache.data;
    }

    private invalidateArtistCache(): void {
        this.artistCache = null;
    }

    /**
     * Where and how Lidarr files a new artist: the asked music folder (or Lidarr's
     * first), with the profiles chosen in Kima or else that folder's defaults.
     */
    private async newArtistTarget(requestedPath: string): Promise<{
        rootFolderPath: string;
        qualityProfileId: number;
        metadataProfileId: number;
    }> {
        const folders: LidarrRootFolder[] = (await this.client!.get("/api/v1/rootfolder")).data ?? [];
        const folder = folders.find((f) => f.path === requestedPath) ?? folders[0];
        if (!folder) {
            throw new UserFacingError("Add a music folder in Lidarr before downloading", 409);
        }
        const qualityProfileId = this.qualityProfileId ?? (folder.defaultQualityProfileId || null);
        const metadataProfileId = this.metadataProfileId ?? (folder.defaultMetadataProfileId || null);
        if (qualityProfileId === null || metadataProfileId === null) {
            throw new UserFacingError(
                `Lidarr's music folder ${folder.path} has no default profiles. Set them in Lidarr, or choose them in Kima's Lidarr settings`,
                409
            );
        }
        return { rootFolderPath: folder.path, qualityProfileId, metadataProfileId };
    }

    /**
     * Adds the artist with this MusicBrainz id, monitoring nothing on its own:
     * each album Kima asks for is monitored when it is added. Returns null when
     * Lidarr does not know the id; Lidarr errors are thrown.
     */
    async addArtist(
        mbid: string,
        artistName: string,
        rootFolderPath: string,
        isDiscovery: boolean = false
    ): Promise<LidarrArtist | null> {
        const client = await this.requireClient();
        const existing = (await this.getArtistList()).find((a) => a.foreignArtistId === mbid);
        if (existing) return existing;
        const target = await this.newArtistTarget(rootFolderPath);

        const lookup = await client.get<LidarrArtist[]>("/api/v1/artist/lookup", {
            params: { term: `lidarr:${mbid}` },
        });
        const artistData = (lookup.data ?? []).find((a) => a.foreignArtistId === mbid);
        if (!artistData) {
            logger.error(`Lidarr does not know artist ${artistName} (${mbid})`);
            return null;
        }

        const discoveryTagId = isDiscovery ? await this.getOrCreateDiscoveryTag() : null;
        const artistPayload: LidarrAddArtistRequest = {
            foreignArtistId: artistData.foreignArtistId,
            artistName: artistData.artistName,
            ...target,
            monitored: true,
            monitorNewItems: "none",
            addOptions: { monitor: "existing", searchForMissingAlbums: false },
            ...(discoveryTagId ? { tags: [discoveryTagId] } : {}),
        };

        let added: LidarrArtist;
        try {
            added = (await client.post("/api/v1/artist", artistPayload)).data;
        } catch (postError: any) {
            const errorMsg = postError.response?.data?.[0]?.errorMessage || postError.message || "";
            if (errorMsg.includes("already exists") || errorMsg.includes("UNIQUE constraint failed")) {
                this.invalidateArtistCache();
                const raced = (await this.getArtistList()).find((a) => a.foreignArtistId === mbid);
                if (raced) return raced;
            }
            throw postError;
        }
        this.invalidateArtistCache();
        logger.debug(`Added artist to Lidarr: ${artistName}${isDiscovery ? " (tagged as discovery)" : ""}`);

        await new Promise((resolve) => setTimeout(resolve, this.ARTIST_ADD_SETTLE_MS));
        try {
            await client.post("/api/v1/command", { name: "RefreshArtist", artistId: added.id });
        } catch (refreshError: any) {
            logger.warn(`   Metadata refresh for ${artistName} failed: ${refreshError.message}`);
        }
        return added;
    }

    /** Poll a Lidarr command every 2 s for up to 30 s by default; one still going then is reported as running. */
    private async waitForCommand(
        commandId: number,
        timeoutMs: number = this.COMMAND_POLL_TIMEOUT_DEFAULT,
        pollIntervalMs: number = this.COMMAND_POLL_INTERVAL
    ): Promise<{ status: string; message: string }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const response = await this.client!.get(
                `/api/v1/command/${commandId}`
            );
            const { status, message, body } = response.data;

            if (status !== "started" && status !== "queued") {
                logger.debug(
                    `   Command ${commandId} completed with status: ${status}`
                );
                return {
                    status,
                    message: message || body?.records?.[0]?.message || "",
                };
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        return { status: "running", message: "" };
    }

    async addAlbum(
        rgMbid: string,
        artistName: string,
        albumTitle: string,
        rootFolderPath: string,
        artistMbid?: string,
        isDiscovery: boolean = false
    ): Promise<{ album: LidarrAlbum; searchCommandId?: number } | null> {
        const client = await this.requireClient();

        if (await sourcePauseController.isPaused("lidarr")) {
            throw new AcquisitionError(
                "Lidarr is paused",
                AcquisitionErrorType.LIDARR_UNAVAILABLE,
                true
            );
        }

        try {
            logger.debug(
                `   Adding album: ${albumTitle} by ${artistName}${
                    isDiscovery ? " (discovery)" : ""
                }`
            );
            logger.debug(`   Album MBID: ${rgMbid}`);
            logger.debug(`   Artist MBID: ${artistMbid || "none"}`);

            const existingArtistList = await this.getArtistList();
            let artist = existingArtistList.find(
                (a: LidarrArtist) =>
                    artistMbid && a.foreignArtistId === artistMbid
            );

            let justAddedArtist = false;

            if (!artist && artistMbid) {
                logger.debug(`   Adding artist first: ${artistName}`);

                const inFlight = this.artistAddInFlight.get(artistMbid);
                if (inFlight) {
                    logger.debug(`   Artist ${artistMbid} add already in-flight, waiting...`);
                    const result = await inFlight;
                    artist = result ?? undefined;
                } else {
                    const addPromise = this.addArtist(
                        artistMbid,
                        artistName,
                        rootFolderPath,
                        isDiscovery
                    ).finally(() => this.artistAddInFlight.delete(artistMbid));
                    this.artistAddInFlight.set(artistMbid, addPromise);
                    const addedArtist = await addPromise;
                    artist = addedArtist ?? undefined;
                }

                if (!artist) {
                    logger.error(`Failed to add artist`);
                    return null;
                }

                justAddedArtist = true;
                logger.debug(
                    `   Artist added: ${artist.artistName} (ID: ${artist.id})`
                );
                logger.debug(
                    `   Waiting for Lidarr to populate album catalog...`
                );
            } else if (!artist) {
                logger.error(`Artist not found and no MBID provided`);
                return null;
            } else {
                logger.debug(
                    `   Artist already exists: ${artist.artistName} (ID: ${artist.id})`
                );
            }

            // Discover manages only artists it added, which carry its tag; a library
            // request takes the tag off, so Discover's cleanup leaves the artist alone.
            const discoveryTagId = await this.getOrCreateDiscoveryTag();
            const discoveryOwned = !!discoveryTagId && !!artist.tags?.includes(discoveryTagId);
            if (isDiscovery && !discoveryOwned) {
                logger.warn(
                    `   [Lidarr] ${artist.artistName} is in Lidarr outside Discover; not adding "${albumTitle}"`
                );
                return null;
            }
            if (!isDiscovery && discoveryOwned && !(await this.removeTagsFromArtist(artist.id, [discoveryTagId!]))) {
                logger.warn(`   [Lidarr] ${artist.artistName} keeps the Discover tag; its weekly cleanup may remove it`);
            }

            let artistAlbums: LidarrAlbum[] = [];

            const artistAlbumsResponse = await client.get(
                `/api/v1/album?artistId=${artist.id}`
            );
            artistAlbums = artistAlbumsResponse.data;

            if (artistAlbums.length === 0 && justAddedArtist) {
                logger.debug(`   Waiting for Lidarr to fetch album metadata...`);

                const maxAttempts = this.METADATA_FETCH_MAX_ATTEMPTS;
                const retryDelay = this.METADATA_FETCH_DELAY;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay)
                    );

                    const retryResponse = await client.get(
                        `/api/v1/album?artistId=${artist.id}`
                    );
                    artistAlbums = retryResponse.data;

                    if (artistAlbums.length > 0) {
                        logger.debug(`   Albums loaded after ${attempt * (this.METADATA_FETCH_DELAY / 1000)}s`);
                        break;
                    }

                    if (attempt < maxAttempts) {
                        logger.debug(
                            `   Attempt ${attempt}/${maxAttempts}: Still waiting...`
                        );
                    } else {
                        logger.warn(
                            `Timeout reached after ${
                                (maxAttempts * this.METADATA_FETCH_DELAY) / 1000
                            }s - artist catalog may still be populating`
                        );
                    }
                }
            } else if (artistAlbums.length === 0 && !justAddedArtist) {
                logger.debug(
                    `   Artist exists but has 0 albums - refreshing metadata...`
                );
                try {
                    await this.refreshArtistAndWait(artist.id);

                    const retryResponse = await client.get(
                        `/api/v1/album?artistId=${artist.id}`
                    );
                    artistAlbums = retryResponse.data;
                } catch {
                    logger.warn(`   Metadata refresh failed`);
                }
            }

            logger.debug(
                `   Found ${artistAlbums.length} albums for ${artist.artistName}`
            );

            // Only the album asked for: one the artist's list lacks (its metadata
            // profile leaves the type out, or it was removed) is added by its id.
            const albumData =
                artistAlbums.find((a: LidarrAlbum) => a.foreignAlbumId === rgMbid) ??
                (await this.addAlbumById(artist, rgMbid));
            if (!albumData) {
                throw new AcquisitionError(
                    `Lidarr doesn't know "${albumTitle}" (${rgMbid})`,
                    AcquisitionErrorType.ALBUM_NOT_FOUND,
                    false
                );
            }

            logger.debug(
                `   Found album in catalog: ${albumData.title} (ID: ${albumData.id})`
            );

            if (isDiscovery && (albumData.statistics?.trackFileCount ?? 0) > 0) {
                logger.warn(
                    `   [Lidarr] "${albumData.title}" already has files in Lidarr; Discover only fetches new albums`
                );
                return null;
            }

            if (albumData.statistics?.percentOfTracks >= 100) {
                throw new AcquisitionError(
                    `Already in Lidarr: all ${albumData.statistics.trackFileCount} tracks`,
                    AcquisitionErrorType.ALREADY_OWNED,
                    false
                );
            }

            if (!artist.monitored) {
                logger.debug(`   Enabling artist monitoring...`);
                await client.put(`/api/v1/artist/${artist.id}`, {
                    ...artist,
                    monitored: true,
                });
                logger.debug(`   Artist monitoring enabled`);
            } else {
                logger.debug(`   Artist already monitored`);
            }

            // Kima asks for the album, not one edition: anyReleaseOk lets Lidarr grab any
            // edition and, on import, monitor whichever one the files match.
            const fullAlbum = (await client.get(`/api/v1/album/${albumData.id}`)).data;
            await client.put(`/api/v1/album/${fullAlbum.id}`, {
                ...fullAlbum,
                monitored: true,
                anyReleaseOk: true,
            });
            const updatedAlbum = (await client.get(`/api/v1/album/${fullAlbum.id}`)).data;
            if (!updatedAlbum.monitored || !updatedAlbum.anyReleaseOk) {
                logger.error(`   Lidarr did not keep monitoring for "${updatedAlbum.title}" (ID: ${updatedAlbum.id})`);
            }

            if ((updatedAlbum.releases?.length || 0) === 0) {
                logger.warn(`Album has 0 releases - refreshing artist metadata from MusicBrainz...`);
                await this.refreshArtistAndWait(artist.id);
                const refreshed = (await client.get(`/api/v1/album/${updatedAlbum.id}`)).data;
                if ((refreshed.releases?.length || 0) === 0) {
                    logger.warn(`   Still no releases after refresh; the search may find nothing`);
                }
            }

            const search = await this.runAlbumSearch(updatedAlbum.id);
            if (search.status === "running") {
                logger.debug(`   Lidarr is still searching for "${updatedAlbum.title}"`);
                return { album: updatedAlbum, searchCommandId: search.commandId };
            }
            await this.finishSearch(search, updatedAlbum.id, albumTitle, !isDiscovery);
            logger.debug(`   Album download started: ${updatedAlbum.title}`);
            return { album: updatedAlbum };
        } catch (error: any) {
            if (error instanceof AcquisitionError) throw error;
            logger.error("Lidarr add album error:", error.response?.data || error.message);
            if (isTransient(error)) {
                throw new AcquisitionError(
                    `Lidarr unavailable: ${error.message}`,
                    AcquisitionErrorType.LIDARR_UNAVAILABLE,
                    true,
                    error
                );
            }
            throw error;
        }
    }

    /** Ask Lidarr to search for one album again; the watcher follows the search by its command id. */
    async startAlbumSearch(albumId: number): Promise<number> {
        const client = await this.requireClient();
        const command = await client.post("/api/v1/command", { name: "AlbumSearch", albumIds: [albumId] });
        return command.data.id;
    }

    /** Start Lidarr's search for one album and wait for it, up to 30 s; a longer search is reported as running. */
    private async runAlbumSearch(albumId: number): Promise<SearchCommand> {
        const command = await this.client!.post("/api/v1/command", {
            name: "AlbumSearch",
            albumIds: [albumId],
        });
        return { commandId: command.data.id, ...(await this.waitForCommand(command.data.id)) };
    }

    /**
     * Where a search Kima started stands now: still running, or finished. A
     * command Lidarr no longer lists (it restarted) counts as finished.
     */
    async searchStatus(commandId: number): Promise<SearchCommand> {
        const client = await this.requireClient();
        try {
            const { status, message, body } = (await client.get(`/api/v1/command/${commandId}`)).data;
            const running = status === "queued" || status === "started";
            return { commandId, status: running ? "running" : status, message: message || body?.records?.[0]?.message || "" };
        } catch (error: any) {
            if (error.response?.status === 404) return { commandId, status: "completed", message: "" };
            throw error;
        }
    }

    /**
     * A finished search either grabbed a release, or nothing was grabbed and the
     * error says why in Lidarr's own words. A library request whose only
     * candidates were bundles turned down for albums already owned grabs one.
     */
    async finishSearch(
        search: SearchCommand,
        albumId: number,
        albumTitle: string,
        allowBundle: boolean,
        after?: string
    ): Promise<void> {
        if (search.status !== "completed") {
            throw new AcquisitionError(
                `Lidarr's search for "${albumTitle}" ${search.status}${search.message ? `: ${search.message}` : ""}`,
                AcquisitionErrorType.NO_RELEASES_AVAILABLE,
                true
            );
        }
        if (!NOTHING_GRABBED.test(search.message)) return;
        // Discover stays album-scoped (a bundle would import the artist's whole
        // discography off one discovery request), and a job a bundle already
        // failed is not given another.
        if (allowBundle) {
            const album = (await this.client!.get<LidarrAlbum>(`/api/v1/album/${albumId}`)).data;
            if (await this.tryBundleGrab(album.artistId, { id: albumId, title: albumTitle, releaseDate: album.releaseDate })) {
                logger.debug(`   Bundle grab started for "${albumTitle}"`);
                return;
            }
        }
        throw await this.nothingGrabbedError(albumId, albumTitle, after);
    }

    /** Whether Lidarr holds every track of an album, for the edition it monitors; an album it no longer has is not whole. */
    async albumWhole(albumId: number): Promise<boolean> {
        const client = await this.requireClient();
        try {
            const { data } = await client.get<LidarrAlbum>(`/api/v1/album/${albumId}`);
            return (data.statistics?.percentOfTracks ?? 0) >= 100;
        } catch (error: any) {
            if (error.response?.status === 404) return false;
            throw error;
        }
    }

    private async grabHistory(downloadId: string): Promise<{ id: number; albumId: number }[]> {
        const { data } = await this.client!.get<{ records: { id: number; albumId: number }[] }>("/api/v1/history", {
            params: { page: 1, pageSize: 100, eventType: 1, downloadId },
        });
        return data.records ?? [];
    }

    /**
     * Marks an imported single-album grab failed as Lidarr's own "mark as failed" does:
     * the release is blocklisted and, with "redownload failed" on, Lidarr searches again.
     * False for a bundle (it would search every album it covers) or a download with no grab.
     */
    async markDownloadFailed(downloadId: string): Promise<boolean> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) return false;
        const grabs = await this.grabHistory(downloadId);
        if (grabs.length === 0 || new Set(grabs.map((g) => g.albumId)).size > 1) return false;
        await this.client.post(`/api/v1/history/failed/${grabs[0].id}`);
        return true;
    }

    /** The albums Lidarr has a search queued or running for, its own after a failed download included. */
    async albumsBeingSearched(): Promise<Set<number>> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) return new Set();
        const { data } = await this.client.get<{ name: string; status: string; body?: { albumIds?: number[] } }[]>("/api/v1/command");
        return new Set(
            data
                .filter((c) => c.name === "AlbumSearch" && (c.status === "queued" || c.status === "started"))
                .flatMap((c) => c.body?.albumIds ?? [])
        );
    }

    private async refreshArtistAndWait(artistId: number): Promise<void> {
        await this.client!.post("/api/v1/command", { name: "RefreshArtist", artistId });
        await new Promise((resolve) => setTimeout(resolve, this.ARTIST_REFRESH_WAIT_MS));
    }

    /** Adds exactly this album to an artist already in Lidarr, by its MusicBrainz id; null when Lidarr's metadata does not know it. */
    private async addAlbumById(artist: LidarrArtist, rgMbid: string): Promise<LidarrAlbum | null> {
        const { data: found } = await this.client!.get<LidarrAlbum[]>("/api/v1/album/lookup", {
            params: { term: `lidarr:${rgMbid}` },
        });
        const album = found.find((a) => a.foreignAlbumId === rgMbid);
        if (!album) return null;
        logger.debug(`   Adding "${album.title}" to ${artist.artistName} in Lidarr by its id`);
        const { data } = await this.client!.post<LidarrAlbum>("/api/v1/album", {
            ...album,
            artist,
            artistId: artist.id,
            monitored: true,
            anyReleaseOk: true,
            addOptions: { searchForNewAlbum: false },
        });
        return data;
    }

    /**
     * Grabs a multi-album bundle covering the album, as Lidarr's "download anyway" does, when Lidarr has
     * no objection or refused only because other albums in it are owned. An album search never lists a
     * bundle, so the artist's releases are searched. Any other rejection leaves it alone. True when the
     * grab started.
     */
    async tryBundleGrab(artistId: number, album: { title: string; releaseDate?: string; id: number }): Promise<boolean> {
        let releases: any[] = [];
        try {
            releases = (
                await this.client!.get("/api/v1/release", {
                    params: { artistId },
                    timeout: RELEASE_SEARCH_TIMEOUT_MS,
                })
            ).data ?? [];
        } catch (error: any) {
            logger.warn(`   Bundle scan for artist ${artistId} failed: ${error.message}`);
            return false;
        }

        const year = album.releaseDate ? Number(album.releaseDate.slice(0, 4)) : undefined;
        const candidates = releases.filter(
            (r) =>
                looksLikeBundle(r) &&
                (r.rejections ?? []).every((m: string) => EXISTING_FILES.test(m)) &&
                bundleCoversAlbum(r.title, album.title, year)
        );
        if (candidates.length === 0) return false;

        candidates.sort(
            (a, b) =>
                (a.size ?? Infinity) - (b.size ?? Infinity) ||
                (b.statistics?.seeders ?? 0) - (a.statistics?.seeders ?? 0)
        );
        const pick = candidates[0];

        try {
            await this.client!.post("/api/v1/release", {
                guid: pick.guid,
                indexerId: pick.indexerId,
            });
        } catch (error: any) {
            logger.warn(`   Bundle grab rejected (${error.response?.status}): ${pick.title}`);
            return false;
        }
        logger.debug(`   Bundle grabbed: "${pick.title}" (${formatBytes(pick.size)})`);
        return true;
    }

    /** `after`: the failed release a retry follows, which the message leads with. */
    private async nothingGrabbedError(albumId: number, albumTitle: string, after?: string): Promise<AcquisitionError> {
        let releases: { rejections?: string[] }[] = [];
        try {
            releases = (
                await this.client!.get("/api/v1/release", {
                    params: { albumId },
                    timeout: RELEASE_SEARCH_TIMEOUT_MS,
                })
            ).data ?? [];
        } catch (error: any) {
            logger.warn(`   Release list for album ${albumId} unavailable: ${error.message}`);
        }

        const reasons = releases.flatMap((r) => r.rejections ?? []);
        const owned =
            releases.length > 0 &&
            releases.every((r) => (r.rejections ?? []).length > 0 && r.rejections!.every((m) => EXISTING_FILES.test(m)));
        const counts = new Map<string, number>();
        for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
        const top = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, n]) => `${reason} (${n})`);
        // "Existing files" on the album's own release list is not proof the album
        // is complete (its track count is): a bundle's rejection often belongs to
        // the other albums it is linked to. Reported as availability, recoverable.
        const detail = owned
            ? "every release was rejected as existing files"
            : releases.length === 0
              ? after
                  ? "no other release found"
                  : "indexers found no releases"
              : `${releases.length} found, none approved: ${top.join("; ")}`;
        return new AcquisitionError(
            `${after ?? `No releases available for "${albumTitle}"`} - ${detail}`,
            AcquisitionErrorType.NO_RELEASES_AVAILABLE,
            true
        );
    }

    async getArtists(): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            return await this.getArtistList();
        } catch (error) {
            logger.error("Lidarr get artists error:", error);
            return [];
        }
    }

    /** Deletes an artist from Lidarr by MusicBrainz id, optionally with its files. */
    async deleteArtist(
        mbid: string,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return {
                success: false,
                message: "Lidarr not enabled or configured",
            };
        }

        if (!mbid || mbid.startsWith("temp-")) {
            return { success: false, message: "Invalid or temporary MBID" };
        }

        try {
            const artists = await this.getArtists();
            const lidarrArtist = artists.find(
                (a) => a.foreignArtistId === mbid
            );

            if (!lidarrArtist) {
                logger.debug(
                    `[LIDARR] Artist with MBID ${mbid} not found in Lidarr`
                );
                return {
                    success: true,
                    message:
                        "Artist not in Lidarr (already removed or never added)",
                };
            }

            logger.debug(
                `[LIDARR] Deleting artist: ${lidarrArtist.artistName} (ID: ${lidarrArtist.id})`
            );

            await this.client.delete(`/api/v1/artist/${lidarrArtist.id}`, {
                params: {
                    deleteFiles: deleteFiles,
                    addImportListExclusion: false,
                },
                timeout: this.API_TIMEOUT_DEFAULT, // 30 second timeout
            });

            logger.debug(
                `[LIDARR] Successfully deleted artist: ${lidarrArtist.artistName}`
            );
            return {
                success: true,
                message: `Deleted ${lidarrArtist.artistName} from Lidarr`,
            };
        } catch (error: any) {
            logger.error(
                "[LIDARR] Delete artist error:",
                error?.message || error
            );
            return {
                success: false,
                message: error?.message || "Failed to delete from Lidarr",
            };
        }
    }

    /** One album, or null when Lidarr no longer has it. Any other error throws. */
    async getAlbum(albumId: number): Promise<LidarrAlbum | null> {
        const client = await this.requireClient();
        try {
            return (await client.get(`/api/v1/album/${albumId}`)).data;
        } catch (error: any) {
            if (error.response?.status === 404) return null;
            throw error;
        }
    }

    /** One artist, or null when Lidarr no longer has it. Any other error throws. */
    async getArtistById(artistId: number): Promise<LidarrArtist | null> {
        const client = await this.requireClient();
        try {
            return (await client.get(`/api/v1/artist/${artistId}`)).data;
        } catch (error: any) {
            if (error.response?.status === 404) return null;
            throw error;
        }
    }

    /** Every album Lidarr lists for an artist. Errors throw. */
    async getAlbumsByArtistId(artistId: number): Promise<LidarrAlbum[]> {
        const client = await this.requireClient();
        return (await client.get("/api/v1/album", { params: { artistId } })).data ?? [];
    }

    /** Delete an album from Lidarr; a 404 counts as done. Callers go through discovery/lidarrRemoval. */
    async deleteAlbumById(albumId: number, deleteFiles: boolean): Promise<void> {
        const client = await this.requireClient();
        try {
            await client.delete(`/api/v1/album/${albumId}`, {
                params: { deleteFiles, addImportListExclusion: false },
                timeout: this.API_TIMEOUT_DEFAULT,
            });
        } catch (error: any) {
            if (error.response?.status !== 404) throw error;
        }
    }

    /** The album Lidarr holds under this release-group id, or null when it has none. Errors throw. */
    async findAlbumByForeignId(albumMbid: string): Promise<LidarrAlbum | null> {
        const client = await this.requireClient();
        const albums: LidarrAlbum[] = (await client.get("/api/v1/album", { params: { foreignAlbumId: albumMbid } })).data ?? [];
        return albums.find((album) => album.foreignAlbumId === albumMbid) ?? null;
    }

    /** Whether Lidarr has this album with files already downloaded. */
    async isAlbumAvailable(albumMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const response = await this.client.get("/api/v1/album", {
                params: { foreignAlbumId: albumMbid },
            });

            const albums = response.data;
            if (!albums || albums.length === 0) {
                return false;
            }

            for (const album of albums) {
                if (album.foreignAlbumId === albumMbid) {
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            if (error.response?.status === 404) {
                return false;
            }
            logger.error("Lidarr album check error:", error.message);
            return false;
        }
    }

    /** The tracks Lidarr knows for a release-group id that have no files yet. */
    async getMissingTracksByAlbumMbid(
        albumMbid: string
    ): Promise<Array<{ title: string; trackNumber: number | null }>> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client || !albumMbid) {
            return [];
        }

        try {
            const albumResponse = await this.client.get<LidarrAlbum[]>(
                "/api/v1/album",
                {
                    params: { foreignAlbumId: albumMbid },
                }
            );

            const lidarrAlbum = (albumResponse.data || []).find(
                (a: LidarrAlbum) => a.foreignAlbumId === albumMbid
            );

            if (!lidarrAlbum) {
                return [];
            }

            const tracksResponse = await this.client.get<LidarrTrack[]>(
                "/api/v1/track",
                {
                    params: { albumId: lidarrAlbum.id },
                }
            );

            const tracks: LidarrTrack[] = tracksResponse.data || [];
            const parseTrackNumber = (
                track: LidarrTrack
            ): number | null => {
                const rawCandidates = [
                    track.trackNumber,
                    track.absoluteTrackNumber,
                    track.position,
                ];

                for (const rawValue of rawCandidates) {
                    const parsedValue = Number(rawValue);
                    if (Number.isFinite(parsedValue) && parsedValue > 0) {
                        return parsedValue;
                    }
                }

                const title = track.title || "";
                const titleNumberMatch = title.match(/^\s*(\d{1,3})\b/);
                if (titleNumberMatch) {
                    const parsedFromTitle = Number(titleNumberMatch[1]);
                    if (
                        Number.isFinite(parsedFromTitle) &&
                        parsedFromTitle > 0
                    ) {
                        return parsedFromTitle;
                    }
                }

                return null;
            };

            const missingTracks = tracks
                .filter((track: LidarrTrack) =>
                    track.hasFile === undefined
                        ? !track.trackFileId
                        : !track.hasFile
                )
                .map((track: LidarrTrack) => ({
                    title: track.title,
                    trackNumber: parseTrackNumber(track),
                }))
                .filter((track: { title: string; trackNumber: number | null }) =>
                    !!track.title
                )
                .sort(
                    (
                        a: { title: string; trackNumber: number | null },
                        b: { title: string; trackNumber: number | null }
                    ) => {
                    if (a.trackNumber === null && b.trackNumber === null) {
                        return a.title.localeCompare(b.title);
                    }
                    if (a.trackNumber === null) return 1;
                    if (b.trackNumber === null) return -1;
                    return a.trackNumber - b.trackNumber;
                    }
                );

            return missingTracks;
        } catch (error: any) {
            logger.debug(
                `[LIDARR] Failed to fetch missing tracks for album MBID ${albumMbid}: ${error?.message || error}`
            );
            return [];
        }
    }

    async getTags(): Promise<LidarrTag[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const response = await this.client.get("/api/v1/tag");
            return response.data || [];
        } catch (error: any) {
            logger.error("[LIDARR] Failed to get tags:", error.message);
            return [];
        }
    }

    async createTag(label: string): Promise<LidarrTag | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const response = await this.client.post("/api/v1/tag", { label });
            logger.debug(
                `[LIDARR] Created tag: ${label} (ID: ${response.data.id})`
            );
            return response.data;
        } catch (error: any) {
            logger.error("[LIDARR] Failed to create tag:", error.message);
            return null;
        }
    }

    /**
     * The discovery tag's id, created when Lidarr has none. Looked up each time: a
     * remembered id outlives the tag when someone deletes it in Lidarr.
     */
    async getOrCreateDiscoveryTag(): Promise<number | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const tags = await this.getTags();
            const existingTag = tags.find(
                (t) => t.label === DISCOVERY_TAG_LABEL
            );

            if (existingTag) {
                logger.debug(
                    `[LIDARR] Found existing discovery tag (ID: ${existingTag.id})`
                );
                return existingTag.id;
            }

            const newTag = await this.createTag(DISCOVERY_TAG_LABEL);
            if (newTag) {
                return newTag.id;
            }

            return null;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to get/create discovery tag:",
                error.message
            );
            return null;
        }
    }

    async removeTagsFromArtist(
        artistId: number,
        tagIds: number[]
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const response = await this.client.get(
                `/api/v1/artist/${artistId}`
            );
            const artist = response.data;

            const existingTags = artist.tags || [];
            const filteredTags = existingTags.filter(
                (t: number) => !tagIds.includes(t)
            );

            await this.client.put(`/api/v1/artist/${artistId}`, {
                ...artist,
                tags: filteredTags,
            });

            logger.debug(
                `[LIDARR] Removed tags ${tagIds} from artist ${artist.artistName}`
            );
            return true;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to remove tags from artist:",
                error.message
            );
            return false;
        }
    }

    async getArtistsByTag(tagId: number): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const artists = await this.getArtistList();

            return artists.filter((artist) => artist.tags?.includes(tagId));
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to get artists by tag:",
                error.message
            );
            return [];
        }
    }

    /**
     * The artists that still carry Discover's tag, read without changing anything: null when Lidarr is not set up,
     * and an error when it does not answer, so a caller never mistakes an unreachable Lidarr for "no artist is
     * tagged". A missing tag means none is.
     */
    async readDiscoveryTaggedArtists(): Promise<LidarrArtist[] | null> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) return null;
        const tags: LidarrTag[] = (await this.client.get("/api/v1/tag")).data || [];
        const tag = tags.find((t) => t.label === DISCOVERY_TAG_LABEL);
        if (!tag) return [];
        const artists: LidarrArtist[] = (await this.client.get("/api/v1/artist")).data || [];
        return artists.filter((artist) => artist.tags?.includes(tag.id));
    }

    async getDiscoveryArtists(): Promise<LidarrArtist[]> {
        const tagId = await this.getOrCreateDiscoveryTag();
        if (!tagId) {
            return [];
        }
        return this.getArtistsByTag(tagId);
    }

    /** Takes the discovery tag off an artist, as when the user likes an album and the artist becomes owned. */
    async removeDiscoveryTagByMbid(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const tagId = await this.getOrCreateDiscoveryTag();
            if (!tagId) {
                return false;
            }

            const artists = await this.getArtists();
            const artist = artists.find(
                (a) => a.foreignArtistId === artistMbid
            );

            if (!artist) {
                logger.debug(
                    `[LIDARR] Artist ${artistMbid} not found in Lidarr`
                );
                return true; // Not an error - artist might not be in Lidarr
            }

            if (!artist.tags?.includes(tagId)) {
                logger.debug(
                    `[LIDARR] Artist ${artist.artistName} doesn't have discovery tag`
                );
                return true; // Already doesn't have tag
            }

            return await this.removeTagsFromArtist(artist.id, [tagId]);
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to remove discovery tag:",
                error.message
            );
            return false;
        }
    }

    /** Deletes an artist by Lidarr id. */
    async deleteArtistById(
        lidarrId: number,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return { success: false, message: "Lidarr not enabled" };
        }

        try {
            await this.client.delete(`/api/v1/artist/${lidarrId}`, {
                params: {
                    deleteFiles,
                    addImportListExclusion: false,
                },
                timeout: this.API_TIMEOUT_DEFAULT,
            });

            return { success: true, message: "Artist deleted" };
        } catch (error: any) {
            if (error.response?.status === 404) {
                return { success: true, message: "Artist already removed" };
            }
            logger.error("[LIDARR] Delete artist by ID error:", error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * Stop Lidarr's background searches (RSS, missing albums) grabbing an album.
     * Its own re-search after a failed download ignores monitoring.
     */
    async unmonitorAlbum(albumId: number): Promise<void> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) return;
        try {
            await this.client.put("/api/v1/album/monitor", { albumIds: [albumId], monitored: false });
        } catch (error: any) {
            logger.warn(`[LIDARR] Could not unmonitor album ${albumId}: ${error.message}`);
        }
    }

    /**
     * Delete a queue item; with blocklist Lidarr never grabs that release again,
     * and unless skipRedownload it searches for another. A 404 counts as success.
     * Callers go through lidarrFailures.removeFailedDownload.
     */
    async removeQueueItem(
        item: { id: number; title?: string },
        opts: { blocklist: boolean; skipRedownload: boolean; removeFromClient?: boolean }
    ): Promise<boolean> {
        const client = await this.requireClient();

        try {
            const { removeFromClient = true, ...queueOpts } = opts;
            await client.delete(`/api/v1/queue/${item.id}`, {
                params: { removeFromClient, ...queueOpts },
            });
            logger.debug(`[LIDARR] Removed from queue: ${item.title ?? item.id}`);
            return true;
        } catch (error: any) {
            if (error.response?.status === 404) {
                return true;
            }
            logger.error(
                `[LIDARR] Failed to remove queue item ${item.id}:`,
                error.response?.data || error.message
            );
            return false;
        }
    }

    /** Every item in Lidarr's download queue; throws when Lidarr cannot be read. */
    async getQueueItems(): Promise<LidarrQueueItem[]> {
        const client = await this.requireClient();

        const response = await client.get("/api/v1/queue", {
            params: { page: 1, pageSize: 1000, includeUnknownArtistItems: true },
        });
        return (response.data as LidarrQueueResponse).records;
    }

    /** Albums releasing within the date range for monitored artists, from Lidarr's calendar. */
    async getCalendar(
        startDate: Date,
        endDate: Date
    ): Promise<CalendarRelease[]> {
        await this.ensureInitialized();

        if (!this.client) {
            logger.debug("[LIDARR] Not configured - cannot fetch calendar");
            return [];
        }

        try {
            const start = startDate.toISOString().split("T")[0];
            const end = endDate.toISOString().split("T")[0];

            const response = await this.client.get(`/api/v1/calendar`, {
                params: {
                    start,
                    end,
                    includeArtist: true,
                },
            });

            const albums = response.data as LidarrAlbum[];
            const releases: CalendarRelease[] = albums.map(
                (album) => ({
                    id: album.id,
                    title: album.title,
                    artistName: album.artist?.artistName || "Unknown Artist",
                    artistId: album.artist?.id,
                    artistMbid: album.artist?.foreignArtistId,
                    albumMbid: album.foreignAlbumId,
                    releaseDate: album.releaseDate,
                    monitored: album.monitored,
                    grabbed: album.grabbed || false,
                    hasFile: album.statistics?.percentOfTracks === 100,
                    coverUrl:
                        album.images?.find(
                            (img: any) => img.coverType === "cover"
                        )?.remoteUrl || null,
                })
            );

            logger.debug(
                `[LIDARR] Calendar: Found ${releases.length} releases between ${start} and ${end}`
            );
            return releases;
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to fetch calendar:`, error.message);
            return [];
        }
    }

    async getMonitoredArtists(): Promise<
        { id: number; name: string; mbid: string }[]
    > {
        await this.ensureInitialized();

        if (!this.client) {
            return [];
        }

        try {
            const response = await this.client.get(`/api/v1/artist`);
            const artists = response.data as LidarrArtist[];
            return artists
                .filter((artist) => artist.monitored)
                .map((artist) => ({
                    id: artist.id,
                    name: artist.artistName,
                    mbid: artist.foreignArtistId,
                }));
        } catch (error: any) {
            logger.error(
                `[LIDARR] Failed to fetch monitored artists:`,
                error.message
            );
            return [];
        }
    }

    /**
     * Everything the download watcher needs in one fetch: Lidarr's queue as it
     * reports each item, and the albums it holds in full. Null when Lidarr is
     * off, paused, or any fetch fails: a partial snapshot would read as missing downloads.
     */
    async getReconciliationSnapshot(): Promise<ReconciliationSnapshot | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client || (await sourcePauseController.isPaused("lidarr"))) {
            return null;
        }
        const client = this.client;

        try {
            const [queueResponse, albumResponse] = await Promise.all([
                client.get("/api/v1/queue", {
                    params: { page: 1, pageSize: 1000, includeUnknownArtistItems: true },
                }),
                client.get("/api/v1/album"),
            ]);
            if (!Array.isArray(albumResponse.data)) {
                throw new Error("album list is not an array");
            }
            if (!Array.isArray(queueResponse.data?.records)) {
                throw new Error("queue response has no records");
            }

            const snapshot: ReconciliationSnapshot = {
                queue: new Map(),
                queueItems: queueResponse.data.records as LidarrQueueItem[],
                completeAlbumIds: new Set(),
                completeAlbumMbids: new Set(),
                fetchedAt: new Date(),
            };
            for (const item of snapshot.queueItems) {
                if (item.downloadId && !snapshot.queue.has(item.downloadId)) snapshot.queue.set(item.downloadId, item);
            }
            for (const album of albumResponse.data as LidarrAlbum[]) {
                if (!((album.statistics?.percentOfTracks ?? 0) >= 100)) continue;
                snapshot.completeAlbumIds.add(album.id);
                if (album.foreignAlbumId) snapshot.completeAlbumMbids.add(album.foreignAlbumId);
            }

            logger.debug(
                `[LIDARR] Snapshot fetched: ${snapshot.queue.size} queue items, ${snapshot.completeAlbumIds.size} complete albums`
            );
            return snapshot;
        } catch (error: any) {
            logger.warn(`[LIDARR] Snapshot skipped this cycle: ${error.message}`);
            return null;
        }
    }
}

/**
 * Lidarr's state for one watcher cycle. An album counts only when Lidarr holds
 * every track of it, matched by Lidarr's album id or its MusicBrainz id.
 */
export interface ReconciliationSnapshot {
    /** One record per download; a download covering several albums has one per album in `queueItems`. */
    queue: Map<string, LidarrQueueItem>;
    queueItems: LidarrQueueItem[];
    completeAlbumIds: Set<number>;
    completeAlbumMbids: Set<string>;
    fetchedAt: Date;
}

/** Whether Lidarr holds every track of this album. */
export function albumComplete(
    snapshot: ReconciliationSnapshot,
    album: { lidarrAlbumId?: number | null; mbid?: string | null }
): boolean {
    return (
        (!!album.lidarrAlbumId && snapshot.completeAlbumIds.has(album.lidarrAlbumId)) ||
        (!!album.mbid && snapshot.completeAlbumMbids.has(album.mbid))
    );
}

/** How far a queued download has got, 0-100; unknown until Lidarr reports its size. */
export function downloadProgress(item: LidarrQueueItem): number | undefined {
    if (!item.size || item.size <= 0 || item.sizeleft === undefined) return undefined;
    return Math.round(((item.size - item.sizeleft) / item.size) * 100);
}

export interface CalendarRelease {
    id: number;
    title: string;
    artistName: string;
    artistId?: number;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    monitored: boolean;
    grabbed: boolean;
    hasFile: boolean;
    coverUrl: string | null;
}

export const lidarrService = new LidarrService();

/** The track files Lidarr imported from one download, each with its album. */
export async function getImportedFiles(lidarrUrl: string, apiKey: string, downloadId: string): Promise<LidarrHistoryRecord[]> {
    const client = createLidarrClient(lidarrUrl, apiKey);
    const files: LidarrHistoryRecord[] = [];
    for (let page = 1; ; page++) {
        const { data } = await client.get<{ records: LidarrHistoryRecord[]; totalRecords: number }>("/api/v1/history", {
            params: { page, pageSize: 1000, eventType: 3, downloadId },
        });
        files.push(...(data.records ?? []));
        if (!data.records?.length || files.length >= data.totalRecords) return files;
    }
}

/** Lidarr's history of one event type since `since`, with album and artist attached. */
export async function getHistorySince(
    lidarrUrl: string,
    apiKey: string,
    since: Date,
    eventType: number
): Promise<LidarrHistoryRecord[]> {
    const { data } = await createLidarrClient(lidarrUrl, apiKey).get<LidarrHistoryRecord[]>("/api/v1/history/since", {
        params: { date: since.toISOString(), eventType, includeAlbum: true, includeArtist: true },
    });
    return data;
}

