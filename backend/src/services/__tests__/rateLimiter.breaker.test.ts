/**
 * Five rate-limit replies in a row open a service's breaker: its next request is held, and once the hold is over the
 * request runs and the breaker is closed again. Other services are not held. (p-queue is the immediate stand-in.)
 */
jest.mock("../../utils/logger", () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { rateLimiter } from "../rateLimiter";

const limited = () => Promise.reject(Object.assign(new Error("Too Many Requests"), { response: { status: 429 } }));

afterEach(() => jest.restoreAllMocks());

it("holds a service after five rate limits in a row, and lets it go when the hold is over", async () => {
    for (let i = 0; i < 5; i++) {
        await expect(rateLimiter.execute("songlink", limited, { skipRetry: true })).rejects.toThrow("Too Many Requests");
    }

    const giveUp = new AbortController();
    setTimeout(() => giveUp.abort(new Error("held")), 30);
    const held = jest.fn().mockResolvedValue("sent");
    await expect(rateLimiter.execute("songlink", held, { signal: giveUp.signal })).rejects.toThrow("held");
    expect(held).not.toHaveBeenCalled();

    // Another service is not held.
    await expect(rateLimiter.execute("wikidata", async () => "ok")).resolves.toBe("ok");

    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await expect(rateLimiter.execute("songlink", async () => "sent")).resolves.toBe("sent");
    jest.restoreAllMocks();
    // Closed again: the next request goes straight through.
    await expect(rateLimiter.execute("songlink", async () => "again")).resolves.toBe("again");
});

it("a request that is not rate limited fails at once with its own error", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(rateLimiter.execute("lrclib", fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
});
