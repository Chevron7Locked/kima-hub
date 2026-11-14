/**
 * The mood step of the enrichment cycle: mood scores for new or changed sound vectors, the mood statistics when
 * their inputs changed, then every track's tags (services/moods/). The scheduler decides when the step runs and
 * in what order; everything the step does once it runs is here, and it is tried without the scheduler.
 *
 * Shape: a factory, because the step keeps one fact between calls (the unwritten note); a step with no such fact
 * is a plain function (similarity.ts).
 *
 * The step reads the scheduler's progress through `readProgress` and its Redis through `redis`, so it holds no
 * connection of its own. The one fact it keeps in this process is a note it could not yet write to Redis.
 */

import type { Redis } from "ioredis";
import { logger } from "../../utils/logger";
import { buildMoods } from "../../services/moods/state";
import { writeMoodTags } from "../../services/moods/tags";
import { dropCachedMixes } from "../../services/mixes/dropCache";
import { soundInputsSettled, type SoundInputs } from "./soundInputs";

export interface MoodStepDeps {
    /** The scheduler's progress counts. */
    readProgress: () => Promise<SoundInputs>;
    /** The scheduler's Redis, asked for when the step needs it: the scheduler opens its connection on first use. */
    redis: () => Pick<Redis, "get" | "set" | "del" | "scan">;
}

/**
 * The note in Redis that the moods changed and the cached mixes that depend on them are not dropped yet. It is kept
 * outside the process so a restart before the inputs settle still makes the drop, and it is not under `mixes:` so
 * the drop never deletes it.
 */
const MOOD_MIXES_OWED_KEY = "enrichment:mood-mixes-owed";

/**
 * The mood step, once analysis and sound vectors have finished for the whole library (the moods read the vectors, and
 * their statistics the whole library). Each call: mood scores for new or changed vectors, the mood statistics when
 * their inputs changed, then every track's tags. A change drops the cached mood mixes, and the drop stays owed
 * across a Redis failure or a restart. A failure is logged and stops the step (scores already committed stay).
 * The call returns how many tracks were scored.
 */
export function createMoodStep({ readProgress, redis }: MoodStepDeps): () => Promise<number> {
    // A change whose note could not be written to Redis, held here until it is: the moods are already committed,
    // so the next cycle will not see the change again.
    let owedNoteUnwritten = false;

    /**
     * Writes down that the moods changed (when they did) and, once the moods' inputs have settled, drops the cached
     * mixes that depend on them. A Redis or database error is logged and goes no further: the mood tags are still
     * written, and a note already written down stays for the next cycle.
     */
    async function dropMixesIfOwed(changed: boolean): Promise<void> {
        if (changed) owedNoteUnwritten = true;
        try {
            const client = redis();
            if (owedNoteUnwritten) {
                await client.set(MOOD_MIXES_OWED_KEY, "1");
                owedNoteUnwritten = false;
            }
            if ((await client.get(MOOD_MIXES_OWED_KEY)) && soundInputsSettled(await readProgress())) {
                const dropped = await dropCachedMixes(client, true);
                await client.del(MOOD_MIXES_OWED_KEY);
                if (dropped > 0) logger.info(`[Enrichment] Cleared ${dropped} mix cache entries after the moods changed`);
            }
        } catch (error) {
            logger.error("[Enrichment] Could not drop the cached mood mixes; the moods changed and the drop is still owed:", error);
        }
    }

    return async () => {
        if (!soundInputsSettled(await readProgress())) {
            logger.debug("[Enrichment] Moods wait: analysis or sound vectors are still being made");
            return 0;
        }
        try {
            const { scored, stateChanged } = await buildMoods();
            await dropMixesIfOwed(scored > 0 || stateChanged);
            const tagged = await writeMoodTags();
            if (tagged > 0) logger.info(`[Enrichment] Mood tags changed on ${tagged} tracks`);
            return scored;
        } catch (error) {
            logger.error("[Enrichment] Mood step failed; the cycle goes on without it:", error);
            return 0;
        }
    };
}
