/**
 * What a stage job asks of the scheduler to run its phase: the stage's own window, the work owed to it, and the
 * claim-and-queue dispatch. The scheduler binds each to the stage; the job never sees how the window is measured,
 * how the offer is gated (one heavy model at a time, paused sources) or how claims are made.
 */

import type { StageWork } from "../unifiedEnrichment";

export interface StageOffer {
    /** How many answers this stage may have in flight now (the scheduler's drain-rate cap). */
    window(): Promise<number>;
    /** The records this stage owes, up to `limit`, already gated by the scheduler. */
    nextWork(limit: number): Promise<StageWork[]>;
    /** Claim the owed records and hand each to `produce`; returns how many were queued. */
    dispatch(work: StageWork[], produce: (item: StageWork) => Promise<void>): Promise<number>;
}
