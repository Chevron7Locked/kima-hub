-- Audio remediation Phase A (spec 1.6 + 1.10).
-- TranscodedFile: cache validity becomes mtime EQUALITY + source size; sourceSize 0
-- marks legacy rows that must revalidate once. BigInt because lossless sources and
-- transcode outputs can exceed Int's ~2.1GB ceiling.
ALTER TABLE "TranscodedFile" ALTER COLUMN "cacheSize" SET DATA TYPE BIGINT;
ALTER TABLE "TranscodedFile" ADD COLUMN "sourceSize" BIGINT NOT NULL DEFAULT 0;
-- Audiobook: cached per-file track map (index/startOffset/duration) so list and
-- series responses can carry the same tracks shape as the detail endpoint.
ALTER TABLE "Audiobook" ADD COLUMN "tracksJson" JSONB;
