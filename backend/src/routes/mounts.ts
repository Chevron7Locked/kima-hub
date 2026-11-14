/**
 * Every router the server mounts, in the order they answer. Who may reach each is declared in ./mountAccess, by path
 * (the families are described in ./access).
 *
 * Adding a router means adding a line here and its access there; a path without access refuses everything.
 */

import { Router, type Express, type RequestHandler } from "express";
import { authLimiter } from "../middleware/rateLimiter";
import { mountRoute, type Mount } from "./access";
import { mountAccess } from "./mountAccess";

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

export interface MountOptions {
    /** The health check, served at /health and /api/health. */
    health: RequestHandler;
    /** The read-only public vibe feed; it does not exist unless this is set. */
    publicVibe: boolean;
}

/** One router at its path, with the access `mountAccess` declares for that path. */
function mount(path: string, router: RequestHandler): Mount {
    return { path, router, ...mountAccess[path] };
}

/** Where the queue dashboard (Bull Board) answers. */
export const QUEUE_BOARD_PATH = "/api/admin/queues";

/**
 * The queue dashboard's place, at its path with the access `mountAccess` declares for it. Bull Board is built once the
 * workers have started, which is after the server is listening, but its errors must still reach the error handler,
 * which has to be mounted last. So the place is taken now, before the handler, and the dashboard's router is put in
 * it later: the returned function sets it. Until then the place answers like a path with no route (after the access
 * check). The dashboard is not in `apiMounts`: its router belongs to Bull Board and its routes cannot be listed.
 */
export function mountQueueBoardSlot(app: Express): (router: RequestHandler) => void {
    let board: RequestHandler | undefined;
    mountRoute(
        app,
        mount(QUEUE_BOARD_PATH, (req, res, next) => (board ? board(req, res, next) : next())),
    );
    return (router) => {
        board = router;
    };
}

/** Every mount, in the order they answer. */
export function apiMounts(options: MountOptions): Mount[] {
    const health = Router().get("/", options.health);
    return [
        mount("/api/auth", authRoutes),
        mount("/api/onboarding", onboardingRoutes),
        mount("/api/share", shareRoutes),
        mount("/api/api-keys", apiKeysRoutes),
        mount("/api/device-link", deviceLinkRoutes),
        mount("/api/library", libraryRoutes),
        mount("/api/plays", playsRoutes),
        mount("/api/whats-new", whatsNewRoutes),
        mount("/api/stats", statsRoutes),
        mount("/api/settings", settingsRoutes),
        mount("/api/system-settings", systemSettingsRoutes),
        mount("/api/playback-state", playbackStateRoutes),
        mount("/api/playlists", playlistsRoutes),
        mount("/api/search", searchRoutes),
        mount("/api/recommendations", recommendationsRoutes),
        mount("/api/downloads", downloadsRoutes),
        mount("/api/notifications", notificationsRoutes),
        mount("/api/webhooks", webhooksRoutes),
        mount("/api/audiobooks", audiobooksRoutes),
        mount("/api/podcasts", podcastsRoutes),
        mount("/api/artists", artistsRoutes),
        mount("/api/soulseek", soulseekRoutes),
        mount("/api/discover", discoverRoutes),
        mount("/api/mixes", mixesRoutes),
        mount("/api/enrichment", enrichmentRoutes),
        mount("/api/spotify", spotifyRoutes),
        mount("/api/browse", browseRoutes),
        mount("/api/analysis", analysisRoutes),
        mount("/api/releases", releasesRoutes),
        mount("/api/vibe", vibeRoutes),
        ...(options.publicVibe ? [mount("/api/public/vibe", publicVibeRoutes)] : []),
        mount("/api/system", systemRoutes),
        // The ticket route is mounted before /api/events, which it would otherwise sit under.
        mount("/api/events/ticket", eventsTicketRoutes),
        mount("/api/events", eventsRoutes),
        mount("/rest", subsonicRouter),
        mount("/health", health),
        mount("/api/health", health),
        mount("/api/metrics", metricsRoutes),
    ];
}

/** Mounts every router with its access, the sign-in address limit first. */
export function mountApi(app: Express, options: MountOptions): void {
    // Runaway limits on the sign-in surfaces, in front of the routers that guard passwords.
    app.use("/api/auth/login", authLimiter);
    app.use("/api/onboarding/register", authLimiter);
    for (const each of apiMounts(options)) mountRoute(app, each);
}
