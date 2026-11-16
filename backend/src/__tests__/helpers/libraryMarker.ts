import { prisma } from "../../utils/db";
import { libraryChangedAt, markLibraryChanged } from "../../services/libraryChanged";

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

/** Whether the library-changed marker (services/libraryChanged.ts) moved while `work` ran: the real marker, on the suite database. */
export async function markerMoves(work: () => Promise<unknown>): Promise<boolean> {
    const before = (await markLibraryChanged()).getTime();
    await tick();
    await work();
    return (await libraryChangedAt()) > before;
}

// The marker is written by one statement that names its column; a test that counts or breaks marker writes finds them by it.
const writesMarker = (args: unknown[]) => Array.isArray(args[0]) && (args[0] as string[]).join("").includes('"libraryChangedAt"');

/** Counts the writes to the marker made from now on, against the real database. Call `restore` when done. */
export function watchMarkerWrites() {
    const original = prisma.$queryRaw.bind(prisma);
    let writes = 0;
    const spy = jest.spyOn(prisma, "$queryRaw").mockImplementation(((...args: unknown[]) => {
        if (writesMarker(args)) writes++;
        return (original as (...a: unknown[]) => unknown)(...args);
    }) as never);
    return { count: () => writes, reset: () => { writes = 0; }, restore: () => spy.mockRestore() };
}

/** Makes every write to the marker fail with `error`; other queries run as they are. Returns the way to undo it. */
export function failMarkerWrites(error: Error) {
    const original = prisma.$queryRaw.bind(prisma);
    const spy = jest.spyOn(prisma, "$queryRaw").mockImplementation(((...args: unknown[]) =>
        writesMarker(args) ? Promise.reject(error) : (original as (...a: unknown[]) => unknown)(...args)) as never);
    return () => spy.mockRestore();
}
