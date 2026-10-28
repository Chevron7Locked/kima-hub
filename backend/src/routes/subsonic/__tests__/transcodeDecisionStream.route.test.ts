/**
 * Subsonic's transcode decision, getTranscodeStream and stream.view follow one rule (planSubsonicSong): a stream
 * is what the decision promised, a bitrate cap is never exceeded by Kima's own MP3 tiers, an asked-for MP3 is an MP3,
 * and a format Kima cannot make is refused. Real files made with the ffmpeg the server transcodes with, on the real
 * database; only the music and cache folders in the config point at a temp dir. music-metadata cannot load under
 * Jest (its stub knows no bitrate), so here it answers each file's real bitrate as ffmpeg reads it.
 */
jest.mock("../../../config", () => {
    const actual = jest.requireActual("../../../config");
    const base = require("path").join(require("os").tmpdir(), `kima-transcode-${process.pid}`);
    Object.assign(actual.config.music, { musicPath: `${base}/music`, transcodeCachePath: `${base}/cache` });
    return actual;
});

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { parseFile } from "music-metadata";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { prisma } from "../../../utils/db";
import { config } from "../../../config";
import { getAudioStreamingService } from "../../../services/audioStreaming";
import { compatRouter } from "../compat";
import { playbackRouter } from "../playback";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-transcode";
/** key -> file and the ffmpeg encoder arguments that make it */
const FILES = {
    flac: ["A/B/01.flac", ["-c:a", "flac"]],          // noise: far above any cap
    m4a: ["A/B/02.m4a", ["-c:a", "aac", "-b:a", "64k"]], // already under every cap
    mp3: ["A/B/03.mp3", ["-c:a", "libmp3lame", "-b:a", "320k"]],
    mystery: ["A/B/04.flac", ["-c:a", "flac"]],        // its metadata gives no bitrate
} as const;
type Key = keyof typeof FILES;
const track = (k: Key) => `${P}-${k}`;

const app = () => {
    const a = express();
    a.use((req: any, _res, next) => { req.user = { id: `${P}-user`, username: "t", role: "user" }; next(); });
    a.use("/rest", compatRouter);
    a.use("/rest", playbackRouter);
    return a;
};

const decide = async (k: Key | string, query = "", mediaType = "song") =>
    (await request(app()).get(`/rest/getTranscodeDecision.view?f=json&mediaId=${k in FILES ? track(k as Key) : k}&mediaType=${mediaType}&${query}`))
        .body["subsonic-response"].transcodeDecision;
const transcodeStream = (k: Key, params: string) =>
    request(app()).get(`/rest/getTranscodeStream.view?f=json&mediaId=${track(k)}&mediaType=song&transcodeParams=${encodeURIComponent(params)}`);
/** A file's audio stream bitrate in kbps, as ffmpeg reports it (it prints the input's details, then exits 1). */
function probeKbps(file: string): number {
    const out = spawnSync(ffmpegPath.path, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
    return Number(/Audio: .*?(\d+) kb\/s/.exec(out)?.[1] ?? /bitrate: (\d+) kb\/s/.exec(out)?.[1]);
}
let probes = 0;
/** The bitrate of the bytes a route sent. */
function servedKbps(body: Buffer): number {
    const file = path.join(config.music.transcodeCachePath, `probe-${++probes}.bin`);
    fs.writeFileSync(file, body);
    return probeKbps(file);
}
const asBuffer = (r: request.Request) => r.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });

