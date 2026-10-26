import { describe, expect, it } from "vitest";
import { buildGenreStations } from "@/features/home/radioData";

// The server lists one station per genre under whichever spelling most songs carry (#235); its colour follows the
// genre, not the spelling.
describe("genre station colours", () => {
    const style = (genre: string) => buildGenreStations([{ genre, count: 20 }])[0];

    it("gives every spelling of a genre the genre's colour", () => {
        const hipHop = style("hip hop");
        // A Unicode hyphen, a no-break space, a soft hyphen, a minus sign and full-width letters.
        for (const spelling of ["hip-hop", "hiphop", "Hip_Hop", "hip\u2010hop", "hip\u00a0hop", "hip\u00adhop", "hip\u2212hop", "\uff28\uff29\uff30\uff0d\uff28\uff2f\uff30"]) {
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
