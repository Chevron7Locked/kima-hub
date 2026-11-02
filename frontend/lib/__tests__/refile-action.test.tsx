// The release item that re-files albums by their tags: it asks first, queues the re-file, then says where the
// result will show; a refusal (one is already running) shows the server's reason.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const refile = vi.fn();
vi.mock("@/lib/api", () => ({ api: { refileAlbums: (...a: unknown[]) => refile(...a) } }));

import { RefileAction } from "@/components/whats-new/RefileAction";
import type { ReleaseItem } from "@/components/whats-new/types";

const item = {
    kind: "action", key: "albums.refile", title: "Re-file albums", summary: "s", body: "b", cta: "Re-file albums", run: "refileAlbums",
    confirmTitle: "Re-file albums by their tags?", confirmMessage: "Reads every song's tags again.", confirmLabel: "Re-file albums",
} as Extract<ReleaseItem, { kind: "action" }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    refile.mockReset();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const button = (text: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);

describe("the re-file release item", () => {
    it("asks first, then queues the re-file and says where the result will show", async () => {
        refile.mockResolvedValue({ message: "ok" });
        const onDone = vi.fn();
        await act(async () => root.render(<RefileAction item={item} done={false} onDone={onDone} />));
        await act(async () => button("Re-file albums")!.click());
        expect(document.body.textContent).toContain("Reads every song's tags again.");
        expect(refile).not.toHaveBeenCalled();

        const confirm = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === "Re-file albums") as HTMLButtonElement;
        await act(async () => confirm.click());
        expect(refile).toHaveBeenCalledTimes(1);
        expect(onDone).toHaveBeenCalled();
    });

    it("says it is running only right after this session started it", async () => {
        refile.mockResolvedValue({ message: "ok" });
        // The parent flips `done` when onDone fires, as the changelog page does.
        function Host() {
            const [done, setDone] = React.useState(false);
            return <RefileAction item={item} done={done} onDone={() => setDone(true)} />;
        }
        await act(async () => root.render(<Host />));
        await act(async () => button("Re-file albums")!.click());
        const confirm = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === "Re-file albums") as HTMLButtonElement;
        await act(async () => confirm.click());
        expect(container.textContent).toContain("Re-filing albums. The result will show in your notifications.");
        // The button stays: a re-file can be run again any time.
        expect(button("Re-file albums")).toBeDefined();
    });

    it("keeps its button when the server already reports it done, and says it ran before", async () => {
        await act(async () => root.render(<RefileAction item={item} done={true} onDone={() => {}} />));
        expect(container.textContent).toContain("Albums were re-filed before. Running it again is safe.");
        expect(container.textContent).not.toContain("Re-filing albums");
        expect(button("Re-file albums")).toBeDefined();
    });

    it("shows the server's reason when it is refused", async () => {
        refile.mockRejectedValue(new Error("Albums are already being re-filed (a re-file is already active)"));
        await act(async () => root.render(<RefileAction item={item} done={false} onDone={() => {}} />));
        await act(async () => button("Re-file albums")!.click());
        const confirm = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === "Re-file albums") as HTMLButtonElement;
        await act(async () => confirm.click());
        expect(container.textContent).toContain("Albums are already being re-filed");
    });
});
