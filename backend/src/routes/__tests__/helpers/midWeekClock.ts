import { addHours, startOfWeek } from "date-fns";
import { WEEK_STARTS_ON } from "../../../lib/discoveryWeek";

/**
 * Moves `Date` to Thursday noon of this week, still running forward, so a test file that works out
 * weeks from today never straddles a week boundary or lands on a week's last day (when a generation
 * rolls into the next week). Only `Date` is faked: the database and Redis clients keep real timers.
 * Call before working out any week; it restores real timers itself after the file's last test.
 */
export function useMidWeekClock(): void {
    afterAll(() => jest.useRealTimers());
    jest.useFakeTimers({
        now: addHours(startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }), 3 * 24 + 12),
        advanceTimers: true,
        doNotFake: [
            "hrtime", "nextTick", "performance", "queueMicrotask",
            "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout",
        ],
    });
}
