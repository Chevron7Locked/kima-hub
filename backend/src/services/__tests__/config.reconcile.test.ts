/**
 * Reconcile config parsing: retiring confirmed-gone tracks is opt-in, and an
 * unknown mode fails loudly at boot — silently falling back would flip the
 * delete decision without anyone saying so.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseReconcileMode } from "../../utils/configValidator";

describe("reconcile config", () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it("defaults to flag mode", () => {
        expect(parseReconcileMode({})).toBe("flag");
    });

    it("parses delete mode from env", () => {
        expect(parseReconcileMode({ RECONCILE_MODE: "delete" })).toBe("delete");
    });

    it("rejects unknown modes loudly", () => {
        expect(() => parseReconcileMode({ RECONCILE_MODE: "nuke" })).toThrow();
        expect(() => parseReconcileMode({ RECONCILE_MODE: "delete-after-grace" })).toThrow();
    });

    it("the loaded config carries the mode read at boot", async () => {
        process.env.RECONCILE_MODE = "delete";
        jest.resetModules();
        const { config, initializeMusicConfig } = await import("../../config");
        expect(config.music.reconcileMode).toBe("delete");

        // Validating the paths later keeps it.
        process.env.MUSIC_PATH = os.tmpdir();
        process.env.TRANSCODE_CACHE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-cache-"));
        await initializeMusicConfig();
        expect(config.music.musicPath).toBe(os.tmpdir());
        expect(config.music.reconcileMode).toBe("delete");
    });
});
