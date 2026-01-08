import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { spotifyService } from "../services/spotify";
import { deezerService, DeezerPlaylistPreview, DeezerRadioStation } from "../services/deezer";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

/**
 * Unified playlist preview type
 */
interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

/**
 * Convert Deezer playlist to unified format
 */
function deezerPlaylistToUnified(playlist: DeezerPlaylistPreview): PlaylistPreview {
    return {
        id: playlist.id,
        source: "deezer",
        type: "playlist",
        title: playlist.title,
        description: playlist.description,
        creator: playlist.creator,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
        url: `https://www.deezer.com/playlist/${playlist.id}`,
    };
}

/**
 * Convert Deezer radio to unified format
 */
function deezerRadioToUnified(radio: DeezerRadioStation): PlaylistPreview {
    return {
        id: radio.id,
        source: "deezer",
        type: "radio",
        title: radio.title,
        description: radio.description,
        creator: "Deezer",
        imageUrl: radio.imageUrl,
        trackCount: 0, // Radio tracks are dynamic
        url: `https://www.deezer.com/radio-${radio.id}`,
    };
}

// ============================================
// Playlist Endpoints
// ============================================

/**
 * GET /api/browse/playlists/featured
 * Get featured/chart playlists from Deezer
 */
router.get("/playlists/featured", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        logger.debug(`[Browse] Fetching featured playlists (limit: ${limit})...`);

        const playlists = await deezerService.getFeaturedPlaylists(limit);
        logger.debug(`[Browse] Got ${playlists.length} Deezer playlists`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse featured playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlists" });
    }
});

/**
 * GET /api/browse/playlists/search
 * Search for playlists on Deezer
 */
router.get("/playlists/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        logger.debug(`[Browse] Searching playlists for "${query}"...`);

        const playlists = await deezerService.searchPlaylists(query, limit);
        logger.debug(`[Browse] Search "${query}": ${playlists.length} results`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            query,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse search playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to search playlists" });
    }
});

/**
 * GET /api/browse/playlists/:id
 * Get full details of a Deezer playlist
 */
router.get("/playlists/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const playlist = await deezerService.getPlaylist(id);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        res.json({
            ...playlist,
            source: "deezer",
            url: `https://www.deezer.com/playlist/${id}`,
        });
    } catch (error: any) {
        logger.error("Playlist fetch error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlist" });
    }
});

// ============================================
// Radio Endpoints
// ============================================

/**
 * GET /api/browse/radios
 * Get all radio stations (mood/theme based mixes)
 */
router.get("/radios", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching radio stations...");
        const radios = await deezerService.getRadioStations();

        res.json({
            radios: radios.map(deezerRadioToUnified),
            total: radios.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse radios error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radios" });
    }
});

/**
 * GET /api/browse/radios/by-genre
 * Get radio stations organized by genre
 */
router.get("/radios/by-genre", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching radios by genre...");
        const genresWithRadios = await deezerService.getRadiosByGenre();

        // Transform to include unified format
        const result = genresWithRadios.map(genre => ({
            id: genre.id,
            name: genre.name,
            radios: genre.radios.map(deezerRadioToUnified),
        }));

        res.json({
            genres: result,
            total: result.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse radios by genre error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radios" });
    }
});

/**
 * GET /api/browse/radios/:id
 * Get tracks from a radio station (as playlist format for import)
 */
router.get("/radios/:id", async (req, res) => {
    try {
        const { id } = req.params;
        logger.debug(`[Browse] Fetching radio ${id} tracks...`);
        
        const radioPlaylist = await deezerService.getRadioTracks(id);

        if (!radioPlaylist) {
            return res.status(404).json({ error: "Radio station not found" });
        }

        res.json({
            ...radioPlaylist,
            source: "deezer",
            type: "radio",
        });
    } catch (error: any) {
        logger.error("Radio tracks error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radio tracks" });
    }
});

// ============================================
// Genre Endpoints
// ============================================

/**
 * GET /api/browse/genres
 * Get all available genres
 */
router.get("/genres", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching genres...");
        const genres = await deezerService.getGenres();

        res.json({
            genres,
            total: genres.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse genres error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genres" });
    }
});

/**
 * GET /api/browse/genres/:id
 * Get content for a specific genre (playlists + radios)
 */
router.get("/genres/:id", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        if (isNaN(genreId)) {
            return res.status(400).json({ error: "Invalid genre ID" });
        }

        logger.debug(`[Browse] Fetching content for genre ${genreId}...`);
        const content = await deezerService.getEditorialContent(genreId);

        res.json({
            genreId,
            playlists: content.playlists.map(deezerPlaylistToUnified),
            radios: content.radios.map(deezerRadioToUnified),
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Genre content error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genre content" });
    }
});

/**
 * GET /api/browse/genres/:id/playlists
 * Get playlists for a specific genre (by name search)
 */
router.get("/genres/:id/playlists", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

        // Get genre name first
        const genres = await deezerService.getGenres();
        const genre = genres.find(g => g.id === genreId);

        if (!genre) {
            return res.status(404).json({ error: "Genre not found" });
        }

        const playlists = await deezerService.getGenrePlaylists(genre.name, limit);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            genre: genre.name,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Genre playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genre playlists" });
    }
});

// ============================================
// URL Parsing (supports both Spotify & Deezer)
// ============================================

/**
 * POST /api/browse/playlists/parse
 * Parse a Spotify or Deezer URL and return playlist info
 * This is the main entry point for URL-based imports
 */
router.post("/playlists/parse", async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }

        // Try Deezer first (our primary source)
        const deezerParsed = deezerService.parseUrl(url);
        if (deezerParsed && deezerParsed.type === "playlist") {
            return res.json({
                source: "deezer",
                type: "playlist",
                id: deezerParsed.id,
                url: `https://www.deezer.com/playlist/${deezerParsed.id}`,
            });
        }

        // Try Spotify (still supported for URL imports)
        const spotifyParsed = spotifyService.parseUrl(url);
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return res.json({
                source: "spotify",
                type: "playlist",
                id: spotifyParsed.id,
                url: `https://open.spotify.com/playlist/${spotifyParsed.id}`,
            });
        }

        return res.status(400).json({ 
            error: "Invalid or unsupported URL. Please provide a Spotify or Deezer playlist URL." 
        });
    } catch (error: any) {
        logger.error("Parse URL error:", error);
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

// ============================================
// Combined Browse Endpoint (for frontend convenience)
// ============================================

/**
 * GET /api/browse/all
 * Get a combined view of featured content (playlists, genres)
 * Note: Radio stations are now internal (library-based), not from Deezer
 */
router.get("/all", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching browse content (playlists + genres)...");

        // Only fetch playlists and genres - radios are now internal library-based
        const [playlists, genres] = await Promise.all([
            deezerService.getFeaturedPlaylists(200),
            deezerService.getGenres(),
        ]);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            radios: [], // Radio stations are now internal (use /api/library/radio)
            genres,
            radiosByGenre: [], // Deprecated - use internal radios
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse all error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch browse content" });
    }
});

export default router;
