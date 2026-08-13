-- ApiKey.key was stored plaintext -- a DB read or a leaked backup handed
-- over a working, usable credential with no cracking step at all, unlike
-- User.passwordHash (bcrypt) or the 2FA secret (AES-256-CBC via
-- utils/encryption.ts). An API key is 256 bits of server-generated random
-- data, not a low-entropy human-chosen password, so bcrypt is the wrong
-- primitive here: its salting exists to defeat a dictionary attack and to
-- stop two equal secrets from hashing equal, neither of which is a risk for
-- a value with no dictionary and never reused. Salting would also cost the
-- O(1) index lookup every auth request on this path needs -- a bcrypt
-- comparison can't be looked up by index, it has to scan and compare every
-- row. A deterministic SHA-256 digest keeps the lookup an index hit (see
-- apiKeyStore.ts's `hashApiKey`) while making the stored value as useless to
-- a DB/backup leak as a proper password hash: irreversible, and a rainbow
-- table over a 256-bit random space is not a real attack.
--
-- Existing keys are re-keyed IN PLACE, not invalidated: they are plaintext
-- in this column right up until the UPDATE below runs, so this migration
-- has the one input it needs (the real value) to compute the same digest
-- `hashApiKey` computes at issue time -- there's no reason to force every
-- device/Subsonic client to re-pair over this.
--
-- RENAME (not drop+add) preserves the column's data, its UNIQUE constraint,
-- and its plain index across the change -- Postgres carries all three
-- through a column rename automatically; only their SQL names need
-- following, so `prisma migrate diff` sees exactly what this file did.
ALTER TABLE "ApiKey" RENAME COLUMN "key" TO "keyHash";
ALTER INDEX "ApiKey_key_key" RENAME TO "ApiKey_keyHash_key";
ALTER INDEX "ApiKey_key_idx" RENAME TO "ApiKey_keyHash_idx";

-- pgcrypto's digest() is what computes the hash server-side; already used
-- nowhere else in this schema, so this is the first migration to need it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Re-key every existing row: the column still holds the real plaintext key
-- at this point (only its NAME changed above), so this overwrites it with
-- SHA-256(plaintext) -- byte-identical to what `hashApiKey` (Node's
-- crypto.createHash("sha256")) computes for the same input, since a
-- generated key is a pure hex string (ASCII, no multi-byte characters), so
-- there is no encoding question between Postgres's UTF-8 text->bytea cast
-- and Node's default UTF-8 string encoding to land on the same digest.
UPDATE "ApiKey" SET "keyHash" = encode(digest("keyHash", 'sha256'), 'hex');
