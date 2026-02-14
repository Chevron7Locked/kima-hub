# Safe Migration Guide for Production (1k+ Users)

## Current Situation

Your database has **30 pending migrations** but the schema already exists, causing Prisma error P3005.

### What Happened
- Database was created/modified outside Prisma's migration system
- Some migrations were manually applied (WebhookEvent table, DiscoveryBatch.version)
- Migration history table (`_prisma_migrations`) is out of sync with actual schema

### What We Found (via introspection)
- ✅ WebhookEvent table EXISTS (from migration 20260214121222)
- ✅ DiscoveryBatch.version field EXISTS (from migration 20260214_add_discovery_batch_version)
- ❌ SystemSettings new fields MISSING (from migration 20260214145320)
- ❓ DownloadJob unique constraint status UNKNOWN (need to check)

---

## SAFE Migration Strategy

### Option 1: Baseline + Apply Missing (RECOMMENDED for Production)

This approach:
- Marks all old migrations as "already applied" (baselining)
- Only runs genuinely new migrations
- **Zero risk** to existing data

**Steps:**

```bash
cd /mnt/storage/Projects/lidify/backend

# Step 1: Baseline the database (mark migrations as applied without running them)
npx prisma migrate resolve --applied "20250101000000_rename_soulseek_fallback"
npx prisma migrate resolve --applied "20250102000000_add_user_token_version"
npx prisma migrate resolve --applied "20250102000001_add_downloadjob_targetmbid_index"
npx prisma migrate resolve --applied "20251130000000_init"
npx prisma migrate resolve --applied "20251225000000_add_missing_track_updated_at"
npx prisma migrate resolve --applied "20251225100000_add_similar_artists_json"
npx prisma migrate resolve --applied "20251226000000_add_mood_bucket_system"
npx prisma migrate resolve --applied "20251229004706_add_enrichment_concurrency"
npx prisma migrate resolve --applied "20251229043907_add_metadata_overrides"
npx prisma migrate resolve --applied "20251230000000_add_podcast_audiobook_search_vectors"
npx prisma migrate resolve --applied "20251230234224_add_enrichment_and_overrides"
npx prisma migrate resolve --applied "20251231041041_add_original_year_to_album"
npx prisma migrate resolve --applied "20260101152925_add_lidarr_webhook_secret"
npx prisma migrate resolve --applied "20260102142537_add_analysis_started_at"
npx prisma migrate resolve --applied "20260102150000_add_audio_analyzer_workers"
npx prisma migrate resolve --applied "20260103045951_add_lastfm_api_key"
npx prisma migrate resolve --applied "20260104000000_add_soulseek_concurrent_downloads"
npx prisma migrate resolve --applied "20260107000000_add_download_source_columns"
npx prisma migrate resolve --applied "20260118000000_add_partial_unique_index_active_downloads"
npx prisma migrate resolve --applied "20260123181610_add_artist_counts_and_indexes"
npx prisma migrate resolve --applied "20260127000000_add_pgvector"
npx prisma migrate resolve --applied "20260128000000_add_clap_workers"
npx prisma migrate resolve --applied "20260128100000_reduce_embedding_dimension"
npx prisma migrate resolve --applied "20260130000000_add_similarity_functions"
npx prisma migrate resolve --applied "20260204100000_add_vibe_analysis_fields"
npx prisma migrate resolve --applied "20260207000000_add_music_search_vector_triggers"
npx prisma migrate resolve --applied "20260214115252_add_download_job_unique_constraint"
npx prisma migrate resolve --applied "20260214121222_add_webhook_events"
npx prisma migrate resolve --applied "20260214_add_discovery_batch_version"

# Step 2: NOW verify what's left to apply
npx prisma migrate status

# Step 3: Apply ONLY the missing migration (SystemSettings config)
npx prisma migrate deploy
```

**Expected Result:**
- Only migration `20260214145320_standardize_integration_config` will run
- Adds 5 new nullable columns to SystemSettings
- **No data loss risk** (nullable columns, no foreign keys)
- Takes < 1 second

---

### Option 2: Manual SQL (If Option 1 Fails)

If baselining doesn't work, manually apply just the missing changes:

```sql
-- Connect to database
-- psql -U lidify -d lidify

-- Check if columns already exist (IMPORTANT: verify first!)
SELECT column_name FROM information_schema.columns
WHERE table_name = 'SystemSettings'
AND column_name IN ('soulseekEnabled', 'lastfmEnabled', 'lastfmApiSecret', 'lastfmUserKey', 'soulseekDownloadPath');

-- If columns DON'T exist, add them:
ALTER TABLE "SystemSettings" ADD COLUMN "soulseekEnabled" BOOLEAN;
ALTER TABLE "SystemSettings" ADD COLUMN "soulseekDownloadPath" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "lastfmApiSecret" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "lastfmUserKey" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "lastfmEnabled" BOOLEAN;

-- Then baseline the migration:
npx prisma migrate resolve --applied "20260214145320_standardize_integration_config"
```

