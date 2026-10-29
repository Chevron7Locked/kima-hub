/**
 * One day for a mix: the server's own calendar date, in its own time zone, gives the mix's id, its seed and its
 * weekday. Kima runs on servers in many time zones, so the check runs again in a separate Node process on Los Angeles
 * time (Jest's own processes are pinned to UTC): at 17:30 on a Sunday there, the UTC date is already Monday.
 */
jest.mock("../moodMixes");
jest.mock("../genreMixes");
jest.mock("../timeMixes");
jest.mock("../discoveryMixes", () => require("./helpers/rotationMocks").discoveryMixesMock());
jest.mock("../../moodBucketService", () => require("./helpers/rotationMocks").moodBucketServiceMock());
jest.mock("../mixDay", () => {
    const actual = jest.requireActual("../mixDay");
    return { ...actual, mixDay: jest.fn(actual.mixDay) };
});
jest.mock("../../../utils/logger", () => require("./helpers/rotationMocks").loggerMock());

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";
import * as moodMixes from "../moodMixes";
import * as genreMixes from "../genreMixes";
import * as timeMixes from "../timeMixes";
import * as discoveryMixes from "../discoveryMixes";
import { programmaticPlaylistService } from "../index";
import { mixDay, weekdayOf } from "../mixDay";

/** Sunday 2026-10-25, 17:30 in Los Angeles (UTC-7 in October): 00:30 on Monday 2026-10-26 in UTC. */
const LA_SUNDAY_EVENING = Date.UTC(2026, 9, 26, 0, 30);

/** mixDay.ts run in a fresh Node process with the time zone `tz`, at `at`. */
function inTimeZone(tz: string, at: number): { day: string; weekday: number; clockWeekday: number; utcDay: string } {
    const source = fs.readFileSync(path.join(__dirname, "../mixDay.ts"), "utf8");
    const module = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText;
    const script = `
        const module = { exports: {} }, exports = module.exports;
        ${module}
        const now = new Date(${at});
        const day = module.exports.mixDay(now);
        process.stdout.write(JSON.stringify({
            day, weekday: module.exports.weekdayOf(day), clockWeekday: now.getDay(),
            utcDay: now.toISOString().slice(0, 10),
        }));
    `;
    return JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString());
}

describe("the day a mix holds for", () => {
    it("is the server's calendar date, and its weekday, on Los Angeles time at 17:30 on a Sunday", () => {
        const la = inTimeZone("America/Los_Angeles", LA_SUNDAY_EVENING);
        expect(la).toEqual({ day: "2026-10-25", weekday: 0, clockWeekday: 0, utcDay: "2026-10-26" });
    });

    it("is the UTC date on a UTC server", () => {
        expect(inTimeZone("UTC", LA_SUNDAY_EVENING)).toEqual({
            day: "2026-10-26", weekday: 1, clockWeekday: 1, utcDay: "2026-10-26",
        });
    });

    it("reads the weekday from the date a refresh's reroll follows, and refuses anything else", () => {
        expect(weekdayOf("2026-10-25")).toBe(0);
        expect(weekdayOf("2026-10-25-1792771200000")).toBe(0);
        expect(weekdayOf("2026-10-31")).toBe(6);
        expect(() => weekdayOf("d7919")).toThrow(RangeError);
    });
});

describe("the daily rotation", () => {
    const generators = [moodMixes, genreMixes, timeMixes, discoveryMixes].flatMap((module) =>
        Object.values(module).filter((value): value is jest.Mock => jest.isMockFunction(value)),
    );

    beforeEach(() => {
        for (const mock of generators) mock.mockReset().mockResolvedValue(null);
    });

    /** The day every generator was handed, minus a refresh's reroll. */
    const daysHanded = () =>
        new Set(generators.flatMap((mock) => mock.mock.calls.flatMap((call) => call.slice(1, 2).map((d: unknown) => String(d).slice(0, 10)))));

    // A day no clock gives today, so a generator that took its day from anywhere but mixDay would show.
    const SERVER_DAY = "2031-01-05";

    it("hands every generator that takes a day the server's calendar date from mixDay, refresh or not", async () => {
        const now = new Date(Date.UTC(2026, 9, 25, 12));
        (mixDay as jest.Mock).mockReturnValue(SERVER_DAY);
        await programmaticPlaylistService.generateAllMixes("day-user", false, now);
        expect(mixDay).toHaveBeenCalledWith(now);
        expect(daysHanded()).toEqual(new Set([SERVER_DAY]));
        for (const mock of generators) mock.mockClear();
        await programmaticPlaylistService.generateAllMixes("day-user", true, now);
        expect(daysHanded()).toEqual(new Set([SERVER_DAY]));
    });

    it("hands the day mix the same day as every other mix", async () => {
        (mixDay as jest.Mock).mockReturnValue(SERVER_DAY);
        // Every pick empty, so the fallback walk reaches every generator, the day mix among them.
        await programmaticPlaylistService.generateAllMixes("day-user");
        expect((timeMixes.generateDayMix as jest.Mock).mock.calls).toEqual([["day-user", SERVER_DAY]]);
    });
});
