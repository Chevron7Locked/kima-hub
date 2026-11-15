/**
 * The admin notice about an unreadable credential is sent once per field per process, but only once it was actually
 * delivered: a notice that failed to send is tried again on the next read. Real cipher, notifications stubbed.
 */
import { decryptSettings, noteUnreadableCredentials } from "../encryptedFields";
import { notificationService } from "../../services/notificationService";

// 'xc1.' marks the current format, and the rest is no valid ciphertext: stored, but the key cannot read it.
const unreadable = "xc1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A settings read that waits for its notices. */
async function read<S extends Record<string, unknown>>(settings: S) {
    const resolved = decryptSettings(settings);
    await noteUnreadableCredentials(resolved, () => []);
    return resolved;
}

afterEach(() => {
    jest.restoreAllMocks();
});

it("tries the notice again on the next read when the first one could not be sent, then not a third time", async () => {
    const notify = jest
        .spyOn(notificationService, "notifyAdmins")
        .mockRejectedValueOnce(new Error("notifications are down"))
        .mockResolvedValue(undefined as never);

    const first = await read({ slskdApiKey: unreadable });
    expect(first.slskdApiKey).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);

    await read({ slskdApiKey: unreadable });
    expect(notify).toHaveBeenCalledTimes(2);

    await read({ slskdApiKey: unreadable });
    expect(notify).toHaveBeenCalledTimes(2);
});

it("never lets a notice that is still being sent land after the notice that takes it away", async () => {
    const groupKey = "unreadable-credential:fanartApiKey";
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(notificationService, "notifyAdmins").mockImplementation((async (n: { groupKey?: string }) => {
        if (n.groupKey !== groupKey) return;
        order.push("notice starts");
        await gate;
        order.push("notice stored");
    }) as never);
    jest.spyOn(notificationService, "resolve").mockImplementation((async (key: string) => {
        if (key === groupKey) order.push("notice taken away");
    }) as never);

    // one read finds the credential unreadable and is still sending its notice when a later read finds it readable
    const unreadableRead = read({ fanartApiKey: unreadable });
    while (!order.includes("notice starts")) await new Promise((resolve) => setTimeout(resolve, 5));
    const readableRead = read({ fanartApiKey: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([unreadableRead, readableRead]);

    expect(order).toEqual(["notice starts", "notice stored", "notice taken away"]);
});
