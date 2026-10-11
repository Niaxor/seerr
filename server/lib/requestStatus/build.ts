// Pure functions that turn Sonarr data into per-episode / per-season / overall
// request status. No I/O here so the rules can be unit tested.

import type {
  EpisodeState,
  EpisodeStatus,
  FastStartEpisodeInput,
  ReasonCode,
  SearchActivity,
  SeasonStatus,
  SeriesStatusInputs,
  SonarrCommandInput,
  SonarrEpisodeInput,
  SonarrHistoryInput,
  SonarrQueueInput,
  StatusReason,
  StatusRollup,
} from './types';
import { EPISODE_STATES } from './types';

const SEARCH_COMMANDS = new Set([
  'EpisodeSearch',
  'SeasonSearch',
  'SeriesSearch',
  'MissingEpisodeSearch',
]);

const ACTIVE_COMMAND_STATUSES = new Set(['queued', 'started']);

/** Most "active" first; used for the summary state of a season / request. */
const SUMMARY_PRIORITY: EpisodeState[] = [
  'downloading',
  'importing',
  'searching',
  'grabbed',
  'search_queued',
  'failed',
  'not_found',
  'wanted',
  'unaired',
  'available',
];

const toTime = (iso?: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Sonarr serialises TimeSpan as "hh:mm:ss" or "d.hh:mm:ss" (optionally with
 * fractional seconds). Returns seconds or null.
 */
export const parseTimeLeft = (value?: string | null): number | null => {
  if (!value) return null;
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(
    value.trim()
  );
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
};

export interface SearchTarget {
  /** Whole series (bundle search) */
  all?: boolean;
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
}

/**
 * Parses Sonarr's search progress message, e.g.
 * "Searching indexers for [Naruto : S01E40 (40)]. 1 active indexers"
 * "Searching indexers for [Ted Lasso : S02]. 2 active indexers"
 * "Searching indexers for [Naruto] Series bundles (Naruto Complete, ...)" (fast-start fork)
 * Formats from Sonarr IndexerSearch/Definitions/*SearchCriteria.ToString().
 */
export const parseSearchTarget = (
  message?: string | null
): SearchTarget | null => {
  if (!message || !message.startsWith('Searching indexers for')) return null;
  if (/\] Series bundles/.test(message)) return { all: true };
  const match = / : S(\d{2,})(?:E(\d{2,}))?(?: \((\d+)\))?\]/.exec(message);
  if (!match) return null;
  return {
    seasonNumber: Number(match[1]),
    episodeNumber: match[2] !== undefined ? Number(match[2]) : undefined,
    absoluteEpisodeNumber:
      match[3] !== undefined ? Number(match[3]) : undefined,
  };
};

const commandCovers = (
  command: SonarrCommandInput,
  episode: SonarrEpisodeInput,
  seriesId: number
): boolean => {
  const body = command.body ?? {};
  switch (command.name) {
    case 'EpisodeSearch':
      return (body.episodeIds ?? []).includes(episode.id);
    case 'SeasonSearch':
      return (
        body.seriesId === seriesId && body.seasonNumber === episode.seasonNumber
      );
    case 'SeriesSearch':
      return (
        body.seriesId === seriesId || (body.seriesIds ?? []).includes(seriesId)
      );
    case 'MissingEpisodeSearch':
      // seriesId null = every series
      return (
        (body.seriesId == null || body.seriesId === seriesId) &&
        episode.monitored &&
        !episode.hasFile
      );
    default:
      return false;
  }
};

const targetMatches = (
  target: SearchTarget,
  episode: SonarrEpisodeInput
): boolean => {
  if (target.all) return true;
  if (target.seasonNumber !== episode.seasonNumber) {
    // Anime episode criteria carry the absolute number too
    return (
      target.absoluteEpisodeNumber !== undefined &&
      target.absoluteEpisodeNumber === episode.absoluteEpisodeNumber
    );
  }
  if (target.episodeNumber === undefined) return true; // season-level query
  return target.episodeNumber === episode.episodeNumber;
};

