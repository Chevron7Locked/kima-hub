export interface LidarrAlbum {
  id: number;
  title: string;
  disambiguation?: string;
  overview?: string;
  artistId: number;
  foreignAlbumId: string;
  monitored: boolean;
  anyReleaseOk: boolean;
  profileId: number;
  duration: number;
  albumType: string;
  secondaryTypes: string[];
  mediumCount: number;
  ratings: {
    votes: number;
    value: number;
  };
  releaseDate: string;
  releases: LidarrRelease[];
  genres: string[];
  media: LidarrMedia[];
  artist?: LidarrArtist;
  links: LidarrLink[];
  images?: Array<{
    coverType: string;
    url: string;
    remoteUrl?: string;
  }>;
  statistics: {
    trackFileCount: number;
    trackCount: number;
    totalTrackCount: number;
    sizeOnDisk: number;
    percentOfTracks: number;
  };
  grabbed?: boolean;
}

export interface LidarrRelease {
  id: number;
  albumId: number;
  foreignReleaseId: string;
  title: string;
  status: string;
  duration: number;
  trackCount: number;
  media: LidarrMedia[];
  mediumCount: number;
  disambiguation?: string;
  country: string[];
  label: string[];
  format: string;
  monitored: boolean;
}

export interface LidarrMedia {
  mediumNumber: number;
  mediumName: string;
  mediumFormat: string;
}

export interface LidarrTrack {
  id: number;
  albumId: number;
  title: string;
  trackNumber?: number | string;
  absoluteTrackNumber?: number | string;
  position?: number | string;
  mediumNumber?: number;
  hasFile?: boolean;
  trackFileId?: number;
}

export interface LidarrArtist {
  id: number;
  foreignArtistId: string;
  artistName: string;
  nameSlug: string;
  overview?: string;
  genres: string[];
  links: LidarrLink[];
  monitored?: boolean;
  tags?: number[];
  artistType?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  statistics: {
    albumCount: number;
    trackFileCount: number;
    trackCount: number;
    totalTrackCount: number;
    sizeOnDisk: number;
    percentOfTracks: number;
  };
  ratings?: {
    votes: number;
    value: number;
  };
}

export interface LidarrLink {
  url: string;
  name: string;
}

export interface LidarrRootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace: number;
  totalSpace: number;
}

export interface LidarrQualityProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: Array<{
    id: number;
    name: string;
    quality?: {
      id: number;
      name: string;
    };
    allowed: boolean;
  }>;
}

export interface LidarrWebhookPayload {
  eventType: 'Grab' | 'Download' | 'AlbumDownload' | 'TrackRetag' | 'Rename' | 'ImportFailure';
  artist?: {
    id: number;
    name: string;
    mbId?: string;
  };
  album?: {
    id: number;
    title: string;
    mbId?: string;
  };
  release?: {
    id: number;
    title: string;
    mbId?: string;
  };
  downloadId?: string;
  albumId?: number;
  trackFiles?: Array<{
    id: number;
    path: string;
    quality: string;
  }>;
}

export interface LidarrAddAlbumRequest {
  foreignAlbumId: string;
  monitored: boolean;
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  addOptions: {
    searchForNewAlbum: boolean;
  };
  tags?: number[];
}

export interface LidarrAddArtistRequest {
  foreignArtistId: string;
  artistName: string;
  rootFolderPath: string;
  qualityProfileId: number;
  metadataProfileId: number;
  monitored: boolean;
  monitorNewItems: 'all' | 'none';
  addOptions: {
    monitor: string;
    searchForMissingAlbums: boolean;
  };
  tags?: number[];
}

export interface LidarrTag {
  id: number;
  label: string;
}

export interface LidarrQueueItem {
  id: number;
  title: string;
  status: string;
  downloadId: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  statusMessages: { title: string; messages: string[] }[];
  sizeleft?: number;
  size?: number;
}

export interface LidarrQueueResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: LidarrQueueItem[];
}

export interface LidarrHistoryRecord {
  id: number;
  albumId: number;
  downloadId: string;
  eventType: string;
  date: string;
  data: {
    droppedPath?: string;
    importedPath?: string;
  };
  album: {
    id: number;
    title: string;
    foreignAlbumId: string;
  };
  artist: {
    name: string;
  };
}

export interface LidarrHistoryResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: LidarrHistoryRecord[];
}
