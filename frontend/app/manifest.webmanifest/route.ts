import { NextRequest, NextResponse } from "next/server";

/**
 * Dynamic manifest that serves "display": "browser" on iOS.
 *
 * iOS standalone PWAs (WKWebView) have a known WebKit bug (#261858) where
 * the audio session is suspended when the app is backgrounded and cannot
 * be reactivated from Control Center — play() resolves but produces no
 * sound. Safari tabs don't have this problem because the Safari process
 * maintains the audio session.
 *
 * By serving display: "browser" on iOS, "Add to Home Screen" creates a
 * bookmark that opens in a Safari tab instead of a standalone WKWebView,
 * giving users full background audio with Control Center support.
 *
 * Desktop and Android continue to get the full standalone PWA experience.
 */

const BASE_MANIFEST = {
    id: "/",
    name: "Kima",
    short_name: "Kima",
    description: "Self-hosted music streaming",
    lang: "en",
    scope: "/",
    start_url: "/",
    orientation: "portrait",
    theme_color: "#000000",
    background_color: "#000000",
    categories: ["music", "entertainment"],
    icons: [
        { src: "assets/icons/icon-48.webp", type: "image/webp", sizes: "48x48", purpose: "any" },
        { src: "assets/icons/icon-72.webp", type: "image/webp", sizes: "72x72", purpose: "any" },
        { src: "assets/icons/icon-96.webp", type: "image/webp", sizes: "96x96", purpose: "any" },
        { src: "assets/icons/icon-128.webp", type: "image/webp", sizes: "128x128", purpose: "any" },
        { src: "assets/icons/icon-192.webp", type: "image/webp", sizes: "192x192", purpose: "any maskable" },
        { src: "assets/icons/icon-256.webp", type: "image/webp", sizes: "256x256", purpose: "any" },
        { src: "assets/icons/icon-512.webp", type: "image/webp", sizes: "512x512", purpose: "any maskable" },
    ],
    shortcuts: [
        { name: "Vibe", short_name: "Vibe", url: "/vibe", icons: [{ src: "assets/icons/icon-96.webp", sizes: "96x96" }] },
        { name: "Search", short_name: "Search", url: "/search", icons: [{ src: "assets/icons/icon-96.webp", sizes: "96x96" }] },
        { name: "Library", short_name: "Library", url: "/library", icons: [{ src: "assets/icons/icon-96.webp", sizes: "96x96" }] },
    ],
};

function isIOS(ua: string): boolean {
    return /iPhone|iPad|iPod/.test(ua);
}

export async function GET(request: NextRequest) {
    const ua = request.headers.get("user-agent") || "";
    const ios = isIOS(ua);

    const manifest = {
        ...BASE_MANIFEST,
        display: ios ? "browser" : "standalone",
        ...(ios ? {} : { display_override: ["window-controls-overlay", "standalone"] }),
    };

    return NextResponse.json(manifest, {
        headers: {
            "Content-Type": "application/manifest+json",
            "Cache-Control": "public, max-age=3600",
        },
    });
}
