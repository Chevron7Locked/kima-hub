/**
 * A Home mix drawn by the recipe engine: the mix's own id, title, description and colour around the songs the engine
 * draws from its recipe for this day and this user.
 */
import { ProgrammaticMix, mixOf, tracksByIds } from "./helpers";
import { weekdayOf } from "./mixDay";
import { UnrankableLibraryError, pickRecipeTracks } from "./recipes";

export interface RecipeMixSpec {
    /** The recipe's id in recipes.json. */
    recipe: string;
    /** The mix id's prefix; the day it holds for follows it. */
    id: string;
    type: string;
    name: string;
    description: string;
    /** Key into the mix colour table. */
    colorType: string;
    /** The weekday the mix exists on (0 = Sunday), of the day it is drawn for; every day when absent. */
    day?: number;
}

/**
 * The mix for `today`, or null on another weekday or when fewer than MIN_MIX_TRACKS songs are the recipe's members or the library cannot rank the recipe (UnrankableLibraryError).
 * `today` is the day the mix holds for, with a refresh's reroll appended, so a refresh draws again.
 */
export async function recipeMix(spec: RecipeMixSpec, userId: string, today: string): Promise<ProgrammaticMix | null> {
    if (spec.day !== undefined && weekdayOf(today) !== spec.day) return null;
    try {
        const mix = await pickRecipeTracks(spec.recipe, { userId, date: today });
        return mix ? mixFromTracks(spec, today, mix.trackIds) : null;
    } catch (error) {
        // A library the recipe cannot rank has no such mix; that is a property of the library, not a fault.
        if (error instanceof UnrankableLibraryError) return null;
        throw error;
    }
}

/** The mix `spec` names for `today`, holding these songs in this order. */
export async function mixFromTracks(spec: RecipeMixSpec, today: string, trackIds: string[]): Promise<ProgrammaticMix> {
    const tracks = await tracksByIds(trackIds, { album: { select: { coverUrl: true } } });
    return mixOf({ ...spec, id: `${spec.id}-${today}` }, tracks);
}

/** A generator for the daily rotation: `recipeMix` with its spec bound. */
export const recipeMixGenerator =
    (spec: RecipeMixSpec) =>
    (userId: string, today: string): Promise<ProgrammaticMix | null> =>
        recipeMix(spec, userId, today);
