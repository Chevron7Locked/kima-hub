import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

export type NotificationType =
    | "system"
    | "download_complete"
    | "download_failed"
    | "playlist_ready"
    | "import_complete"
    | "error";

export interface CreateNotificationParams {
    userId: string;
    type: NotificationType;
    title: string;
    message?: string;
    metadata?: Record<string, any>;
}

class NotificationService {
    /**
     * Create a new notification for a user
     */
    async create(params: CreateNotificationParams) {
        const { userId, type, title, message, metadata } = params;

        const notification = await prisma.notification.create({
            data: {
                userId,
                type,
                title,
                message,
                metadata,
            },
        });

        logger.debug(
            `[NOTIFICATION] Created: ${type} - ${title} for user ${userId}`
        );
        return notification;
    }

    /**
     * Get all uncleared notifications for a user
     */
    async getForUser(userId: string, includeRead = true) {
        return prisma.notification.findMany({
            where: {
                userId,
                cleared: false,
                ...(includeRead ? {} : { read: false }),
            },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
    }

    /**
     * Get unread count for a user
     */
    async getUnreadCount(userId: string) {
        return prisma.notification.count({
            where: {
                userId,
                cleared: false,
                read: false,
            },
        });
    }

    /**
     * Mark a notification as read
     */
    async markAsRead(id: string, userId: string) {
        return prisma.notification.updateMany({
            where: { id, userId },
            data: { read: true },
        });
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId: string) {
        return prisma.notification.updateMany({
            where: { userId, cleared: false },
            data: { read: true },
        });
    }

    /**
     * Clear a notification (remove from view but keep in DB)
     */
    async clear(id: string, userId: string) {
        return prisma.notification.updateMany({
            where: { id, userId },
            data: { cleared: true },
        });
    }

    /**
     * Clear all notifications for a user
     */
    async clearAll(userId: string) {
        return prisma.notification.updateMany({
            where: { userId },
            data: { cleared: true },
        });
    }

    /**
     * Delete old cleared notifications (cleanup job)
     */
    async deleteOldCleared(daysOld = 30) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysOld);

        const result = await prisma.notification.deleteMany({
            where: {
                cleared: true,
                createdAt: { lt: cutoff },
            },
        });

        if (result.count > 0) {
            logger.debug(
                `[NOTIFICATION] Cleaned up ${result.count} old notifications`
            );
        }
        return result;
    }

    // === Convenience methods for common notification types ===

    /**
     * Notify user that a download completed
     */
    async notifyDownloadComplete(
        userId: string,
        subject: string,
        albumId?: string,
        artistId?: string
    ) {
        return this.create({
            userId,
            type: "download_complete",
            title: "Download Complete",
            message: `${subject} has been downloaded and added to your library`,
            metadata: { albumId, artistId },
        });
    }

    /**
     * Notify user that a download failed
     */
    async notifyDownloadFailed(
        userId: string,
        subject: string,
        error?: string
    ) {
        return this.create({
            userId,
            type: "download_failed",
            title: "Download Failed",
            message: `Failed to download ${subject}${
                error ? `: ${error}` : ""
            }`,
            metadata: { subject, error },
        });
    }

    /**
     * Notify user that a playlist is ready
     */
    async notifyPlaylistReady(
        userId: string,
        playlistName: string,
        playlistId: string,
        trackCount: number
    ) {
        return this.create({
            userId,
            type: "playlist_ready",
            title: "Playlist Ready",
            message: `"${playlistName}" is ready with ${trackCount} tracks`,
            metadata: { playlistId, playlistName, trackCount },
        });
    }

    /**
     * Notify user that a Spotify import completed
     */
    async notifyImportComplete(
        userId: string,
        playlistName: string,
        playlistId: string,
        matchedTracks: number,
        totalTracks: number
    ) {
        const message = `"${playlistName}" imported with ${matchedTracks} of ${totalTracks} tracks`;

        return this.create({
            userId,
            type: "import_complete",
            title: "Import Complete",
            message,
            metadata: { playlistId, playlistName, matchedTracks, totalTracks },
        });
    }

    /**
     * System notification (cache cleared, sync complete, etc.)
     */
    async notifySystem(userId: string, title: string, message?: string) {
        return this.create({
            userId,
            type: "system",
            title,
            message,
        });
    }
}

export const notificationService = new NotificationService();