beforeAll(async () => {
    jest.mocked(parseFile).mockImplementation(async (file: string) =>
        ({ format: { bitrate: file.endsWith("04.flac") ? undefined : probeKbps(file) * 1000 } }) as never);
    fs.mkdirSync(config.music.transcodeCachePath, { recursive: true });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    await prisma.album.create({ data: { id: `${P}-al`, rgMbid: `${P}-rg`, artistId: `${P}-ar`, identityKey: `${P}-ak`, title: P, primaryType: "Album", year: 2024, location: "LIBRARY" } });
    for (const [k, [rel, codec]] of Object.entries(FILES)) {
        const file = path.join(config.music.musicPath, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        execFileSync(ffmpegPath.path, ["-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:a=0.5", "-ac", "2", ...codec, "-y", file]);
        const mime = { flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg", mystery: "audio/flac" }[k as Key];
        await prisma.track.create({ data: { id: track(k as Key), albumId: `${P}-al`, title: k, trackNo: 1, duration: 3, filePath: rel, mime, fileModified: new Date(), fileSize: fs.statSync(file).size } });
    }
    await prisma.podcast.create({ data: { id: `${P}-pod`, feedUrl: `https://example.invalid/${P}`, title: P } });
    for (const [id, mimeType] of [[`${P}-ep-mp3`, "audio/mpeg"], [`${P}-ep-unknown`, null], [`${P}-ep-odd`, "audio/x-something"], [`${P}-ep-proto`, "constructor"]] as const) {
        await prisma.podcastEpisode.create({ data: { id, podcastId: `${P}-pod`, guid: id, title: id, audioUrl: `https://example.invalid/${id}.mp3`, publishedAt: new Date(), mimeType } });
    }
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: `${P}-pod` } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: `${P}-al` } });
    await prisma.artist.deleteMany({ where: { id: `${P}-ar` } });
    // The shared streaming service keeps a cache-eviction timer; stop it so the run can exit.
    getAudioStreamingService(config.music.transcodeCachePath, config.music.transcodeCacheMaxGb).destroy();
    fs.rmSync(path.dirname(config.music.musicPath), { recursive: true, force: true });
    await closeEngineConnections();
});

it("direct play gets a transcodeParams value, and the stream serves the file as it is", async () => {
    for (const query of ["", "format=flac", "format=raw&maxBitRate=128"]) {
        const d = await decide("flac", query);
        expect([query, d.canDirectPlay, d.transcodeParams]).toEqual([query, true, "q-original"]);
        const res = await transcodeStream("flac", d.transcodeParams);
        expect([query, res.status, res.headers["content-type"]]).toEqual([query, 200, "audio/flac"]);
    }
});

it("a bitrate cap is never exceeded: a file over it gets the highest MP3 tier within it", async () => {
    for (const [cap, params, kbps] of [["320", "q-high-320", 320], ["256", "q-medium-256", 192], ["128", "q-low-128", 128]] as const) {
        const d = await decide("flac", `maxBitRate=${cap}`);
        expect([cap, d.canDirectPlay, d.canTranscode, d.transcodeParams]).toEqual([cap, false, true, params]);
        const res = await asBuffer(transcodeStream("flac", d.transcodeParams));
        expect(res.headers["content-type"]).toBe("audio/mpeg");
        expect([cap, servedKbps(res.body)]).toEqual([cap, kbps]);
    }
});

it("a cap below Kima's smallest MP3 is refused unless the file already fits", async () => {
    const d = await decide("flac", "maxBitRate=64");
    expect([d.canDirectPlay, d.canTranscode, d.transcodeParams]).toEqual([false, false, undefined]);
    expect(d.errorReason).toMatch(/smallest mp3/);
    // stream.view still plays something: the smallest MP3, its old best effort.
    const res = await asBuffer(request(app()).get(`/rest/stream.view?id=${track("flac")}&maxBitRate=64`));
    expect([res.headers["content-type"], servedKbps(res.body)]).toEqual(["audio/mpeg", 128]);
});

