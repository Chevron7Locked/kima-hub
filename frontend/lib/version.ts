import packageJson from "../package.json";

// Base version from package.json
const BASE_VERSION = packageJson.version;

// A build that is not a tagged release says so in the UI, so a screenshot or a
// bug report carries the channel it came from. Set at build time via
// NEXT_PUBLIC_BUILD_TYPE:
//
//   "preview"  the on-demand pre-release channel, published to ghcr.io
//   "dev"      a locally built stack (docker-compose.yml defaults to this)
//
// A tagged release passes nothing, so it renders as a bare version number.
// Anything else passed through shows up verbatim rather than being swallowed --
// an unrecognised channel name is worth seeing, not hiding.
const BUILD_TYPE = process.env.NEXT_PUBLIC_BUILD_TYPE?.trim() || "";

export const APP_VERSION = BUILD_TYPE ? `${BASE_VERSION}-${BUILD_TYPE}` : BASE_VERSION;
