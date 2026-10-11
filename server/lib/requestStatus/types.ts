// Per-episode request status ("where is my show?").
//
// Seerr's own media status only says Pending / Processing / Available, and its
// download tracker only carries Sonarr queue rows. This module builds a
// per-episode picture for one series from Sonarr (stock APIs, optionally
// enriched by the fast-start Sonarr fork) and rolls it up per season and for
// the whole request. GET /api/v1/tv/:tmdbId/status returns SeriesRequestStatus.

/**
 * Where one episode is on its way into the library. Ordered roughly from
 * "done" to "nothing happening yet".
 */
export type EpisodeState =
  | 'available' // file on disk (Sonarr hasFile)
  | 'importing' // download finished, Sonarr is importing it
  | 'downloading' // in the download client with progress
  | 'grabbed' // release sent to the download client, not moving yet (queued/paused/delayed)
  | 'searching' // an indexer search covering this episode is running right now
  | 'search_queued' // a search covering this episode is queued, or running but not at it yet
  | 'not_found' // searched, nothing suitable was grabbed
  | 'failed' // download failed, or downloaded but import is blocked
  | 'wanted' // monitored and missing, no search has run yet
  | 'unaired'; // air date in the future

export const EPISODE_STATES: EpisodeState[] = [
  'available',
  'importing',
  'downloading',
  'grabbed',
  'searching',
  'search_queued',
  'not_found',
  'failed',
  'wanted',
  'unaired',
];

/** Machine-readable reason codes, the UI maps them to icons/short text. */
export type ReasonCode =
  // why nothing was grabbed
  | 'no_releases' // indexers returned nothing
  | 'no_suitable_release' // stock Sonarr: searched, nothing grabbed, reason unknown
  | 'custom_format' // rejected by custom format score (e.g. "Foreign subs or dubs")
  | 'quality' // quality not wanted by the profile
  | 'size' // too small / too large
  | 'packs_only' // only season packs / full-series bundles that could not be used
  | 'blocklisted' // only blocklisted releases
  | 'seeders' // not enough seeders
  | 'unparsable' // release names could not be matched to the episode
  | 'already_queued' // a better or equal release is already queued / on disk
  // download problems
  | 'download_failed'
  | 'import_blocked'
  | 'stalled'
  | 'delayed' // delay profile holding the release
  | 'client_unavailable'
  | 'paused'
  | 'not_in_client' // grabbed but no longer in the download queue
  // nothing happened yet
  | 'not_searched_yet'
  | 'other';

export interface StatusReason {
  code: ReasonCode;
  /** One short human sentence, already in English. */
  message: string;
  /** Optional extra lines, e.g. "12 releases rejected: Foreign subs or dubs". */
  details?: string[];
}

export interface EpisodeStatus {
  sonarrEpisodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number | null;
  title?: string | null;
  airDateUtc?: string | null;
  state: EpisodeState;
  /**
   * 0..1 share of this episode that is "in" (downloaded or available). Feeds
   * the season / request percentages. 1 for available and importing.
   */
  progress: number;
  /** Download fraction 0..1 while there is a download, else null. */
  downloadProgress: number | null;
  /**
   * 'file' when downloadProgress is this episode's own file (fast-start fork,
   * qBittorrent per-file progress); 'release' when it is the whole release
   * (stock Sonarr reports one size for a multi-episode pack).
   */
  progressScope: 'file' | 'release' | null;
  sizeBytes: number | null;
  sizeLeftBytes: number | null;
  etaSeconds: number | null;
  releaseTitle: string | null;
  downloadId: string | null;
  reason: StatusReason | null;
  lastSearchAt: string | null;
  /** Short status line for the row, e.g. "Searching indexers now". */
  detail: string | null;
}

export interface StatusRollup {
  /** Number of requested episodes in scope (unaired excluded). */
  total: number;
  /** 0..100, integer. Share of requested aired episodes downloaded or available. */
  percent: number;
  available: number;
  counts: Record<EpisodeState, number>;
  /** Summary state: the most "active" state present (see summaryState). */
  state: EpisodeState | 'empty';
  /** Seconds until every active download in scope is done, null if unknown. */
  etaSeconds: number | null;
  /** Bytes of the downloads in scope (deduplicated per release / file). */
  bytesTotal: number;
  bytesLeft: number;
}

export interface SeasonStatus extends StatusRollup {
  seasonNumber: number;
}

export interface SearchActivity {
  /** Sonarr command name, e.g. MissingEpisodeSearch. */
  command: string;
  status: 'queued' | 'started';
  /** Sonarr's progress message, e.g. "Searching indexers for [Naruto : S01E40 (40)]". */
  message: string | null;
  startedAt: string | null;
}

export type RequestStatusSource = 'sonarr' | 'sonarr-faststart';

