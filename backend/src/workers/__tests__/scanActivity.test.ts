/**
 * Enrichment waits while a library scan is running or queued; the album re-file shares the queue but adds no songs.
 * Real queue on the test Redis: no scan worker runs here, so an added job stays waiting.
 */
import { scanQueue } from "../queues";
import { libraryScanRunning } from "../scanActivity";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

const SCAN_ID = "scanActivity-test-scan";
const REFILE_ID = "scanActivity-test-refile";

const remove = async (id: string) => (await scanQueue.getJob(id))?.remove();

// This worker's own Redis database: other files queue scans here and leave them waiting.
beforeAll(() => scanQueue.obliterate({ force: true }));

// In an afterEach: the shared Redis clients are closed before the file's afterAll hooks run.
afterEach(async () => {
    await remove(SCAN_ID);
    await remove(REFILE_ID);
});

afterAll(() => closeQueue(scanQueue));

it("is true while a scan waits or runs, and false once it is gone", async () => {
    expect(await libraryScanRunning()).toBe(false);
    await scanQueue.add("scan", { userId: "u", source: "test" }, { jobId: SCAN_ID });
    expect(await libraryScanRunning()).toBe(true);
    await remove(SCAN_ID);
    expect(await libraryScanRunning()).toBe(false);
});

it("counts a scan waiting out a retry delay", async () => {
    await scanQueue.add("scan", { userId: "u", source: "test" }, { jobId: SCAN_ID, delay: 60_000 });
    expect(await (await scanQueue.getJob(SCAN_ID))?.getState()).toBe("delayed");
    expect(await libraryScanRunning()).toBe(true);
});

it("does not count the album re-file", async () => {
    await scanQueue.add("refile", { userId: "u" }, { jobId: REFILE_ID });
    expect(await libraryScanRunning()).toBe(false);
});