const pickQueueRow = (
  rows: SonarrQueueInput[] | undefined
): SonarrQueueInput | null => {
  if (!rows || rows.length === 0) return null;
  // The row furthest along wins (importing > downloading > queued)
  const rank = (r: SonarrQueueInput) => {
    switch (r.trackedDownloadState) {
      case 'importing':
      case 'importPending':
        return 4;
      case 'importBlocked':
        return 3;
      case 'failed':
      case 'failedPending':
        return 0;
      default:
        return r.size && r.size > 0 ? 2 - (r.sizeleft ?? 0) / r.size : 1;
    }
  };
  return [...rows].sort((a, b) => rank(b) - rank(a))[0];
};

const statusMessageLines = (row: SonarrQueueInput): string[] => {
  const lines: string[] = [];
  for (const m of row.statusMessages ?? []) {
    for (const line of m.messages ?? []) {
      if (line) lines.push(line);
    }
    if ((!m.messages || m.messages.length === 0) && m.title) {
      lines.push(m.title);
    }
  }
  if (row.errorMessage) lines.push(row.errorMessage);
  return [...new Set(lines)];
};

const REASON_TEXT: Record<ReasonCode, string> = {
  no_releases: 'No releases found on the indexers',
  no_suitable_release: 'Searched, but no suitable release was found',
  custom_format: 'Only releases rejected by custom formats',
  quality: 'Only releases in unwanted qualities',
  size: 'Only releases of the wrong size',
  packs_only: 'Only season packs or bundles that could not be used',
  blocklisted: 'Only blocklisted releases',
  seeders: 'Only releases without enough seeders',
  unparsable: 'Releases found, but none matched this episode',
  already_queued: 'An equal or better release is already queued',
  download_failed: 'Download failed',
  import_blocked: 'Downloaded, but the import needs attention',
  stalled: 'Download is stalled',
  delayed: 'Waiting for the delay profile',
  client_unavailable: 'Download client unavailable',
  paused: 'Paused in the download client',
  not_in_client: 'Grabbed, but no longer in the download client',
  not_searched_yet: 'Waiting for the first search',
  other: 'Not found',
};

export const reasonText = (code: ReasonCode): string => REASON_TEXT[code];

const fastStartReason = (
  fs: FastStartEpisodeInput | undefined
): StatusReason | null => {
  const last = fs?.lastSearch;
  if (!last) return null;
  if (last.outcome === 'no_releases') {
    return {
      code: 'no_releases',
      message: last.summary ?? REASON_TEXT.no_releases,
    };
  }
  if (last.outcome === 'all_rejected') {
    const rejections = [...(last.rejections ?? [])].sort(
      (a, b) => b.count - a.count
    );
    const top = rejections[0];
    const code: ReasonCode = top?.code ?? 'other';
    return {
      code,
      message: last.summary ?? REASON_TEXT[code],
      details: rejections.map(
        (r) =>
          `${r.count} × ${REASON_TEXT[r.code] ?? r.code}${
            r.examples && r.examples.length > 0
              ? ` (${r.examples.join(', ')})`
              : ''
          }`
      ),
    };
  }
  return null;
};

interface FileProgress {
  fraction: number;
  sizeBytes: number;
  sizeLeftBytes: number;
  etaSeconds: number | null;
  allComplete: boolean;
  anyStarted: boolean;
  releaseTitle: string | null;
  downloadId: string | null;
}

