/**
 * A library scan is running or waiting to run, so songs may still be on their way into the library. Enrichment waits
 * for it: every step starts from the whole library, never from the part scanned so far. The album re-file shares the
 * scan queue but adds no songs, so it does not count; a scan waiting out a retry delay does. The queue is loaded on first use, so importing the enrichment
 * loop opens no connection.
 */
export async function libraryScanRunning(): Promise<boolean> {
    const { scanQueue } = await import("./queues");
    const jobs = await scanQueue.getJobs(["active", "waiting", "prioritized", "delayed"]);
    return jobs.some((job) => job?.name === "scan");
}
