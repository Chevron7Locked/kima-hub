import { Router } from "express";
import { refreshPodcastFeed } from "../podcasts";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap, clamp, parseIntParam } from "./mappers";

export const podcastRouter = Router();

function mapPodcastEpisode(episode: {
    id: string;
    podcastId: string;
    title: string;
    description: string | null;
    audioUrl: string;
    duration: number;
    publishedAt: Date;
    createdAt?: Date;
    fileSize?: number | null;
    mimeType: string | null;
    podcastTitle?: string;
}) {
    const contentType = episode.mimeType || "audio/mpeg";
    const suffix = contentType.includes("/") ? contentType.split("/")[1] : "mpeg";

    return {
        "@_id": episode.id,
        "@_parent": episode.podcastId,
        "@_isDir": false,
        "@_channelId": episode.podcastId,
        "@_title": episode.title,
        "@_album": episode.podcastTitle || undefined,
        "@_artist": "Podcast",
        "@_coverArt": episode.podcastId,
        "@_description": episode.description || undefined,
        "@_streamUrl": episode.audioUrl,
        "@_streamId": episode.id,
        "@_publishDate": episode.publishedAt.toISOString(),
        "@_created": episode.createdAt?.toISOString() || undefined,
        "@_duration": episode.duration || 0,
        "@_status": "completed",
        "@_size": episode.fileSize ?? undefined,
        "@_contentType": contentType,
        "@_suffix": suffix,
        "@_isVideo": false,
        "@_type": "podcast",
    };
}

podcastRouter.all("/getPodcastEpisode.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const episode = await prisma.podcastEpisode.findFirst({
        where: {
            id,
            podcast: {
                subscriptions: {
                    some: { userId: req.user!.id },
                },
            },
        },
        include: {
            podcast: {
                select: { title: true },
            },
        },
    });

    if (!episode) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Podcast episode not found");
    }

    return subsonicOk(req, res, {
        podcastEpisode: mapPodcastEpisode({
            ...episode,
            podcastTitle: episode.podcast.title,
        }),
    });
}));

podcastRouter.all("/getPodcasts.view", wrap(async (req, res) => {
    const includeEpisodes = (req.query.includeEpisodes as string | undefined) !== "false";
    const id = req.query.id as string | undefined;
    const userId = req.user!.id;

    const subscriptions = await prisma.podcastSubscription.findMany({
        where: {
            userId,
            ...(id ? { podcastId: id } : {}),
        },
        include: {
            podcast: {
                include: {
                    episodes: includeEpisodes
                        ? {
                              orderBy: { publishedAt: "desc" },
                              take: 200,
                          }
                        : false,
                },
            },
        },
        orderBy: { subscribedAt: "desc" },
    });

    const channel = subscriptions.map((sub: (typeof subscriptions)[number]) => ({
        "@_id": sub.podcast.id,
        "@_url": sub.podcast.feedUrl,
        "@_title": sub.podcast.title,
        "@_description": sub.podcast.description || undefined,
        "@_coverArt": sub.podcast.id,
        "@_originalImageUrl": sub.podcast.imageUrl || undefined,
        ...(includeEpisodes && sub.podcast.episodes.length > 0
            ? { episode: sub.podcast.episodes.map(mapPodcastEpisode) }
            : {}),
    }));

    return subsonicOk(req, res, {
        podcasts: channel.length > 0 ? { channel } : {},
    });
}));

podcastRouter.all("/getNewestPodcasts.view", wrap(async (req, res) => {
    const count = clamp(parseIntParam(req.query.count as string | undefined, 20), 1, 500);

    const episodes = await prisma.podcastEpisode.findMany({
        where: {
            podcast: {
                subscriptions: {
                    some: { userId: req.user!.id },
                },
            },
        },
        orderBy: { publishedAt: "desc" },
        take: count,
    });

    return subsonicOk(req, res, {
        newestPodcasts: episodes.length > 0
            ? { episode: episodes.map(mapPodcastEpisode) }
            : {},
    });
}));

podcastRouter.all("/refreshPodcasts.view", wrap(async (req, res) => {
    const subscriptions = await prisma.podcastSubscription.findMany({
        where: { userId: req.user!.id },
        select: { podcastId: true },
    });

    await Promise.allSettled(
        subscriptions.map((sub: (typeof subscriptions)[number]) => refreshPodcastFeed(sub.podcastId))
    );

    return subsonicOk(req, res);
}));
