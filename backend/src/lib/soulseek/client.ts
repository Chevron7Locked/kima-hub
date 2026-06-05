/**
 * Soulseek client facade — conditionally routes to the slskd HTTP adapter
 * or the vendored P2P client based on the SLSKD_URL environment variable.
 *
 * When SLSKD_URL is set, all Soulseek operations are routed through slskd's
 * REST API (the SlskdClient class). Otherwise, the original P2P client is
 * used for direct Soulseek network connections.
 */

import { SlskClient as P2PClient } from './p2p-client'
import { SlskdClient } from './slskd-client'

// Re-export the correct implementation based on environment.
// Both classes expose the same public surface that SoulseekService depends on:
// login, search, download, removeDownload, destroy, server.conn, loggedIn, downloads.
// Cast to P2PClient type so consumers see a single type — the runtime signatures match.
export const SlskClient: typeof P2PClient = process.env.SLSKD_URL
  ? SlskdClient as unknown as typeof P2PClient
  : P2PClient

// Re-export the client events type from the P2P client for type compatibility
export type { SlskClientEvents, SlskPeersEvents } from './p2p-client'
