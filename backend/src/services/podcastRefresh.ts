import { prisma, Prisma } from "../utils/db";
import { rssParserService, type RSSEpisode as FeedEpisode } from "./rss-parser";
import { enrichmentFailureService } from "./enrichmentFailureService";
import { assignCategories } from "./podcastCatalog";
import { dropCachedEpisode } from "./podcastDownload";

/**
 * Fetch a stored show's feed again and store its episodes: new ones are added, and one already stored takes the
 * feed's current title, description, audio address, length, size and date (keeping its id, so a person's progress
 * stays). An episode whose audio address changed loses its cached copy, so the old audio is not served under the new
 * address. The feed's ETag and Last-Modified are saved only once all of that is stored, so a refresh that fails
 * partway reads the feed again next time instead of being answered "not modified". Null when the show is not stored.
 * Shared by the refresh route, the Subsonic refresh and the podcast worker.
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

    // One read of what is stored, to tell new episodes from changed ones without a query per episode.
    const feedGuids = result.episodes.map(e => e.guid).filter(Boolean);
    const stored = new Map(
        (await prisma.podcastEpisode.findMany({
            where: { podcastId, guid: { in: feedGuids } },
            select: {
                id: true, guid: true, title: true, description: true, audioUrl: true,
                duration: true, fileSize: true, publishedAt: true,
                // A cached copy's own length and size are measured, so the feed's figures do not replace them.
                downloads: { select: { id: true }, take: 1 },
            },
        })).map(e => [e.guid, e])
    );

    let newEpisodesCount = 0;
    const seen = new Set<string>();
    for (const ep of result.episodes) {
        // A guid listed twice is one episode.
        if (seen.has(ep.guid)) continue;
        seen.add(ep.guid);
        const have = stored.get(ep.guid);
        if (!have) {
            // upsert, not create: manual and automatic refreshes can race on the (podcastId, guid) unique key.
            await prisma.podcastEpisode.upsert({
                where: { podcastId_guid: { podcastId, guid: ep.guid } },
                create: episodeRow(podcastId, ep),
                update: {},
            });
            newEpisodesCount++;
            continue;
        }
        // A new address is new audio: the cached copy and its measured figures belong to the old one.
        const audioChanged = have.audioUrl !== ep.audioUrl;
        const measured = have.downloads.length > 0 && !audioChanged;
        const changes: Prisma.PodcastEpisodeUpdateManyMutationInput = {};
        if (have.title !== ep.title) changes.title = ep.title;
        if ((have.description ?? null) !== (ep.description ?? null)) changes.description = ep.description ?? null;
        if (audioChanged) changes.audioUrl = ep.audioUrl;
        // A figure the feed leaves out (no date, no length, no size) is not the feed saying it changed.
        if (ep.publishedGiven !== false && have.publishedAt.getTime() !== ep.publishedAt.getTime()) changes.publishedAt = ep.publishedAt;
        if (!measured && ep.duration > 0 && have.duration !== ep.duration) changes.duration = ep.duration;
        if (!measured && ep.fileSize != null && have.fileSize !== ep.fileSize) changes.fileSize = ep.fileSize;
        if (Object.keys(changes).length > 0) {
            await prisma.podcastEpisode.updateMany({ where: { id: have.id }, data: changes });
        }
        // Dropped after the new address is saved, whatever this refresh's read of the episode showed: a download that
        // filed its copy since then is found here, and one that starts to file now sees the new address and discards.
        if (audioChanged) await dropCachedEpisode(have.id);
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
