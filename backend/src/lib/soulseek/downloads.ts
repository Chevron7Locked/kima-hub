import type stream from 'stream'
import type TypedEventEmitter from 'typed-emitter'

import type { DistributiveOmit } from './utils/types'
import { distributiveOmit } from './utils/types'

export type Download =
  | RequestedDownload
  | QueuedDownload
  | ConnectedDownload
  | DownloadingDownload
  | CompleteDownload
  | DeniedDownload

type SlskDownloadEvents = {
  status: (status: Download['status'], data: DownloadStatusData) => void
  data?: (data: Buffer) => void
  progress?: (metadata: { totalBytes: bigint; receivedBytes: bigint; progress: number }) => void
  complete?: (receivedBytes: bigint) => void
  error?: (error: Error) => void
}
export type SlskDownloadEventEmitter = TypedEventEmitter<SlskDownloadEvents>

export type RequestedDownload = {
  status: 'requested'
  username: string
  filename: string
  receivedBytes: bigint
  stream: stream.PassThrough
  events: SlskDownloadEventEmitter
  requestQueuePosition: () => void
}

type QueuedDownload = Omit<RequestedDownload, 'status'> & {
  status: 'queued'
  queuePosition: number
}

export type ConnectedDownload = Omit<QueuedDownload, 'status'> & {
  status: 'connected'
  token: string
  totalBytes: bigint
}

export type DownloadingDownload = Omit<ConnectedDownload, 'status'> & {
  status: 'downloading'
}

export type CompleteDownload = Omit<DownloadingDownload, 'status'> & {
  status: 'complete'
}

type DeniedDownload = Omit<RequestedDownload, 'status'> & {
  status: 'denied'
  reason: string
}

export type DownloadWithToken = ConnectedDownload | DownloadingDownload | CompleteDownload

export type DownloadStatusData = DistributiveOmit<
  Download,
  'stream' | 'events' | 'requestQueuePosition'
>

export const makeDownloadStatusData = <T extends Download>(obj: T): DownloadStatusData =>
  distributiveOmit(obj, ['stream', 'events', 'requestQueuePosition'])
