import { afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A fresh element and React root for each test in the calling file, unmounted and removed after it. Read
 * `dom.host` and `dom.root` inside the tests (they change per test).
 */
export function mountHost(): { host: HTMLDivElement; root: Root } {
    const dom = {} as { host: HTMLDivElement; root: Root };
    beforeEach(() => {
        dom.host = document.createElement("div");
        document.body.appendChild(dom.host);
        dom.root = createRoot(dom.host);
    });
    afterEach(() => {
        act(() => dom.root.unmount());
        dom.host.remove();
    });
    return dom;
}
