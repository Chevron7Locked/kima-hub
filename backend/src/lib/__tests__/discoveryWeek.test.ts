import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";
import {
    localWeekOf,
    resolveGenerationWeekStart,
    resolveViewWeek,
    weekStartKey,
} from "../discoveryWeek";

describe("resolveGenerationWeekStart -- boundary roll-forward", () => {
    it("rolls forward to the upcoming Monday when run on the week's last day (Sunday 20:00, Monday-start)", () => {
        const sundayEvening = new Date("2026-05-24T20:00:00.000Z");
        const result = resolveGenerationWeekStart(sundayEvening);
        // startOfWeek alone would give 2026-05-18, the week that is ending.
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("rolls forward at the very last instant of the week (Sunday 23:59:59.999)", () => {
        // The final millisecond is still the same calendar day as endOfWeek.
        const lastInstant = new Date("2026-05-24T23:59:59.999Z");
        const result = resolveGenerationWeekStart(lastInstant);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("does not roll forward at the first instant of the week (Monday 00:00:00.000)", () => {
        // Monday midnight starts the week; it must stay on 2026-05-25, not move to 2026-06-01.
        const firstInstant = new Date("2026-05-25T00:00:00.000Z");
        const result = resolveGenerationWeekStart(firstInstant);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("does not roll forward mid-week (Wednesday, Monday-start) and tags the current week", () => {
        const wednesday = new Date("2026-05-27T12:00:00.000Z");
        const result = resolveGenerationWeekStart(wednesday);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    // The week start is stored and compared as midnight (UTC in Jest), not the run's time of day.
    it("returns the week start at 00:00:00.000 UTC, not the run's time of day, mid-week", () => {
        const wednesdayNoon = new Date("2026-05-27T12:00:00.000Z");
        const result = resolveGenerationWeekStart(wednesdayNoon);
        expect(result.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    });

    it("returns the week start at 00:00:00.000 UTC after rolling forward from Sunday evening", () => {
        // A roll that kept the 20:00 would pass the date-only tests above but store a wrong weekStart.
        const sundayEvening = new Date("2026-05-24T20:00:00.000Z");
        const result = resolveGenerationWeekStart(sundayEvening);
        expect(result.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    });
});

describe("resolveViewWeek -- fallback, staleness, and the null path", () => {
    const calendar = new Date("2026-05-25T00:00:00.000Z");

    it("returns the calendar week and stale=false when there is no batch", () => {
        // A new install has no completed batch; its empty week is not stale.
        const r = resolveViewWeek(calendar, null);
        expect(r.weekStart).toEqual(calendar);
        expect(r.stale).toBe(false);
    });

    it("serves a weeks-old completed batch, flagged stale", () => {
        // The latest batch is never cleaned up, so a batch 3 weeks back is still served as stale.
        const threeWeeksBack = new Date("2026-05-04T00:00:00.000Z");
        const r = resolveViewWeek(calendar, threeWeeksBack);
        expect(r.weekStart).toEqual(threeWeeksBack);
        expect(r.stale).toBe(true);
    });

    it("flags stale=true for a batch exactly one week old", () => {
        // Last week's batch is strictly before the calendar week.
        const lastWeek = new Date("2026-05-18T00:00:00.000Z");
        const r = resolveViewWeek(calendar, lastWeek);
        expect(r.weekStart).toEqual(lastWeek);
        expect(r.stale).toBe(true);
    });

    it("serves a future-dated batch (generated early for next week) as stale=false", () => {
        // Generation tags the upcoming week, so on Sunday the latest batch is a week ahead of the calendar.
        const future = new Date("2026-06-01T00:00:00.000Z");
        const r = resolveViewWeek(calendar, future);
        expect(r.weekStart).toEqual(future);
        expect(r.stale).toBe(false);
    });

    it("treats a batch from later in the same calendar week (Wednesday vs Monday start) as fresh and serves its date", () => {
        const wednesdaySameWeek = new Date("2026-05-27T00:00:00.000Z");
        const r = resolveViewWeek(calendar, wednesdaySameWeek);
        expect(r.weekStart).toEqual(wednesdaySameWeek);
        expect(r.stale).toBe(false);
    });

    it("treats a batch matching the calendar week exactly as fresh", () => {
        const r = resolveViewWeek(calendar, new Date("2026-05-25T00:00:00.000Z"));
        expect(r.weekStart).toEqual(calendar);
        expect(r.stale).toBe(false);
    });
});

describe("weekStartKey -- stable jobId key", () => {
    it("truncates the time component to a YYYY-MM-DD key (dedup stability)", () => {
        // The BullMQ jobId must not carry the time, or dedup breaks.
        expect(weekStartKey(new Date("2026-05-25T05:00:00.000Z"))).toBe("2026-05-25");
    });

    it("keeps the same day for any time on that day (late evening)", () => {
        expect(weekStartKey(new Date("2026-05-25T23:30:00.000Z"))).toBe("2026-05-25");
    });

    it("a Sunday-evening generation run produces the upcoming week's key", () => {
        const sundayEvening = new Date("2026-05-24T20:00:00.000Z");
        const tagged = resolveGenerationWeekStart(sundayEvening);
        expect(weekStartKey(tagged)).toBe("2026-05-25");
    });

    it("two runs on different days of the same week produce the same key", () => {
        // Monday and Wednesday runs must collide in BullMQ, so both key to 2026-05-25.
        const monday = new Date("2026-05-25T05:00:00.000Z");
        const wednesday = new Date("2026-05-27T12:00:00.000Z");
        const kMon = weekStartKey(resolveGenerationWeekStart(monday));
        const kWed = weekStartKey(resolveGenerationWeekStart(wednesday));
        expect(kMon).toBe("2026-05-25");
        expect(kWed).toBe("2026-05-25");
        expect(kMon).toBe(kWed);
    });
});

/** What a run at one wall-clock time saw, in a Node process on one time zone. */
interface RunSeen {
    zone: string;
    /** The job key of the week the run generates for. */
    key: string;
    /** The key of the calendar week GET /current compares against. */
    calendarKey: string;
    /** Local weekday (0 = Sunday), hour and minute the generated week starts at. */
    startsAt: number[];
    /** The UTC date of that week start. */
    utcDate: string;
}

/**
 * discoveryWeek.ts run in a fresh Node process with the time zone `tz` (Jest's
 * own processes are pinned to UTC). `body` sees the module as `week` and
 * date-fns as `dateFns`, and leaves its answer in `seen`.
 */
function runInTimeZone<T>(tz: string, body: string): T {
    const source = fs.readFileSync(path.join(__dirname, "../discoveryWeek.ts"), "utf8");
    const module = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText;
    const script = `
        const module = { exports: {} }, exports = module.exports;
        ${module}
        const week = module.exports, dateFns = require("date-fns");
        let seen;
        ${body}
        process.stdout.write(JSON.stringify(seen));
    `;
    return JSON.parse(
        execFileSync(process.execPath, ["-e", script], {
            cwd: path.resolve(__dirname, "../../.."),
            env: { ...process.env, TZ: tz },
        }).toString(),
    );
}

/** A generation run at each local wall-clock time [year, month, day, hour, minute]. */
function inTimeZone(tz: string, wallTimes: number[][]): RunSeen[] {
    return runInTimeZone(tz, `
        seen = ${JSON.stringify(wallTimes)}.map(([y, mo, d, h, mi]) => {
            const now = new Date(y, mo - 1, d, h, mi);
            const start = week.resolveGenerationWeekStart(now);
            return {
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                key: week.weekStartKey(start),
                calendarKey: week.weekStartKey(dateFns.startOfWeek(now, { weekStartsOn: 1 })),
                startsAt: [start.getDay(), start.getHours(), start.getMinutes()],
                utcDate: start.toISOString().slice(0, 10),
            };
        });
    `);
}

describe("the week on the server's own clock (TZ)", () => {
    const CRON_RUN = [2026, 5, 25, 5, 0]; // Monday 05:00, when discoverCron fires
    const SUNDAY_LATE = [2026, 5, 24, 23, 30];
    const MONDAY_EARLY = [2026, 5, 25, 0, 30];
    const WEDNESDAY = [2026, 5, 27, 12, 0];
    const SATURDAY = [2026, 5, 23, 17, 30];

    it.each(["Asia/Tokyo", "Pacific/Kiritimati", "UTC", "America/Los_Angeles"])(
        "names the local Monday the week starts on, either side of Sunday/Monday midnight, in %s",
        (tz) => {
            const runs = inTimeZone(tz, [CRON_RUN, SUNDAY_LATE, MONDAY_EARLY, WEDNESDAY, SATURDAY]);
            expect(runs.map(({ zone, key, calendarKey, startsAt }) => ({ zone, key, calendarKey, startsAt }))).toEqual([
                { zone: tz, key: "2026-05-25", calendarKey: "2026-05-25", startsAt: [1, 0, 0] },
                // The week's last day rolls forward to the week about to start.
                { zone: tz, key: "2026-05-25", calendarKey: "2026-05-18", startsAt: [1, 0, 0] },
                { zone: tz, key: "2026-05-25", calendarKey: "2026-05-25", startsAt: [1, 0, 0] },
                { zone: tz, key: "2026-05-25", calendarKey: "2026-05-25", startsAt: [1, 0, 0] },
                { zone: tz, key: "2026-05-18", calendarKey: "2026-05-18", startsAt: [1, 0, 0] },
            ]);
        },
    );

    // East of UTC, local midnight is still the previous day in UTC; the key must use the local date.
    it("keys a Tokyo week by its Monday although that midnight is Sunday in UTC", () => {
        const [run] = inTimeZone("Asia/Tokyo", [CRON_RUN]);
        expect(run.key).toBe("2026-05-25");
        expect(run.utcDate).toBe("2026-05-24");
    });

    it("lands on local midnight Monday across both daylight-saving changes in Los Angeles", () => {
        const runs = inTimeZone("America/Los_Angeles", [
            [2026, 3, 8, 20, 0], // Sunday clocks went forward
            [2026, 11, 1, 20, 0], // Sunday clocks went back
            [2026, 11, 2, 5, 0], // the cron's run the next morning
        ]);
        expect(runs.map(({ key, startsAt }) => ({ key, startsAt }))).toEqual([
            { key: "2026-03-09", startsAt: [1, 0, 0] },
            { key: "2026-11-02", startsAt: [1, 0, 0] },
            { key: "2026-11-02", startsAt: [1, 0, 0] },
        ]);
    });
});

describe("localWeekOf -- the week a stored week start belongs to", () => {
    const HOUR = 3_600_000;
    const MONDAY = Date.UTC(2026, 4, 25);
    const WEEK = 7 * 24 * HOUR;

    // A week start stored in any zone is within 26 hours (UTC+14 to UTC-12) of the same midnight here,
    // and weeks are 168 hours apart, so no such shift reaches a neighbouring week.
    it("finds the stored week, never the one before or after, for every shift of up to 26 hours", () => {
        for (let shift = -26; shift <= 26; shift++) {
            for (const weeks of [-1, 0, 1]) {
                const stored = new Date(MONDAY + weeks * WEEK + shift * HOUR);
                expect([weeks, shift, localWeekOf(stored).getTime()]).toEqual([weeks, shift, MONDAY + weeks * WEEK]);
            }
        }
    });

    it("keeps the batch's own instant for its albums and the local week for display", () => {
        const stored = new Date(MONDAY - 9 * HOUR); // midnight Monday in Tokyo
        const view = resolveViewWeek(new Date(MONDAY), stored);
        expect(view.weekStart).toBe(stored);
        expect(view.weekOf.getTime()).toBe(MONDAY);
        expect(view.stale).toBe(false);
    });
});

/** What GET /current would show for one stored batch, viewed at one local wall-clock time. */
interface ViewSeen {
    zone: string;
    stale: boolean;
    /** The stored week start was handed back unchanged, for the album queries. */
    keepsStored: boolean;
    /** The local week the batch counts as, YYYY-MM-DD. */
    weekOf: string;
    /** The response's weekStart and weekEnd text, and whether each parses back to its instant. */
    weekStartText: string;
    weekEndText: string;
    textsParseBack: boolean;
}

/** A stored week start: an exact instant, or midnight of [year, month, day] on the viewing zone's own clock. */
type Stored = number | number[];

function viewInTimeZone(tz: string, cases: { now: number[]; stored: Stored }[]): ViewSeen[] {
    return runInTimeZone(tz, `
        seen = ${JSON.stringify(cases)}.map(({ now: [y, mo, d, h, mi], stored }) => {
            const now = new Date(y, mo - 1, d, h, mi);
            const batch = typeof stored === "number" ? new Date(stored) : new Date(stored[0], stored[1] - 1, stored[2]);
            const view = week.resolveViewWeek(dateFns.startOfWeek(now, { weekStartsOn: 1 }), batch);
            const weekEnd = dateFns.endOfWeek(view.weekOf, { weekStartsOn: 1 });
            return {
                zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                stale: view.stale,
                keepsStored: view.weekStart.getTime() === batch.getTime(),
                weekOf: week.weekStartKey(view.weekOf),
                weekStartText: week.weekBoundaryIso(view.weekOf),
                weekEndText: week.weekBoundaryIso(weekEnd),
                textsParseBack: new Date(week.weekBoundaryIso(view.weekOf)).getTime() === view.weekOf.getTime()
                    && new Date(week.weekBoundaryIso(weekEnd)).getTime() === weekEnd.getTime(),
            };
        });
    `);
}

describe("the week GET /current shows, on the server's own clock (TZ)", () => {
    const HOUR = 3_600_000;
    const ZONES = ["Asia/Tokyo", "Pacific/Kiritimati", "UTC", "America/Los_Angeles"];
    // Batches stored at Monday midnight UTC.
    const UTC_THIS_MONDAY = Date.UTC(2026, 4, 25);
    const UTC_LAST_MONDAY = Date.UTC(2026, 4, 18);
    const UTC_NEXT_MONDAY = Date.UTC(2026, 5, 1);
    const WEDNESDAY = [2026, 5, 27, 12, 0];
    const SUNDAY_NIGHT = [2026, 5, 31, 22, 0];

    it.each(ZONES)("counts a batch stored at UTC Monday midnight as this week when viewed mid-week, in %s", (tz) => {
        const seen = viewInTimeZone(tz, [{ now: WEDNESDAY, stored: UTC_THIS_MONDAY }]);
        expect(seen.map(({ zone, stale, keepsStored }) => ({ zone, stale, keepsStored }))).toEqual([
            { zone: tz, stale: false, keepsStored: true },
        ]);
    });

    it.each(ZONES)("flags last week's batch as stale, whether stored at UTC midnight or local midnight, in %s", (tz) => {
        const seen = viewInTimeZone(tz, [
            { now: WEDNESDAY, stored: UTC_LAST_MONDAY },
            { now: WEDNESDAY, stored: [2026, 5, 18] },
        ]);
        expect(seen.map(({ zone, stale }) => ({ zone, stale }))).toEqual([
            { zone: tz, stale: true },
            { zone: tz, stale: true },
        ]);
    });

    it.each(ZONES)("treats this week's and next week's batches made here as fresh, in %s", (tz) => {
        const seen = viewInTimeZone(tz, [
            { now: WEDNESDAY, stored: [2026, 5, 25] },
            { now: SUNDAY_NIGHT, stored: [2026, 6, 1] },
            { now: SUNDAY_NIGHT, stored: UTC_NEXT_MONDAY },
        ]);
        expect(seen.map(({ stale }) => stale)).toEqual([false, false, false]);
    });

    it.each(ZONES)("names the batch's local week, with weekEnd that week's last instant, in %s", (tz) => {
        const seen = viewInTimeZone(tz, [
            { now: WEDNESDAY, stored: UTC_THIS_MONDAY },
            { now: WEDNESDAY, stored: UTC_LAST_MONDAY },
            { now: SUNDAY_NIGHT, stored: [2026, 6, 1] },
        ]);
        const offset = { "Asia/Tokyo": "+09:00", "Pacific/Kiritimati": "+14:00", UTC: "Z", "America/Los_Angeles": "-07:00" }[tz];
        expect(seen.map(({ weekOf, weekStartText, weekEndText, textsParseBack }) => ({ weekOf, weekStartText, weekEndText, textsParseBack }))).toEqual([
            { weekOf: "2026-05-25", weekStartText: `2026-05-25T00:00:00.000${offset}`, weekEndText: `2026-05-31T23:59:59.999${offset}`, textsParseBack: true },
            { weekOf: "2026-05-18", weekStartText: `2026-05-18T00:00:00.000${offset}`, weekEndText: `2026-05-24T23:59:59.999${offset}`, textsParseBack: true },
            { weekOf: "2026-06-01", weekStartText: `2026-06-01T00:00:00.000${offset}`, weekEndText: `2026-06-07T23:59:59.999${offset}`, textsParseBack: true },
        ]);
    });

    it("gets both daylight-saving changes right in Los Angeles", () => {
        const springWednesday = [2026, 3, 11, 12, 0];
        const fallWednesday = [2026, 11, 4, 12, 0];
        const seen = viewInTimeZone("America/Los_Angeles", [
            { now: springWednesday, stored: Date.UTC(2026, 2, 9) },
            { now: springWednesday, stored: Date.UTC(2026, 2, 2) },
            { now: springWednesday, stored: [2026, 3, 9] },
            { now: springWednesday, stored: [2026, 3, 2] },
            { now: fallWednesday, stored: Date.UTC(2026, 10, 2) },
            { now: fallWednesday, stored: Date.UTC(2026, 9, 26) },
            { now: fallWednesday, stored: [2026, 11, 2] },
            { now: fallWednesday, stored: [2026, 10, 26] },
        ]);
        expect(seen.map(({ stale, weekOf }) => ({ stale, weekOf }))).toEqual([
            { stale: false, weekOf: "2026-03-09" },
            { stale: true, weekOf: "2026-03-02" },
            { stale: false, weekOf: "2026-03-09" },
            { stale: true, weekOf: "2026-03-02" },
            { stale: false, weekOf: "2026-11-02" },
            { stale: true, weekOf: "2026-10-26" },
            { stale: false, weekOf: "2026-11-02" },
            { stale: true, weekOf: "2026-10-26" },
        ]);
        expect(seen[4].weekStartText).toBe("2026-11-02T00:00:00.000-08:00");
        expect(seen[0].weekEndText).toBe("2026-03-15T23:59:59.999-07:00");
    });

    // The widest gap between two zones, 26 hours, in both directions: an
    // operator who moves the server from UTC+14 to UTC-12, or back.
    it.each([
        ["Etc/GMT+12", -14],
        ["Pacific/Kiritimati", +12],
    ])("keeps every week apart when batches were made 26 hours away, viewed in %s", (tz, madeAtOffsetFromUtc) => {
        const madeThere = (utcMonday: number) => utcMonday + (madeAtOffsetFromUtc as number) * HOUR;
        const seen = viewInTimeZone(tz as string, [
            { now: WEDNESDAY, stored: madeThere(UTC_THIS_MONDAY) },
            { now: WEDNESDAY, stored: madeThere(UTC_LAST_MONDAY) },
            { now: SUNDAY_NIGHT, stored: madeThere(UTC_NEXT_MONDAY) },
        ]);
        expect(seen.map(({ zone, stale, weekOf }) => ({ zone, stale, weekOf }))).toEqual([
            { zone: tz, stale: false, weekOf: "2026-05-25" },
            { zone: tz, stale: true, weekOf: "2026-05-18" },
            { zone: tz, stale: false, weekOf: "2026-06-01" },
        ]);
    });
});
