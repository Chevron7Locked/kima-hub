/** A station's songs, without its paging: what tests compare station membership and order by. */
import { getRecipe, pickStationPage, pickWildcardPage, type Recipe } from "../../services/mixes/recipes";
import type { StationRequest } from "../../services/mixes/stationOrder";

export async function pickStationTracks(recipe: Recipe, request: StationRequest): Promise<string[]> {
    return (await pickStationPage(recipe, request)).trackIds;
}

export async function pickWildcardStation(request: StationRequest): Promise<string[]> {
    return (await pickWildcardPage(request)).trackIds;
}

export async function pickRecipeStation(recipeId: string, request: StationRequest): Promise<string[]> {
    return pickStationTracks(getRecipe(recipeId), request);
}
