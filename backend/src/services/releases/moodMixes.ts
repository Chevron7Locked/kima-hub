/**
 * The mood-mix question after the mood heads were fixed: rebuild (clear the
 * saved mix), keep, or save it as a playlist first. A mix under a mood that no
 * longer exists is "retired" and offers only save or remove; unanswered, it is
 * asked again. Answers are ReleaseChoice rows; every endpoint is repeatable.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { announcePlaylistChange } from "../playlistEvents";
import { moodBucketService, VALID_MOODS, type MoodType } from "../moodBucketService";
import { addTracks } from "../playlistService";

/** The ReleaseChoice key the answer is stored under (the catalog items are "moods.mixes*"). */
const MOOD_MIX_DECISION_KEY = "moods.mixes.rebuild";
/** The release that asks. */
export const MOOD_MIX_RELEASE = "1.11.0";

/** "remove" is the retired-mix wording of "rebuild": both clear the mix. */
export type MoodMixDecision = "rebuild" | "keep" | "remove";

/**
 * Display names of the moods 1.11 dropped, as the app showed them up to 1.10.1
 * (MOOD_CONFIG in moodBucketService), so a saved playlist carries the name the
 * user knew the mix by.
 */
const RETIRED_MOOD_NAMES: Record<string, string> = {
    energetic: "High Energy",
    focus: "Focus Mode",
    melancholy: "Deep Feels",
    acoustic: "Acoustic Vibes",
};

/** A mood id nobody named: "late-night" -> "Late Night". */
function titleCase(id: string): string {
    return id
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
}

interface SavedMix {
    id: string;
    name: string;
    mood: string;
    trackIds: string[];
    /** Saved under a mood that no longer exists; the app cannot show it. */
    retired: boolean;
}

/**
 * The user's saved mood mix, including a retired one. The id is the one the
 * home page uses for the same mix (`your-mood-mix-<generatedAt ms>`).
 */
async function savedMoodMix(userId: string): Promise<SavedMix | null> {
    const row = await prisma.userMoodMix.findUnique({
        where: { userId },
        select: { mood: true, trackIds: true, generatedAt: true },
    });
    if (!row) return null;

    if (VALID_MOODS.includes(row.mood as MoodType)) {
        const mix = await moodBucketService.getUserMoodMix(userId);
        if (!mix) return null;
        return { id: mix.id, name: mix.name, mood: mix.mood, trackIds: mix.trackIds, retired: false };
    }
    const label = RETIRED_MOOD_NAMES[row.mood] ?? titleCase(row.mood);
    return {
        id: `your-mood-mix-${row.generatedAt.getTime()}`,
        name: `Your ${label} Mix`,
        mood: row.mood,
        trackIds: row.trackIds,
        retired: true,
    };
}

export interface MoodMixState {
    /** The user's saved mood mix, or null when they have none (or cleared it). */
    mix: { id: string; name: string; mood: string; trackCount: number; retired: boolean } | null;
    /** "rebuild" means the mix was cleared, by Rebuild or Remove. */
    decision: "rebuild" | "keep" | null;
    /** The playlist this mix was already saved as, if any. */
    playlist: { id: string; name: string } | null;
}

export async function moodMixState(userId: string): Promise<MoodMixState> {
    const [mix, choice] = await Promise.all([
        savedMoodMix(userId),
        prisma.releaseChoice.findUnique({
            where: { userId_key: { userId, key: MOOD_MIX_DECISION_KEY } },
            select: { enabled: true, decidedBy: true },
        }),
    ]);
    const playlist = mix
        ? await prisma.playlist.findFirst({
              where: { userId, mixId: mix.id },
              select: { id: true, name: true },
          })
        : null;
    return {
        mix: mix
            ? { id: mix.id, name: mix.name, mood: mix.mood, trackCount: mix.trackIds.length, retired: mix.retired }
            : null,
        decision:
            choice?.decidedBy === ChoiceDecidedBy.EXPLICIT ? (choice.enabled ? "rebuild" : "keep") : null,
        playlist,
    };
}

export class MoodMixCannotKeepError extends Error {}

/**
 * Record the answer; rebuild and remove clear the saved mix. "keep" on a
 * retired mix throws MoodMixCannotKeepError. Returns mixes removed (0 on a
 * repeat). A cleared mix cannot come back.
 */
export async function decideMoodMixes(
    userId: string,
    decision: MoodMixDecision,
): Promise<{ decision: MoodMixDecision; removed: number }> {
    const clear = decision !== "keep";
    if (!clear && (await savedMoodMix(userId))?.retired) throw new MoodMixCannotKeepError();

    await prisma.releaseChoice.upsert({
        where: { userId_key: { userId, key: MOOD_MIX_DECISION_KEY } },
        create: {
            userId,
            version: MOOD_MIX_RELEASE,
            key: MOOD_MIX_DECISION_KEY,
            enabled: clear,
            decidedBy: ChoiceDecidedBy.EXPLICIT,
        },
        update: { enabled: clear, decidedBy: ChoiceDecidedBy.EXPLICIT, decidedAt: new Date() },
    });
    if (!clear) return { decision, removed: 0 };

    const { removed } = await moodBucketService.clearUserMoodMix(userId);
    // The home page's mix list is cached for an hour and carries the saved mix;
    // drop it so the cleared mix does not keep showing up.
    await redisClient.del(`mixes:${userId}`);
    logger.debug(`[Release] ${userId} chose ${decision} for their mood mix (${removed} cleared)`);
    return { decision, removed };
}

export class MoodMixNotFoundError extends Error {}

/**
 * Save the user's current mood mix (`mixId`, else MoodMixNotFoundError) as a
 * playlist keyed by that id, so repeat saves reuse it and skip tracks already
 * there. A retired mix is named after its old mood.
 */
export async function saveMoodMixAsPlaylist(
    userId: string,
    mixId: string,
): Promise<{ id: string; name: string; trackCount: number; created: boolean }> {
    const mix = await savedMoodMix(userId);
    if (!mix || mix.id !== mixId) throw new MoodMixNotFoundError(mixId);

    let created = false;
    let playlist = await prisma.playlist.findFirst({
        where: { userId, mixId: mix.id },
        select: { id: true, name: true },
    });
    if (!playlist) {
        try {
            playlist = await prisma.playlist.create({
                data: { userId, mixId: mix.id, name: mix.name, isPublic: false },
                select: { id: true, name: true },
            });
            created = true;
        } catch (error) {
            // Two saves at once: the unique (userId, mixId) index let one win.
            // Use the winner's playlist.
            if ((error as { code?: string }).code !== "P2002") throw error;
            playlist = await prisma.playlist.findFirstOrThrow({
                where: { userId, mixId: mix.id },
                select: { id: true, name: true },
            });
        }
    }

    const { added } = await addTracks(playlist.id, mix.trackIds);
    if (created || added > 0) announcePlaylistChange(userId, playlist.id);
    const trackCount = await prisma.playlistItem.count({ where: { playlistId: playlist.id } });
    return { ...playlist, trackCount, created };
}