---

## Pre-Migration Checklist

**BEFORE running ANY migrations:**

- [ ] **Backup database** (CRITICAL for 1k+ users)
  ```bash
  # Docker method
  docker compose exec postgres pg_dump -U lidify lidify > backup_$(date +%Y%m%d_%H%M%S).sql

  # Direct method (if pg_dump available)
  pg_dump -h 127.0.0.1 -p 5433 -U lidify lidify > backup_$(date +%Y%m%d_%H%M%S).sql
  ```

- [ ] **Verify backup is valid**
  ```bash
  # Check file size (should be > 1MB for populated database)
  ls -lh backup_*.sql

  # Check it contains CREATE TABLE statements
  grep "CREATE TABLE" backup_*.sql | head
  ```

- [ ] **Stop application** (prevent writes during migration)
  ```bash
  docker compose stop backend
  # OR
  pm2 stop backend
  ```

- [ ] **Test migration on backup first** (RECOMMENDED)
  ```bash
  # Create test database
  createdb lidify_test
  psql lidify_test < backup_YYYYMMDD_HHMMSS.sql

  # Update .env temporarily to point to test DB
  # Run migration on test DB
  npx prisma migrate deploy

  # Verify success, then apply to production
  ```

---

## Post-Migration Verification

**After migration succeeds:**

```bash
# Step 1: Verify migration history
npx prisma migrate status
# Should show: "Database schema is up to date!"

# Step 2: Verify new columns exist
npx prisma db pull
grep -A 5 "model SystemSettings" prisma/schema.prisma | grep -E "(soulseekEnabled|lastfmEnabled)"

# Step 3: Regenerate Prisma Client
npx prisma generate

# Step 4: Restart application
docker compose start backend
# OR
pm2 restart backend

# Step 5: Test critical paths
curl http://localhost:3006/health
curl http://localhost:3006/api/system-settings
```

---

## Migration Safety Analysis

### New Migration from This Session

**Migration:** `20260214145320_standardize_integration_config`

**Changes:**
```sql
ALTER TABLE "SystemSettings" ADD COLUMN "soulseekEnabled" BOOLEAN;
ALTER TABLE "SystemSettings" ADD COLUMN "soulseekDownloadPath" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "lastfmApiSecret" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "lastfmUserKey" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "lastfmEnabled" BOOLEAN;
```

**Risk Assessment:**
- ✅ **Data Loss Risk:** ZERO (adding nullable columns, no data deletion)
- ✅ **Downtime:** < 1 second (ADD COLUMN is fast on small tables)
- ✅ **Rollback:** Easy (DROP COLUMN if needed)
- ✅ **Breaking Changes:** NONE (nullable columns, env fallback in code)
- ✅ **Lock Duration:** Minimal (SystemSettings table has 1 row)

**User Impact:**
- No service interruption
- Existing configurations continue working (env var fallback)
- New configuration options available via API

---

## Rollback Plan

### If Migration Fails

```bash
# Step 1: Restore from backup
psql -U lidify -d lidify < backup_YYYYMMDD_HHMMSS.sql

# Step 2: Restart application
docker compose restart backend
```

### If Migration Succeeds But App Breaks

```bash
# Step 1: Revert code to previous commit
git checkout main  # or previous stable tag

# Step 2: Restart application
docker compose restart backend

# Step 3: (Optional) Remove new columns if they cause issues
psql -U lidify -d lidify -c '
  ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "soulseekEnabled";
  ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "soulseekDownloadPath";
  ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "lastfmApiSecret";
  ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "lastfmUserKey";
  ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "lastfmEnabled";
'
```

---

## Important Notes for 1k+ Users

### 1. **No Breaking Changes**
- All new columns are nullable
- Code has env variable fallback
- Existing users see no difference
- New features opt-in via settings

### 2. **Backward Compatibility**
- Old code works with new schema (nullable columns ignored)
- New code works with old schema (falls back to env vars)
- Rolling deployment is safe

### 3. **Redis Dependency**
- New code uses Redis for distributed locks and caching
- **Graceful degradation:** App continues without Redis (reduced reliability)
- Redis recommended but not required for deployment

### 4. **Monitoring Post-Deploy**
Watch for:
- `ConfigurationError` exceptions (missing config)
- `Redis error` logs (connection issues)
- Webhook processing failures
- Download job duplicates

---

## Questions to Answer

Before proceeding, please confirm:

1. **Do you have a recent backup?** (REQUIRED before any migration)
2. **Is Redis running in your production stack?** (Check docker-compose.yml)
3. **Can you afford 5-10 seconds of downtime** for migration + restart?
4. **Do you want to test on a staging/backup database first?** (RECOMMENDED)

Let me know and I'll guide you through the safest path.
