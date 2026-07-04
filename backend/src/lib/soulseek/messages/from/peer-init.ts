import type { ConnectionType } from '../common'
import type { MessageParser } from '../message-parser'

export type FromPeerInitMessage = ReturnType<
  (typeof fromPeerInitMessage)[keyof typeof fromPeerInitMessage]
>

export type PierceFirewall = {
  kind: 'pierceFirewall'
  token: string
}

export type PeerInit = {
  kind: 'peerInit'
  username: string
  type: ConnectionType
  token: string
}

const fromPeerInitMessage = {
  pierceFirewall: (msg: MessageParser): PierceFirewall => {
    const token = msg.rawHexStr(4)
    return { kind: 'pierceFirewall', token }
  },
  peerInit: (msg: MessageParser): PeerInit => {
    const username = msg.str()
    const type = msg.str() as ConnectionType
    const token = msg.rawHexStr(4)
    return { kind: 'peerInit', username, type, token }
  },
}

export const fromPeerInitMessageParser = (msg: MessageParser) => {
  const size = msg.int32()
  if (size <= 4) return

  const code = msg.int8()
  switch (code) {
    case 0:
      return fromPeerInitMessage.pierceFirewall(msg)
    case 1:
      return fromPeerInitMessage.peerInit(msg)
  }
}
