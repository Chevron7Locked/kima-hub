// Every localStorage key the audio stack uses. Writers and readers import from here.
export const STORAGE_KEYS = {
    CURRENT_AUDIOBOOK: "kima_current_audiobook",
    CURRENT_PODCAST: "kima_current_podcast",
    PLAYBACK_TYPE: "kima_playback_type",
    CURRENT_INDEX: "kima_current_index",
    IS_SHUFFLE: "kima_is_shuffle",
    REPEAT_MODE: "kima_repeat_mode",
    PLAYER_MODE: "kima_player_mode",
    VOLUME: "kima_volume",
    IS_MUTED: "kima_muted",
} as const;
