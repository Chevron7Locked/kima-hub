import { Job } from 'bull';
import { logger } from "../../utils/logger";
import { FileValidatorService } from '../../services/fileValidator';

export interface ValidationJobData {
  // Empty for now - could add options later
}

export interface ValidationJobResult {
  tracksChecked: number;
  tracksRemoved: number;
  tracksMissing: string[];
  duration: number;
}

export async function processValidation(job: Job<ValidationJobData>): Promise<ValidationJobResult> {
  logger.debug(`[ValidationJob ${job.id}] Starting file validation`);

  await job.progress(0);

  const validator = new FileValidatorService();
  const result = await validator.validateLibrary();

  await job.progress(100);

  logger.debug(`[ValidationJob ${job.id}] Validation complete: ${result.tracksRemoved} tracks removed`);

  return result;
}
