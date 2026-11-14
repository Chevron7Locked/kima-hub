/**
 * The identification job: answer one song's `recording` question (which MusicBrainz recording this file is, and
 * its ISRC and genres), and give untagged albums their id and warm AcoustID before the songs go out.
 *
 * Interface:
 *  - `identifyTrack(trackId, jobId?)`: one claimed question, settled on its stage record (done, absent, or failed
 *    with its cause) and returned as "identified", "no_match" or "deferred".
 *  - `runIdentification(offer)`: the scheduler's turn for the stage: look ahead, prepare, and queue the window.
 *  - `queueIdentification(item)`: queue one claimed song's job (also how a retry re-queues it).
 *  - `prepareIdentification(upcoming)`: before dispatch, ask AcoustID about the coming songs in batches and name
 *    their untagged albums.
 *  - `IDENTIFICATION_LOOKAHEAD`: how many songs ahead of the dispatch the scheduler offers for that.
 *
 * Identification order (Kevin 2026-10-15, `.claude/rules/identification.md`): the file's recording id tag,
 * AcoustID by fingerprint, the album's tracklist by the album row's id, the ISRC, the name search. A pick that
 * matches AcoustID only by length goes last. The scheduler claims the record and queues the job; nothing here does.
 */

import { logger } from "../../utils/logger";
import { TimeoutError, withTimeout } from "../../utils/timeout";
import { prisma } from "../../utils/db";
import { entityGoneError } from "../entityGone";
import * as stageRecords from "../../services/stages/stageRecords";
import type { FailureOutcome } from "../../services/stages/stageRecords";
import { musicBrainzService, type AlbumCatalogue } from "../../services/musicbrainz";
import { topVoted } from "../../utils/votes";
import { trackIdentityService } from "../../services/trackIdentity";
import {
    identifyTrackByAcoustid,
    persistAcoustidFingerprint,
    prefetchAcoustidReplies,
    readIdentityTags,
} from "../../services/acoustidIdentification";
import { albumFactsOf, fillAlbumFromCatalogue, identifyAlbumsBySound, type AlbumFacts } from "../../services/albumIdentification";
import { acoustidService } from "../../services/acoustidService";
import { fingerprintToAsk, fingerprintsToAsk, type FingerprintQuestion } from "../../services/fingerprintChoice";
import { isMbid } from "../../services/artistIdentity";
import type { Outcome } from "../../utils/outcome";
import { sourcePauseController } from "../../services/sourcePauseController";
import { normalizeIsrc, pickRecording, recordingAgrees, type ExpectedRecording } from "../../services/recordingMatch";
import { ACOUSTID_NOT_ASKED } from "./fingerprint";
import { trackQueue } from "../enrichmentQueues";
import type { StageOffer, StageWork } from "./stageOffer";

/** The time one source gets to answer one question about a song: a few HTTP calls. */
const RECORDING_BUDGET_MS = 30_000;

/** How far ahead of the dispatch AcoustID is asked, so its batches fill up (10 songs per request). */
export const IDENTIFICATION_LOOKAHEAD = 100;

/** An ask that timed out or threw: a transient failure, so the record retries on its ladder. */
function unansweredAsk(err: unknown): Outcome<never> {
    const message = err instanceof Error ? err.message : String(err);
    return {
        kind: "transient",
        error: {
            code: err instanceof TimeoutError ? "TIMEOUT" : "REQUEST_FAILED",
            message,
        },
    };
}

/** Ask a source within the stage budget. A blown budget or a throw comes back
 * as `transient` with the real cause, never as "nothing found". */
async function askWithinBudget<T>(
    ask: () => Promise<Outcome<T>>,
    timeoutMs: number,
    label: string,
): Promise<Outcome<T>> {
    try {
        return await withTimeout(ask(), timeoutMs, label);
    } catch (err) {
        return unansweredAsk(err);
    }
}

/**
 * True when the fingerprint stage closed with no fingerprint to come (failed for good, or set aside by a person): the question
 * is settled as "never", so identification skips AcoustID and records the skip.
 * Open fingerprint states never reach here; the prerequisite gate holds them.
 */
