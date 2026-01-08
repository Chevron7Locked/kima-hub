import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { config } from "../config";

interface PlaylistTrack {
    artistName: string;
    albumTitle?: string;
    trackTitle: string;
    reason?: string;
}

interface GeneratePlaylistParams {
    userId: string;
    topArtists: Array<{ name: string; playCount: number; genres: string[] }>;
    recentDiscoveries: string[];
    likedArtists: string[];
    dislikedArtists: string[];
    targetCount: number;
}

class OpenAIService {
    private client: AxiosInstance;
    private apiKey: string;

    constructor() {
        this.apiKey = config.openai.apiKey;
        this.client = axios.create({
            baseURL: "https://api.openai.com/v1",
            timeout: 60000,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
        });
    }

    async generateWeeklyPlaylist(
        params: GeneratePlaylistParams
    ): Promise<PlaylistTrack[]> {
        const {
            topArtists,
            recentDiscoveries,
            likedArtists,
            dislikedArtists,
            targetCount,
        } = params;

        // Build context for AI
        const topArtistsText = topArtists
            .slice(0, 20)
            .map(
                (a) =>
                    `${a.name} (${a.playCount} plays, genres: ${a.genres.join(
                        ", "
                    )})`
            )
            .join("\n");

        const prompt = `You are a music curator creating a personalized "Discover Weekly" playlist.

USER'S LISTENING PROFILE:
Top Artists (last 90 days):
${topArtistsText}

Recent Discoveries (NEW artists to explore): ${recentDiscoveries.join(", ") || "None yet"}
Liked Artists: ${likedArtists.join(", ") || "None"}
Disliked Artists (NEVER recommend): ${dislikedArtists.join(", ") || "None"}

TASK:
Generate a ${targetCount}-track playlist with this breakdown:
- 25% (${Math.round(
            targetCount * 0.25
        )} tracks): From the user's top artists (1-2 tracks max per artist)
- 75% (${Math.round(
            targetCount * 0.75
        )} tracks): NEW discoveries from the "Recent Discoveries" list above

CRITICAL REQUIREMENTS:
1. PRIORITIZE new artists from the "Recent Discoveries" list - this is the main goal
2. Include only 1-2 well-known tracks from the user's top artists as "familiar anchors"
3. For new discoveries, choose popular, accessible tracks that will hook the listener
4. Maintain genre consistency with user's preferences
5. NEVER include artists from the "Disliked Artists" list
6. Variety of moods and tempos across the playlist

OUTPUT FORMAT (JSON):
{
  "tracks": [
    {
      "artistName": "Artist Name",
      "trackTitle": "Track Title",
      "reason": "Brief reason (e.g., 'Popular track from your favorite artist' or 'Similar to Jamiroquai')"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;

        try {
            const response = await this.client.post("/chat/completions", {
                model: "gpt-4-turbo",
                messages: [
                    {
                        role: "system",
                        content:
                            "You are an expert music curator who creates personalized playlists based on listening history. You always respond with valid JSON only. Ensure all strings are properly escaped.",
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                max_tokens: 2000,
                temperature: 0.7,
                response_format: { type: "json_object" },
            });

            const content = response.data.choices[0].message.content.trim();

            // Remove markdown code blocks if present
            let jsonContent = content;
            if (content.startsWith("```json")) {
                jsonContent = content
                    .replace(/```json\n?/g, "")
                    .replace(/```\n?/g, "")
                    .trim();
            } else if (content.startsWith("```")) {
                jsonContent = content.replace(/```\n?/g, "").trim();
            }

            const result = JSON.parse(jsonContent);

            return result.tracks || [];
        } catch (error: any) {
            logger.error(
                "OpenAI API error:",
                error.response?.data || error.message
            );

            // Log the raw response content for debugging
            if (error instanceof SyntaxError) {
                logger.error("Failed to parse JSON response");
            }

            throw new Error("Failed to generate playlist with AI");
        }
    }

    async enhanceTrackRecommendation(
        track: { artist: string; title: string },
        userContext: string
    ): Promise<string> {
        const prompt = `Given this track: "${track.title}" by ${track.artist}
User context: ${userContext}

Provide a single-sentence reason why this track would fit in their Discover Weekly playlist.
Be concise and engaging (max 15 words).`;

        try {
            const response = await this.client.post("/chat/completions", {
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content:
                            "You write brief, engaging music recommendations.",
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                max_tokens: 50,
            });

            return response.data.choices[0].message.content.trim();
        } catch (error) {
            logger.error("OpenAI enhancement error:", error);
            return "Recommended based on your listening history";
        }
    }
}

export const openAIService = new OpenAIService();
