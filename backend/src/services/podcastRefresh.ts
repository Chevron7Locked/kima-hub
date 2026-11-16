import { prisma, Prisma } from "../utils/db";
import { rssParserService, type RSSEpisode as FeedEpisode } from "./rss-parser";
import { enrichmentFailureService } from "./enrichmentFailureService";
import { assignCategories } from "./podcastCatalog";

/**
 * Fetch a stored show's feed again and store its new episodes; null when the show is not stored. Shared by the
 * refresh route, the Subsonic refresh and the podcast worker.
 */
export async function refreshPodcastFeed(podcastId: string): Promise<{ newEpisodesCount: number; totalEpisodes: number } | null> {
    const podcast = await prisma.podcast.findUnique({ where: { id: podcastId } });
    if (!podcast) return null;

    const result = await rssParserService.parseFeed(podcast.feedUrl, {
        etag: podcast.feedEtag,
        lastModified: podcast.feedLastModified,
    });
    // The feed answered, so an earlier failure to read it (a host or network down for a moment) is over.
    await enrichmentFailureService.resolveByEntity("podcast", podcastId);

    if (result.notModified) {
        await prisma.podcast.update({
            where: { id: podcastId },
            data: { lastRefreshed: new Date() },
        });
        return { newEpisodesCount: 0, totalEpisodes: podcast.episodeCount };
    }

    await prisma.podcast.update({
        where: { id: podcastId },
        data: {
            title: result.podcast.title,
            author: result.podcast.author,
            description: result.podcast.description,
            imageUrl: result.podcast.imageUrl,
            language: result.podcast.language,
            explicit: result.podcast.explicit || false,
            episodeCount: result.episodes.length,
            lastRefreshed: new Date(),
            feedEtag: result.etag || null,
            feedLastModified: result.lastModified || null,
        },
    });
    if (podcast.categoryIds.length === 0) {
        // Nobody waits on a refresh's categories, so a person's own requests to Apple go first.
        await assignCategories(podcastId, podcast.itunesId, result.podcast.categoryNames, "background");
    }

    // Batch fetch all existing GUIDs to avoid N+1 queries
    const feedGuids = result.episodes.map(e => e.guid).filter(Boolean);
    const existingGuids = new Set(
        (await prisma.podcastEpisode.findMany({
            where: { podcastId, guid: { in: feedGuids } },
            select: { guid: true },
        })).map(e => e.guid)
    );

    let newEpisodesCount = 0;
    for (const ep of result.episodes) {
        if (existingGuids.has(ep.guid)) continue;

        // upsert, not find-then-create: manual and automatic refreshes can race on the
        // (podcastId, guid) unique key. An existing episode is left untouched.
        await prisma.podcastEpisode.upsert({
            where: { podcastId_guid: { podcastId, guid: ep.guid } },
            create: episodeRow(podcastId, ep),
            update: {},
        });
        newEpisodesCount++;
    }

    return { newEpisodesCount, totalEpisodes: result.episodes.length };
}

/** A feed episode as the row that stores it. */
export function episodeRow(podcastId: string, ep: FeedEpisode): Prisma.PodcastEpisodeUncheckedCreateInput {
    return {
        podcastId,
        guid: ep.guid,
        title: ep.title,
        description: ep.description,
        audioUrl: ep.audioUrl,
        duration: ep.duration,
        publishedAt: ep.publishedAt,
        episodeNumber: ep.episodeNumber,
        season: ep.season,
        imageUrl: ep.imageUrl,
        fileSize: ep.fileSize,
        mimeType: ep.mimeType,
    };
}
