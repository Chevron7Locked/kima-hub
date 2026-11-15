-- The newest 30-second step of a two-factor code a person has used: a code from that step or an earlier one is refused.
ALTER TABLE "User" ADD COLUMN "twoFactorLastStep" INTEGER NOT NULL DEFAULT 0;
