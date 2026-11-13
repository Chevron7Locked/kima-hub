/**
 * Every router the server mounts, with who may reach it. The families are described in ./access.
 *
 * Adding a router means adding a line here with its access; a line without one refuses everything. A route that
 * differs from its mount is listed under `routes`, written as the router writes it.
 */

import { Router, type Express, type RequestHandler } from "express";
import { authLimiter } from "../middleware/rateLimiter";
import { mountRoute, type Access, type Mount } from "./access";

import authRoutes from "./auth";
import onboardingRoutes from "./onboarding";
import libraryRoutes from "./library";
import playsRoutes from "./plays";
import whatsNewRoutes from "./whatsNew";
import statsRoutes from "./stats";
import settingsRoutes from "./settings";
import systemSettingsRoutes from "./systemSettings";
import playbackStateRoutes from "./playbackState";
import playlistsRoutes from "./playlists";
import searchRoutes from "./search";
import recommendationsRoutes from "./recommendations";
import downloadsRoutes from "./downloads";
import webhooksRoutes from "./webhooks";
import audiobooksRoutes from "./audiobooks";
import podcastsRoutes from "./podcasts";
import artistsRoutes from "./artists";
import soulseekRoutes from "./soulseek";
import discoverRoutes from "./discover";
import apiKeysRoutes from "./apiKeys";
import mixesRoutes from "./mixes";
import enrichmentRoutes from "./enrichment";
import deviceLinkRoutes from "./deviceLink";
import spotifyRoutes from "./spotify";
import notificationsRoutes from "./notifications";
import browseRoutes from "./browse";
import analysisRoutes from "./analysis";
import releasesRoutes from "./releases";
import vibeRoutes from "./vibe";
import publicVibeRoutes from "./publicVibe";
import systemRoutes from "./system";
import shareRoutes from "./share";
import eventsRoutes from "./events";
import eventsTicketRoutes from "./eventsTicket";
import metricsRoutes from "./metrics";
import { subsonicRouter } from "./subsonic/index";

const publicAccess: Access = { family: "public" };
const signedIn: Access = { family: "signed-in" };
/** Signed in, where streaming URLs carry the token in `?token=`. */
const signedInByUrlToken: Access = { family: "signed-in", urlToken: true };

export interface MountOptions {
    /** The health check, served at /health and /api/health. */
    health: RequestHandler;
    /** The read-only public vibe feed; it does not exist unless this is set. */
    publicVibe: boolean;
}

