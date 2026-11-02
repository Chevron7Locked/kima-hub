/**
 * #215: with an external slskd, Kima finds a finished download in slskd's download folder as Kima's container sees it.
 * That folder is set in Settings (soulseekDownloadPath); with it empty, it is SLSKD_DOWNLOADS or /soulseek-downloads.
 * Connecting applies it, so a changed or cleared setting takes effect on the next connection. The slskd client is
 * stood in for (no network); the settings reader returns what each case needs.
 */
import { EventEmitter } from "events";

let current: Record<string, unknown> = {};
jest.mock("../../utils/systemSettings", () => ({ getSystemSettings: jest.fn(async () => current) }));
jest.mock("../../lib/soulseek/client", () => {
    class FakeClient extends EventEmitter {
        server = { conn: new EventEmitter() };
        constructor() {
            super();
            setImmediate(() => this.server.conn.emit("connect"));
        }
        login = jest.fn(async () => {});
        destroy = jest.fn();
    }
    return { resolveSlskClient: () => FakeClient, SlskClient: FakeClient };
});

import { soulseekService } from "../soulseek";
import { peekSlskdConfig } from "../../lib/soulseek/slskd-client";

const slskd = (soulseekDownloadPath: string | null) => ({
    soulseekEnabled: true,
    soulseekMode: "slskd",
    slskdUrl: "http://slskd:5030",
    slskdApiKey: "k",
    soulseekDownloadPath,
});

afterAll(() => soulseekService.disconnect?.());

it("uses the download folder set in Settings", async () => {
    current = slskd("/mnt/slskd/complete");
    await soulseekService.connect();
    expect(peekSlskdConfig().downloads).toBe("/mnt/slskd/complete");
});

it("goes back to the default when the setting is cleared", async () => {
    current = slskd(null);
    await soulseekService.connect();
    expect(peekSlskdConfig().downloads).toBe(process.env.SLSKD_DOWNLOADS || "/soulseek-downloads");
});
