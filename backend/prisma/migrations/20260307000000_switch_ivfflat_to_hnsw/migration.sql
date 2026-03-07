-- Switch from IVFFlat to HNSW for track embeddings
-- IVFFlat degrades after bulk inserts without REINDEX; HNSW does not.
-- pgvector 0.5.0+ supports HNSW (we have 0.8.2).

DROP INDEX IF EXISTS "track_embeddings_embedding_idx";

CREATE INDEX "track_embeddings_embedding_idx" ON "track_embeddings"
    USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 200);
