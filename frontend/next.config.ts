import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    turbopack: {
        root: __dirname,
    },

    // Dev-server origins. Add your own (e.g. a LAN/tailnet address you browse
    // from) via KIMA_DEV_ORIGINS="host1,http://host2:3030" — never hard-coded here.
    allowedDevOrigins: [
        "http://127.0.0.1:3030",
        "http://127.0.0.1",
        "127.0.0.1",
        "http://localhost:3030",
        "http://localhost",
        "localhost",
        ...(process.env.KIMA_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ],

    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "cdn-images.dzcdn.net",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "e-cdns-images.dzcdn.net",
                pathname: "/**",
            },
            {
                protocol: "http",
                hostname: "localhost",
                port: "3006",
                pathname: "/**",
            },
            {
                protocol: "http",
                hostname: "127.0.0.1",
                port: "3006",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "assets.pippa.io",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "is1-ssl.mzstatic.com",
                pathname: "/**",
            },
        ],
        formats: ["image/avif", "image/webp"],
        deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
        imageSizes: [16, 32, 48, 64, 96, 128, 256, 384, 512],
        minimumCacheTTL: 60 * 60 * 24 * 7, // Cache for 7 days
        // SVG optimization disabled for security (prevents XSS via crafted SVGs)
    },
    reactStrictMode: true,
    async headers() {
        return [
            {
                source: "/(.*)",
                headers: [
                    {
                        key: "Permissions-Policy",
                        value: "camera=(), microphone=(), geolocation=()",
                    },
                    {
                        key: "X-Frame-Options",
                        value: "DENY",
                    },
                    {
                        key: "X-Content-Type-Options",
                        value: "nosniff",
                    },
                    {
                        key: "Referrer-Policy",
                        value: "strict-origin-when-cross-origin",
                    },
                    {
                        key: "X-DNS-Prefetch-Control",
                        value: "on",
                    },
                    {
                        key: "Content-Security-Policy",
                        value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn-images.dzcdn.net https://e-cdns-images.dzcdn.net https://assets.pippa.io https://is1-ssl.mzstatic.com; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; worker-src 'self' blob:",
                    },
                ],
            },
        ];
    },
    async redirects() {
        return [
            { source: "/setup", destination: "/login", permanent: true },
            { source: "/import/spotify", destination: "/import/playlist", permanent: true },
            // The queue lives in the right-hand panel now; an old bookmark lands on home, where the panel is.
            { source: "/queue", destination: "/", permanent: true },
        ];
    },
    // /api/* goes to the backend. Images set NEXT_PUBLIC_BACKEND_URL; the
    // fallback is the local dev backend (backend/.env PORT=3111). /api/events
    // is excluded: app/api/events/route.ts streams it without buffering.
    async rewrites() {
        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:3111";

        return [
            {
                source: "/api/:path((?!events).*)*",
                destination: `${backendUrl}/api/:path*`,
            },
            {
                source: "/rest/:path*",
                destination: `${backendUrl}/rest/:path*`,
            },
            {
                source: "/health",
                destination: `${backendUrl}/health`,
            },
        ];
    },
};

// The bundle analyzer is a devDependency, stripped from production images.
// Next awaits a promise-returning config export, so load it lazily: prod
// boots never reference the package. ANALYZE=true (dev) gets the report.
export default async function config(): Promise<NextConfig> {
    if (process.env.ANALYZE === "true") {
        const { default: withBundleAnalyzer } = await import("@next/bundle-analyzer");
        return withBundleAnalyzer({ enabled: true })(nextConfig);
    }
    return nextConfig;
}
