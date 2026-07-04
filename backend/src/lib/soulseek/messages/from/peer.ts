import * as zlib from 'zlib'
import { promisify } from 'util'

import type { FileAttribute } from '../common'
import { TransferDirection } from '../common'
import { MessageParser } from '../message-parser'

const MAX_DECOMPRESS_SIZE = 10 * 1024 * 1024 // 10 MB
const unzip = promisify(zlib.unzip)

export type FromPeerMessage = Awaited<ReturnType<(typeof fromPeerMessage)[keyof typeof fromPeerMessage]>>

export type SharedFileListRequest = {
  kind: 'sharedFileListRequest'
}

export type FileSearchResponse = {
  kind: 'fileSearchResponse'
  username: string
  token: string
  files: {
    filename: string
    size: bigint
    attrs: Map<FileAttribute, number>
  }[]
  slotsFree: boolean
  avgSpeed: number
  queueLength: number
}

export type TransferRequest = TransferRequestDownload | TransferRequestUpload
type TransferRequestDownload = {
  kind: 'transferRequest'
  direction: 0
  token: string
  filename: string
}
type TransferRequestUpload = {
  kind: 'transferRequest'
  direction: 1
  token: string
  filename: string
  size: bigint
}

export type TransferResponse =
  | {
      kind: 'transferResponse'
      token: string
      allowed: true
    }
  | {
      kind: 'transferResponse'
      token: string
      allowed: false
      reason: string
    }

export type PlaceInQueueResponse = {
  kind: 'placeInQueueResponse'
  filename: string
  place: number
}

export type UploadFailed = { kind: 'uploadFailed'; filename: string }

export type UploadDenied = {
  kind: 'uploadDenied'
  filename: string
  reason: string
}

const fromPeerMessage = {
  sharedFileListRequest: (): SharedFileListRequest => {
    return { kind: 'sharedFileListRequest' }
  },
  fileSearchResponse: async (msg_: MessageParser): Promise<FileSearchResponse> => {
    const content = msg_.data.slice(msg_.pointer)
    const buffer = await unzip(content, { maxOutputLength: MAX_DECOMPRESS_SIZE })

    const msg = new MessageParser(buffer)
    const username = msg.str()
    const token = msg.rawHexStr(4)

    const numResults = msg.int32()
    const results: FileSearchResponse['files'] = []
    for (let i = 0; i < numResults; i++) {
      msg.int8() // code
      const filename = msg.str()
      const size = msg.int64()
      msg.str() // ext
      const numAttrs = msg.int32()
      const attrs: FileSearchResponse['files'][number]['attrs'] = new Map()
      for (let attrib = 0; attrib < numAttrs; attrib++) {
        const attrType = msg.int32() as FileAttribute
        const attrValue = msg.int32()
        attrs.set(attrType, attrValue)
      }

      results.push({
        filename,
        size,
        attrs,
      })
    }
    const slotsFree = msg.int8()
    const avgSpeed = msg.int32()
    const queueLength = msg.int32()

    return {
      kind: 'fileSearchResponse',
      username,
      token,
      files: results,
      slotsFree: slotsFree > 0,
      avgSpeed,
      queueLength,
    }
  },
  transferRequest: (msg: MessageParser): TransferRequest => {
    const direction = msg.int32()
    const token = msg.rawHexStr(4)
    const filename = msg.str()

    if (direction === TransferDirection.Download) {
      return { kind: 'transferRequest', direction, token, filename }
    } else if (direction === TransferDirection.Upload) {
      const size = msg.int64()
      return { kind: 'transferRequest', direction, token, filename, size }
    } else {
      throw new Error(`Unknown transfer direction: ${direction}`)
    }
  },
  transferResponse: (msg: MessageParser): TransferResponse => {
    const token = msg.rawHexStr(4)
    const allowed = msg.int8()

    if (allowed === 0) {
      const reason = msg.str()
      return { kind: 'transferResponse', token, allowed: false, reason }
    } else {
      return { kind: 'transferResponse', token, allowed: true }
    }
  },
  placeInQueueResponse: (msg: MessageParser): PlaceInQueueResponse => {
    const filename = msg.str()
    const place = msg.int32()
    return { kind: 'placeInQueueResponse', filename, place }
  },
  uploadFailed: (msg: MessageParser): UploadFailed => {
    const filename = msg.str()
    return { kind: 'uploadFailed', filename }
  },
  uploadDenied: (msg: MessageParser): UploadDenied => {
    const filename = msg.str()
    const reason = msg.str()
    return { kind: 'uploadDenied', filename, reason }
  },
}

export const fromPeerMessageParser = async (msg: MessageParser) => {
  const size = msg.int32()
  if (size < 4) return

  const code = msg.int32()
  switch (code) {
    case 4:
      return fromPeerMessage.sharedFileListRequest()
    case 9:
      return fromPeerMessage.fileSearchResponse(msg)
    case 40:
      return fromPeerMessage.transferRequest(msg)
    case 41:
      return fromPeerMessage.transferResponse(msg)
    case 44:
      return fromPeerMessage.placeInQueueResponse(msg)
    case 46:
      return fromPeerMessage.uploadFailed(msg)
    case 50:
      return fromPeerMessage.uploadDenied(msg)
  }
}
