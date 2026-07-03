-- Remediation Wave 0 / Segment F1 (findings DB-1, DB-3, DB-4).
-- Additive indexes only. NOTE: schema.prisma is missing @@index declarations for a
-- large number of indexes that already exist in the DB per prior migrations (e.g.
-- Play_userId_playedAt_idx, Play_trackId_idx, Track_albumId_idx,
-- DiscoveryTrack_discoveryAlbumId_idx, Notification_userId_cleared_idx,
-- Notification_userId_read_idx, Notification_createdAt_idx, and ~90 others across
-- other models). Those @@index lines were added to schema.prisma to bring it back in
-- sync with reality, but no CREATE INDEX is needed for them here since they already
-- exist. Only the genuinely new indexes are created below.
-- CreateIndex
CREATE INDEX "Play_userId_trackId_idx" ON "Play"("userId", "trackId");

-- CreateIndex
CREATE INDEX "Notification_userId_cleared_read_idx" ON "Notification"("userId", "cleared", "read");

-- CreateIndex
CREATE INDEX "Notification_userId_cleared_createdAt_idx" ON "Notification"("userId", "cleared", "createdAt");

-- CreateIndex
CREATE INDEX "DiscoveryTrack_trackId_idx" ON "DiscoveryTrack"("trackId");