const fastStartFileProgress = (
  fs: FastStartEpisodeInput | undefined
): FileProgress | null => {
  const files = (fs?.files ?? []).filter((f) => f.priority > 0);
  if (files.length === 0) return null;
  let size = 0;
  let done = 0;
  let eta: number | null = null;
  for (const f of files) {
    size += f.sizeBytes;
    done += f.sizeBytes * Math.min(Math.max(f.progress, 0), 1);
    if (typeof f.etaSeconds === 'number') {
      eta = Math.max(eta ?? 0, f.etaSeconds);
    }
  }
  return {
    fraction: size > 0 ? done / size : 0,
    sizeBytes: size,
    sizeLeftBytes: Math.max(size - done, 0),
    etaSeconds: eta,
    allComplete: files.every(
      (f) => f.progress >= 1 || f.state === 'complete' || f.state === 'imported'
    ),
    anyStarted: files.some((f) => f.progress > 0),
    releaseTitle: files[0].releaseTitle ?? null,
    downloadId: files[0].downloadId ?? null,
  };
};

const latestHistory = (
  rows: SonarrHistoryInput[] | undefined
): SonarrHistoryInput | null => {
  if (!rows || rows.length === 0) return null;
  return [...rows].sort(
    (a, b) => (toTime(b.date) ?? 0) - (toTime(a.date) ?? 0)
  )[0];
};

const blank = (
  episode: SonarrEpisodeInput
): Omit<EpisodeStatus, 'state' | 'progress'> => ({
  sonarrEpisodeId: episode.id,
  seasonNumber: episode.seasonNumber,
  episodeNumber: episode.episodeNumber,
  absoluteEpisodeNumber: episode.absoluteEpisodeNumber ?? null,
  title: episode.title ?? null,
  airDateUtc: episode.airDateUtc ?? null,
  downloadProgress: null,
  progressScope: null,
  sizeBytes: null,
  sizeLeftBytes: null,
  etaSeconds: null,
  releaseTitle: null,
  downloadId: null,
  reason: null,
  lastSearchAt: episode.lastSearchTime ?? null,
  detail: null,
});

interface EpisodeContext {
  now: number;
  seriesId: number;
  queueRows?: SonarrQueueInput[];
  history?: SonarrHistoryInput[];
  commands: SonarrCommandInput[];
  fastStart?: FastStartEpisodeInput;
}

