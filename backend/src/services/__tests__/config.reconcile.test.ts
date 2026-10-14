/**
 * Reconcile config parsing: retiring confirmed-gone tracks is opt-in, and an
 * unknown mode fails loudly at boot — silently falling back would flip the
 * delete decision without anyone saying so.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseMusicOverrides, validateMusicConfig } from "../../utils/configValidator";

describe("reconcile config", () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it("defaults to flag mode", () => {
        expect(parseMusicOverrides({}).reconcileMode).toBe("flag");
    });

    it("parses delete mode from env", () => {
        expect(parseMusicOverrides({ RECONCILE_MODE: "delete" }).reconcileMode).toBe("delete");
    });

    it("rejects unknown modes loudly", () => {
        expect(() => parseMusicOverrides({ RECONCILE_MODE: "nuke" })).toThrow();
        expect(() => parseMusicOverrides({ RECONCILE_MODE: "delete-after-grace" })).toThrow();
    });

    it("validateMusicConfig() carries the mode", async () => {
        process.env.RECONCILE_MODE = "delete";
        process.env.MUSIC_PATH = os.tmpdir();
        process.env.TRANSCODE_CACHE_PATH = fs.mkdtempSync(
            path.join(os.tmpdir(), "reconcile-cache-")
        );
        const cfg = await validateMusicConfig();
        expect(cfg.reconcileMode).toBe("delete");
    });
});
