/**
 * Soulseek client facade — conditionally routes to the slskd HTTP adapter
 * or the vendored P2P client based on the SLSKD_URL environment variable.
 *
 * When SLSKD_URL is set, all Soulseek operations are routed through slskd's
 * REST API (the SlskdClient class). Otherwise, the original P2P client is
 * used for direct Soulseek network connections.
 *
 * Both backends must satisfy ISlskClient — the explicit public surface that
 * SoulseekService depends on. The `_p2p`/`_slskd` assignments below are a
 * compile-time proof of that contract: if either backend drifts from the
 * interface (an upstream change to the P2P client, or a missed method on the
 * adapter), the build fails HERE rather than breaking silently at runtime.
 * This replaces the previous `as unknown as typeof P2PClient` cast, which
 * bypassed type checking entirely.
 */

import type { EventEmitter } from 'events'
import { SlskClient as P2PClient } from './p2p-client'
import { SlskdClient } from './slskd-client'
import type { Download } from './downloads'
import type { FileSearchResponse } from './messages/from/peer'

/** Options accepted by a Soulseek search (shared by both backends). */
export interface SlskSearchOptions {
  timeout?: number
  onResult?: (result: FileSearchResponse) => void
  maxResponses?: number
}

/** Minimal surface of the server connection that SoulseekService reads. */
export interface SlskServerConn {
  once(event: string, listener: (...args: any[]) => void): unknown
  readonly destroyed: boolean
  readonly writable: boolean
}

/**
 * The exact public surface SoulseekService depends on. Both the vendored
 * P2P client and the slskd HTTP adapter implement this. Kept deliberately
 * minimal — only what SoulseekService actually calls — so the two backends
 * stay interchangeable.
 */
export interface ISlskClient extends EventEmitter {
  loggedIn: boolean
  downloads: Download[]
  server: { conn: SlskServerConn }
  login(username: string, password: string, timeout?: number): Promise<void>
  search(query: string, opts?: SlskSearchOptions): Promise<FileSearchResponse[]>
  download(username: string, filename: string, receivedBytes?: bigint | number): Promise<Download>
  removeDownload(download: Download): void
  destroy(): void
}

// Compile-time contract guard. Each assignment forces TS to verify that the
// backend's instances satisfy ISlskClient; a drift produces an error at the
// specific line, so diagnostics point straight at the offending backend.
const _p2p: new () => ISlskClient = P2PClient
const _slskd: new () => ISlskClient = SlskdClient

// Select the backend by environment. The return type is the interface, not a
// concrete class, so consumers depend only on the shared contract.
export const SlskClient: new () => ISlskClient = process.env.SLSKD_URL ? _slskd : _p2p

// Re-export the client events type from the P2P client for type compatibility.
export type { SlskClientEvents, SlskPeersEvents } from './p2p-client'