export interface SeriesRequestStatus {
  tmdbId: number;
  is4k: boolean;
  /** Seerr media status for this track (MediaStatus enum value), for context. */
  mediaStatus: number | null;
  /** 'awaiting_approval' when the request has not been approved yet. */
  phase: 'not_requested' | 'awaiting_approval' | 'in_sonarr' | 'unavailable';
  source: RequestStatusSource | null;
  sonarrSeriesId: number | null;
  generatedAt: string;
  /** Suggested poll interval for clients, in seconds. */
  refreshSeconds: number;
  overall: StatusRollup;
  seasons: SeasonStatus[];
  episodes: EpisodeStatus[];
  activity: SearchActivity[];
  /** Set when phase is 'unavailable' (Sonarr unreachable etc.). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Inputs (subset of the Sonarr v3 API shapes we read)
// ---------------------------------------------------------------------------

export interface SonarrEpisodeInput {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number | null;
  title?: string | null;
  airDateUtc?: string | null;
  hasFile: boolean;
  monitored: boolean;
  lastSearchTime?: string | null;
}

export interface SonarrStatusMessageInput {
  title?: string;
  messages?: string[];
}

/** GET /api/v3/queue/details?seriesId= row (one per episode of a release). */
export interface SonarrQueueInput {
  episodeId?: number | null;
  title?: string | null;
  size?: number | null;
  sizeleft?: number | null;
  timeleft?: string | null;
  estimatedCompletionTime?: string | null;
  /** queued | paused | downloading | completed | failed | warning | delay | downloadClientUnavailable | fallback | unknown */
  status?: string | null;
  /** downloading | importBlocked | importPending | importing | imported | failedPending | failed | ignored */
  trackedDownloadState?: string | null;
  /** ok | warning | error */
  trackedDownloadStatus?: string | null;
  statusMessages?: SonarrStatusMessageInput[] | null;
  errorMessage?: string | null;
  downloadId?: string | null;
}

/** GET /api/v3/command row. */
export interface SonarrCommandInput {
  name: string;
  /** queued | started | completed | failed | aborted | cancelled | orphaned */
  status: string;
  message?: string | null;
  started?: string | null;
  queued?: string | null;
  body?: {
    seriesId?: number | null;
    seriesIds?: number[] | null;
    seasonNumber?: number | null;
    episodeIds?: number[] | null;
  } | null;
}

/** GET /api/v3/history/series?seriesId= row. */
export interface SonarrHistoryInput {
  episodeId: number;
  /** grabbed | downloadFolderImported | downloadFailed | episodeFileDeleted | downloadIgnored | ... */
  eventType: string;
  date: string;
  sourceTitle?: string | null;
  downloadId?: string | null;
  data?: Record<string, string | null | undefined> | null;
}

// ---------------------------------------------------------------------------
// Fast-start Sonarr fork: GET /api/v3/faststart/status?seriesId=
// (spec: docs/request-status/sonarr-faststart-status-endpoint.md)
// ---------------------------------------------------------------------------

export interface FastStartFileInput {
  downloadId: string;
  releaseTitle?: string | null;
  fileIndex: number;
  fileName: string;
  sizeBytes: number;
  /** 0..1 from qBittorrent torrents/files `progress`. */
  progress: number;
  /** 0 = not downloaded (skipped). */
  priority: number;
  /** skipped | queued | downloading | complete | imported */
  state: string;
  etaSeconds?: number | null;
}

export interface FastStartSearchOutcomeInput {
  at: string;
  /** grabbed | no_releases | all_rejected | pending */
  outcome: string;
  releasesFound: number;
  releasesMatchingEpisode?: number;
  /** Rejections grouped into ReasonCode buckets, largest first. */
  rejections?: { code: ReasonCode; count: number; examples?: string[] }[];
  summary?: string | null;
}

export interface FastStartEpisodeInput {
  episodeId: number;
  files?: FastStartFileInput[];
  lastSearch?: FastStartSearchOutcomeInput | null;
  /** True while an indexer query covering this episode is in flight. */
  searchingNow?: boolean;
  /** True when this episode is part of a running/queued search that has not reached it yet. */
  searchQueued?: boolean;
}

export interface FastStartStatusInput {
  seriesId: number;
  generatedAt?: string;
  episodes: FastStartEpisodeInput[];
}

export interface SeriesStatusInputs {
  episodes: SonarrEpisodeInput[];
  queue: SonarrQueueInput[];
  commands: SonarrCommandInput[];
  history: SonarrHistoryInput[];
  sonarrSeriesId: number;
  /** Season numbers that were requested; null/empty = every monitored season (excluding specials). */
  requestedSeasons?: number[] | null;
  fastStart?: FastStartStatusInput | null;
}
