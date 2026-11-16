import * as settings from "../../utils/systemSettings";
import { libraryChangedAt, markLibraryChanged } from "../../services/libraryChanged";

// The real writer, taken before any spy exists: a spy set over a spy that is still in place would otherwise call itself.
const realSave = settings.saveSystemSettings;

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

/** Moves the real marker to `at` (now), as the code under test does, and answers the time now stored. */
export async function markedTime(at?: Date): Promise<Date> {
    await markLibraryChanged(at);
    return new Date(await libraryChangedAt());
}

/** Whether the library-changed marker (services/libraryChanged.ts) moved while `work` ran: the real marker, on the suite database. */
export async function markerMoves(work: () => Promise<unknown>): Promise<boolean> {
    const before = (await markedTime()).getTime();
    await tick();
    await work();
    return (await libraryChangedAt()) > before;
}

// The marker is saved through saveSystemSettings (the one settings writer) with its field; a test that counts or breaks
// marker writes finds them by it.
const writesMarker = (changes: unknown) => typeof changes === "object" && changes !== null && "libraryChangedAt" in changes;

/** Counts the writes to the marker made from now on, against the real database. Call `restore` when done. */
export function watchMarkerWrites() {
    const original = realSave;
    let writes = 0;
    const spy = jest.spyOn(settings, "saveSystemSettings").mockImplementation(((changes: Parameters<typeof original>[0]) => {
        if (writesMarker(changes)) writes++;
        return original(changes);
    }) as never);
    return { count: () => writes, reset: () => { writes = 0; }, restore: () => spy.mockRestore() };
}

/** Makes every write to the marker fail with `error`; other saves run as they are. Returns the way to undo it. */
export function failMarkerWrites(error: Error) {
    const original = realSave;
    const spy = jest.spyOn(settings, "saveSystemSettings").mockImplementation(((changes: Parameters<typeof original>[0]) =>
        writesMarker(changes) ? Promise.reject(error) : original(changes)) as never);
    return () => spy.mockRestore();
}
