import type { ConnectionType, FileAttribute } from '../common'
import { TransferDirection } from '../common'
import { MessageBuilder } from '../message-builder'

type ToPeerMessage = Parameters<(typeof toPeerMessage)[keyof typeof toPeerMessage]>[0]

export type PierceFirewall = {
  token: string
}

export type PeerInit = {
  username: string
  type: ConnectionType
  token: string
}

export type SharedFileListResponse = {
  dirs: {
    name: string
    files: {
      filename: string
      size: number | bigint
      extension: string
      attrs: Map<FileAttribute, number>
    }[]
  }[]
}

export type FileSearchResponse = {
  username: string
  token: string
  results: {
    filename: string
    size: number | bigint
    extension: string
    attrs: Map<FileAttribute, number>
  }[]
  slotsFree: number
  avgSpeed: number
  queueLength: number
}

export type TransferRequest =
  | {
      direction: 0
      token: string
      filename: string
    }
  | {
      direction: 1
      token: string
      filename: string
      size: number | bigint
    }

export type TransferResponse =
  | {
      token: string
      allowed: true
    }
  | {
      token: string
      allowed: false
      reason: string
    }

export type QueueUpload = {
  filename: string
}

export type PlaceInQueueRequest = {
  filename: string
}

export const toPeerMessage = {
  pierceFirewall: (msg: PierceFirewall) => new MessageBuilder().int8(0).rawHexStr(msg.token),
  peerInit: (msg: PeerInit) =>
    new MessageBuilder().int8(1).str(msg.username).str(msg.type).rawHexStr(msg.token),
  sharedFileListResponse: (msg: SharedFileListResponse) => {
    const builder = new MessageBuilder().int32(5).int32(msg.dirs.length)
    for (let i = 0; i < msg.dirs.length; i++) {
      const dir = msg.dirs[i]

      builder.str(dir.name).int32(dir.files.length)

      for (let j = 0; j < dir.files.length; j++) {
        const file = dir.files[j]
        const attrs = [...file.attrs.entries()]

        builder.int8(1).str(file.filename).int64(file.size).str(file.extension).int32(attrs.length)

        for (let k = 0; k < attrs.length; k++) {
          const [key, value] = attrs[k]
          builder.int32(key).int32(value)
        }
      }
    }

    return builder
  },
  fileSearchResponse: (msg: FileSearchResponse) => {
    const builder = new MessageBuilder()
      .int32(9)
      .str(msg.username)
      .rawHexStr(msg.token)
      .int32(msg.results.length)

    for (let i = 0; i < msg.results.length; i++) {
      const result = msg.results[i]
      const attrs = [...result.attrs.entries()]

      builder
        .int8(1)
        .str(result.filename)
        .int64(result.size)
        .str(result.extension)
        .int32(attrs.length)

      for (let j = 0; j < attrs.length; j++) {
        const [key, value] = attrs[j]
        builder.int32(key).int32(value)
      }
    }

    builder.int8(msg.slotsFree).int32(msg.avgSpeed).int32(msg.queueLength)

    return builder
  },
  transferRequest: (msg: TransferRequest) => {
    const builder = new MessageBuilder()
      .int32(40)
      .int32(msg.direction)
      .rawHexStr(msg.token)
      .str(msg.filename)

    if (msg.direction === TransferDirection.Upload) {
      builder.int64(msg.size)
    }

    return builder
  },
  transferResponse: (msg: TransferResponse) => {
    const builder = new MessageBuilder()
      .int32(41)
      .rawHexStr(msg.token)
      .int8(msg.allowed ? 1 : 0)

    if (!msg.allowed) {
      builder.str(msg.reason)
    }

    return builder
  },
  queueUpload: (msg: QueueUpload) => new MessageBuilder().int32(43).str(msg.filename),
  placeInQueueRequest: (msg: PlaceInQueueRequest) =>
    new MessageBuilder().int32(51).str(msg.filename),
}
