/**
 * The library change marker moves once at start-up, so shown changes still waiting in the coalescing window
 * (services/shownChanges.ts) when the last process stopped do not leave a client with a stale list. Real database.
 */
import { prisma } from "../../utils/db";
import { markLibraryChangedAtStart } from "../libraryChanged";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";

afterAll(async () => {
    await prisma.$disconnect();
});

it("moves the library change marker at start-up", async () => {
    expect(await markerMoves(markLibraryChangedAtStart)).toBe(true);
});
