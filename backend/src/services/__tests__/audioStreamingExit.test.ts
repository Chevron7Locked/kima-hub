/**
 * The streaming service's cache eviction runs every six hours for as long as the server runs, and never keeps a
 * process alive by itself: the server is kept up by what it serves. A process that made the service and has nothing
 * else to do exits. Before, the timer held it, and a test file that streamed a song kept Jest running, holding the
 * suite's lock, until someone killed it.
 */
import { spawnSync } from "child_process";
import os from "os";
import path from "path";

it("a process that made the streaming service and has nothing else to do exits", () => {
    const backend = path.join(__dirname, "../../..");
    const cache = path.join(os.tmpdir(), `kima-stream-exit-${process.pid}`);
    const script = `require("./src/services/audioStreaming").getAudioStreamingService(${JSON.stringify(cache)}, 1); console.log("made")`;
    const run = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
        cwd: backend,
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        env: { ...process.env, LOG_LEVEL: "error" },
    });
    expect(run.stdout).toContain("made");
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
}, 45_000);