async function fingerprintStageSettledFailed(trackId: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ status: string; retryable: boolean }>
    >(
        `SELECT status, retryable FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = 'fingerprint'`,
        trackId,
    );
    const row = rows[0];
    return !!row && (row.status === "blocked" || (row.status === "failed" && !row.retryable));
}

/**
 * True when saved replies alone settle the song's AcoustID question, so no request is needed: walking its
 * questions in order, each has a saved reply, up to one with a pick (the later ones are then never asked).
 * A question without a saved reply, or none at all, is false: while AcoustID is paused that song waits.
 */
async function answeredFromSavedReplies(questions: FingerprintQuestion[], title: string): Promise<boolean> {
    for (const q of questions) {
        const answer = await acoustidService.savedAnswer(q.duration, q.fingerprint, title);
        if (answer === undefined) return false;
        if (answer !== null) return true;
    }
    return questions.length > 0;
}

type CatalogueRecording = AlbumCatalogue["recordings"][number];

/** What the album chain answered: this track's row plus the album-level answers. */
type CatalogueAnswer = AlbumFacts & { entry: CatalogueRecording };

/**
 * Find our file in its album's tracklist: title, version and length must agree (`recordingAgrees`). A row
 * credited to the track's artist wins, since two songs on a compilation can share a title. With none, the
 * album vouches for the artist (a name written another way) only when exactly one row is the track. Rows
 * carrying the file's ISRC are tried first.
 */
function matchCatalogueRecording(
    recordings: CatalogueRecording[],
    expected: ExpectedRecording,
    isrc: string | null,
): CatalogueRecording | null {
    const asCandidates = (rows: CatalogueRecording[], artists?: string[]) =>
        rows.map((rec) => ({
            id: rec.recordingId,
            title: rec.title,
            lengthMs: rec.durationMs,
            artists: artists ?? rec.artists,
        }));
    const credited = (rows: CatalogueRecording[]) => pickRecording(asCandidates(rows), expected);
    const vouched = (rows: CatalogueRecording[]) => {
        const agreeing = asCandidates(rows, expected.artists).filter((c) => recordingAgrees(c, expected));
        return agreeing.length === 1 ? agreeing[0] : null;
    };
    const withIsrc = isrc ? recordings.filter((rec) => rec.isrcs.includes(isrc)) : [];
    const pick = credited(withIsrc) ?? credited(recordings) ?? vouched(withIsrc) ?? vouched(recordings);
    return pick ? recordings.find((rec) => rec.recordingId === pick.id) ?? null : null;
}

/**
 * Answer one track's `recording` question and write it to the record. Runs only
 * once the fingerprint question is settled; waiting is the gate's job.
 */
