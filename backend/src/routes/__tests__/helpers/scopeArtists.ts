/**
 * A test that starts a walk over every artist (the recount, the image backfill) sees every artist in the database, and
 * the other suites of a full run fill it, so the walk's length, and the test's, would depend on them. `scopeArtists`
 * adds the test's own id prefix to the artist reads' filter: the real queries still run, over this test's artists only.
 * Call it in a `beforeEach` (or the test); `jest.restoreAllMocks()` undoes it.
 */
import { prisma } from "../../../utils/db";

/** `args` with the artist id prefix added to its filter. */
export const onlyArtistsStartingWith = (prefix: string) => (args: any) => ({
    ...args,
    where: { AND: [args?.where ?? {}, { id: { startsWith: prefix } }] },
});

/** Makes `prisma.artist.count` and `findMany` read only the artists whose id starts with `prefix`. */
export function scopeArtists(prefix: string): void {
    const mine = onlyArtistsStartingWith(prefix);
    const realCount: any = prisma.artist.count.bind(prisma.artist);
    const realFindMany: any = prisma.artist.findMany.bind(prisma.artist);
    jest.spyOn(prisma.artist, "count").mockImplementation(((args?: any) => realCount(mine(args))) as any);
    jest.spyOn(prisma.artist, "findMany").mockImplementation(((args?: any) => realFindMany(mine(args))) as any);
}
