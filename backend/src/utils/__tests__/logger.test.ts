import { AxiosError } from "axios";
import { logger } from "../logger";
import { setEnv } from "../../__tests__/helpers/env";

it("logs a failed request as one line without its query string", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const err = new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED", {
        method: "get",
        baseURL: "https://query.wikidata.org",
        url: "/sparql?query=x&api_key=secret",
        headers: {} as never,
    });
    logger.warn("Wikidata fetch failed:", err, 7);
    const printed = spy.mock.calls[0].slice(1);
    expect(printed).toEqual(["timeout of 10000ms exceeded (ECONNABORTED, GET https://query.wikidata.org/sparql)", 7]);
    expect(JSON.stringify(printed)).not.toContain("secret");
    spy.mockRestore();
});

describe("LOG_LEVEL", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    /** Loads a fresh logger with LOG_LEVEL set, logs one line at every level, and
     * says which levels printed. */
    function printedAt(value: string, nodeEnv = "production") {
        const restoreEnv = setEnv({ LOG_LEVEL: value, NODE_ENV: nodeEnv });
        const printed: string[] = [];
        for (const method of ["debug", "info", "warn", "error"] as const) {
            jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                printed.push(String(args[0]));
            });
        }
        try {
            jest.isolateModules(() => {
                const { logger: fresh } = require("../logger");
                fresh.debug("d");
                fresh.info("i");
                fresh.warn("w");
                fresh.error("e");
            });
        } finally {
            restoreEnv();
        }
        return printed;
    }

    it.each(["debug", "DEBUG", "Debug"])("%s logs every level", (value) => {
        expect(printedAt(value)).toEqual(["[DEBUG] d", "[INFO] i", "[WARN] w", "[ERROR] e"]);
    });

    it.each(["info", "INFO", "Info"])("%s logs info and above", (value) => {
        expect(printedAt(value)).toEqual(["[INFO] i", "[WARN] w", "[ERROR] e"]);
    });

    it.each(["warn", "WARN", "Warn"])("%s logs warnings and errors", (value) => {
        expect(printedAt(value)).toEqual(["[WARN] w", "[ERROR] e"]);
    });

    it.each(["error", "ERROR", "Error"])("%s logs errors only", (value) => {
        expect(printedAt(value)).toEqual(["[ERROR] e"]);
    });

    it.each(["silent", "SILENT", "Silent"])("%s logs nothing", (value) => {
        expect(printedAt(value)).toEqual([]);
    });

    it.each([
        ["verbose", "production", ["[WARN] w", "[ERROR] e"]],
        ["loud", "development", ["[DEBUG] d", "[INFO] i", "[WARN] w", "[ERROR] e"]],
    ])("an unknown value %s logs at the %s default, with one warning naming it", (value, nodeEnv, expected) => {
        const printed = printedAt(value, nodeEnv);
        expect(printed.filter((line) => line.includes(value))).toEqual([
            expect.stringMatching(new RegExp(`^\\[WARN\\] LOG_LEVEL "${value}"`)),
        ]);
        expect(printed.filter((line) => !line.includes(value))).toEqual(expected);
    });
});
