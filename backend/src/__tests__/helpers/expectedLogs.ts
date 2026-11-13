/**
 * For a test case that expects the code under test to log a warning or an error.
 *
 * Route tests use the real logger, so an error nobody expected prints in the run. A case that expects one calls
 * `expectLog("error")` first: the real logger is silenced for that case only, and the returned spy records the calls
 * for the case's own assertions. The spy is restored after each case, so the next case's errors print again.
 *
 *     const logged = expectLog("error");
 *     ...
 *     expect(logged).toHaveBeenCalledWith("Save playback state error:", expect.any(Error));
 */
import { logger } from "../../utils/logger";

type Level = "warn" | "error";

const spies: jest.SpyInstance[] = [];

afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
});

export function expectLog(level: Level): jest.SpyInstance {
    const spy = jest.spyOn(logger, level).mockImplementation(() => {});
    spies.push(spy);
    return spy;
}
