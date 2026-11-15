/**
 * The admin notice about an unreadable credential is sent once per field per process, but only once it was actually
 * delivered: a notice that failed to send is tried again on the next read. Real cipher, notifications stubbed.
 */
import { resolveEncryptedSettings } from "../encryptedFields";
import { notificationService } from "../../services/notificationService";

// 'xc1.' marks the current format, and the rest is no valid ciphertext: stored, but the key cannot read it.
const unreadable = "xc1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

afterEach(() => {
    jest.restoreAllMocks();
});

it("tries the notice again on the next read when the first one could not be sent, then not a third time", async () => {
    const notify = jest
        .spyOn(notificationService, "notifyAdmins")
        .mockRejectedValueOnce(new Error("notifications are down"))
        .mockResolvedValue(undefined as never);

    const first = await resolveEncryptedSettings({ slskdApiKey: unreadable }, () => []);
    expect(first.slskdApiKey).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);

    await resolveEncryptedSettings({ slskdApiKey: unreadable }, () => []);
    expect(notify).toHaveBeenCalledTimes(2);

    await resolveEncryptedSettings({ slskdApiKey: unreadable }, () => []);
    expect(notify).toHaveBeenCalledTimes(2);
});
