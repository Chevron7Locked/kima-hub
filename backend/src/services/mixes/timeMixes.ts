import { ProgrammaticMix } from "./helpers";
import { recipeMix, type RecipeMixSpec } from "./recipeMix";

/** The days that have a mix, by day of week (0 = Sunday), each drawn from its recipe. */
const DAY_MIXES: Record<number, RecipeMixSpec> = {
    0: {
        recipe: "sunday-morning",
        id: "sunday",
        type: "sunday-morning",
        name: "Sunday Morning",
        description: "Peaceful tunes for a lazy Sunday",
        colorType: "sunday-morning",
    },
    1: {
        recipe: "monday-motivation",
        id: "monday",
        type: "confidence-boost",
        name: "Monday Motivation",
        description: "Start your week with energy",
        colorType: "confidence-boost",
    },
    5: {
        recipe: "friday-night",
        id: "friday",
        type: "dance-floor",
        name: "Friday Night",
        description: "Weekend vibes to kick off the party",
        colorType: "dance-floor",
    },
};

/** Today's day mix by the server's clock, or null on a day without one. */
export async function generateDayMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const day = DAY_MIXES[new Date().getDay()];
    return day ? recipeMix(day, userId, today) : null;
}