/** Every mount, in the order they answer. */
export function apiMounts(options: MountOptions): Mount[] {
    const health = Router().get("/", options.health);
    return [
        {
            path: "/api/auth",
            router: authRoutes,
            access: {
                ...signedIn,
                routes: {
                    "POST /login": "public",
                    "POST /logout": "public",
                    "POST /refresh": "public",
                    "GET /users": "admin",
                    "POST /create-user": "admin",
                    "DELETE /users/:id": "admin",
                },
            },
        },
        {
            path: "/api/onboarding",
            router: onboardingRoutes,
            access: {
                ...signedIn,
                routes: {
                    "POST /register": "public",
                    "GET /status": "public",
                    "POST /lidarr": "admin",
                    "POST /audiobookshelf": "admin",
                    "POST /soulseek": "admin",
                },
            },
        },
        {
            path: "/api/share",
            router: shareRoutes,
            access: {
                family: "share-token",
                routes: { "POST /": "signed-in", "DELETE /:token": "signed-in" },
            },
        },
        { path: "/api/api-keys", router: apiKeysRoutes, access: signedIn, runawayLimit: true },
        {
            path: "/api/device-link",
            router: deviceLinkRoutes,
            access: { ...signedInByUrlToken, routes: { "POST /verify": "public" } },
            runawayLimit: true,
        },
        {
            // The library router limits itself: cover art and streaming skip the runaway limit.
            path: "/api/library",
            router: libraryRoutes,
            access: {
                ...signedInByUrlToken,
                routes: {
                    "POST /scan": "admin",
                    "POST /organize": "admin",
                    "POST /refile": "admin",
                    "GET /corrupt-tracks": "admin",
                    "GET /missing-tracks": "admin",
                    "GET /removals": "admin",
                    "DELETE /corrupt-tracks": "admin",
                    "POST /artist-counts/backfill": "admin",
                    "POST /backfill-genres": "admin",
                    "DELETE /artists/:id": "admin",
                    "DELETE /albums/:id": "admin",
                    "DELETE /tracks/:id": "admin",
                    "POST /image-backfill/start": "admin",
                },
            },
        },
        { path: "/api/plays", router: playsRoutes, access: signedIn, runawayLimit: true },
        { path: "/api/whats-new", router: whatsNewRoutes, access: signedIn, runawayLimit: true },
        { path: "/api/stats", router: statsRoutes, access: signedIn, runawayLimit: true },
        {
            path: "/api/settings",
            router: settingsRoutes,
            access: { ...signedIn, routes: { "POST /cleanup-stale-jobs": "admin" } },
            runawayLimit: true,
        },
        {
            path: "/api/system-settings",
            router: systemSettingsRoutes,
            access: { family: "admin", routes: { "GET /public-config": "signed-in" } },
            runawayLimit: true,
        },
        // No runaway limit: playback state syncs often.
        { path: "/api/playback-state", router: playbackStateRoutes, access: signedIn },
        { path: "/api/playlists", router: playlistsRoutes, access: signedInByUrlToken, runawayLimit: true },
        { path: "/api/search", router: searchRoutes, access: signedIn, runawayLimit: true },
        { path: "/api/recommendations", router: recommendationsRoutes, access: signedInByUrlToken, runawayLimit: true },
        {
            path: "/api/downloads",
            router: downloadsRoutes,
            access: { ...signedInByUrlToken, routes: { "POST /clear-lidarr-queue": "admin" } },
            runawayLimit: true,
        },
        { path: "/api/notifications", router: notificationsRoutes, access: signedIn, runawayLimit: true },
        // The router applies the webhook limit, which lets requests carrying the secret through.
        { path: "/api/webhooks", router: webhooksRoutes, access: { family: "webhook" } },
        {
            // The cover stays reachable without a session: lock-screen artwork requests it that way, so the runaway
            // limit is its only bound. The stream route accepts a token in the URL.
            path: "/api/audiobooks",
            router: audiobooksRoutes,
            access: {
                ...signedInByUrlToken,
                routes: { "GET /:id/cover": "public", "OPTIONS /:id/cover": "public" },
            },
            runawayLimit: true,
        },
        { path: "/api/podcasts", router: podcastsRoutes, access: signedInByUrlToken, runawayLimit: true },
        { path: "/api/artists", router: artistsRoutes, access: signedInByUrlToken, runawayLimit: true },
        {
            path: "/api/soulseek",
            router: soulseekRoutes,
            access: { ...signedIn, routes: { "POST /connect": "admin", "POST /disconnect": "admin" } },
            runawayLimit: true,
        },
        {
            path: "/api/discover",
            router: discoverRoutes,
            access: {
                ...signedInByUrlToken,
                routes: { "POST /cleanup-lidarr": "admin", "POST /fix-tagging": "admin" },
            },
            runawayLimit: true,
        },
        { path: "/api/mixes", router: mixesRoutes, access: signedInByUrlToken, runawayLimit: true },
        {
            path: "/api/enrichment",
            router: enrichmentRoutes,
            access: {
                ...signedIn,
                routes: {
                    "POST /pause": "admin",
                    "POST /resume": "admin",
                    "POST /stop": "admin",
                    "POST /retry-failed-and-blocked": "admin",
                    "POST /re-decide-everything": "admin",
                    "POST /rerun": "admin",
                    "POST /wipe-and-rerun": "admin",
                    "POST /sync": "admin",
                    "POST /retry": "admin",
                    "PUT /artists/:id/metadata": "admin",
                    "PUT /albums/:id/metadata": "admin",
                    "PUT /tracks/:id/metadata": "admin",
                    "POST /artists/:id/reset": "admin",
                    "POST /albums/:id/reset": "admin",
                    "POST /tracks/:id/reset": "admin",
                    "PUT /concurrency": "admin",
                },
            },
            runawayLimit: true,
        },
        { path: "/api/spotify", router: spotifyRoutes, access: signedInByUrlToken, runawayLimit: true },
        { path: "/api/browse", router: browseRoutes, access: signedInByUrlToken, runawayLimit: true },
        {
            // The analyzers report here with the server's own secret.
            path: "/api/analysis",
            router: analysisRoutes,
            access: { family: "admin", routes: { "POST /vibe/failure": "internal", "POST /vibe/success": "internal" } },
            runawayLimit: true,
        },
        { path: "/api/releases", router: releasesRoutes, access: signedInByUrlToken, runawayLimit: true },
        { path: "/api/vibe", router: vibeRoutes, access: signedIn, runawayLimit: true },
        // Read-only public vibe feed: it does not exist unless KIMA_PUBLIC_VIBE=true.
        ...(options.publicVibe
            ? [{ path: "/api/public/vibe", router: publicVibeRoutes, access: { family: "internal" }, runawayLimit: true } satisfies Mount]
            : []),
        { path: "/api/system", router: systemRoutes, access: signedIn, runawayLimit: true },
        // The ticket route is mounted before /api/events, which it would otherwise sit under.
        { path: "/api/events/ticket", router: eventsTicketRoutes, access: signedInByUrlToken, runawayLimit: true },
        // Public: the stream proves itself with the one-time ticket the route reads; long-lived, so no runaway limit.
        { path: "/api/events", router: eventsRoutes, access: publicAccess },
        // Subsonic limits and signs in its own requests.
        { path: "/rest", router: subsonicRouter, access: { family: "subsonic" } },
        { path: "/health", router: health, access: publicAccess },
        { path: "/api/health", router: health, access: publicAccess },
        // The runaway limit comes first, so a looping client is held before the sign-in check.
        { path: "/api/metrics", router: metricsRoutes, access: { family: "admin" }, runawayLimit: true },
    ];
}

/** Mounts every router with its access, the sign-in address limit first. */
export function mountApi(app: Express, options: MountOptions): void {
    // Runaway limits on the sign-in surfaces, in front of the routers that guard passwords.
    app.use("/api/auth/login", authLimiter);
    app.use("/api/onboarding/register", authLimiter);
    for (const mount of apiMounts(options)) mountRoute(app, mount);
}