/** Decides one episode's state. Order of the checks is the rule set. */
export const buildEpisodeStatus = (
  episode: SonarrEpisodeInput,
  ctx: EpisodeContext
): EpisodeStatus => {
  const base = blank(episode);

  // 1. On disk
  if (episode.hasFile) {
    return {
      ...base,
      state: 'available',
      progress: 1,
      downloadProgress: null,
      detail: null,
    };
  }

  const row = pickQueueRow(ctx.queueRows);
  const files = fastStartFileProgress(ctx.fastStart);

  // 2. In Sonarr's download queue
  if (row) {
    const size = row.size ?? 0;
    const left = Math.min(Math.max(row.sizeleft ?? 0, 0), size);
    const releaseFraction = size > 0 ? (size - left) / size : 0;
    const fraction = files ? files.fraction : releaseFraction;
    const eta =
      files?.etaSeconds ??
      parseTimeLeft(row.timeleft) ??
      (() => {
        const t = toTime(row.estimatedCompletionTime);
        return t !== null && t > ctx.now
          ? Math.round((t - ctx.now) / 1000)
          : null;
      })();
    const common = {
      ...base,
      downloadProgress: fraction,
      progressScope: files ? ('file' as const) : ('release' as const),
      sizeBytes: files ? files.sizeBytes : size || null,
      sizeLeftBytes: files ? files.sizeLeftBytes : size ? left : null,
      etaSeconds: eta,
      releaseTitle: row.title ?? files?.releaseTitle ?? null,
      downloadId: row.downloadId ?? files?.downloadId ?? null,
    };
    const lines = statusMessageLines(row);

    switch (row.trackedDownloadState) {
      case 'importPending':
      case 'importing':
        return {
          ...common,
          state: 'importing',
          progress: 1,
          downloadProgress: 1,
          etaSeconds: null,
          detail: 'Importing into the library',
        };
      case 'importBlocked':
        return {
          ...common,
          state: 'failed',
          progress: fraction,
          reason: {
            code: 'import_blocked',
            message: REASON_TEXT.import_blocked,
            details: lines,
          },
          detail: lines[0] ?? REASON_TEXT.import_blocked,
        };
      case 'failed':
      case 'failedPending':
        return {
          ...common,
          state: 'failed',
          progress: 0,
          etaSeconds: null,
          reason: {
            code: 'download_failed',
            message: REASON_TEXT.download_failed,
            details: lines,
          },
          detail: lines[0] ?? REASON_TEXT.download_failed,
        };
      default:
        break;
    }

    // Fast-start per-file: this episode's file finished, waiting for the
    // progressive import to pick it up.
    if (files && files.allComplete) {
      return {
        ...common,
        state: 'importing',
        progress: 1,
        downloadProgress: 1,
        etaSeconds: null,
        detail: 'Downloaded, importing',
      };
    }

    const status = (row.status ?? '').toLowerCase();
    if (status === 'delay') {
      return {
        ...common,
        state: 'grabbed',
        progress: 0,
        reason: { code: 'delayed', message: REASON_TEXT.delayed },
        detail: REASON_TEXT.delayed,
      };
    }
    if (status === 'downloadclientunavailable') {
      return {
        ...common,
        state: 'grabbed',
        progress: fraction,
        reason: {
          code: 'client_unavailable',
          message: REASON_TEXT.client_unavailable,
        },
        detail: REASON_TEXT.client_unavailable,
      };
    }
    if (status === 'paused') {
      return {
        ...common,
        state: 'grabbed',
        progress: fraction,
        reason: { code: 'paused', message: REASON_TEXT.paused },
        detail: REASON_TEXT.paused,
      };
    }

    const moving = files
      ? files.anyStarted
      : status === 'downloading' || releaseFraction > 0;
    const warning =
      row.trackedDownloadStatus === 'warning' || status === 'warning';

    if (!moving) {
      return {
        ...common,
        state: 'grabbed',
        progress: 0,
        reason: warning
          ? { code: 'stalled', message: REASON_TEXT.stalled, details: lines }
          : null,
        detail: files
          ? 'Queued in the bundle, earlier episodes first'
          : 'Waiting in the download client',
      };
    }

    return {
      ...common,
      state: 'downloading',
      progress: fraction,
      reason: warning
        ? { code: 'stalled', message: REASON_TEXT.stalled, details: lines }
        : null,
      detail: files ? null : 'Progress is for the whole release',
    };
  }

  // 3. Search running / queued
  const fs = ctx.fastStart;
  const lastSearch = toTime(episode.lastSearchTime);
  if (fs?.searchingNow) {
    return {
      ...base,
      state: 'searching',
      progress: 0,
      detail: 'Searching indexers now',
    };
  }
  if (fs?.searchQueued) {
    return {
      ...base,
      state: 'search_queued',
      progress: 0,
      detail: 'Queued for search',
    };
  }
  for (const command of ctx.commands) {
    if (!commandCovers(command, episode, ctx.seriesId)) continue;
    if (command.status === 'queued') {
      return {
        ...base,
        state: 'search_queued',
        progress: 0,
        detail: 'Queued for search',
      };
    }
    // started
    const startedAt = toTime(command.started);
    const searchedThisRun =
      lastSearch !== null && startedAt !== null && lastSearch >= startedAt;
    const target = parseSearchTarget(command.message);
    if (target) {
      if (targetMatches(target, episode)) {
        return {
          ...base,
          state: 'searching',
          progress: 0,
          detail: 'Searching indexers now',
        };
      }
      // Sonarr picks releases after each season's queries, so an earlier
      // episode of the season being searched is still waiting on the decision.
      if (searchedThisRun && target.seasonNumber === episode.seasonNumber) {
        return {
          ...base,
          state: 'searching',
          progress: 0,
          detail: 'Searched, choosing a release',
        };
      }
      if (!searchedThisRun) {
        return {
          ...base,
          state: 'search_queued',
          progress: 0,
          detail: 'Queued for search',
        };
      }
      // searched earlier in this run, fall through to the outcome rules
    } else if (!searchedThisRun) {
      return {
        ...base,
        state: 'searching',
        progress: 0,
        detail: 'Search running',
      };
    }
  }

  // 4. History (no queue row)
  const last = latestHistory(ctx.history);
  const lastEventAt = toTime(last?.date);
  if (last && last.eventType === 'downloadFailed') {
    if (lastSearch === null || (lastEventAt ?? 0) >= lastSearch) {
      const message = last.data?.message ?? undefined;
      return {
        ...base,
        state: 'failed',
        progress: 0,
        releaseTitle: last.sourceTitle ?? null,
        downloadId: last.downloadId ?? null,
        reason: {
          code: 'download_failed',
          message: REASON_TEXT.download_failed,
          details: message ? [message] : undefined,
        },
        detail: message ?? REASON_TEXT.download_failed,
      };
    }
  }
  if (
    last &&
    last.eventType === 'grabbed' &&
    (lastSearch === null || (lastEventAt ?? 0) >= lastSearch - 60_000)
  ) {
    // Just grabbed: Sonarr's queue catches up within a minute or so.
    const recent = lastEventAt !== null && ctx.now - lastEventAt < 5 * 60_000;
    return {
      ...base,
      state: 'grabbed',
      progress: 0,
      releaseTitle: last.sourceTitle ?? null,
      downloadId: last.downloadId ?? null,
      reason: recent
        ? null
        : { code: 'not_in_client', message: REASON_TEXT.not_in_client },
      detail: recent
        ? 'Sent to the download client'
        : REASON_TEXT.not_in_client,
    };
  }

  // 5. Not aired yet
  const airAt = toTime(episode.airDateUtc);
  if (airAt === null || airAt > ctx.now) {
    return {
      ...base,
      state: 'unaired',
      progress: 0,
      detail: airAt === null ? 'No air date yet' : 'Not aired yet',
    };
  }

  // 6. Searched, nothing grabbed
  if (lastSearch !== null) {
    const reason = fastStartReason(fs) ?? {
      code: 'no_suitable_release' as const,
      message: REASON_TEXT.no_suitable_release,
    };
    return {
      ...base,
      state: 'not_found',
      progress: 0,
      reason,
      detail: reason.message,
    };
  }

  // 7. Nothing happened yet
  return {
    ...base,
    state: 'wanted',
    progress: 0,
    reason: { code: 'not_searched_yet', message: REASON_TEXT.not_searched_yet },
    detail: REASON_TEXT.not_searched_yet,
  };
};