it("a file already within the cap plays as it is, and the decision says so", async () => {
    const flacKbps = probeKbps(path.join(config.music.musicPath, FILES.flac[0]));
    expect(flacKbps).toBeGreaterThan(500);
    // A lossless file under a generous cap is not cut to a 320 MP3.
    const roomy = await decide("flac", `maxBitRate=${flacKbps + 100}`);
    expect([roomy.canDirectPlay, roomy.transcodeParams]).toEqual([true, "q-original"]);
    expect((await transcodeStream("flac", roomy.transcodeParams)).headers["content-type"]).toBe("audio/flac");
    // Over 320 but under the file: the top tier.
    const tight = await decide("flac", "maxBitRate=500");
    expect([tight.canDirectPlay, tight.transcodeParams]).toEqual([false, "q-high-500"]);
    expect(servedKbps((await asBuffer(transcodeStream("flac", tight.transcodeParams))).body)).toBe(320);
    // The 64 kbps m4a under a 128 cap, with no format and with its own format asked.
    expect(probeKbps(path.join(config.music.musicPath, FILES.m4a[0]))).toBeLessThanOrEqual(128);
    for (const query of ["maxBitRate=128", "format=m4a&maxBitRate=320"]) {
        const d = await decide("m4a", query);
        expect([query, d.canDirectPlay, d.transcodeParams]).toEqual([query, true, "q-original"]);
        expect((await request(app()).get(`/rest/stream.view?id=${track("m4a")}&${query}`)).headers["content-type"]).toBe("audio/mp4");
    }
});

it("a file whose bitrate cannot be read is made into an MP3 under a cap", async () => {
    const d = await decide("mystery", "maxBitRate=320");
    expect([d.canDirectPlay, d.transcodeParams]).toEqual([false, "q-high-320"]);
    expect((await transcodeStream("mystery", d.transcodeParams)).headers["content-type"]).toBe("audio/mpeg");
});

it("an asked-for MP3 is an MP3, even when the file is already under the cap", async () => {
    const uncapped = await decide("flac", "format=mp3");
    expect([uncapped.canDirectPlay, uncapped.transcodeParams]).toEqual([false, "mp3-high"]);
    expect(servedKbps((await asBuffer(transcodeStream("flac", uncapped.transcodeParams))).body)).toBe(320);

    const small = await decide("m4a", "format=mp3&maxBitRate=128");
    expect([small.canDirectPlay, small.transcodeParams]).toEqual([false, "mp3-low-128"]);
    expect((await transcodeStream("m4a", small.transcodeParams)).headers["content-type"]).toBe("audio/mpeg");
    // With an MP3 of it now cached, a request that asked for no format still gets the file the decision promised.
    const again = await decide("m4a", "maxBitRate=128");
    expect([again.canDirectPlay, (await transcodeStream("m4a", again.transcodeParams)).headers["content-type"]]).toEqual([true, "audio/mp4"]);

    // An MP3 asked for as MP3 under a cap below its own bitrate is cut to the cap; within the cap it plays as it is.
    const mp3 = await decide("mp3", "format=mp3&maxBitRate=128");
    expect([mp3.canDirectPlay, mp3.transcodeParams]).toEqual([false, "mp3-low-128"]);
    expect(servedKbps((await asBuffer(transcodeStream("mp3", mp3.transcodeParams))).body)).toBe(128);
    expect((await decide("mp3", "format=mp3")).canDirectPlay).toBe(true);
});

it("a format Kima cannot make is refused in the decision, with no params", async () => {
    for (const [k, query, reason] of [["flac", "format=opus", /only to mp3/], ["flac", "format=flac&maxBitRate=128", /cannot make flac smaller/], ["m4a", "format=aac", /only to mp3/]] as const) {
        const d = await decide(k, query);
        expect([query, d.canDirectPlay, d.canTranscode, d.transcodeParams]).toEqual([query, false, false, undefined]);
        expect(d.errorReason).toMatch(reason);
    }
});

it("stream.view, download.view and hls.view follow the same rule", async () => {
    const res = await asBuffer(request(app()).get(`/rest/stream.view?id=${track("flac")}&maxBitRate=128`));
    expect([res.headers["content-type"], servedKbps(res.body)]).toEqual(["audio/mpeg", 128]);
    expect((await request(app()).get(`/rest/stream.view?id=${track("m4a")}&format=mp3&maxBitRate=128`)).headers["content-type"]).toBe("audio/mpeg");
    expect((await request(app()).get(`/rest/stream.view?id=${track("flac")}&format=mp3`)).headers["content-type"]).toBe("audio/mpeg");
    // A format it cannot make still streams, as if none were asked: older clients send one by habit.
    expect((await request(app()).get(`/rest/stream.view?id=${track("flac")}&format=opus`)).headers["content-type"]).toBe("audio/flac");
    // A download is always the file itself.
    expect((await request(app()).get(`/rest/download.view?id=${track("flac")}&maxBitRate=128`)).headers["content-type"]).toBe("audio/flac");
    // HLS hands the client a stream.view link carrying its bitrate as the cap.
    const hls = await request(app()).get(`/rest/hls.view?id=${track("flac")}&bitRate=192`);
    expect(hls.text).toMatch(new RegExp(`/rest/stream\\.view\\?id=${track("flac")}&maxBitRate=192`));
});

