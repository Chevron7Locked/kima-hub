import axios, { AxiosInstance } from "axios";
import { createHash } from "crypto";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";
import { sourcePauseController } from "./sourcePauseController";
import { USER_AGENT, config } from "../config";
import { Outcome, answered, absent, rateLimited, transient, permanent } from "../utils/outcome";
import { titlesAgree } from "./albumIdentity";
import { lengthsAgree, versionOf } from "./recordingMatch";

/**
 * AcoustID lookup client. The POST body is form-encoded with `meta` as
 * "recordings%20releasegroups" (the server does not decode '+'), and the length
 * goes in `duration`. Results without a `recordings` array are skipped.
 * Failures come back as `Outcome` kinds, never as a null that means "nothing".
 *
 * AcoustID's rate limit is per app key, shared by every install on the same key, so
 * identification asks for many fingerprints per request (`lookupMany`) and keeps each
 * reply: a song is asked once, and `lookup` answers from the saved reply.
 */
interface AcoustIDRecording {
    id: string;
    title?: string;
    duration?: number;
    artists?: { id: string; name: string }[];
    releasegroups?: { id: string; title?: string; type?: string }[];
}

interface AcoustIDResultRaw {
    id: string;
    score: number;
    duration?: number;
    recordings?: AcoustIDRecording[];
}

interface AcoustIDLookupResponse {
    status: string;
    results?: AcoustIDResultRaw[];
}

/** A `batch=1` reply: one entry per fingerprint, `index` naming its place in the request. */
interface AcoustIDBatchResponse {
    status: string;
    fingerprints?: { index: number; results?: AcoustIDResultRaw[] }[];
}

export interface AcoustIDResult {
    recordingMbid: string;
    artistMbid: string;
    /** Every album (release group) AcoustID lists for the recording, in its order. */
    releaseGroups: { id: string; title: string }[];
    /** The recordings of the matching result that are this track, best first; the first is `recordingMbid`. */
    candidates: string[];
    /** The pick's title (and version) is the track's. When false, the pick only has the track's length. */
    titleAgrees: boolean;
    title: string;
    artist: string;
}

/** Confidence floor: below this AcoustID is effectively guessing. */
const MIN_SCORE = 0.5;

/** Fingerprints per request. The server takes 20 and its own code says that will drop to 10 or less. */
const BATCH_SIZE = 10;

/** After a batch request fails (not a rate limit, which pauses the source), batches wait this long. */
const BATCH_HOLD_MS = 60_000;

/** Saved replies: a match for 30 days, "nothing matched" for 7 (the same as MusicBrainz answers). */
const MATCHED_TTL = 30 * 24 * 3600;
const UNMATCHED_TTL = 7 * 24 * 3600;

class AcoustIDService {
    private client: AxiosInstance;
    /** Until when batch requests wait after one failed; each song still asks on its own. */
    private batchesHeldUntil = 0;

