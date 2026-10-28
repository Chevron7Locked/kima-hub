import { config } from "../../config";
import { getAudioStreamingService } from "../../services/audioStreaming";
import { capKbps, LOWEST_TIER_KBPS, songFormat, tierFor, type SubsonicServe } from "./mappers";

/** What a Subsonic client gets for a song: the file as it is, an MP3 Kima makes, or a refusal with its reason. */
export type SubsonicPlan = { direct: true } | { direct: false; serve: SubsonicServe } | { refused: string };

/**
 * The one rule for a song's stream, followed by getTranscodeDecision, getTranscodeStream and stream.view, from the
 * client's `format` and `maxBitRate`, the song's format as Kima lists it, and the file's own bitrate (read from the
 * file, see AudioStreamingService.servesOriginal). Kima makes only MP3s at 128/192/320 kbps, so another format is
 * only ever the file itself, and a cap under 128 can be met only by a file already within it.
 */
export async function planSubsonicSong(
    format: string | undefined,
    maxBitRate: string | undefined,
    track: { mime: string | null; filePath: string | null },
    absolutePath: string,
): Promise<SubsonicPlan> {
    const wanted = format?.toLowerCase();
    if (wanted === "raw") return { direct: true };
    const cap = capKbps(maxBitRate);
    const source = songFormat(track);
    const streaming = getAudioStreamingService(config.music.transcodeCachePath, config.music.transcodeCacheMaxGb);
    const fits = (mp3Only: boolean) =>
        streaming.servesOriginal(absolutePath, cap === null ? "original" : tierFor(cap), { mp3Only, keepUnderKbps: cap ?? undefined });

    if (wanted === "mp3") {
        if (await fits(true)) return { direct: true };
    } else if (!wanted || wanted === source) {
        if (cap === null || (await fits(false))) return { direct: true };
        if (wanted) return { refused: `Kima cannot make ${wanted} smaller; it transcodes only to mp3` };
    } else {
        return { refused: `Kima transcodes only to mp3; it cannot make ${wanted}` };
    }
    if (cap !== null && cap < LOWEST_TIER_KBPS) {
        return { refused: `the smallest mp3 Kima makes is ${LOWEST_TIER_KBPS} kbps, over the ${cap} kbps cap` };
    }
    return { direct: false, serve: { quality: cap === null ? "high" : tierFor(cap), mp3Only: wanted === "mp3", capKbps: cap } };
}