const emptyCounts = (): Record<EpisodeState, number> =>
  EPISODE_STATES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<EpisodeState, number>
  );

export const rollup = (episodes: EpisodeStatus[]): StatusRollup => {
  const counts = emptyCounts();
  let progress = 0;
  let total = 0;
  let eta: number | null = null;
  const bytes = new Map<string, { size: number; left: number }>();

  for (const e of episodes) {
    counts[e.state] += 1;
    if (e.state === 'unaired') continue;
    total += 1;
    progress += Math.min(Math.max(e.progress, 0), 1);
    if (
      (e.state === 'downloading' || e.state === 'grabbed') &&
      typeof e.etaSeconds === 'number'
    ) {
      eta = Math.max(eta ?? 0, e.etaSeconds);
    }
    if (e.downloadId && e.sizeBytes) {
      const key =
        e.progressScope === 'file'
          ? `${e.downloadId}|${e.sonarrEpisodeId}`
          : e.downloadId;
      if (!bytes.has(key)) {
        bytes.set(key, { size: e.sizeBytes, left: e.sizeLeftBytes ?? 0 });
      }
    }
  }

  let bytesTotal = 0;
  let bytesLeft = 0;
  for (const b of bytes.values()) {
    bytesTotal += b.size;
    bytesLeft += b.left;
  }

  const fraction = total > 0 ? progress / total : 0;
  // Never round up to 100 while something is still missing
  const percent =
    total === 0
      ? 0
      : fraction >= 1
        ? 100
        : Math.min(99, Math.floor(fraction * 100));

  return {
    total,
    percent,
    available: counts.available,
    counts,
    state: summaryState(counts),
    etaSeconds: eta,
    bytesTotal,
    bytesLeft,
  };
};