    constructor() {
        this.client = axios.create({
            baseURL: "https://api.acoustid.org",
            timeout: 10000,
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    }

    /**
     * An explicit key, else the encrypted SystemSettings key, else the config
     * default. Never throws; getSystemSettings is imported lazily to avoid a cycle.
     */
    private async resolveApiKey(explicit?: string): Promise<string | undefined> {
        if (explicit) return explicit;
        try {
            const { getSystemSettings } = await import("../utils/systemSettings");
            const settings = await getSystemSettings();
            if (settings?.acoustidApiKey) return settings.acoustidApiKey;
        } catch (err: any) {
            logger.debug(
                `[AcoustID] Settings read failed, using config key: ${err?.message}`
            );
        }
        return process.env.ACOUSTID_CLIENT_KEY || config.acoustid.clientKey;
    }

    /**
     * application/x-www-form-urlencoded encoding done by hand. URLSearchParams
     * would emit a literal '+' for the space inside the meta parameter, which
     * this server does not decode back to a space (see module docstring).
     */
    private formEncode(params: Record<string, string>): string {
        return Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
    }

    /** Where the reply for this fingerprint and length is kept: one key per question asked. */
    private replyKey(duration: number, fingerprint: string): string {
        const digest = createHash("sha256").update(fingerprint.trim()).digest("hex");
        return `acoustid:lookup:${Math.round(duration)}:${digest}`;
    }

    /** The saved results for a question, or null when AcoustID must be asked. */
    private async savedResults(key: string): Promise<AcoustIDResultRaw[] | null> {
        try {
            const raw = await redisClient.get(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { results?: AcoustIDResultRaw[] };
            return Array.isArray(parsed?.results) ? parsed.results : null;
        } catch (err) {
            logger.debug(`[AcoustID] Saved reply unreadable for ${key}: ${(err as Error).message}`);
            return null;
        }
    }

    /** Whether AcoustID's reply for this fingerprint and length is already saved. */
    async hasSavedReply(duration: number, fingerprint: string): Promise<boolean> {
        if (!fingerprint || !(duration > 0)) return false;
        return (await this.savedResults(this.replyKey(duration, fingerprint))) !== null;
    }

    /**
     * AcoustID's answer for a song from its saved reply, never a request: undefined when no reply
     * is saved, null when the saved reply has no confident pick.
     */
    async savedAnswer(duration: number, fingerprint: string, title?: string): Promise<AcoustIDResult | null | undefined> {
        if (!fingerprint || !(duration > 0)) return undefined;
        const results = await this.savedResults(this.replyKey(duration, fingerprint));
        if (results === null) return undefined;
        const picked = this.pickFingerprintMatch(results, duration, title);
        return picked ? this.toResult(picked) : null;
    }

    private toResult(picked: { recording: AcoustIDRecording; candidates: AcoustIDRecording[]; titleAgrees: boolean }): AcoustIDResult {
        const { recording, candidates, titleAgrees } = picked;
        const artist = recording.artists?.[0];
        return {
            recordingMbid: recording.id,
            artistMbid: artist?.id || "",
            releaseGroups: (recording.releasegroups ?? []).map((rg) => ({ id: rg.id, title: rg.title ?? "" })),
            candidates: candidates.map((rec) => rec.id),
            titleAgrees,
            title: recording.title || "",
            artist: artist?.name || "",
        };
    }

    /** A failed save never un-answers the question: the caller already has the reply. */
    private async saveResults(key: string, results: AcoustIDResultRaw[]): Promise<void> {
        try {
            const ttl = results.length > 0 ? MATCHED_TTL : UNMATCHED_TTL;
            await redisClient.setex(key, ttl, JSON.stringify({ results, savedAt: new Date().toISOString() }));
        } catch (err) {
            logger.warn(`[AcoustID] Could not save the reply for ${key}: ${(err as Error).message}`);
        }
    }

    /** Whether a batch may be asked now: a key, the source not paused, no batch failure in the last minute. */
    async mayAskInBatches(options: { clientKey?: string } = {}): Promise<boolean> {
        if (Date.now() < this.batchesHeldUntil) return false;
        if (!(await this.resolveApiKey(options.clientKey))) return false;
        return !(await sourcePauseController.isPaused("acoustid"));
    }

    /**
     * Ask AcoustID about many songs at once, BATCH_SIZE fingerprints per request, and save
     * each reply for `lookup`. Questions already answered are not asked again. Never throws:
     * a rate limit pauses the source and stops, any other failure stops, and every song not
     * answered here is asked on its own by `lookup`. Returns how many songs were asked.
     */
    async lookupMany(
        entries: { duration: number; fingerprint: string }[],
        options: { clientKey?: string } = {}
    ): Promise<number> {
        if (!(await this.mayAskInBatches(options))) return 0;
        const apiKey = (await this.resolveApiKey(options.clientKey))!;

        const owed = new Map<string, { duration: number; fingerprint: string }>();
        for (const entry of entries) {
            if (!entry.fingerprint || !Number.isFinite(entry.duration) || entry.duration <= 0) continue;
            const key = this.replyKey(entry.duration, entry.fingerprint);
            if (!owed.has(key) && !(await this.savedResults(key))) owed.set(key, entry);
        }

        const pending = [...owed.entries()];
        let asked = 0;
        for (let start = 0; start < pending.length; start += BATCH_SIZE) {
            const chunk = pending.slice(start, start + BATCH_SIZE);
            const params: Record<string, string> = {
                client: apiKey,
                meta: "recordings releasegroups",
                batch: "1",
            };
            chunk.forEach(([, entry], i) => {
                params[`duration.${i}`] = String(Math.round(entry.duration));
                params[`fingerprint.${i}`] = entry.fingerprint.trim();
            });
            try {
                const response = await rateLimiter.execute("acoustid", () =>
                    this.client.post("/v2/lookup", this.formEncode(params), {
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    })
                );
                const data = response?.data as AcoustIDBatchResponse | undefined;
                if (!data || data.status !== "ok" || !Array.isArray(data.fingerprints)) {
                    logger.debug(`[AcoustID] Batch reply unusable (status '${data?.status ?? "unreadable"}')`);
                    this.batchesHeldUntil = Date.now() + BATCH_HOLD_MS;
                    return asked;
                }
                for (const answer of data.fingerprints) {
                    const asking = chunk[answer.index];
                    if (asking) await this.saveResults(asking[0], answer.results ?? []);
                }
                asked += chunk.length;
            } catch (error: any) {
                if (await sourcePauseController.handleRateLimit("acoustid", error)) {
                    logger.warn("[AcoustID] Rate limited during a batch lookup; source 'acoustid' paused");
                } else {
                    logger.debug(`[AcoustID] Batch lookup failed: ${error?.response?.status || error?.message}`);
                    this.batchesHeldUntil = Date.now() + BATCH_HOLD_MS;
                }
                return asked;
            }
        }
        return asked;
    }

    /**
     * Ask AcoustID which recording a fingerprint is; never throws. `duration` is the track's length in
     * seconds, `fingerprint` fpcalc's, and `title` the track's own (`pickFingerprintMatch`).
     */
    async lookup(
        duration: number,
        fingerprint: string,
        options: { clientKey?: string; title?: string } = {}
    ): Promise<Outcome<AcoustIDResult>> {
        const apiKey = await this.resolveApiKey(options.clientKey);
        if (!apiKey) {
            logger.debug("[AcoustID] No client key configured; not asking");
            return permanent(
                "NO_CLIENT_KEY",
                "No AcoustID client key configured — the question was never asked"
            );
        }
        if (!fingerprint || !Number.isFinite(duration) || duration <= 0) {
            logger.debug(
                `[AcoustID] Skipping lookup: fingerprint=${
                    fingerprint ? "present" : "missing"
                }, duration=${duration}`
            );
            return permanent(
                "NO_FINGERPRINT",
                `Cannot ask: fingerprint=${
                    fingerprint ? "present" : "missing"
                }, duration=${duration}`
            );
        }

        try {
            const key = this.replyKey(duration, fingerprint);
            let results = await this.savedResults(key);
            const saved = results !== null;
            if (!results) {
                const body = this.formEncode({
                    client: apiKey,
                    duration: String(Math.round(duration)),
                    fingerprint: fingerprint.trim(),
                    meta: "recordings releasegroups",
                });
                const response = await rateLimiter.execute("acoustid", () =>
                    this.client.post("/v2/lookup", body, {
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                    })
                );

                const data = response?.data as AcoustIDLookupResponse | undefined;
                if (!data || data.status !== "ok") {
                    return transient(
                        "BAD_RESPONSE",
                        `AcoustID returned status '${data?.status ?? "unreadable"}'`
                    );
                }
                results = data.results ?? [];
                await this.saveResults(key, results);
            }
            const picked = this.pickFingerprintMatch(results, duration, options.title);
            if (!picked) {
                logger.debug(
                    `[AcoustID] No confident match for ${Math.round(duration)}s track`
                );
                return absent({
                    askedDuration: Math.round(duration),
                    topScore: results[0]?.score ?? null,
                    ...(saved ? { saved: true } : {}),
                    reason:
                        "no result above the confidence floor has a recording of this track's length",
                });
            }

            const { result } = picked;
            const outcome = this.toResult(picked);

            logger.debug(
                `[AcoustID] Match recording=${outcome.recordingMbid} albums=${outcome.releaseGroups.length} title="${outcome.title}"`
            );
            return answered(outcome, {
                score: result.score,
                acoustidId: result.id,
                ...(saved ? { saved: true } : {}),
            });
        } catch (error: any) {
            const message = error?.response?.status || error?.message;
            if (await sourcePauseController.handleRateLimit("acoustid", error)) {
                logger.warn(
                    `[AcoustID] Rate limited; source 'acoustid' paused until ${
                        (await sourcePauseController.getPause("acoustid"))?.until?.toISOString() ?? "?"
                    }`
                );
                const pause = await sourcePauseController.getPause("acoustid");
                return rateLimited(
                    pause?.until ?? new Date(Date.now() + 30_000),
                    { reason: "rate-limited", error: String(message) }
                );
            }
            logger.debug(`[AcoustID] Lookup failed: ${message}`);
            return transient("REQUEST_FAILED", String(message));
        }
    }

    /**
     * The first result above the confidence floor with a recording of this track's
     * length (`lengthsAgree`; AcoustID gives no length for the result, so it is the
     * recording's). Among those, recordings whose title is the track's come first
     * (only they, when there are any), then by closest length: those are the
     * candidates, and the first is the pick. Results with no recording are skipped.
     */
    private pickFingerprintMatch(
        results: AcoustIDResultRaw[],
        duration: number,
        title?: string
    ): { result: AcoustIDResultRaw; recording: AcoustIDRecording; candidates: AcoustIDRecording[]; titleAgrees: boolean } | null {
        for (const result of results) {
            if (result.score < MIN_SCORE) continue;
            const fits = (result.recordings || []).filter(
                (rec) => lengthsAgree(duration, rec.duration != null ? rec.duration * 1000 : null) !== false
            );
            if (fits.length === 0) continue;
            const titled = title
                ? fits.filter((rec) => !!rec.title && titlesAgree(rec.title, title) && versionOf(rec.title) === versionOf(title))
                : [];
            const gap = (rec: AcoustIDRecording) =>
                rec.duration != null ? Math.abs(rec.duration - duration) : Number.POSITIVE_INFINITY;
            const candidates = [...(titled.length > 0 ? titled : fits)].sort((a, b) => gap(a) - gap(b));
            return { result, recording: candidates[0], candidates, titleAgrees: titled.length > 0 };
        }
        return null;
    }
}

export const acoustidService = new AcoustIDService();