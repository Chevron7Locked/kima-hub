import type { Prisma } from "@prisma/client";

// UserSettings defaults, matching the schema.prisma column defaults. Every
// site that creates a row uses these.
const DEFAULT_USER_SETTINGS = {
    playbackQuality: "original",
    wifiOnly: false,
    shareLiveListening: true,
};

export function defaultUserSettingsFor(
    userId: string
): Prisma.UserSettingsUncheckedCreateInput {
    return { userId, ...DEFAULT_USER_SETTINGS };
}
