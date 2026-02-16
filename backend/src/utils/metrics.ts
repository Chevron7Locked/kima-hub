import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { logger } from './logger';

collectDefaultMetrics({ prefix: 'lidify_' });

// Download Job Metrics
export const downloadJobsTotal = new Counter({
  name: 'lidify_download_jobs_total',
  help: 'Total number of download jobs processed',
  labelNames: ['source', 'status'],
});

export const downloadJobDuration = new Histogram({
  name: 'lidify_download_job_duration_seconds',
  help: 'Duration of download jobs in seconds',
  labelNames: ['source', 'status'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

export const activeDownloads = new Gauge({
  name: 'lidify_active_downloads',
  help: 'Number of currently active downloads',
  labelNames: ['source'],
});

// Webhook Metrics
export const webhookEventsTotal = new Counter({
  name: 'lidify_webhook_events_total',
  help: 'Total number of webhook events received',
  labelNames: ['event_type', 'status'],
});

export const webhookProcessingDuration = new Histogram({
  name: 'lidify_webhook_processing_duration_seconds',
  help: 'Duration of webhook processing in seconds',
  labelNames: ['event_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

// Soulseek Metrics
export const soulseekConnectionStatus = new Gauge({
  name: 'lidify_soulseek_connection_status',
  help: 'Soulseek connection status (1 = connected, 0 = disconnected)',
});

export const soulseekSearchesTotal = new Counter({
  name: 'lidify_soulseek_searches_total',
  help: 'Total number of Soulseek searches performed',
  labelNames: ['status'],
});

export const soulseekSearchDuration = new Histogram({
  name: 'lidify_soulseek_search_duration_seconds',
  help: 'Duration of Soulseek searches in seconds',
  buckets: [1, 5, 10, 15, 20, 30, 45, 60],
});

export const soulseekDownloadsTotal = new Counter({
  name: 'lidify_soulseek_downloads_total',
  help: 'Total number of Soulseek downloads',
  labelNames: ['status'],
});

export const soulseekDownloadDuration = new Histogram({
  name: 'lidify_soulseek_download_duration_seconds',
  help: 'Duration of Soulseek downloads in seconds',
  labelNames: ['status'],
  buckets: [5, 10, 30, 60, 120, 300, 600, 1200],
});

// Lidarr API Metrics
export const lidarrApiCallsTotal = new Counter({
  name: 'lidify_lidarr_api_calls_total',
  help: 'Total number of Lidarr API calls',
  labelNames: ['endpoint', 'status'],
});

export const lidarrApiDuration = new Histogram({
  name: 'lidify_lidarr_api_duration_seconds',
  help: 'Duration of Lidarr API calls in seconds',
  labelNames: ['endpoint'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// Cache Metrics
export const cacheOperations = new Counter({
  name: 'lidify_cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['cache_name', 'operation'],
});

export const cacheHits = new Counter({
  name: 'lidify_cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_name'],
});

export const cacheMisses = new Counter({
  name: 'lidify_cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_name'],
});

export function getMetrics(): Promise<string> {
  return register.metrics();
}

export function clearMetrics(): void {
  register.clear();
  logger.debug('Metrics registry cleared');
}
