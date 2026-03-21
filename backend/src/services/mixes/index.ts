import { logger } from "../../utils/logger";
import { moodBucketService } from "../moodBucketService";
import { ProgrammaticMix, getSeededRandom } from "./helpers";
import {
    generateEraMix,
    generateGenreMix,
    generatePartyMix,
    generateWorkoutMix,
    generateFocusMix,
} from "./genreMixes";
import {
    generateChillMix,
    generateHighEnergyMix,
    generateLateNightMix,
    generateHappyMix,
    generateMelancholyMix,
    generateDanceFloorMix,
    generateAcousticMix,
    generateInstrumentalMix,
    generateRoadTripMix,
    generateSadGirlSundays,
    generateMainCharacterEnergy,
    generateVillainEra,
    generate3AMThoughts,
    generateHotGirlWalk,
    generateRageCleaning,
    generateGoldenHour,
    generateShowerKaraoke,
    generateInMyFeelings,
    generateMidnightDrive,
    generateCoffeeShopVibes,
    generateRomanticizeYourLife,
    generateThatGirlEra,
    generateUnhinged,
    generateDeepCuts,
    generateKeyJourney,
    generateTempoFlow,
    generateVocalDetox,
    generateMinorKeyMix,
    generateMoodOnDemand,
} from "./moodMixes";
import { generateDayMix } from "./timeMixes";
import {
    generateTopTracksMix,
    generateRediscoverMix,
    generateArtistSimilarMix,
    generateRandomDiscoveryMix,
} from "./discoveryMixes";

export type { ProgrammaticMix } from "./helpers";
export { generateMoodOnDemand } from "./moodMixes";
export { generateMoodTagMix } from "./moodMixes";

export class ProgrammaticPlaylistService {
    private readonly DAILY_MIX_COUNT = 5;

