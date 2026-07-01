-- OIDC / SSO support (Authorization Code + PKCE).
-- User identity link:
ALTER TABLE "User" ADD COLUMN "oidcSub" TEXT;
CREATE UNIQUE INDEX "User_oidcSub_key" ON "User"("oidcSub");

-- Provider config (clientSecret stored encrypted by the app layer):
ALTER TABLE "SystemSettings" ADD COLUMN "oidcEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN "oidcProviderName" TEXT DEFAULT 'SSO';
ALTER TABLE "SystemSettings" ADD COLUMN "oidcIssuer" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "oidcClientId" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "oidcClientSecret" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "oidcScopes" TEXT DEFAULT 'openid profile email';
ALTER TABLE "SystemSettings" ADD COLUMN "oidcRoleClaim" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "oidcAdminValue" TEXT;

-- Email for OIDC account linking:
ALTER TABLE "User" ADD COLUMN "email" TEXT;
