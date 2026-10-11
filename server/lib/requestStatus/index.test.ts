import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type Media from '@server/entity/Media';
import {
  getSeriesRequestStatus,
  requestedSeasonsFor,
  resetRequestStatusCache,
} from '@server/lib/requestStatus';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const media = (extra: Record<string, unknown> = {}): Media =>
  ({
    mediaType: MediaType.TV,
    tmdbId: 46260,
    status: MediaStatus.PROCESSING,
    status4k: MediaStatus.UNKNOWN,
    serviceId: 0,
    externalServiceId: 1,
    serviceId4k: null,
    externalServiceId4k: null,
    seasons: [
      { seasonNumber: 1, status: MediaStatus.PROCESSING, status4k: 1 },
      { seasonNumber: 2, status: MediaStatus.UNKNOWN, status4k: 1 },
    ],
    requests: [
      {
        is4k: false,
        status: MediaRequestStatus.APPROVED,
        seasons: [{ seasonNumber: 1 }, { seasonNumber: 3 }],
      },
      {
        is4k: false,
        status: MediaRequestStatus.DECLINED,
        seasons: [{ seasonNumber: 4 }],
      },
      {
        is4k: true,
        status: MediaRequestStatus.APPROVED,
        seasons: [{ seasonNumber: 5 }],
      },
    ],
    ...extra,
  }) as unknown as Media;

const configureSonarr = () => {
  getSettings().sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'localhost',
      port: 8989,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      is4k: false,
      syncEnabled: true,
    } as SonarrSettings,
  ];
};

describe('requestedSeasonsFor', () => {
  it('takes seasons from live requests of the track and from season status', () => {
    assert.deepEqual(requestedSeasonsFor(media(), false), [1, 3]);
    assert.deepEqual(requestedSeasonsFor(media(), true), [5]);
  });
});

describe('getSeriesRequestStatus', () => {
  beforeEach(() => {
    resetRequestStatusCache();
    mock.restoreAll();
    configureSonarr();
  });

  it('returns not_requested without media', async () => {
    const s = await getSeriesRequestStatus(1, undefined, false);
    assert.equal(s.phase, 'not_requested');
  });

  it('returns awaiting_approval for a pending request not yet in Sonarr', async () => {
    const s = await getSeriesRequestStatus(
      46260,
      media({
        serviceId: null,
        externalServiceId: null,
        status: MediaStatus.PENDING,
        requests: [
          { is4k: false, status: MediaRequestStatus.PENDING, seasons: [] },
        ],
      }),
      false
    );
    assert.equal(s.phase, 'awaiting_approval');
  });

  it('builds status from stock Sonarr and caches it', async () => {
    const getEpisodes = mock.method(
      SonarrAPI.prototype,
      'getEpisodes',
      async () => [
        {
          id: 10,
          seriesId: 1,
          seasonNumber: 1,
          episodeNumber: 1,
          absoluteEpisodeNumber: 1,
          airDateUtc: '2002-10-03T00:00:00Z',
          hasFile: true,
          monitored: true,
        },
        {
          id: 11,
          seriesId: 1,
          seasonNumber: 1,
          episodeNumber: 2,
          absoluteEpisodeNumber: 2,
          airDateUtc: '2002-10-10T00:00:00Z',
          hasFile: false,
          monitored: true,
        },
      ]
    );
    mock.method(SonarrAPI.prototype, 'getQueueDetails', async () => [
      {
        episodeId: 11,
        title: 'Naruto 002',
        size: 100,
        sizeleft: 25,
        status: 'downloading',
        trackedDownloadState: 'downloading',
        downloadId: 'H',
      },
    ]);
    mock.method(SonarrAPI.prototype, 'getCommands', async () => []);
    mock.method(SonarrAPI.prototype, 'getSeriesHistory', async () => []);
    const fastStart = mock.method(
      SonarrAPI.prototype,
      'getFastStartStatus',
      async () => null
    );

    const s = await getSeriesRequestStatus(46260, media(), false);
    assert.equal(s.phase, 'in_sonarr');
    assert.equal(s.source, 'sonarr');
    assert.equal(s.sonarrSeriesId, 1);
    assert.equal(s.overall.percent, 87); // (1 + 0.75) / 2
    assert.equal(s.overall.state, 'downloading');
    assert.equal(s.refreshSeconds, 10);
    assert.deepEqual(
      s.seasons.map((x) => x.seasonNumber),
      [1]
    );

    // Second call within the TTL is served from cache
    await getSeriesRequestStatus(46260, media(), false);
    assert.equal(getEpisodes.mock.callCount(), 1);
    assert.equal(fastStart.mock.callCount(), 1);
  });

  it('reports unavailable when Sonarr fails', async () => {
    mock.method(SonarrAPI.prototype, 'getEpisodes', async () => {
      throw new Error('ECONNREFUSED');
    });
    mock.method(SonarrAPI.prototype, 'getQueueDetails', async () => []);
    mock.method(SonarrAPI.prototype, 'getCommands', async () => []);
    mock.method(SonarrAPI.prototype, 'getSeriesHistory', async () => []);
    mock.method(SonarrAPI.prototype, 'getFastStartStatus', async () => null);

    const s = await getSeriesRequestStatus(46260, media(), false);
    assert.equal(s.phase, 'unavailable');
    assert.equal(s.error, 'Sonarr could not be reached');
  });
});
