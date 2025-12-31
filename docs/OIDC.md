# OIDC Authentication

Lidify supports Single Sign-On (SSO) using OIDC, allowing you to login with your existing identity provider.

## Supported Providers

Keycloak, Authentik, Authelia, Azure AD, Auth0, Okta, and any OIDC-compliant provider.

## Setup

### 1. Configure Your Provider

Add this callback URL to your OIDC provider:

```
http://localhost:3030/auth/callback        # Development
https://music.example.com/auth/callback    # Production
```

### 2. Configure Lidify

Add to your `docker-compose.yml`:

```yaml
environment:
  OIDC_PROVIDERS: keycloak:Keycloak SSO
  OIDC_KEYCLOAK_ISSUER: https://auth.example.com/realms/myrealm
  OIDC_KEYCLOAK_CLIENT_ID: lidify
  OIDC_KEYCLOAK_CLIENT_SECRET: your-secret-here
```

### 3. Restart

> :warning: **Users with matching usernames will login to existing accounts.**

```bash
docker-compose restart
```

## Configuration Options

| Variable | Description |
|----------|-------------|
| `OIDC_PROVIDERS` | List of `id:name` pairs (comma-separated) |
| `OIDC_<ID>_ISSUER` | Provider URL |
| `OIDC_<ID>_CLIENT_ID` | OAuth client ID |
| `OIDC_<ID>_CLIENT_SECRET` | OAuth client secret |
| `OIDC_<ID>_ROLE_FIELD` | OIDC claim field for roles (optional) |
| `DISABLE_CREDENTIALS_PROVIDER` | Set to `true` to hide username/password login |

Replace `<ID>` with your provider ID in UPPERCASE (e.g., `KEYCLOAK`).

## Role Mapping

By default, OIDC users get the "user" role. To assign roles from your OIDC provider:

```yaml
OIDC_KEYCLOAK_ROLE_FIELD: roles
```

Common values (top-level claims only; nested paths like `realm_access.roles` or `resource_access.lidify.roles` are not currently supported directly and must be mapped to a top-level claim in your provider):
- `roles` - Simple roles claim
- `groups` - Groups/AD groups
  Your OIDC provider must include this top-level field in its userinfo response.

Your OIDC provider must include this field in its userinfo response.

## Multiple Providers

```yaml
OIDC_PROVIDERS: keycloak:Company SSO,authentik:Partner SSO
OIDC_KEYCLOAK_ISSUER: https://keycloak.example.com/realms/master
OIDC_KEYCLOAK_CLIENT_ID: lidify
OIDC_KEYCLOAK_CLIENT_SECRET: secret1
OIDC_AUTHENTIK_ISSUER: https://auth.partner.com/application/o/lidify
OIDC_AUTHENTIK_CLIENT_ID: lidify
OIDC_AUTHENTIK_CLIENT_SECRET: secret2
```

## Provider Examples

### Keycloak

1. Create client with:
   - Client ID: `lidify`
   - Access Type: `confidential`
   - Valid Redirect URIs: `http://localhost:3030/auth/callback*`
   - Standard Flow: Enabled

2. Copy client secret from Credentials tab

3. Issuer URL: `https://keycloak.example.com/realms/your-realm`

### Azure AD

1. Register app as "Single-page application"
2. Set redirect URI: `http://localhost:3030/auth/callback`
3. Add permissions: `openid`, `profile`, `email`
4. Create client secret
5. Issuer URL: `https://login.microsoftonline.com/{TENANT_ID}/v2.0`

### Authentik

1. Create OAuth2/OpenID Provider
2. Set redirect URI: `http://localhost:3030/auth/callback`
3. Copy client ID and secret
4. Issuer URL: `https://authentik.example.com/application/o/lidify/`

## Troubleshooting

**Login loops**: Check backend logs and verify the issuer URL exactly matches your provider’s configuration (including whether it requires a trailing slash; e.g. Authentik does)

**"No authorization code"**: Verify callback URL matches exactly in provider config

**"code_verifier mismatch"**: Clear browser localStorage and try again

**"No field for role"**: Either remove `ROLE_FIELD` or add the claim to your OIDC provider

**Backend logs**: `docker-compose logs -f backend`

## Migration from Password Login

1. Add OIDC config (keep credentials enabled)
2. Test OIDC login works
3. Set `DISABLE_CREDENTIALS_PROVIDER=true`
4. Restart