it("transcodeParams Kima would not hand out are an error, not a stream", async () => {
    const forged = [
        "format=mp3", "q-bogus", "q-", "mp3-", "x-high", "q-high-0", "q-high-x", "q-high-123456",
        // Well-formed but never a decision's answer: a cap with "original", a tier over its cap, an uncapped tier
        // without mp3, a cap below the smallest MP3.
        "q-original-128", "mp3-original", "q-high-100", "q-high", "mp3-low-100", "q-low-64", "mp3-medium-320",
    ];
    for (const bad of forged) {
        const res = await transcodeStream("flac", bad);
        expect([bad, res.body["subsonic-response"]?.status]).toEqual([bad, "failed"]);
    }
});

it("a file's bitrate is read once while it is unchanged, however many ranges a client asks for, at once or not", async () => {
    // The fresh copy of the 320 kbps mp3 has never been read.
    const fresh = "A/B/05.mp3";
    fs.copyFileSync(path.join(config.music.musicPath, FILES.mp3[0]), path.join(config.music.musicPath, fresh));
    await prisma.track.create({ data: { id: `${P}-fresh`, albumId: `${P}-al`, title: "fresh", trackNo: 1, duration: 3, filePath: fresh, mime: "audio/mpeg", fileModified: new Date(), fileSize: 1 } });
    const reads = () => jest.mocked(parseFile).mock.calls.filter(([f]) => String(f).endsWith(fresh)).length;
    const range = (i: number) => request(app()).get(`/rest/stream.view?id=${P}-fresh&maxBitRate=500`).set("Range", `bytes=${i * 100}-`);
    await Promise.all([0, 1, 2].map(range));
    await range(3);
    expect(reads()).toBe(1);
});

it("a decision for anything but a song or a podcast is an error", async () => {
    const res = await request(app()).get(`/rest/getTranscodeDecision.view?f=json&mediaId=${track("flac")}&mediaType=video`);
    expect(res.body["subsonic-response"].status).toBe("failed");
});

it("a podcast episode plays as its feed serves it: direct play only for its own format, never a transcode", async () => {
    const asIs = await decide(`${P}-ep-mp3`, "format=mp3", "podcast");
    expect([asIs.canDirectPlay, asIs.canTranscode, asIs.transcodeParams]).toEqual([true, false, "q-original"]);
    const res = await request(app()).get(`/rest/getTranscodeStream.view?mediaId=${P}-ep-mp3&mediaType=podcast&transcodeParams=q-original`);
    expect([res.status, res.headers.location]).toEqual([302, `https://example.invalid/${P}-ep-mp3.mp3`]);

    const other = await decide(`${P}-ep-mp3`, "format=opus", "podcast");
    expect([other.canDirectPlay, other.canTranscode, other.transcodeParams]).toEqual([false, false, undefined]);
    // An episode whose format the feed never said is not claimed to be what the client asked for.
    expect((await decide(`${P}-ep-unknown`, "format=mp3", "podcast")).canDirectPlay).toBe(false);
    expect((await decide(`${P}-ep-odd`, "format=mp3", "podcast")).canDirectPlay).toBe(false);
    // A feed's type that happens to be an object property name is just unknown.
    const proto = await decide(`${P}-ep-proto`, "format=mp3", "podcast");
    expect([proto.canDirectPlay, proto.transcodeReason]).toEqual([false, ["episode is of unknown format, client asked for mp3"]]);
    expect((await decide(`${P}-ep-unknown`, "", "podcast")).canDirectPlay).toBe(true);
});
