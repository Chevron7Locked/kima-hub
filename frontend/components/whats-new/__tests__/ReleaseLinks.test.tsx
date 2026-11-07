// A release item's links: a page inside the app opens in this tab and closes the window; an https address opens in a
// new tab and leaves the window open.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));

import { ReleaseLinks } from "@/components/whats-new/ReleaseLinks";

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

async function render(onFollow: () => void) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            <ReleaseLinks
                onFollow={onFollow}
                links={[
                    { label: "Open radio", href: "/radio" },
                    { label: "Get the iOS app", href: "https://apps.apple.com/app/id6789728815" },
                ]}
            />,
        );
    });
}

const anchor = (label: string) => Array.from(container.querySelectorAll("a")).find((a) => a.textContent?.includes(label))!;

describe("ReleaseLinks", () => {
    it("opens an https link in a new tab and leaves the window open", async () => {
        const onFollow = vi.fn();
        await render(onFollow);
        const a = anchor("Get the iOS app");
        expect(a.getAttribute("href")).toBe("https://apps.apple.com/app/id6789728815");
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toBe("noopener noreferrer");
        await act(async () => {
            a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
        expect(onFollow).not.toHaveBeenCalled();
    });

    it("keeps an in-app link in the same tab and closes the window", async () => {
        const onFollow = vi.fn();
        await render(onFollow);
        const a = anchor("Open radio");
        expect(a.getAttribute("target")).toBeNull();
        await act(async () => {
            a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
        expect(onFollow).toHaveBeenCalledTimes(1);
    });
});
