import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { eventBus } from "./eventBus";

type NotificationType =
    | "system"
    | "download_complete"
    | "download_failed"
    | "download_waiting"
    | "playlist_ready"
    | "import_complete"
    | "error";

interface CreateNotificationParams {
    userId: string;
    type: NotificationType;
    title: string;
    message?: string;
    metadata?: Record<string, any>;
    /** One row per user per key: a new alert replaces the old one, and an
     * identical repeat is dropped. */
    groupKey?: string;
    /** With a group key: an identical repeat still comes back unread. For outcomes
     * of something the user just did, where the repeat is the answer they wait for. */
    renotify?: boolean;
}

class NotificationService {
    /**
     * Create a new notification for a user
     */
    async create(params: CreateNotificationParams) {
        const { userId, type, title, message, metadata, groupKey, renotify } = params;

        let notification;
        if (groupKey) {
            const where = { userId_groupKey: { userId, groupKey } };
            const existing = await prisma.notification.findUnique({ where });
            const identical =
                existing &&
                existing.type === type &&
                existing.title === title &&
                existing.message === (message ?? null) &&
                JSON.stringify(existing.metadata ?? null) === JSON.stringify(metadata ?? null);
            if (!renotify && identical) return existing;
            const fields = { type, title, message: message ?? null, metadata };
            notification = await prisma.notification.upsert({
                where,
                create: { userId, groupKey, ...fields },
                update: { ...fields, read: false, cleared: false, createdAt: new Date() },
            });
        } else {
            notification = await prisma.notification.create({
                data: { userId, type, title, message, metadata },
            });
        }

        eventBus.emit({
            type: "notification",
            userId,
            payload: {
                id: notification.id,
                notificationType: type,
                title,
                message,
            },
        });

        logger.debug(
            `[NOTIFICATION] Created: ${type} - ${title} for user ${userId}`
        );
        return notification;
    }

    /** The same alert for every admin. */
    async notifyAdmins(params: Omit<CreateNotificationParams, "userId">) {
        const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
        for (const admin of admins) {
            await this.create({ ...params, userId: admin.id });
        }
    }

    /** Delete one user's alert under a group key, leaving every other user's. */
    async resolveFor(userId: string, groupKey: string) {
        const row = await prisma.notification.findUnique({
            where: { userId_groupKey: { userId, groupKey } },
            select: { id: true },
        });
        if (!row) return;
        await prisma.notification.deleteMany({ where: { id: row.id } });
        eventBus.emit({ type: "notification:cleared", userId, payload: { id: row.id } });
    }

    /**
     * Delete every user's alert under a group key, once its cause is gone
     */
    async resolve(groupKey: string) {
        const rows = await prisma.notification.findMany({
            where: { groupKey },
            select: { id: true, userId: true },
        });
        if (rows.length === 0) return;
        await prisma.notification.deleteMany({ where: { groupKey } });
        for (const row of rows) {
            eventBus.emit({
                type: "notification:cleared",
                userId: row.userId,
                payload: { id: row.id },
            });
        }
    }

    /** Delete a user's rows under a key prefix beyond the newest `keep`. */
    async trimGroup(userId: string, keyPrefix: string, keep: number) {
        const stale = await prisma.notification.findMany({
            where: { userId, groupKey: { startsWith: keyPrefix } },
            orderBy: { createdAt: "desc" },
            skip: keep,
            select: { id: true },
        });
        if (stale.length === 0) return;
        await prisma.notification.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
        for (const row of stale) {
            eventBus.emit({ type: "notification:cleared", userId, payload: { id: row.id } });
        }
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
        const result = await prisma.notification.updateMany({
            where: { id, userId },
            data: { read: true },
        });
        eventBus.emit({ type: "notification:read", userId, payload: { id } });
        return result;
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId: string) {
        const result = await prisma.notification.updateMany({
            where: { userId, cleared: false },
            data: { read: true },
        });
        eventBus.emit({ type: "notification:read", userId, payload: {} });
        return result;
    }

    /**
     * Clear a notification (remove from view but keep in DB)
     */
    async clear(id: string, userId: string) {
        const result = await prisma.notification.updateMany({
            where: { id, userId },
            data: { cleared: true },
        });

        eventBus.emit({
            type: "notification:cleared",
            userId,
            payload: { id },
        });

        return result;
    }

    /**
     * Clear all notifications for a user
     */
    async clearAll(userId: string) {
        const result = await prisma.notification.updateMany({
            where: { userId },
            data: { cleared: true },
        });

        eventBus.emit({
            type: "notification:cleared",
            userId,
            payload: {},
        });

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
    /** A download Lidarr is holding for the user to import or remove; a repeat for the same album replaces the row. */
    async notifyDownloadWaiting(userId: string, subject: string, reason: string) {
        return this.create({
            userId,
            type: "download_waiting",
            title: "Waiting in Lidarr",
            message: `${subject}: ${reason}. It is waiting in Lidarr's queue for you to import or remove.`,
            metadata: { subject, reason },
            groupKey: `download-waiting:${subject}`,
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
     * Notify user that a Spotify import failed
     */
    async notifyImportFailed(userId: string, playlistName: string, error: string) {
        return this.create({
            userId,
            type: "error",
            title: "Import failed",
            message: `"${playlistName}": ${error}`,
            metadata: { href: "/import/playlist" },
        });
    }
}

export const notificationService = new NotificationService();
