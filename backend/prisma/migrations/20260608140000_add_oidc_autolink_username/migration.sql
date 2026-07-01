-- Toggle: auto-link an OIDC login to an existing local account by username.
-- Safe only when the IdP doesn't allow arbitrary self-chosen usernames.
ALTER TABLE "SystemSettings"
  ADD COLUMN "oidcAutoLinkByUsername" BOOLEAN NOT NULL DEFAULT true;
