# Security

How Kima protects accounts and stored credentials, and what to do when you open it to the internet.

## Secrets

Kima needs two secrets: one that signs sessions and login tokens (`SESSION_SECRET`, at least 32 characters) and one that encrypts the credentials you save in Settings (`SETTINGS_ENCRYPTION_KEY`).

- The all-in-one image creates both on first start and keeps them in `/data/secrets/`. Back up `/data`. If the encryption key is lost, the saved credentials (Lidarr, Audiobookshelf, Soulseek and the like) cannot be read and you have to enter them again.
- The split stack reads them from your `.env` file. Make each with `openssl rand -base64 32`.
- Never commit a `.env` file, and never change the encryption key on an install that already has saved credentials.
- Kima refuses to start with a missing encryption key or the placeholder `default-encryption-key-change-me`. A key shorter than 32 characters starts with a warning.

Credentials saved in Settings are encrypted with XChaCha20-Poly1305. API keys you create are stored only as SHA-256 hashes; the plain key is shown once, when it is created.

## Accounts and sessions

- The first account created becomes the administrator. After that, accounts are created by an administrator in Settings under Users.
- Passwords are at least 6 characters. Hashes are stored with bcrypt.
- Login tokens last 24 hours. A refresh token lasts 30 days, and the app renews the login token with it automatically.
- The session cookie is `httpOnly` and `sameSite=lax`. It is marked `secure` only when `SECURE_COOKIES=true`, so set that when you serve Kima over HTTPS. A session lasts 7 days.
- Changing a password signs that account out everywhere else.
- Failed logins are limited to 20 per 15 minutes per address. Successful logins are not counted.
- An account can turn on two-factor authentication with an authenticator app. Kima shows 10 recovery codes once, when it is turned on.
- An administrator who is locked out can set `ADMIN_RESET_PASSWORD` and restart. See [configuration.md](configuration.md#common-options).

## API keys and client tokens

Scripts and other programs can sign in with an API key sent in an `X-API-Key` header. Create and revoke keys in Settings, under You > Apps. Subsonic clients can use one as well; see [subsonic.md](subsonic.md).

Audio streams that a player has to open by address use a short-lived ticket that works only for streaming, so the main login token does not have to appear in the address.

## Webhooks

Lidarr tells Kima when a download finishes by calling a webhook. Kima gives Lidarr a secret when you save the Lidarr settings and refuses webhook calls that do not carry it. Without a secret, webhook calls are accepted but rate-limited.

## Admin tools

The job queue dashboard (Bull Board) is at `/api/admin/queues` and requires a signed-in administrator.

## Putting Kima on the internet

Kima is built for a home network. If you open it to the internet:

1. Put a reverse proxy with HTTPS in front of port 3030 and publish no other port.
2. Set `SECURE_COOKIES=true`.
3. Set `ALLOWED_ORIGINS` to the address people use to open Kima.
4. Turn on two-factor authentication for administrator accounts.
5. Keep Kima updated; see [install.md](install.md#updating).

Kima trusts the proxy's forwarded address, so the login limit counts the real client address as long as your proxy sets it.

## Network use

Kima has no telemetry and sends nothing to its author. Apart from a daily update check against GitHub, which you can turn off, it contacts outside services only for features you use. The full list, and what is sent to each, is in [PRIVACY.md](../PRIVACY.md).
