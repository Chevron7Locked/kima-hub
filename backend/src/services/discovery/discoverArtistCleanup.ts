/**
 * Removes the artists Discover added to Lidarr once nothing keeps them (`removeDiscoveryArtist` decides each one).
 * Lidarr can take many seconds per artist delete, so a clear or the admin's clean-up button asks for a run
 * (`requestDiscoverArtistCleanup`) and answers without waiting; the run happens in its own queue. The end of a Discover
 * batch makes the same pass in its own turn, sparing the artists it fetched, and a dry run previews it.
 *
 * Runs take turns with the start of a Discover generation (`takeDiscoverArtistsTurn`): from the step before it picks
 * albums until its batch exists, nothing yet marks the new week's artists as in use, so no run may remove artists then.
 * A generation removes artists inside its own turn, before it picks.
 *
 * Lidarr is shared, so an artist Lidarr refused, a Lidarr that could not be read, or a run that could not be queued
 * goes to every admin's tray as one row, and a run with no failure clears that row.
 */

import { discoverArtistsQueue } from "../../workers/queues";
import { lidarrService } from "../lidarr";
import type { LidarrArtist } from "../../types/lidarr";
import { notificationService } from "../notificationService";
import { logger } from "../../utils/logger";
import { distributedLock } from "../../utils/distributedLock";
import { LockUnavailableError } from "../../utils/lockErrors";
import { withTimeout } from "../../utils/timeout";
import { discoveryArtistVerdict, removeDiscoveryArtist } from "./lidarrRemoval";

export const discoverArtistsGroupKey = "discover-lidarr-artists";

export interface ArtistFailure {
    artistName: string;
    reason: string;
}

/** What one run did. `unread` is why the run could not go through the artists at all. */
export interface ArtistCleanupResult {
    removed: number;
    kept: number;
    failed: ArtistFailure[];
    unread?: string;
}

/** Held while artists may be removed, or while a generation has not yet recorded the artists it picks. */
export interface ArtistsTurn {
    /** Aborts if the turn is lost (Redis dropped the lock), so removal stops before another holder starts. */
    signal: AbortSignal;
    release(): Promise<void>;
}

const TURN_KEY = "discover-lidarr-artists";
/** Renewed a third of the way through; a process that dies frees the turn within this. */
const TURN_TTL_MS = 60_000;
const TURN_POLL_MS = 2_000;
/** A Redis that does not answer leaves the queue waiting forever; the clear must still answer. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Waits until no one else holds the turn, then holds it. Throws when Redis cannot be reached. */
export async function takeDiscoverArtistsTurn(): Promise<ArtistsTurn> {
    for (;;) {
        const taken = await distributedLock.acquire(TURN_KEY, TURN_TTL_MS);
        if (taken.outcome === "unavailable") throw new LockUnavailableError(TURN_KEY, taken.error);
        if (taken.outcome === "acquired") {
            const stopRenewal = taken.lease.keepAlive();
            return {
                signal: taken.lease.signal,
                release: async () => {
                    stopRenewal();
                    await taken.lease.release();
                },
            };
        }
        await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
    }
}

/** Waiting runs: one that has not started reads the artists afresh, so it covers a new request. */
const NOT_STARTED = ["waiting", "delayed", "prioritized"] as const;

/**
 * Ask for a run. A run that has not started covers this request; one in progress gets another after it. Never throws:
 * a request that cannot be queued goes to the tray, since the clear that asked has already done its own work, and its
 * reason is returned (null once queued) for a caller that answers someone.
 */
export async function requestDiscoverArtistCleanup(): Promise<string | null> {
    try {
        await withTimeout(
            (async () => {
                if ((await discoverArtistsQueue.getJobs([...NOT_STARTED])).length > 0) return;
                await discoverArtistsQueue.add("remove-artists", {}, { jobId: `discover-artists-${Date.now()}` });
            })(),
            REQUEST_TIMEOUT_MS,
            "the job queue did not answer",
        );
        return null;
    } catch (error: any) {
        logger.warn(`[Discover] Could not queue the Lidarr artist run: ${error.message}`);
        const unread = `the removal could not be started: ${error.message}`;
        await report({ removed: 0, kept: 0, failed: [], unread });
        return unread;
    }
}

