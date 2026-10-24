import { logger } from "../../utils/logger";
import { moodBucketService } from "../moodBucketService";
import { ProgrammaticMix, getSeededRandom } from "./helpers";
import { mixDay } from "./mixDay";
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
    generateSleepMix,
    generateSummerMix,
    generateEpicMix,
    generateDreamyMix,
    generateNostalgicMix,
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

class ProgrammaticPlaylistService {
    private readonly DAILY_MIX_COUNT = 5;

    async generateAllMixes(
        userId: string,
        forceRandom = false,
        now = new Date()
    ): Promise<ProgrammaticMix[]> {
        // The server's calendar date: every mix's id, seed and weekday come from it.
        const today = mixDay(now);
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
                name: "Era Mix",
            },
            {
                fn: () => generateGenreMix(userId, today + seedSuffix),
                name: "Genre Mix",
            },
            {
                fn: () => generateTopTracksMix(userId),
                name: "Top Tracks Mix",
            },
            {
                fn: () => generateRediscoverMix(userId, today + seedSuffix),
                name: "Rediscover Mix",
            },
            {
                fn: () => generateArtistSimilarMix(userId),
                name: "Artist Similar Mix",
            },
            {
                fn: () =>
                    generateRandomDiscoveryMix(userId, today + seedSuffix),
                name: "Random Discovery Mix",
            },
            {
                fn: () => generatePartyMix(userId, today + seedSuffix),
                name: "Party Mix",
            },
            {
                fn: () => generateChillMix(userId, today + seedSuffix),
                name: "Chill Mix",
            },
            {
                fn: () => generateWorkoutMix(userId, today + seedSuffix),
                name: "Workout Mix",
            },
            {
                fn: () => generateFocusMix(userId, today + seedSuffix),
                name: "Focus Mix",
            },
            {
                fn: () => generateHighEnergyMix(userId, today + seedSuffix),
                name: "High Energy Mix",
            },
            {
                fn: () => generateLateNightMix(userId, today + seedSuffix),
                name: "Late Night Mix",
            },
            {
                fn: () => generateHappyMix(userId, today + seedSuffix),
                name: "Happy Vibes Mix",
            },
            {
                fn: () => generateMelancholyMix(userId, today + seedSuffix),
                name: "Melancholy Mix",
            },
            {
                fn: () => generateDanceFloorMix(userId, today + seedSuffix),
                name: "Dance Floor Mix",
            },
            {
                fn: () => generateAcousticMix(userId, today + seedSuffix),
                name: "Acoustic Mix",
            },
            {
                fn: () => generateInstrumentalMix(userId, today + seedSuffix),
                name: "Instrumental Mix",
            },
            {
                fn: () => generateRoadTripMix(userId, today + seedSuffix),
                name: "Road Trip Mix",
            },
            {
                fn: () => generateDayMix(userId, today + seedSuffix),
                name: "Day Mix",
            },
            {
                fn: () => generateSadGirlSundays(userId, today + seedSuffix),
                name: "Sad Girl Sundays",
            },
            {
                fn: () =>
                    generateMainCharacterEnergy(userId, today + seedSuffix),
                name: "Main Character Energy",
            },
            {
                fn: () => generateVillainEra(userId, today + seedSuffix),
                name: "Villain Era",
            },
            {
                fn: () => generate3AMThoughts(userId, today + seedSuffix),
                name: "3AM Thoughts",
            },
            {
                fn: () => generateHotGirlWalk(userId, today + seedSuffix),
                name: "Hot Girl Walk",
            },
            {
                fn: () => generateRageCleaning(userId, today + seedSuffix),
                name: "Rage Cleaning",
            },
            {
                fn: () => generateGoldenHour(userId, today + seedSuffix),
                name: "Golden Hour",
            },
            {
                fn: () => generateShowerKaraoke(userId, today + seedSuffix),
                name: "Shower Karaoke",
            },
            {
                fn: () => generateInMyFeelings(userId, today + seedSuffix),
                name: "In My Feelings",
            },
            {
                fn: () => generateMidnightDrive(userId, today + seedSuffix),
                name: "Midnight Drive",
            },
            {
                fn: () => generateCoffeeShopVibes(userId, today + seedSuffix),
                name: "Coffee Shop Vibes",
            },
            {
                fn: () =>
                    generateRomanticizeYourLife(userId, today + seedSuffix),
                name: "Romanticize Your Life",
            },
            {
                fn: () => generateThatGirlEra(userId, today + seedSuffix),
                name: "That Girl Era",
            },
            {
                fn: () => generateUnhinged(userId, today + seedSuffix),
                name: "Unhinged",
            },
            {
                fn: () => generateSleepMix(userId, today + seedSuffix),
                name: "Sleep",
            },
            {
                fn: () => generateSummerMix(userId, today + seedSuffix),
                name: "Summer",
            },
            {
                fn: () => generateEpicMix(userId, today + seedSuffix),
                name: "Epic",
            },
            {
                fn: () => generateDreamyMix(userId, today + seedSuffix),
                name: "Dreamy",
            },
            {
                fn: () => generateNostalgicMix(userId, today + seedSuffix),
                name: "Nostalgic",
            },
            {
                fn: () => generateDeepCuts(userId, today + seedSuffix),
                name: "Deep Cuts",
            },
            {
                fn: () => generateKeyJourney(userId, today + seedSuffix),
                name: "Key Journey",
            },
            {
                fn: () => generateTempoFlow(userId, today + seedSuffix),
                name: "Tempo Flow",
            },
            {
                fn: () => generateVocalDetox(userId, today + seedSuffix),
                name: "Vocal Detox",
            },
            {
                fn: () => generateMinorKeyMix(userId, today + seedSuffix),
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

        // One mix failing (a recipe refusing a library with no spread on a mood) must not blank the others.
        const generate = async (i: number): Promise<ProgrammaticMix | null> => {
            try {
                return await mixGenerators[i].fn();
            } catch (error) {
                logger.error(`[MIXES] ${mixGenerators[i].name} failed:`, error);
                return null;
            }
        };
        const mixPromises = selectedIndices.map((i) => {
            logger.debug(`[MIXES] Generating ${mixGenerators[i].name}...`);
            return generate(i);
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
                    const fallbackMix = await generate(i);
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
