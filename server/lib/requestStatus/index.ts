// Loads Sonarr data for one series and builds SeriesRequestStatus.
// Results are cached per Sonarr server + series for a few seconds so several
// TV clients polling the same title cost one round of Sonarr calls.

import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { buildSeriesStatus, refreshSecondsFor, rollup } from './build';
import type {
  FastStartStatusInput,
  RequestStatusSource,
  SeriesRequestStatus,
} from './types';

const CACHE_TTL_MS = 5_000;
/** How long to remember that a Sonarr server has no fast-start endpoint. */
const FASTSTART_PROBE_TTL_MS = 10 * 60_000;

interface CacheEntry {
  at: number;
  promise: Promise<SeriesRequestStatus>;
}

const cache = new Map<string, CacheEntry>();
const noFastStartUntil = new Map<number, number>();

/** For tests. */
export const resetRequestStatusCache = (): void => {
  cache.clear();
  noFastStartUntil.clear();
};

/** Seasons the request covers for this quality track. */
export const requestedSeasonsFor = (media: Media, is4k: boolean): number[] => {
  const seasons = new Set<number>();
  for (const request of media.requests ?? []) {
    if (Boolean(request.is4k) !== is4k) continue;
    if (
      request.status === MediaRequestStatus.DECLINED ||
      request.status === MediaRequestStatus.FAILED
    ) {
      continue;
    }
    for (const season of request.seasons ?? []) {
      seasons.add(season.seasonNumber);
    }
  }
  for (const season of media.seasons ?? []) {
    const status = is4k ? season.status4k : season.status;
    if (
      status === MediaStatus.PROCESSING ||
      status === MediaStatus.PARTIALLY_AVAILABLE ||
      status === MediaStatus.AVAILABLE
    ) {
      seasons.add(season.seasonNumber);
    }
  }
  return [...seasons].sort((a, b) => a - b);
};

const emptyStatus = (
  tmdbId: number,
  is4k: boolean,
  mediaStatus: number | null,
  phase: SeriesRequestStatus['phase'],
  error?: string
): SeriesRequestStatus => ({
  tmdbId,
  is4k,
  mediaStatus,
  phase,
  source: null,
  sonarrSeriesId: null,
  generatedAt: new Date().toISOString(),
  refreshSeconds: phase === 'awaiting_approval' ? 60 : 300,
  overall: rollup([]),
  seasons: [],
  episodes: [],
  activity: [],
  ...(error ? { error } : {}),
});

export const getSeriesRequestStatus = async (
  tmdbId: number,
  media: Media | undefined,
  is4k: boolean
): Promise<SeriesRequestStatus> => {
  if (!media || media.mediaType !== MediaType.TV) {
    return emptyStatus(tmdbId, is4k, null, 'not_requested');
  }

  const mediaStatus = (is4k ? media.status4k : media.status) ?? null;
  const serviceId = is4k ? media.serviceId4k : media.serviceId;
  const seriesId = is4k ? media.externalServiceId4k : media.externalServiceId;

  if (serviceId == null || seriesId == null) {
    const awaiting = (media.requests ?? []).some(
      (r) => Boolean(r.is4k) === is4k && r.status === MediaRequestStatus.PENDING
    );
    return emptyStatus(
      tmdbId,
      is4k,
      mediaStatus,
      awaiting ? 'awaiting_approval' : 'not_requested'
    );
  }

  const server = getSettings().sonarr.find((s) => s.id === serviceId);
  if (!server) {
    return emptyStatus(
      tmdbId,
      is4k,
      mediaStatus,
      'unavailable',
      'Sonarr server for this request is no longer configured'
    );
  }

  const requestedSeasons = requestedSeasonsFor(media, is4k);
  const key = `${server.id}:${seriesId}:${requestedSeasons.join(',')}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { ...(await cached.promise), tmdbId, is4k, mediaStatus };
  }

  const promise = (async (): Promise<SeriesRequestStatus> => {
    const sonarr = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });

    try {
      const probeFastStart = (noFastStartUntil.get(server.id) ?? 0) < now;
      const [episodes, queue, commands, history, fastStart] = await Promise.all(
        [
          sonarr.getEpisodes(seriesId),
          sonarr.getQueueDetails(seriesId),
          sonarr.getCommands(),
          sonarr.getSeriesHistory(seriesId),
          probeFastStart
            ? sonarr
                .getFastStartStatus(seriesId)
                .catch((e): FastStartStatusInput | null => {
                  logger.debug('Fast-start status unavailable', {
                    label: 'Request Status',
                    errorMessage: e.message,
                  });
                  return null;
                })
            : Promise.resolve(null),
        ]
      );

      if (probeFastStart && !fastStart) {
        noFastStartUntil.set(server.id, now + FASTSTART_PROBE_TTL_MS);
      }

      const built = buildSeriesStatus({
        episodes,
        queue,
        commands,
        history,
        sonarrSeriesId: seriesId,
        requestedSeasons,
        fastStart,
      });

      const source: RequestStatusSource = fastStart
        ? 'sonarr-faststart'
        : 'sonarr';

      return {
        tmdbId,
        is4k,
        mediaStatus,
        phase: 'in_sonarr',
        source,
        sonarrSeriesId: seriesId,
        generatedAt: new Date().toISOString(),
        refreshSeconds: refreshSecondsFor(built.overall.state),
        ...built,
      };
    } catch (e) {
      logger.warn('Unable to build request status from Sonarr', {
        label: 'Request Status',
        errorMessage: e.message,
        sonarr: server.name,
        seriesId,
      });
      cache.delete(key);
      return emptyStatus(
        tmdbId,
        is4k,
        mediaStatus,
        'unavailable',
        'Sonarr could not be reached'
      );
    }
  })();

  cache.set(key, { at: now, promise });
  return promise;
};
