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
        now = new Date(),
        timeZone?: string
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

        // A forced refresh draws the day's mixes anew.
        const day = today + (forceRandom ? `-${Date.now()}` : "");
        const mixGenerators = [
            {
                fn: () => generateEraMix(userId, day),
                name: "Era Mix",
            },
            {
                fn: () => generateGenreMix(userId, day),
                name: "Genre Mix",
            },
            {
                fn: () => generateTopTracksMix(userId),
                name: "Top Tracks Mix",
            },
            {
                fn: () => generateRediscoverMix(userId, day),
                name: "Rediscover Mix",
            },
            {
                fn: () => generateArtistSimilarMix(userId),
                name: "Artist Similar Mix",
            },
            {
                fn: () =>
                    generateRandomDiscoveryMix(userId, day),
                name: "Random Discovery Mix",
            },
            {
                fn: () => generatePartyMix(userId, day),
                name: "Party Mix",
            },
            {
                fn: () => generateChillMix(userId, day),
                name: "Chill Mix",
            },
            {
                fn: () => generateWorkoutMix(userId, day),
                name: "Workout Mix",
            },
            {
                fn: () => generateFocusMix(userId, day),
                name: "Focus Mix",
            },
            {
                fn: () => generateHighEnergyMix(userId, day),
                name: "High Energy Mix",
            },
            {
                fn: () => generateLateNightMix(userId, day, timeZone),
                name: "Late Night Mix",
            },
            {
                fn: () => generateHappyMix(userId, day),
                name: "Happy Vibes Mix",
            },
            {
                fn: () => generateMelancholyMix(userId, day),
                name: "Melancholy Mix",
            },
            {
                fn: () => generateDanceFloorMix(userId, day),
                name: "Dance Floor Mix",
            },
            {
                fn: () => generateAcousticMix(userId, day),
                name: "Acoustic Mix",
            },
            {
                fn: () => generateInstrumentalMix(userId, day),
                name: "Instrumental Mix",
            },
            {
                fn: () => generateRoadTripMix(userId, day),
                name: "Road Trip Mix",
            },
            {
                fn: () => generateDayMix(userId, day),
                name: "Day Mix",
            },
            {
                fn: () => generateSadGirlSundays(userId, day),
                name: "Sad Girl Sundays",
            },
            {
                fn: () =>
                    generateMainCharacterEnergy(userId, day),
                name: "Main Character Energy",
            },
            {
                fn: () => generateVillainEra(userId, day),
                name: "Villain Era",
            },
            {
                fn: () => generateHotGirlWalk(userId, day),
                name: "Hot Girl Walk",
            },
            {
                fn: () => generateRageCleaning(userId, day),
                name: "Rage Cleaning",
            },
            {
                fn: () => generateGoldenHour(userId, day),
                name: "Golden Hour",
            },
            {
                fn: () => generateShowerKaraoke(userId, day),
                name: "Shower Karaoke",
            },
            {
                fn: () => generateInMyFeelings(userId, day),
                name: "In My Feelings",
            },
            {
                fn: () => generateMidnightDrive(userId, day, timeZone),
                name: "Midnight Drive",
            },
            {
                fn: () => generateCoffeeShopVibes(userId, day),
                name: "Coffee Shop Vibes",
            },
            {
                fn: () =>
                    generateRomanticizeYourLife(userId, day),
                name: "Romanticize Your Life",
            },
            {
                fn: () => generateThatGirlEra(userId, day),
                name: "That Girl Era",
            },
            {
                fn: () => generateUnhinged(userId, day),
                name: "Unhinged",
            },
            {
                fn: () => generateSleepMix(userId, day),
                name: "Sleep",
            },
            {
                fn: () => generateSummerMix(userId, day),
                name: "Summer",
            },
            {
                fn: () => generateEpicMix(userId, day),
                name: "Epic",
            },
            {
                fn: () => generateDreamyMix(userId, day),
                name: "Dreamy",
            },
            {
                fn: () => generateNostalgicMix(userId, day),
                name: "Nostalgic",
            },
            {
                fn: () => generateDeepCuts(userId, day),
                name: "Deep Cuts",
            },
            {
                fn: () => generateKeyJourney(userId, day),
                name: "Key Journey",
            },
            {
                fn: () => generateTempoFlow(userId, day),
                name: "Tempo Flow",
            },
            {
                fn: () => generateVocalDetox(userId, day),
                name: "Vocal Detox",
            },
            {
                fn: () => generateMinorKeyMix(userId, day),
                name: "Minor Key Mondays",
            },
        ];

        const selectedIndices: number[] = [];
        let seed = dateSeed;

        while (selectedIndices.length < this.DAILY_MIX_COUNT) {
            seed = (seed * 9301 + 49297) % 233280;
            const index = seed % mixGenerators.length;
            if (!selectedIndices.includes(index)) selectedIndices.push(index);
        }

        // One mix failing (a recipe refusing a library with no spread on a mood) must not blank the others.
        const generate = async (i: number): Promise<ProgrammaticMix | null> => {
            try {
                return await mixGenerators[i].fn();
            } catch (error) {
                logger.error(`[MIXES] ${mixGenerators[i].name} failed:`, error);
                return null;
            }
        };
        const mixes = await Promise.all(selectedIndices.map(generate));
        const finalMixes = mixes.filter((mix): mix is ProgrammaticMix => mix !== null);

        // A mix that came back empty is replaced by the next type not yet tried.
        if (finalMixes.length < this.DAILY_MIX_COUNT) {
            const successfulTypes = new Set(finalMixes.map((m) => m.type));
            const attemptedIndices = new Set(selectedIndices);

            for (
                let i = 0;
                i < mixGenerators.length &&
                finalMixes.length < this.DAILY_MIX_COUNT;
                i++
            ) {
                if (!attemptedIndices.has(i)) {
                    const fallbackMix = await generate(i);
                    if (
                        fallbackMix &&
                        !successfulTypes.has(fallbackMix.type)
                    ) {
                        finalMixes.push(fallbackMix);
                        successfulTypes.add(fallbackMix.type);
                    }
                }
            }
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
}

export const programmaticPlaylistService = new ProgrammaticPlaylistService();
