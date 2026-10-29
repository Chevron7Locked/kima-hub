/** Stand-in for liveListening.isPublicListener: "public-user" is the public listener while the mocked config has the public vibe on. */
export const fakeIsPublicListener = async (userId: string) =>
    Boolean(jest.requireMock<{ config: { publicVibe: unknown } }>("../../../config").config.publicVibe) && userId === "public-user";

export const publicVibeConfigMock = () => ({
    config: { publicVibe: { token: "t".repeat(32), username: "listener" } },
});