export const summaryState = (
  counts: Record<EpisodeState, number>
): EpisodeState | 'empty' => {
  const present = SUMMARY_PRIORITY.filter((s) => counts[s] > 0);
  if (present.length === 0) return 'empty';
  return present[0];
};

/** Suggested client poll interval in seconds. */
export const refreshSecondsFor = (state: EpisodeState | 'empty'): number => {
  switch (state) {
    case 'downloading':
    case 'searching':
    case 'importing':
      return 10;
    case 'grabbed':
    case 'search_queued':
      return 15;
    case 'available':
    case 'empty':
    case 'unaired':
      return 300;
    default:
      return 60;
  }
};

const groupBy = <T, K>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
};

export const searchActivity = (
  commands: SonarrCommandInput[],
  seriesId: number
): SearchActivity[] =>
  commands
    .filter(
      (c) =>
        SEARCH_COMMANDS.has(c.name) &&
        ACTIVE_COMMAND_STATUSES.has(c.status) &&
        (c.body?.seriesId == null ||
          c.body.seriesId === seriesId ||
          (c.body.seriesIds ?? []).includes(seriesId))
    )
    .map((c) => ({
      command: c.name,
      status: c.status as 'queued' | 'started',
      message: c.message ?? null,
      startedAt: c.started ?? null,
    }));

export interface BuiltSeriesStatus {
  overall: StatusRollup;
  seasons: SeasonStatus[];
  episodes: EpisodeStatus[];
  activity: SearchActivity[];
}

export const buildSeriesStatus = (
  input: SeriesStatusInputs,
  now: number = Date.now()
): BuiltSeriesStatus => {
  const requested =
    input.requestedSeasons && input.requestedSeasons.length > 0
      ? new Set(input.requestedSeasons)
      : null;

  const inScope = input.episodes.filter((e) =>
    requested
      ? requested.has(e.seasonNumber) && (e.monitored || e.hasFile)
      : e.seasonNumber > 0 && e.monitored
  );

  const queueByEpisode = groupBy(
    input.queue.filter((q) => typeof q.episodeId === 'number'),
    (q) => q.episodeId as number
  );
  const historyByEpisode = groupBy(input.history, (h) => h.episodeId);
  const fastStartByEpisode = new Map(
    (input.fastStart?.episodes ?? []).map((e) => [e.episodeId, e])
  );
  const commands = input.commands.filter(
    (c) => SEARCH_COMMANDS.has(c.name) && ACTIVE_COMMAND_STATUSES.has(c.status)
  );

  const episodes = inScope
    .map((episode) =>
      buildEpisodeStatus(episode, {
        now,
        seriesId: input.sonarrSeriesId,
        queueRows: queueByEpisode.get(episode.id),
        history: historyByEpisode.get(episode.id),
        commands,
        fastStart: fastStartByEpisode.get(episode.id),
      })
    )
    .sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
    );

  const seasons = [...groupBy(episodes, (e) => e.seasonNumber).entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, list]) => ({ seasonNumber, ...rollup(list) }));

  return {
    overall: rollup(episodes),
    seasons,
    episodes,
    activity: searchActivity(input.commands, input.sonarrSeriesId),
  };
};
