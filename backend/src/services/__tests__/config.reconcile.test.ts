/**
 * Reconcile config parsing: library retirement of grace-crossed missing tracks is
 * opt-in and the knobs fail loudly — a silently-misparsed grace window deletes rows.
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

    it("defaults to flag mode and 30 days", () => {
        const cfg = parseMusicOverrides({});
        expect(cfg.reconcileMode).toBe("flag");
        expect(cfg.reconcileGraceDays).toBe(30);
    });

    it("parses delete-after-grace from env", () => {
        const cfg = parseMusicOverrides({
            RECONCILE_MODE: "delete-after-grace",
            RECONCILE_GRACE_DAYS: "14",
        });
        expect(cfg.reconcileMode).toBe("delete-after-grace");
        expect(cfg.reconcileGraceDays).toBe(14);
    });

    it("clamps numeric grace <1 to 1; FATAL on non-numeric", () => {
        expect(parseMusicOverrides({ RECONCILE_GRACE_DAYS: "0" }).reconcileGraceDays).toBe(1);
        expect(parseMusicOverrides({ RECONCILE_GRACE_DAYS: "-5" }).reconcileGraceDays).toBe(1);
        expect(() => parseMusicOverrides({ RECONCILE_GRACE_DAYS: "14d" })).toThrow();
    });

    it("rejects unknown modes loudly", () => {
        expect(() => parseMusicOverrides({ RECONCILE_MODE: "nuke" })).toThrow();
    });

    it("validateMusicConfig() output carries reconcile fields", async () => {
        process.env.RECONCILE_MODE = "delete-after-grace";
        process.env.MUSIC_PATH = os.tmpdir();
        process.env.TRANSCODE_CACHE_PATH = fs.mkdtempSync(
            path.join(os.tmpdir(), "reconcile-cache-")
        );
        const cfg = await validateMusicConfig();
        expect(cfg.reconcileMode).toBe("delete-after-grace");
        expect(cfg.reconcileGraceDays).toBe(30);
    });
});
