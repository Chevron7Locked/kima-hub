/**
 * Saving system settings: when the server saved them but could not clear the listening progress it keeps no longer
 * (Audiobookshelf is off), the person is told in the notification tray, and a clean save says nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const { api, notify } = vi.hoisted(() => ({
    api: { getSystemSettings: vi.fn(), updateSystemSettings: vi.fn() },
    notify: { error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: "me", role: "admin" } }) }));

import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import type { SystemSettings } from "@/features/settings/types";

const dom = mountHost();

let hook: ReturnType<typeof useSystemSettings>;
function Probe() {
    hook = useSystemSettings();
    return null;
}

async function save() {
    await act(async () => dom.root.render(<Probe />));
    await act(async () => {
        await hook.saveSystemSettings(hook.systemSettings as SystemSettings);
    });
}

beforeEach(() => {
    notify.error.mockReset();
    notify.info.mockReset();
    api.getSystemSettings.mockReset().mockResolvedValue({ musicPath: "/music", audiobookshelfEnabled: false });
    api.updateSystemSettings.mockReset();
});

describe("saving system settings", () => {
    it("says so in the notification tray when the listening progress could not be cleared", async () => {
        api.updateSystemSettings.mockResolvedValue({ success: true, audiobookProgressCleared: false });

        await save();

        expect(notify.error).toHaveBeenCalledTimes(1);
        const [title, opts] = notify.error.mock.calls[0];
        expect(title).toBe(title.toLowerCase());
        expect(title).toMatch(/audiobookshelf/);
        expect(opts.message).toBe(opts.message.toLowerCase());
    });

    it("says nothing when the save was clean", async () => {
        api.updateSystemSettings.mockResolvedValue({ success: true });

        await save();

        expect(notify.error).not.toHaveBeenCalled();
        expect(notify.info).not.toHaveBeenCalled();
    });
});
