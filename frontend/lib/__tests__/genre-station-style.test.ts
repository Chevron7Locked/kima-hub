import { describe, expect, it } from "vitest";
import { buildGenreStations } from "@/features/home/radioData";

// The server lists one station per genre under whichever spelling most songs carry (#235); its colour follows the
// genre, not the spelling.
describe("genre station colours", () => {
    const style = (genre: string) => buildGenreStations([{ genre, count: 20 }])[0];

    it("gives every spelling of a genre the genre's colour", () => {
        const hipHop = style("hip hop");
        for (const spelling of ["hip-hop", "hiphop", "Hip_Hop", "hip‐hop", "hip hop"]) {
            expect(style(spelling).accentGradient).toBe(hipHop.accentGradient);
        }
        expect(hipHop.accentGradient).not.toBe(style("not a listed genre").accentGradient);
    });

    it("keeps the station's name and filter as the server spelled them", () => {
        const station = style("Hip-Hop");
        expect(station.name).toBe("Hip-Hop");
        expect(station.filter).toEqual({ type: "genre", value: "Hip-Hop" });
    });
});
