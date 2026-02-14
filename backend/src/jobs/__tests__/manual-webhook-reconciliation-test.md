# Manual Webhook Reconciliation Test

This document describes how to manually test the webhook reconciliation system.

## Prerequisites

1. Lidarr must be running and configured
2. Backend server must be running
3. At least one download job should exist in the database

## Test Scenarios

### Scenario 1: Process Unprocessed Grab Event

1. Create a download job in the database
2. Insert a webhook event directly into the `WebhookEvent` table:
   ```sql
   INSERT INTO "WebhookEvent" (id, "eventId", source, "eventType", payload, processed, "createdAt")
   VALUES (
     'test-event-1',
     'test-lidarr-Grab-12345',
     'lidarr',
     'Grab',
     '{"eventType":"Grab","downloadId":"12345","albums":[{"foreignAlbumId":"test-mbid","title":"Test Album","id":999}],"artist":{"name":"Test Artist"}}'::jsonb,
     false,
     NOW()
   );
   ```
3. Trigger reconciliation manually:
   ```typescript
   import { webhookReconciliation } from './jobs/webhookReconciliation';
   await webhookReconciliation.triggerReconciliation();
   ```
4. Verify:
   - Event is marked as `processed = true`
   - Event has `correlationId` matching the download job ID
   - Download job has `lidarrRef` set to the downloadId

### Scenario 2: Retry Failed Events

1. Create an event with retryCount < 3
2. Mark it as failed:
   ```typescript
   import { webhookEventStore } from './services/webhookEventStore';
   await webhookEventStore.markFailed('event-id', 'Test error');
   ```
3. Trigger reconciliation
4. Verify:
   - Event is retried
   - If retry succeeds, event is marked processed
   - If retry fails, retryCount is incremented

### Scenario 3: Skip Events Exceeding Max Retries

1. Create an event with retryCount >= 3
2. Trigger reconciliation
3. Verify:
   - Event is NOT processed
   - retryCount remains unchanged
   - Event remains unprocessed

## Automated Test

Run the WebhookEventStore tests to verify the core functionality:

```bash
npx jest src/services/__tests__/webhookEventStore.test.ts
```

All tests should pass, confirming:
- Event storage and deduplication
- Event marking (processed/failed)
- Retry count management
- Cleanup of old events