/** The queued run: waits its turn, then goes through every Discover-tagged artist in Lidarr. */
export async function runDiscoverArtistCleanup(): Promise<ArtistCleanupResult> {
    const turn = await takeDiscoverArtistsTurn();
    try {
        return await removeDiscoverArtists(turn);
    } finally {
        await turn.release();
    }
}

/**
 * One pass over every Discover-tagged artist in Lidarr, inside a turn the caller holds. Nothing when Lidarr is not set
 * up. An artist `spare` picks is kept without asking Lidarr anything: the end of a batch spares the artists it fetched.
 */
export async function removeDiscoverArtists(
    turn: ArtistsTurn,
    spare: (artist: LidarrArtist) => boolean = () => false,
): Promise<ArtistCleanupResult> {
    const result: ArtistCleanupResult = { removed: 0, kept: 0, failed: [] };
    let artists;
    try {
        artists = await lidarrService.readDiscoveryTaggedArtists();
    } catch (error: any) {
        result.unread = `Discover's artists could not be read from Lidarr: ${error.message}`;
        await report(result);
        return result;
    }

    for (const artist of artists ?? []) {
        if (turn.signal.aborted) {
            result.unread = "the run lost its turn before it went through every artist";
            break;
        }
        if (spare(artist)) {
            result.kept++;
            continue;
        }
        const removal = await removeDiscoveryArtist(artist);
        if (removal.outcome === "removed") result.removed++;
        else if (removal.outcome === "kept") result.kept++;
        else result.failed.push({ artistName: artist.artistName, reason: removal.reason });
    }
    if (artists) {
        logger.info(`[Discover] Lidarr artists: ${result.removed} removed, ${result.kept} kept, ${result.failed.length} failed`);
    }
    // Lidarr not set up: nothing stays in Lidarr to report, so an earlier row is cleared too.
    await report(result);
    return result;
}

/** What a run would do now, by name, touching nothing. */
export interface ArtistCleanupPreview {
    removed: string[];
    kept: string[];
    errors: string[];
}

/**
 * What a run would remove now, asked of Lidarr the same way and decided by the same verdict, without removing anything
 * or waiting for the turn. Null when Lidarr is not set up; throws when Lidarr cannot be read, so it is never taken for
 * no artists.
 */
export async function previewDiscoverArtists(): Promise<ArtistCleanupPreview | null> {
    const artists = await lidarrService.readDiscoveryTaggedArtists();
    if (!artists) return null;
    const preview: ArtistCleanupPreview = { removed: [], kept: [], errors: [] };
    for (const artist of artists) {
        try {
            const verdict = await discoveryArtistVerdict(artist);
            if (verdict === "delete" || verdict === "forget") preview.removed.push(artist.artistName);
            else preview.kept.push(`${artist.artistName} (${KEPT_BECAUSE[verdict]})`);
        } catch (error: any) {
            preview.errors.push(`${artist.artistName}: ${error.message}`);
        }
    }
    return preview;
}

const KEPT_BECAUSE = {
    theirs: "a listener's",
    unsure: "files Discover did not fetch, or Kima cannot tell",
    "in use": "in a current Discover week or download",
} as const;

async function report({ failed, unread }: ArtistCleanupResult): Promise<void> {
    try {
        if (failed.length === 0 && !unread) {
            await notificationService.resolve(discoverArtistsGroupKey);
            return;
        }
        const listing = failed.map((f) => `${f.artistName}: ${f.reason}`).join("; ");
        const title = unread
            ? "Discover's artists not removed from Lidarr"
            : `${failed.length} Discover artist${failed.length === 1 ? "" : "s"} not removed from Lidarr`;
        const parts = [
            unread ? `Discover's artists stay in Lidarr because ${unread}.` : "",
            failed.length > 0 ? `Lidarr did not remove these Discover artists, so they stay in Lidarr: ${listing}.` : "",
            "The next Discover clear tries again.",
        ];
        await notificationService.notifyAdmins({
            type: "error",
            title,
            message: parts.filter(Boolean).join(" "),
            metadata: { failed, unread: unread ?? null },
            groupKey: discoverArtistsGroupKey,
        });
    } catch (error: any) {
        logger.warn(`[Discover] Could not write the Lidarr artists tray row: ${error.message}`);
    }
}
