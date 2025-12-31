import { PrismaClient, User } from '@prisma/client';

export const prisma = new PrismaClient();

export async function createUser(username: string, passwordHash: string, role?: string, providerId?: string, oidcUid?: string): Promise<User> {
    const user = await prisma.user.create({
        data: {
            username,
            passwordHash,
            role: role || "user",
            onboardingComplete: true, // Skip onboarding for created users
            oidcId: providerId,
            oidcUid: oidcUid,
        },
    });

    // Create default user settings
    await prisma.userSettings.create({
        data: {
            userId: user.id,
            playbackQuality: "original",
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 10240,
        },
    });
    return user;
}

export async function updateUserRole(username: string, role: string): Promise<void> {
    await prisma.user.update({
        where: { username },
        data: { role },
    });
}