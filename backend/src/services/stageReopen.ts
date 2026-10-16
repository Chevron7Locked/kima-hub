import { Prisma } from "@prisma/client";

/**
 * The columns a stage record takes when its question is asked again from the start: owed now,
 * no failures counted, no claim, no error kept. Each caller adds its own evidence, and whether
 * a person's decision is cleared too. Used in the SET list of an UPDATE on "TrackStage".
 */
export const ASKED_AGAIN_SQL = `status = 'pending', failures = 0, redelivered = 0, retryable = true,
    "nextRetryAt" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
    "lastErrorCode" = NULL, "lastErrorMessage" = NULL, "failureClass" = NULL`;

/** `ASKED_AGAIN_SQL` for a tagged `$executeRaw` template. */
export const askedAgain = Prisma.raw(ASKED_AGAIN_SQL);
