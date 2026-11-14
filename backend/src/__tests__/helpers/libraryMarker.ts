import { libraryChangedAt, markLibraryChanged } from "../../services/libraryChanged";

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

/** Whether the library-changed marker (services/libraryChanged.ts) moved while `work` ran: the real marker, on the suite database. */
export async function markerMoves(work: () => Promise<unknown>): Promise<boolean> {
    const before = (await markLibraryChanged()).getTime();
    await tick();
    await work();
    return (await libraryChangedAt()) > before;
}
