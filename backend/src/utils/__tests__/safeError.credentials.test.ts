/**
 * safeError must never hand the error OBJECT to the logger.
 *
 * `logger.error` forwards extra arguments to `console.error`, which runs
 * util.inspect over them, and util.inspect prints an AxiosError's enumerable
 * properties -- including `config.headers`. The connection-test routes in
 * routes/systemSettings.ts put an admin's unsaved API key in a header, so
 * `logger.error(ctx, error)` wrote that key to stdout in plaintext on every
 * failed probe. In production it still landed: the log level defaults to
 * 'warn', and error outranks warn.
 *
 * These cases are measured against this repo's own axios rather than argued.
 * The first one deliberately asserts that the leak WAS real -- if a future
 * axios stops exposing config on the error, that test failing is the signal to
 * re-read this file, not to delete it.
 */

jest.mock("../logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import util from "util";
import axios from "axios";
import { safeError } from "../errors";
import { logger } from "../logger";

const SECRET = "sk-live-do-not-log-me-0123456789";

function fakeRes() {
    const res: any = {
        statusCode: 0,
        body: undefined,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(payload: unknown) {
            res.body = payload;
            return res;
        },
    };
    return res;
}

/**
 * A real AxiosError carrying a real secret header. Port 1 refuses immediately,
 * so this needs no network and no server -- but the error is the genuine
 * article, with the genuine `config` attached.
 */
async function axiosErrorCarryingASecret(): Promise<unknown> {
    try {
        await axios.get("http://127.0.0.1:1/", {
            headers: { Authorization: `Bearer ${SECRET}` },
            timeout: 2000,
        });
        throw new Error("expected the connection to be refused");
    } catch (err) {
        return err;
    }
}

describe("safeError and credentials in logs", () => {
    beforeEach(() => jest.clearAllMocks());

    it("the leak was real: inspecting the error object exposes the header", async () => {
        const err = await axiosErrorCarryingASecret();

        // Exactly what console.error did with the second argument.
        expect(util.inspect(err)).toContain(SECRET);
    });

    it("the stack alone carries none of it", async () => {
        const err = await axiosErrorCarryingASecret();

        expect((err as Error).stack).toBeDefined();
        expect((err as Error).stack).not.toContain(SECRET);
    });

    it("logs a single string, with the context and without the secret", async () => {
        const err = await axiosErrorCarryingASecret();
        const res = fakeRes();

        safeError(res, "Audiobookshelf connection test", err);

        expect(logger.error).toHaveBeenCalledTimes(1);
        const args = (logger.error as jest.Mock).mock.calls[0];

        // ONE argument is the load-bearing assertion: with a second argument
        // there is something for util.inspect to walk into.
        expect(args).toHaveLength(1);
        expect(typeof args[0]).toBe("string");
        expect(args[0]).not.toContain(SECRET);
        expect(args[0]).toContain("Audiobookshelf connection test");
    });

    it("still answers the client with a generic 500", async () => {
        const err = await axiosErrorCarryingASecret();
        const res = fakeRes();

        safeError(res, "Audiobookshelf connection test", err);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Internal server error" });
    });

    it("honours an explicit status code", () => {
        const res = fakeRes();

        safeError(res, "ctx", new Error("boom"), 502);

        expect(res.statusCode).toBe(502);
    });

    it("renders a non-Error without walking into it", () => {
        const res = fakeRes();

        safeError(res, "ctx", { headers: { Authorization: `Bearer ${SECRET}` } });

        const args = (logger.error as jest.Mock).mock.calls[0];
        expect(args).toHaveLength(1);
        // Inspect the WHOLE argument list, not just the first entry: a second
        // argument is precisely how the secret used to escape, so checking only
        // args[0] would pass while leaking.
        expect(util.inspect(args)).not.toContain(SECRET);
    });
});
