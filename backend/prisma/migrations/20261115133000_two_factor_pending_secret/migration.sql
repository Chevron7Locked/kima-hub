-- The secret a person is setting up two-factor with, kept (encrypted) until they prove a code from it, and when it was made.
ALTER TABLE "User" ADD COLUMN "twoFactorPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "twoFactorPendingAt" TIMESTAMP(3);
