/**
 * Connects the download-job module to the modules that own jobs: a Discover batch is told through
 * `checkBatchCompletion`, a playlist import through `checkImportCompletion`. The job module imports neither, so neither
 * forms an import cycle with it. Called once at start, before any job can settle; a test that settles a job of an
 * owner calls it too. Each check reads the owner module's export when it runs, so a test's spy or mock on it is what is told.
 */

import { onOwnerSettled } from "./jobs";
import { discoverWeeklyService } from "../discoverWeekly";
import { playlistImportService } from "../playlistImport";

export function connectJobOwners(): void {
    onOwnerSettled("discoverBatch", (batchId) => discoverWeeklyService.checkBatchCompletion(batchId));
    onOwnerSettled("import", (importId) => playlistImportService.checkImportCompletion(importId));
}
