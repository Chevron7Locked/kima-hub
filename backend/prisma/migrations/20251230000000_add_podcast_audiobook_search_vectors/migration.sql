-- Migration: Add search vector triggers for podcasts and audiobooks
-- This migration creates PostgreSQL functions and triggers to automatically
-- populate and maintain search vectors for podcast and audiobook content

-- ============================================================================
-- PODCAST SEARCH VECTOR FUNCTION
-- ============================================================================
-- Function to generate Podcast search vector from title, author, and description
CREATE OR REPLACE FUNCTION podcast_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  -- Combine title, author, and description into search vector
  -- Using setweight: title (A), author (B), description (C)
  NEW."searchVector" := 
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.author, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
  
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update Podcast search vector
DROP TRIGGER IF EXISTS podcast_search_vector_update ON "Podcast";
CREATE TRIGGER podcast_search_vector_update
  BEFORE INSERT OR UPDATE OF title, author, description
  ON "Podcast"
  FOR EACH ROW
  EXECUTE FUNCTION podcast_search_vector_trigger();

-- ============================================================================
-- PODCAST EPISODE SEARCH VECTOR FUNCTION
-- ============================================================================
-- Function to generate PodcastEpisode search vector from title and description
CREATE OR REPLACE FUNCTION podcast_episode_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  -- Combine title and description into search vector
  -- Using setweight: title (A), description (B)
  NEW."searchVector" := 
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
  
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update PodcastEpisode search vector
DROP TRIGGER IF EXISTS podcast_episode_search_vector_update ON "PodcastEpisode";
CREATE TRIGGER podcast_episode_search_vector_update
  BEFORE INSERT OR UPDATE OF title, description
  ON "PodcastEpisode"
  FOR EACH ROW
  EXECUTE FUNCTION podcast_episode_search_vector_trigger();

-- ============================================================================
-- AUDIOBOOK SEARCH VECTOR FUNCTION
-- ============================================================================
-- Function to generate Audiobook search vector from title, author, narrator, series, and description
CREATE OR REPLACE FUNCTION audiobook_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  -- Combine title, author/narrator/series, and description into search vector
  -- Using setweight: title (A), author/narrator/series (B), description (C)
  NEW."searchVector" := 
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.author, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.narrator, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.series, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
  
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update Audiobook search vector
DROP TRIGGER IF EXISTS audiobook_search_vector_update ON "Audiobook";
CREATE TRIGGER audiobook_search_vector_update
  BEFORE INSERT OR UPDATE OF title, author, narrator, series, description
  ON "Audiobook"
  FOR EACH ROW
  EXECUTE FUNCTION audiobook_search_vector_trigger();

-- ============================================================================
-- ADD SEARCH VECTOR COLUMNS
-- ============================================================================
-- Add searchVector column to Podcast table
ALTER TABLE "Podcast" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

-- Add searchVector column to PodcastEpisode table
ALTER TABLE "PodcastEpisode" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

-- Add searchVector column to Audiobook table
ALTER TABLE "Audiobook" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

-- ============================================================================
-- CREATE GIN INDEXES
-- ============================================================================
-- Create GIN index on Podcast search vector
CREATE INDEX IF NOT EXISTS "Podcast_searchVector_idx" ON "Podcast" USING GIN ("searchVector");

-- Create GIN index on PodcastEpisode search vector
CREATE INDEX IF NOT EXISTS "PodcastEpisode_searchVector_idx" ON "PodcastEpisode" USING GIN ("searchVector");

-- Create GIN index on Audiobook search vector
CREATE INDEX IF NOT EXISTS "Audiobook_searchVector_idx" ON "Audiobook" USING GIN ("searchVector");

-- ============================================================================
-- POPULATE EXISTING RECORDS
-- ============================================================================
-- Update all existing Podcasts to populate their search vectors
UPDATE "Podcast"
SET "searchVector" = 
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(author, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'C');

-- Update all existing PodcastEpisodes to populate their search vectors
UPDATE "PodcastEpisode"
SET "searchVector" = 
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'B');

-- Update all existing Audiobooks to populate their search vectors
UPDATE "Audiobook"
SET "searchVector" = 
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(author, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(narrator, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(series, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'C');
