import { it, expect, vi, beforeEach } from "vitest";

const createNotification = vi.fn();
vi.mock("@/lib/api", () => ({ api: { createNotification: (...a: unknown[]) => createNotification(...a) } }));

import { notify } from "../notify";

beforeEach(() => {
    createNotification.mockReset().mockResolvedValue({ id: "n1" });
});

it("sends the group key it was given, so a repeat under it replaces the row", () => {
    notify.error("could not save 3 songs", { groupKey: "save-songs" });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "could not save 3 songs", groupKey: "save-songs" }));
});

it("sends no group key when none is given, so the title keys the row", () => {
    notify.info("saved");
    expect(createNotification.mock.calls[0][0].groupKey).toBeUndefined();
});
