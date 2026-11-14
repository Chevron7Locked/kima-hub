/**
 * A podcast refresh queued before the podcast was unsubscribed finishes without
 * an error, so no failure is recorded for a podcast that no longer exists.
 * Real database.
 */
import type { Job } from "bullmq";
import { prisma } from "../../../utils/db";
import { processPodcastJob } from "../podcasts";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

afterAll(async () => {
    await closeEngineConnections();
});

it("skips a podcast that was unsubscribed after its job was queued", async () => {
    const job = { data: { podcastId: "podcast_gone_since_queued", podcastTitle: "The Daily" } } as Job;
    await expect(processPodcastJob(job)).resolves.toBeUndefined();
    expect(await prisma.enrichmentFailure.count({ where: { entityId: "podcast_gone_since_queued" } })).toBe(0);
});
