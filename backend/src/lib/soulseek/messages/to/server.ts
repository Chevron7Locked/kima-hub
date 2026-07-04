import crypto from 'crypto'

import type { ConnectionType, UserStatus } from '../common'
import { MessageBuilder } from '../message-builder'



export type Login = {
  username: string
  password: string
}

export type SetWaitPort = {
  port: number
}

export type GetPeerAddress = {
  username: string
}

export type WatchUser = {
  username: string
}

export type ConnectToPeer = {
  token: string
  username: string
  type: ConnectionType
}

export type FileSearch = {
  token: string
  query: string
}

export type SetStatus = {
  status: UserStatus
}

export type SharedFoldersFiles = {
  dirs: number
  files: number
}

export type HaveNoParents = {
  haveNoParents: boolean
}

export type SearchParent = {
  host: string
}

export type CantConnectToPeer = {
  token: string
  username: string
}

export const toServerMessage = {
  login: (msg: Login) =>
    new MessageBuilder()
      .int32(1)
      .str(msg.username)
      .str(msg.password)
      .int32(160)
      .str(
        crypto
          .createHash('md5')
          .update(msg.username + msg.password)
          .digest('hex')
      )
      .int32(17),
  setWaitPort: (msg: SetWaitPort) => new MessageBuilder().int32(2).int32(msg.port),
  getPeerAddress: (msg: GetPeerAddress) => new MessageBuilder().int32(3).str(msg.username),
  watchUser: (msg: WatchUser) => new MessageBuilder().int32(5).str(msg.username),
  connectToPeer: (msg: ConnectToPeer) =>
    new MessageBuilder().int32(18).rawHexStr(msg.token).str(msg.username).str(msg.type),
  fileSearch: (msg: FileSearch) =>
    new MessageBuilder().int32(26).rawHexStr(msg.token).str(msg.query),
  setStatus: (msg: SetStatus) => new MessageBuilder().int32(28).int32(msg.status),
  sharedFoldersFiles: (msg: SharedFoldersFiles) =>
    new MessageBuilder().int32(35).int32(msg.dirs).int32(msg.files),
  haveNoParents: (msg: HaveNoParents) =>
    new MessageBuilder().int32(71).int32(msg.haveNoParents ? 1 : 0),
  searchParent: (msg: SearchParent) => {
    const ip = msg.host
      .split('.')
      .map((x) => parseInt(x, 10))
      .reverse()
    return new MessageBuilder().int32(73).int8(ip[0]).int8(ip[1]).int8(ip[2]).int8(ip[3])
  },
  cantConnectToPeer: (msg: CantConnectToPeer) =>
    new MessageBuilder().int32(1001).rawHexStr(msg.token).str(msg.username),
}