export async function identifyTrack(
    trackId: string,
    jobId?: string,
): Promise<"identified" | "no_match" | "deferred"> {
    const track = await prisma.track.findUnique({
        where: { id: trackId },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    if (!track) {
        throw entityGoneError("Track", trackId);
    }

    // Identification in order: the file's recording id, AcoustID, the album's tracklist, the ISRC, the name search;
    // every candidate must agree with this track (`recordingAgrees`). A MusicBrainz failure defers the record with its
    // cause; AcoustID failing only matters when MusicBrainz has no answer either.
    const timeoutMs = RECORDING_BUDGET_MS;
    const trackRef = {
        id: track.id,
        title: track.title,
        filePath: track.filePath,
        duration: track.duration,
    };
    const tags = await readIdentityTags(trackRef);
    const expected: ExpectedRecording = {
        title: track.title,
        artists: [...(tags?.artists ?? []), track.album.artist.name],
        durationSec: track.duration > 0 ? track.duration : tags?.duration || null,
    };
    const isrc = normalizeIsrc(track.isrc);
    const asked: string[] = [];
    let recordingMbid: string | null = null;
    let answerSource = "musicbrainz";
    let fingerprintToStore: string | null = tags?.fingerprint ?? null;
    let failedAsk: { source: string; outcome: FailureOutcome } | null = null;
    // Why the AcoustID step never ran, when it did not: the fingerprint question closed
    // for good (AcoustID cannot be asked about this file).
    let acoustidSkipped: { reason: "fingerprint-closed" } | null = null;
    // AcoustID failing to answer: kept, and the cause of the deferral only when no other
    // source names the recording.
    let acoustidFailure: FailureOutcome | null = null;
    // The recordings AcoustID would also accept, best first.
    let acoustidCandidates: string[] = [];
    // An AcoustID pick whose title is not the track's (only its length is): asked last,
    // once the tracklist, the ISRC and the name search have had their turn.
    let acoustidLengthOnly: { candidates: string[]; fingerprintFrom?: string } | null = null;
    // The album row's own tracklist, with this track on it (its recording or its name): the
    // album's year, label and genres, for the row.
    let rowAlbum: AlbumFacts | null = null;
    // The tracklist fetched, kept for the length-only pick to take its row from.
    let tracklist: AlbumCatalogue | null = null;
    // Set when the album's tracklist answered: the identity, the ISRCs, the
    // genres and the album-level answers all come from that one fetch.
    let catalogueAnswer: CatalogueAnswer | null = null;
    let evidenceFromAcoustid: Record<string, unknown> = {};

    if (tags?.recordingMbid) {
        recordingMbid = tags.recordingMbid;
        answerSource = "file_tag";
    }

    // AcoustID first for a file whose tags do not name its recording. The prerequisite
    // gate guarantees the fingerprint question is settled: use the stored fingerprint, or
    // skip and record the skip when it closed as a permanent failure.
    if (!recordingMbid) {
        const pause = await sourcePauseController.getPause("acoustid");
        const question = fingerprintToAsk(tags, track.acoustidFingerprint, track.duration);
        if (!question && (await fingerprintStageSettledFailed(track.id))) {
            acoustidSkipped = { reason: "fingerprint-closed" };
        } else if (pause && !(await answeredFromSavedReplies(fingerprintsToAsk(tags, track.acoustidFingerprint, track.duration), track.title))) {
            // AcoustID comes first and can be asked when its pause ends: the question waits until
            // then, uses up no retry, and no lower source answers in its place. A reply already
            // saved needs no request, so it is used even while paused.
            await stageRecords.failOutcome(track.id, "recording", "acoustid", {
                kind: "rateLimited",
                retryAfter: pause.until,
                evidence: { asked, acoustid: "paused" },
            }, { asked }, jobId);
            return "deferred";
        } else {
            asked.push("acoustid");
            const identified = await askWithinBudget(
                () =>
                    identifyTrackByAcoustid(
                        trackRef,
                        tags,
                        // The fingerprint stage's stored answer: never a second fpcalc run.
                        track.acoustidFingerprint ? { fingerprint: track.acoustidFingerprint } : null,
                    ),
                timeoutMs,
                `Timeout asking AcoustID: ${track.title}`,
            );
            if (identified.kind === "answered") {
                fingerprintToStore = identified.value.fingerprint ?? fingerprintToStore;
                if (identified.value.titleAgrees === false) {
                    acoustidLengthOnly = {
                        candidates: identified.value.candidates ?? [identified.value.recordingMbid],
                        fingerprintFrom: identified.value.fingerprintFrom,
                    };
                } else {
                    recordingMbid = identified.value.recordingMbid;
                    answerSource = identified.value.source;
                    evidenceFromAcoustid = { fingerprintFrom: identified.value.fingerprintFrom };
                    acoustidCandidates = identified.value.candidates ?? [identified.value.recordingMbid];
                }
            } else if (identified.kind === "absent") {
                // Asked and nothing matched — an answer, not a failure. The
                // dedupe column still wants the fingerprint.
                const fp = identified.evidence["fingerprint"];
                if (typeof fp === "string") fingerprintToStore = fp;
            } else {
                acoustidFailure = identified;
            }
        }
    }

    // The album's tracklist, by the album row's release-group id: from the files' tags, or from
    // the album step's AcoustID vote (identifyAlbumsBySound). The row's year, label and genres
    // are filled (`rowAlbum`) only when this track is on it.
    const albumRg = isMbid(track.album.rgMbid) ? track.album.rgMbid : null;
    if (albumRg) {
        asked.push("album-catalogue");
        const chain = await askWithinBudget(
            () => musicBrainzService.getAlbumCatalogue(albumRg),
            timeoutMs,
            `Timeout fetching MB album: ${track.album.title}`,
        );
        if (chain.kind === "answered") {
            tracklist = chain.value;
            const row = (id: string) => chain.value.recordings.find((rec) => rec.recordingId === id) ?? null;
            // An answer already found takes its ISRCs and genres from its row: AcoustID's
            // best candidate that is on this album, the file tag's own row. Nothing found
            // yet: the tracklist names the recording.
            const byName = () => matchCatalogueRecording(chain.value.recordings, expected, isrc);
            const entry = !recordingMbid
                ? byName()
                : answerSource === "acoustid"
                  ? acoustidCandidates.map(row).find((rec) => rec !== null) ?? null
                  : row(recordingMbid);
            const facts = albumFactsOf(chain.value);
            if (entry) {
                catalogueAnswer = { entry, ...facts };
                recordingMbid = entry.recordingId;
            }
            // The album row is filled only when this track is on its tracklist: by its recording,
            // or, for a recording found elsewhere that is not, by its name (with none found, the
            // name was the match just tried).
            if (entry || (recordingMbid && byName())) rowAlbum = facts;
        } else if (chain.kind !== "absent" && !recordingMbid) {
            failedAsk = { source: "musicbrainz", outcome: chain };
        }
    }

    if (!recordingMbid && !failedAsk && isrc) {
        asked.push("isrc");
        const hits = await askWithinBudget(
            () => musicBrainzService.lookupRecordingsByIsrc(isrc),
            timeoutMs,
            `Timeout looking up MB recordings by ISRC: ${track.title}`,
        );
        if (hits.kind === "answered") {
            const pick = pickRecording(hits.value, expected);
            if (pick) {
                recordingMbid = pick.id;
                answerSource = "isrc";
            }
        } else if (hits.kind !== "absent") {
            failedAsk = { source: "musicbrainz", outcome: hits };
        }
    }

    if (!recordingMbid && !failedAsk) {
        asked.push("mb-search");
        const search = await askWithinBudget(
            () => musicBrainzService.identifyRecording(expected),
            timeoutMs,
            `Timeout searching MB recording: ${track.title}`,
        );
        if (search.kind === "answered") {
            recordingMbid = search.value.id;
            answerSource = "musicbrainz";
        } else if (search.kind !== "absent") {
            failedAsk = { source: "musicbrainz", outcome: search };
        }
    }

    if (!recordingMbid && !failedAsk && acoustidLengthOnly) {
        const { candidates } = acoustidLengthOnly;
        // A candidate on the fetched tracklist brings its ISRCs and genres with it.
        const entry = tracklist
            ? candidates.map((id) => tracklist!.recordings.find((rec) => rec.recordingId === id)).find((rec) => rec !== undefined) ?? null
            : null;
        if (entry && tracklist) {
            catalogueAnswer = { entry, ...albumFactsOf(tracklist) };
            rowAlbum = catalogueAnswer;
        }
        recordingMbid = entry?.recordingId ?? candidates[0];
        answerSource = "acoustid";
        evidenceFromAcoustid = { fingerprintFrom: acoustidLengthOnly.fingerprintFrom, match: "length only: AcoustID's title is not the track's" };
    }

    if (!recordingMbid && !failedAsk && acoustidFailure) {
        failedAsk = { source: "acoustid", outcome: acoustidFailure };
    }

    if (fingerprintToStore && fingerprintToStore !== track.acoustidFingerprint) {
        try {
            await persistAcoustidFingerprint(track.id, fingerprintToStore);
        } catch (err) {
            // A failed fingerprint write is a real failure: the record keeps the
            // actual error and the question stays open on its own schedule.
            await stageRecords.fail(track.id, "recording", "acoustid", err, {
                stage: "persisting the fingerprint on Track",
            }, jobId);
            return "deferred";
        }
    }

    if (failedAsk) {
        await stageRecords.failOutcome(
            track.id,
            "recording",
            failedAsk.source,
            failedAsk.outcome,
            { asked, ...(acoustidSkipped ? { acoustid: acoustidSkipped.reason } : {}) },
            jobId,
        );
        return "deferred";
    }

    if (!recordingMbid) {
        // Every source that can be asked said "nothing" (AcoustID cannot be, when the
        // file's fingerprint question closed for good): close `done` with evidence
        // naming who was asked. A scan that finds the file changed asks again.
        await stageRecords.absent(track.id, "recording", "acoustid", {
            reason: "no source has a recording that is this track",
            asked,
            ...(acoustidSkipped ? { acoustid: ACOUSTID_NOT_ASKED } : {}),
        }, jobId);
        return "no_match";
    }

    const mbid = recordingMbid;
    // Asking took time: a claim re-issued meanwhile (a wipe, a changed file) owns the answer now.
    if (!(await stageRecords.claimIsCurrent(track.id, "recording", jobId))) return "deferred";
    await prisma.track.update({
        where: { id: track.id },
        data: { recordingMbid: mbid },
    });

    // The track's ISRC comes from its file or an import, or from the recording it
    // was identified as. Only an absent one, or one MusicBrainz gave for an earlier
    // answer, is replaced by this answer's (or cleared when it has none).
    const storeRecordingIsrc =
        answerSource !== "isrc" && (track.isrcSource == null || track.isrcSource === "musicbrainz");

    if (catalogueAnswer) {
        try {
            if (storeRecordingIsrc) await replaceRecordingIsrc(track.id, catalogueAnswer.entry.isrcs[0] ?? null);
            // A track's genres are its recording's curated genres, whichever way it was identified.
            const topGenres = topVoted(catalogueAnswer.entry.genres, 5);
            await trackIdentityService.populateTrackGenres(track.id, topGenres);
            // The same fetch answers the album: original year, label, and genres,
            // filled only where the row is still blank, and only for the album the row names.
            if (rowAlbum) await fillAlbumFromCatalogue(track.album, rowAlbum);
            await stageRecords.answer(track.id, "recording", answerSource, {
                recordingMbid: mbid,
                reason: answerSource === "file_tag"
                    ? "the file's own recording id, found in the album's tracklist"
                    : answerSource === "acoustid"
                      ? "AcoustID's recording, found in the album's tracklist"
                      : "identified from the album's tracklist",
                album:
                    track.album.rgMbidSource === "acoustid"
                        ? "the album's id from the AcoustID vote"
                        : track.album.rgMbidSource === "search"
                          ? "the album's id from a name search"
                          : "the album's own id",
                tags: topGenres,
                ...evidenceFromAcoustid,
            }, jobId);
            return "identified";
        } catch (err) {
            await stageRecords.fail(track.id, "recording", "musicbrainz", err, {
                recordingMbid: mbid,
                stage: "writing the album-chain answer",
            }, jobId);
            return "deferred";
        }
    }

    try {
        // One request answers both when the ISRC is ours to store.
        const detailsLabel = `Timeout fetching MB ISRC and genres: ${track.title}`;
        const details = storeRecordingIsrc
            ? await withTimeout(musicBrainzService.getRecordingIsrcAndGenres(mbid), timeoutMs, detailsLabel).catch(
                  (err) => ({ isrc: unansweredAsk(err), genres: unansweredAsk(err) }),
              )
            : null;
        if (details?.isrc.kind === "answered") {
            await replaceRecordingIsrc(track.id, details.isrc.value);
        } else if (details?.isrc.kind === "absent") {
            await replaceRecordingIsrc(track.id, null);
        }
        const genres =
            details?.genres ??
            (await askWithinBudget(
                () => musicBrainzService.getRecordingGenres(mbid),
                timeoutMs,
                `Timeout fetching MB genres: ${track.title}`,
            ));
        // The album row's own tracklist answered though this recording is not on it: the
        // album is still filled from that fetch.
        if (rowAlbum) await fillAlbumFromCatalogue(track.album, rowAlbum);
        const evidence = { recordingMbid: mbid, reason: `identified via ${answerSource}`, ...evidenceFromAcoustid };
        if (genres.kind === "answered") {
            const topGenres = topVoted(genres.value.genres, 5);
            await trackIdentityService.populateTrackGenres(track.id, topGenres);
            await stageRecords.answer(track.id, "recording", answerSource, { ...evidence, tags: topGenres }, jobId);
            return "identified";
        }
        if (genres.kind === "absent") {
            // Identified, and the recording has no genres: an answer, not a failure.
            await trackIdentityService.populateTrackGenres(track.id, []);
            await stageRecords.answer(track.id, "recording", answerSource, {
                ...evidence,
                reason: `identified via ${answerSource}, recording carries no genres`,
            }, jobId);
            return "identified";
        }
        await stageRecords.failOutcome(track.id, "recording", "musicbrainz", genres, {
            recordingMbid: mbid,
            stage: "fetching genres/isrc for an identified recording",
        }, jobId);
        return "deferred";
    } catch (err) {
        // An unexpected throw (a DB write, not a source answer): record it with its
        // real error so the question is re-asked on the record's own schedule.
        await stageRecords.fail(track.id, "recording", answerSource, err, {
            recordingMbid: mbid,
            stage: "fetching genres/isrc for an identified recording",
        }, jobId);
        return "deferred";
    }
}

/** Set the ISRC MusicBrainz gives for the identified recording, or clear an earlier MusicBrainz one when it has none. */
async function replaceRecordingIsrc(trackId: string, isrc: string | null): Promise<void> {
    const code = normalizeIsrc(isrc);
    await prisma.track.update({
        where: { id: trackId },
        data: code ? { isrc: code, isrcSource: "musicbrainz" } : { isrc: null, isrcSource: null },
    });
}

/**
 * Give untagged albums their MusicBrainz id before their songs are handed out, so each song's
 * job reads the album's tracklist by that id; the backlog of albums whose songs are already
 * identified is worked through as well. Holds the dispatch for about one round's budget at
 * most (identifyAlbumsBySound); a failure only means this round names no album.
 */
async function identifyAlbumsForWork(work: Array<{ trackId: string }>): Promise<void> {
    try {
        const rows = work.length > 0
            ? await prisma.track.findMany({
                  where: { id: { in: work.map((w) => w.trackId) } },
                  select: { id: true, albumId: true },
              })
            : [];
        // The albums in the order their songs go out.
        const albumOf = new Map(rows.map((r) => [r.id, r.albumId]));
        const ordered = [...new Set(work.map((w) => albumOf.get(w.trackId)).filter((id): id is string => !!id))];
        await identifyAlbumsBySound(ordered);
    } catch (err) {
        logger.warn(`[Enrichment] Album identification skipped this round: ${(err as Error).message}`);
    }
}

/**
 * Ask AcoustID about the songs coming up in batches before their jobs run (AcoustID's limit
 * is per app key, shared by every install on it). Never holds the dispatch back: a failure
 * here only means each job asks for itself.
 */
async function prefetchAcoustidForWork(work: Array<{ trackId: string }>): Promise<void> {
    if (work.length === 0) return;
    try {
        const tracks = await prisma.track.findMany({
            where: { id: { in: work.map((w) => w.trackId) } },
            select: { id: true, title: true, filePath: true, duration: true, acoustidFingerprint: true, fileModified: true },
        });
        const asked = await prefetchAcoustidReplies(tracks);
        if (asked > 0) logger.debug(`[Enrichment] Asked AcoustID about ${asked} track(s) in batches`);
    } catch (err) {
        logger.warn(`[Enrichment] AcoustID batch lookup skipped: ${(err as Error).message}`);
    }
}

/**
 * Before the songs go out: ask AcoustID about them in batches, then name their untagged albums, so each job
 * finds its replies saved and its album's id set. Neither holds the dispatch back beyond one round's budget.
 */
export async function prepareIdentification(upcoming: Array<{ trackId: string }>): Promise<void> {
    await prefetchAcoustidForWork(upcoming);
    await identifyAlbumsForWork(upcoming);
}

/** Queue one identification job. `jobId` is per attempt, so a retry never reuses the key a failed job still holds. */
export async function queueIdentification(item: StageWork): Promise<void> {
    await trackQueue.add("enrich", { trackId: item.trackId, trackTitle: item.title }, { jobId: item.jobId });
}

/**
 * The identification stage's turn: look `IDENTIFICATION_LOOKAHEAD` songs ahead so AcoustID's batches fill and
 * untagged albums are named, then claim and queue only the first window's worth.
 */
export async function runIdentification(offer: StageOffer): Promise<number> {
    const upcoming = await offer.nextWork(IDENTIFICATION_LOOKAHEAD);
    await prepareIdentification(upcoming);
    return offer.dispatch(upcoming.slice(0, await offer.window()), queueIdentification);
}
