import type { NextConfig } from "next";

const withBundleAnalyzer = require('@next/bundle-analyzer')({
    enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
    // Allow dev origins for local network testing
    allowedDevOrigins: [
        "http://127.0.0.1:3030",
        "http://127.0.0.1",
        "127.0.0.1",
        "http://localhost:3030",
        "http://localhost",
        "localhost",
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
                protocol: "https",
                hostname: "lastfm.freetls.fastly.net",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "lastfm-img2.akamaized.net",
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
                hostname: "assets.fanart.tv",
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
        imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
        minimumCacheTTL: 60 * 60 * 24 * 7, // Cache for 7 days
        dangerouslyAllowSVG: true,
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
                ],
            },
        ];
    },
    // Proxy API requests to backend (for Docker all-in-one container)
    async rewrites() {
        const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:3006";
        
        return [
            {
                source: "/api/:path*",
                destination: `${backendUrl}/api/:path*`,
            },
            {
                source: "/health",
                destination: `${backendUrl}/health`,
            },
        ];
    },
};

export default withBundleAnalyzer(nextConfig);
