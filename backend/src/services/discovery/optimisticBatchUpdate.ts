/**
 * Optimistic Locking for DiscoveryBatch Updates
 *
 * Prevents race conditions when multiple processes update the same batch
 * by using a version field and retry logic.
 */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { Prisma } from '@prisma/client';

export interface BatchUpdateData {
    status?: string;
    expectedStatus?: string;
    totalAlbums?: number;
    completedAlbums?: number;
    failedAlbums?: number;
    finalSongCount?: number;
    errorMessage?: string | null;
    completedAt?: Date;
}

export interface BatchUpdateResult {
    success: boolean;
    version?: number;
    retries: number;
    error?: string;
}

export interface UpdateOptions {
    maxRetries?: number;
    retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Update a discovery batch with optimistic locking
 *
 * @param batchId - The ID of the batch to update
 * @param data - The fields to update
 * @param options - Retry configuration
 * @param tx - Optional Prisma transaction client
 * @returns Result object with success status and retry count
 */
export async function updateBatchStatus(
    batchId: string,
    data: BatchUpdateData,
    options: UpdateOptions = {},
    tx?: Omit<
        Prisma.TransactionClient,
        '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
    >
): Promise<BatchUpdateResult> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const client = tx ?? prisma;

    let retries = 0;

    while (retries <= maxRetries) {
        try {
            const current = await client.discoveryBatch.findUnique({
                where: { id: batchId },
                select: { version: true },
            });

            if (!current) {
                return {
                    success: false,
                    retries,
                    error: `Batch ${batchId} not found`,
                };
            }

            const currentVersion = current.version ?? 0;
            const nextVersion = currentVersion + 1;

            const { expectedStatus, ...updateData } = data;

            const updated = await client.discoveryBatch.update({
                where: {
                    id: batchId,
                    version: currentVersion,
                    ...(expectedStatus ? { status: expectedStatus } : {}),
                },
                data: {
                    ...updateData,
                    version: nextVersion,
                },
            });

            return {
                success: true,
                version: updated.version ?? nextVersion,
                retries,
            };
        } catch (error: any) {
            const isVersionConflict =
                error.code === 'P2025' ||
                error.message?.includes('Record to update not found');

            if (isVersionConflict) {
                retries++;

                if (retries > maxRetries) {
                    logger.warn(
                        `[OptimisticLock] Max retries (${maxRetries}) reached for batch ${batchId}`
                    );
                    return {
                        success: false,
                        retries,
                        error: `Max retries reached after ${maxRetries} attempts`,
                    };
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, retryDelayMs * Math.random())
                );
            } else {
                logger.error(
                    `[OptimisticLock] Unexpected error updating batch ${batchId}:`,
                    error
                );
                return {
                    success: false,
                    retries,
                    error: `Unexpected error: ${error.message}`,
                };
            }
        }
    }

    return {
        success: false,
        retries,
        error: 'Update loop exited unexpectedly',
    };
}
