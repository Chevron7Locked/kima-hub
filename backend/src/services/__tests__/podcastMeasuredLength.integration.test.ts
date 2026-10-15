/**
 * An episode's stored length becomes its audio's once the file is cached: ad networks stitch ads in,
 * so the feed's length runs minutes short (a real Acast episode: feed 4844 s, file 5344.2 s by
 * music-metadata, 5344.7 s by ffprobe). Real database; music-metadata is the suite's CJS stub.
 */
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { recordMeasuredLength } from "../podcastDownload";

const P = "pod_measured_len";

beforeEach(async () => {
    await prisma.podcastEpisode.deleteMany({ where: { podcastId: P } });
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.podcast.create({
        data: {
            id: P,
            feedUrl: "https://feeds.example.invalid/measured",
            title: "Dungeons and Daddies",
            episodes: { create: [{ id: `${P}-ep`, guid: "g1", title: "Oceans Dad-leven", audioUrl: "https://a.invalid/1.mp3", duration: 4844, publishedAt: new Date() }] },
        },
    });
});

afterAll(async () => {
    await prisma.podcastEpisode.deleteMany({ where: { podcastId: P } });
    await prisma.podcast.deleteMany({ where: { id: P } });
});

const length = async () =>
    (await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: `${P}-ep` }, select: { duration: true } })).duration;

it("stores the audio's own length in place of the feed's", async () => {
    (parseFile as jest.Mock).mockResolvedValueOnce({ format: { duration: 5344.2 } });
    expect(await recordMeasuredLength(`${P}-ep`, "/cache/ep.mp3")).toBe("stored");
    expect(await length()).toBe(5344);
});

it("leaves the stored length when the file's length cannot be read", async () => {
    (parseFile as jest.Mock).mockResolvedValueOnce({ format: {} });
    expect(await recordMeasuredLength(`${P}-ep`, "/cache/ep.mp3")).toBe("unreadable");
    (parseFile as jest.Mock).mockRejectedValueOnce(new Error("not an audio file"));
    expect(await recordMeasuredLength(`${P}-ep`, "/cache/ep.mp3")).toBe("unreadable");
    expect(await length()).toBe(4844);
});

it("does nothing for an episode that no longer exists", async () => {
    (parseFile as jest.Mock).mockResolvedValueOnce({ format: { duration: 100 } });
    await expect(recordMeasuredLength("no_such_episode", "/cache/x.mp3")).resolves.toBe("no-episode");
});
