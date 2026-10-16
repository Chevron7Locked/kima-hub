-- Audio analysis and sound vectors run one after the other unless an admin turns this on.
ALTER TABLE "SystemSettings" ADD COLUMN "analysisAndVectorsTogether" BOOLEAN NOT NULL DEFAULT false;