    async generateAllMixes(
        userId: string,
        forceRandom = false
    ): Promise<ProgrammaticMix[]> {
        const today = new Date().toISOString().split("T")[0];
        const seedString = forceRandom
            ? `${userId}-${Date.now()}-${Math.random()}`
            : `${today}-${userId}`;
        const dateSeed = getSeededRandom(seedString);

        logger.debug(
            `[MIXES] Generating mixes for user ${userId}, forceRandom: ${forceRandom}, seed: ${dateSeed}`
        );

        const seedSuffix = forceRandom ? `-${Date.now()}` : "";
        const mixGenerators = [
            {
                fn: () => generateEraMix(userId, today + seedSuffix),
                weight: 2,
                name: "Era Mix",
            },
            {
                fn: () => generateGenreMix(userId, today + seedSuffix),
                weight: 2,
                name: "Genre Mix",
            },
            {
                fn: () => generateTopTracksMix(userId),
                weight: 1,
                name: "Top Tracks Mix",
            },
            {
                fn: () => generateRediscoverMix(userId, today + seedSuffix),
                weight: 1,
                name: "Rediscover Mix",
            },
            {
                fn: () => generateArtistSimilarMix(userId),
                weight: 1,
                name: "Artist Similar Mix",
            },
            {
                fn: () =>
                    generateRandomDiscoveryMix(userId, today + seedSuffix),
                weight: 1,
                name: "Random Discovery Mix",
            },
            {
                fn: () => generatePartyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Party Mix",
            },
            {
                fn: () => generateChillMix(userId, today + seedSuffix),
                weight: 2,
                name: "Chill Mix",
            },
            {
                fn: () => generateWorkoutMix(userId, today + seedSuffix),
                weight: 2,
                name: "Workout Mix",
            },
            {
                fn: () => generateFocusMix(userId, today + seedSuffix),
                weight: 2,
                name: "Focus Mix",
            },
            {
                fn: () => generateHighEnergyMix(userId, today + seedSuffix),
                weight: 2,
                name: "High Energy Mix",
            },
            {
                fn: () => generateLateNightMix(userId, today + seedSuffix),
                weight: 2,
                name: "Late Night Mix",
            },
            {
                fn: () => generateHappyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Happy Vibes Mix",
            },
            {
                fn: () => generateMelancholyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Melancholy Mix",
            },
            {
                fn: () => generateDanceFloorMix(userId, today + seedSuffix),
                weight: 2,
                name: "Dance Floor Mix",
            },
            {
                fn: () => generateAcousticMix(userId, today + seedSuffix),
                weight: 2,
                name: "Acoustic Mix",
            },
            {
                fn: () => generateInstrumentalMix(userId, today + seedSuffix),
                weight: 2,
                name: "Instrumental Mix",
            },
            {
                fn: () => generateRoadTripMix(userId, today + seedSuffix),
                weight: 2,
                name: "Road Trip Mix",
            },
            {
                fn: () => generateDayMix(userId),
                weight: 1,
                name: "Day Mix",
            },
            {
                fn: () => generateSadGirlSundays(userId, today + seedSuffix),
                weight: 2,
                name: "Sad Girl Sundays",
            },
            {
                fn: () =>
                    generateMainCharacterEnergy(userId, today + seedSuffix),
                weight: 2,
                name: "Main Character Energy",
            },
            {
                fn: () => generateVillainEra(userId, today + seedSuffix),
                weight: 2,
                name: "Villain Era",
            },
            {
                fn: () => generate3AMThoughts(userId, today + seedSuffix),
                weight: 2,
                name: "3AM Thoughts",
            },
            {
                fn: () => generateHotGirlWalk(userId, today + seedSuffix),
                weight: 2,
                name: "Hot Girl Walk",
            },
            {
                fn: () => generateRageCleaning(userId, today + seedSuffix),
                weight: 2,
                name: "Rage Cleaning",
            },
            {
                fn: () => generateGoldenHour(userId, today + seedSuffix),
                weight: 2,
                name: "Golden Hour",
            },
            {
                fn: () => generateShowerKaraoke(userId, today + seedSuffix),
                weight: 2,
                name: "Shower Karaoke",
            },
            {
                fn: () => generateInMyFeelings(userId, today + seedSuffix),
                weight: 2,
                name: "In My Feelings",
            },
            {
                fn: () => generateMidnightDrive(userId, today + seedSuffix),
                weight: 2,
                name: "Midnight Drive",
            },
            {
                fn: () => generateCoffeeShopVibes(userId, today + seedSuffix),
                weight: 2,
                name: "Coffee Shop Vibes",
            },
            {
                fn: () =>
                    generateRomanticizeYourLife(userId, today + seedSuffix),
                weight: 2,
                name: "Romanticize Your Life",
            },
            {
                fn: () => generateThatGirlEra(userId, today + seedSuffix),
                weight: 2,
                name: "That Girl Era",
            },
            {
                fn: () => generateUnhinged(userId, today + seedSuffix),
                weight: 2,
                name: "Unhinged",
            },
            {
                fn: () => generateDeepCuts(userId, today + seedSuffix),
                weight: 1,
                name: "Deep Cuts",
            },
            {
                fn: () => generateKeyJourney(userId, today + seedSuffix),
                weight: 1,
                name: "Key Journey",
            },
            {
                fn: () => generateTempoFlow(userId, today + seedSuffix),
                weight: 1,
                name: "Tempo Flow",
            },
            {
                fn: () => generateVocalDetox(userId, today + seedSuffix),
                weight: 1,
                name: "Vocal Detox",
            },
            {
                fn: () => generateMinorKeyMix(userId, today + seedSuffix),
                weight: 1,
                name: "Minor Key Mondays",
            },
        ];

        const selectedIndices: number[] = [];
        let seed = dateSeed;

        logger.debug(
            `[MIXES] Selecting ${this.DAILY_MIX_COUNT} mixes from ${mixGenerators.length} types...`
        );

        while (selectedIndices.length < this.DAILY_MIX_COUNT) {
            seed = (seed * 9301 + 49297) % 233280;
            const index = seed % mixGenerators.length;
            if (!selectedIndices.includes(index)) {
                selectedIndices.push(index);
                logger.debug(
                    `[MIXES] Selected index ${index}: ${mixGenerators[index].name}`
                );
            }
        }

        logger.debug(
            `[MIXES] Final selected indices: [${selectedIndices.join(", ")}]`
        );

        const mixPromises = selectedIndices.map((i) => {
            logger.debug(`[MIXES] Generating ${mixGenerators[i].name}...`);
            return mixGenerators[i].fn();
        });
        const mixes = await Promise.all(mixPromises);

        logger.debug(`[MIXES] Generated ${mixes.length} mixes before filtering`);
        mixes.forEach((mix, i) => {
            if (mix === null) {
                logger.debug(
                    `[MIXES] Mix ${i} (${
                        mixGenerators[selectedIndices[i]].name
                    }) returned NULL`
                );
            } else {
                logger.debug(
                    `[MIXES] Mix ${i}: ${mix.name} (${mix.trackCount} tracks)`
                );
            }
        });

        let finalMixes = mixes.filter(
            (mix): mix is ProgrammaticMix => mix !== null
        );
        logger.debug(
            `[MIXES] Returning ${finalMixes.length} mixes after filtering nulls`
        );

        if (finalMixes.length < this.DAILY_MIX_COUNT) {
            logger.debug(
                `[MIXES] Only got ${finalMixes.length} mixes, trying to fill gaps...`
            );

            const successfulTypes = new Set(finalMixes.map((m) => m.type));
            const attemptedIndices = new Set(selectedIndices);

            for (
                let i = 0;
                i < mixGenerators.length &&
                finalMixes.length < this.DAILY_MIX_COUNT;
                i++
            ) {
                if (!attemptedIndices.has(i)) {
                    logger.debug(
                        `[MIXES] Attempting fallback: ${mixGenerators[i].name}`
                    );
                    const fallbackMix = await mixGenerators[i].fn();
                    if (
                        fallbackMix &&
                        !successfulTypes.has(fallbackMix.type)
                    ) {
                        finalMixes.push(fallbackMix);
                        successfulTypes.add(fallbackMix.type);
                        logger.debug(
                            `[MIXES] Fallback succeeded: ${fallbackMix.name}`
                        );
                    }
                }
            }

            logger.debug(
                `[MIXES] After fallbacks: ${finalMixes.length} mixes`
            );
        }

        try {
            const savedMoodMix = await moodBucketService.getUserMoodMix(userId);
            if (savedMoodMix) {
                logger.debug(
                    `[MIXES] User has saved mood mix: "${savedMoodMix.name}" with ${savedMoodMix.trackCount} tracks`
                );
                finalMixes.push(savedMoodMix);
            }
        } catch (err) {
            logger.error("[MIXES] Error getting user's saved mood mix:", err);
        }

        return finalMixes;
    }

    generateMoodOnDemand(
        userId: string,
        params: Parameters<typeof generateMoodOnDemand>[1]
    ): ReturnType<typeof generateMoodOnDemand> {
        return generateMoodOnDemand(userId, params);
    }
}

export const programmaticPlaylistService = new ProgrammaticPlaylistService();
