import {
  buildEpisodeStatus,
  buildSeriesStatus,
  parseSearchTarget,
  parseTimeLeft,
  rollup,
} from '@server/lib/requestStatus/build';
import type {
  SonarrCommandInput,
  SonarrEpisodeInput,
  SonarrHistoryInput,
  SonarrQueueInput,
} from '@server/lib/requestStatus/types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const PAST = '2002-10-03T00:00:00Z';
const SERIES_ID = 1;

const ep = (
  id: number,
  seasonNumber: number,
  episodeNumber: number,
  extra: Partial<SonarrEpisodeInput> = {}
): SonarrEpisodeInput => ({
  id,
  seasonNumber,
  episodeNumber,
  absoluteEpisodeNumber: id,
  title: `Episode ${id}`,
  airDateUtc: PAST,
  hasFile: false,
  monitored: true,
  lastSearchTime: null,
  ...extra,
});

const ctx = (
  extra: Partial<Parameters<typeof buildEpisodeStatus>[1]> = {}
): Parameters<typeof buildEpisodeStatus>[1] => ({
  now: NOW,
  seriesId: SERIES_ID,
  commands: [],
  ...extra,
});

// Shape observed on the fast-start test Sonarr (queue/details for a bundle):
// one row per episode, all carrying the whole release's size.
const bundleRow = (
  episodeId: number,
  extra: Partial<SonarrQueueInput> = {}
): SonarrQueueInput => ({
  episodeId,
  title: '[Anime Time] Naruto Complete (001-220 + Movies) [BD] [Dual Audio]',
  size: 3145728000,
  sizeleft: 2535859406,
  timeleft: '00:20:00',
  status: 'downloading',
  trackedDownloadState: 'downloading',
  trackedDownloadStatus: 'ok',
  statusMessages: [],
  downloadId: 'ABC123',
  ...extra,
});

describe('parseTimeLeft', () => {
  it('parses hh:mm:ss and d.hh:mm:ss', () => {
    assert.equal(parseTimeLeft('00:20:05'), 1205);
    assert.equal(parseTimeLeft('1.02:00:00'), 93600);
    assert.equal(parseTimeLeft('00:00:07.1234567'), 7);
    assert.equal(parseTimeLeft(null), null);
    assert.equal(parseTimeLeft('soon'), null);
  });
});

describe('parseSearchTarget', () => {
  it('reads anime episode, season and bundle progress messages', () => {
    assert.deepEqual(
      parseSearchTarget(
        'Searching indexers for [Naruto : S01E40 (40)]. 1 active indexers'
      ),
      { seasonNumber: 1, episodeNumber: 40, absoluteEpisodeNumber: 40 }
    );
    assert.deepEqual(
      parseSearchTarget(
        'Searching indexers for [Ted Lasso : S02]. 2 active indexers'
      ),
      {
        seasonNumber: 2,
        episodeNumber: undefined,
        absoluteEpisodeNumber: undefined,
      }
    );
    assert.deepEqual(
      parseSearchTarget(
        'Searching indexers for [Naruto] Series bundles (Naruto Complete, Naruto Batch). 1 active indexers'
      ),
      { all: true }
    );
    assert.equal(parseSearchTarget('Completed search for 3 episodes.'), null);
  });

  it('copes with a colon in the series title', () => {
    assert.deepEqual(
      parseSearchTarget(
        'Searching indexers for [Star Trek: Picard : S01E02]. 2 active indexers'
      ),
      {
        seasonNumber: 1,
        episodeNumber: 2,
        absoluteEpisodeNumber: undefined,
      }
    );
  });
});

describe('buildEpisodeStatus', () => {
  it('marks episodes with a file as available', () => {
    const s = buildEpisodeStatus(ep(1, 1, 1, { hasFile: true }), ctx());
    assert.equal(s.state, 'available');
    assert.equal(s.progress, 1);
  });

  it('uses release-level progress from the stock queue', () => {
    const s = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({ queueRows: [bundleRow(3)] })
    );
    assert.equal(s.state, 'downloading');
    assert.equal(s.progressScope, 'release');
    assert.ok(Math.abs((s.downloadProgress ?? 0) - 0.1938) < 0.001);
    assert.equal(s.etaSeconds, 1200);
  });

  it('a queued release with no progress is grabbed, not downloading', () => {
    const s = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({
        queueRows: [
          bundleRow(3, {
            status: 'queued',
            sizeleft: 3145728000,
            timeleft: null,
          }),
        ],
      })
    );
    assert.equal(s.state, 'grabbed');
    assert.equal(s.progress, 0);
  });

  it('prefers fast-start per-file progress over the release', () => {
    const s = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({
        queueRows: [bundleRow(3)],
        fastStart: {
          episodeId: 3,
          files: [
            {
              downloadId: 'ABC123',
              fileIndex: 2,
              fileName: 'Naruto - 003.mkv',
              sizeBytes: 300,
              progress: 0.5,
              priority: 1,
              state: 'downloading',
              etaSeconds: 90,
            },
          ],
        },
      })
    );
    assert.equal(s.state, 'downloading');
    assert.equal(s.progressScope, 'file');
    assert.equal(s.downloadProgress, 0.5);
    assert.equal(s.sizeBytes, 300);
    assert.equal(s.etaSeconds, 90);
  });

  it('a finished file in a still-downloading bundle is importing', () => {
    const s = buildEpisodeStatus(
      ep(1, 1, 1),
      ctx({
        queueRows: [bundleRow(1)],
        fastStart: {
          episodeId: 1,
          files: [
            {
              downloadId: 'ABC123',
              fileIndex: 0,
              fileName: 'Naruto - 001.mkv',
              sizeBytes: 300,
              progress: 1,
              priority: 7,
              state: 'complete',
            },
          ],
        },
      })
    );
    assert.equal(s.state, 'importing');
    assert.equal(s.progress, 1);
  });

  it('a later bundle file not started yet reads as grabbed', () => {
    const s = buildEpisodeStatus(
      ep(9, 1, 9),
      ctx({
        queueRows: [bundleRow(9)],
        fastStart: {
          episodeId: 9,
          files: [
            {
              downloadId: 'ABC123',
              fileIndex: 8,
              fileName: 'Naruto - 009.mkv',
              sizeBytes: 300,
              progress: 0,
              priority: 1,
              state: 'queued',
            },
          ],
        },
      })
    );
    assert.equal(s.state, 'grabbed');
    assert.match(s.detail ?? '', /bundle/);
  });

  it('import blocked and failed downloads are failed with the reason', () => {
    const blocked = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({
        queueRows: [
          bundleRow(3, {
            status: 'completed',
            sizeleft: 0,
            trackedDownloadState: 'importBlocked',
            trackedDownloadStatus: 'warning',
            statusMessages: [
              {
                title: 'Naruto - 003.mkv',
                messages: ['Episode file already imported'],
              },
            ],
          }),
        ],
      })
    );
    assert.equal(blocked.state, 'failed');
    assert.equal(blocked.reason?.code, 'import_blocked');
    assert.deepEqual(blocked.reason?.details, [
      'Episode file already imported',
    ]);

    const failed = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({
        queueRows: [
          bundleRow(3, {
            trackedDownloadState: 'failedPending',
            errorMessage: 'qBittorrent reported an error',
          }),
        ],
      })
    );
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason?.code, 'download_failed');
  });

  it('importing rows count as fully downloaded', () => {
    const s = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({
        queueRows: [
          bundleRow(3, { trackedDownloadState: 'importPending', sizeleft: 0 }),
        ],
      })
    );
    assert.equal(s.state, 'importing');
    assert.equal(s.progress, 1);
  });

  it('delay-profile releases are grabbed with a delayed reason', () => {
    const s = buildEpisodeStatus(
      ep(3, 1, 3),
      ctx({
        queueRows: [bundleRow(3, { status: 'delay', sizeleft: 3145728000 })],
      })
    );
    assert.equal(s.state, 'grabbed');
    assert.equal(s.reason?.code, 'delayed');
  });

  describe('searches', () => {
    const started = '2026-10-12T09:59:00Z';
    const missingSearch = (message: string): SonarrCommandInput => ({
      name: 'MissingEpisodeSearch',
      status: 'started',
      started,
      message,
      body: { seriesId: SERIES_ID },
    });

    it('the episode named in the progress message is being searched', () => {
      const cmd = missingSearch(
        'Searching indexers for [Naruto : S01E40 (40)]. 1 active indexers'
      );
      assert.equal(
        buildEpisodeStatus(ep(40, 1, 40), ctx({ commands: [cmd] })).state,
        'searching'
      );
      // Later episode, not reached yet
      assert.equal(
        buildEpisodeStatus(ep(41, 1, 41), ctx({ commands: [cmd] })).state,
        'search_queued'
      );
      // Earlier episode of the same season, waiting for the season decision
      const earlier = buildEpisodeStatus(
        ep(39, 1, 39, { lastSearchTime: '2026-10-12T09:59:30Z' }),
        ctx({ commands: [cmd] })
      );
      assert.equal(earlier.state, 'searching');
      assert.equal(earlier.detail, 'Searched, choosing a release');
    });

    it('an earlier season searched in this run falls through to not found', () => {
      const cmd = missingSearch(
        'Searching indexers for [Naruto : S02E05 (40)]. 1 active indexers'
      );
      const s = buildEpisodeStatus(
        ep(2, 1, 2, {
          absoluteEpisodeNumber: 2,
          lastSearchTime: '2026-10-12T09:59:30Z',
        }),
        ctx({ commands: [cmd] })
      );
      assert.equal(s.state, 'not_found');
      assert.equal(s.reason?.code, 'no_suitable_release');
    });

    it('queued commands mark covered episodes as queued for search', () => {
      const cmd: SonarrCommandInput = {
        name: 'EpisodeSearch',
        status: 'queued',
        body: { episodeIds: [7] },
      };
      assert.equal(
        buildEpisodeStatus(ep(7, 1, 7), ctx({ commands: [cmd] })).state,
        'search_queued'
      );
      assert.equal(
        buildEpisodeStatus(ep(8, 1, 8), ctx({ commands: [cmd] })).state,
        'wanted'
      );
    });

    it('fast-start search flags win over command inference', () => {
      const s = buildEpisodeStatus(
        ep(8, 1, 8),
        ctx({ fastStart: { episodeId: 8, searchingNow: true } })
      );
      assert.equal(s.state, 'searching');
    });
  });

  describe('history and outcomes', () => {
    const history = (
      eventType: string,
      date: string,
      data: Record<string, string> = {}
    ): SonarrHistoryInput => ({
      episodeId: 5,
      eventType,
      date,
      sourceTitle: 'Naruto 005',
      downloadId: 'X',
      data,
    });

    it('a recent grab without a queue row is grabbed', () => {
      const s = buildEpisodeStatus(
        ep(5, 1, 5, { lastSearchTime: '2026-10-12T09:58:00Z' }),
        ctx({ history: [history('grabbed', '2026-10-12T09:58:10Z')] })
      );
      assert.equal(s.state, 'grabbed');
      assert.equal(s.reason, null);
    });

    it('an old grab that left the client says so', () => {
      const s = buildEpisodeStatus(
        ep(5, 1, 5, { lastSearchTime: '2026-10-11T09:58:00Z' }),
        ctx({ history: [history('grabbed', '2026-10-11T09:58:10Z')] })
      );
      assert.equal(s.state, 'grabbed');
      assert.equal(s.reason?.code, 'not_in_client');
    });

    it('a failed download newer than the last search is failed', () => {
      const s = buildEpisodeStatus(
        ep(5, 1, 5, { lastSearchTime: '2026-10-12T08:00:00Z' }),
        ctx({
          history: [
            history('grabbed', '2026-10-12T08:00:10Z'),
            history('downloadFailed', '2026-10-12T09:00:00Z', {
              message: 'Torrent has no seeders',
            }),
          ],
        })
      );
      assert.equal(s.state, 'failed');
      assert.equal(s.detail, 'Torrent has no seeders');
    });

    it('a search after the failure that found nothing is not found', () => {
      const s = buildEpisodeStatus(
        ep(5, 1, 5, { lastSearchTime: '2026-10-12T09:30:00Z' }),
        ctx({
          history: [
            history('downloadFailed', '2026-10-12T09:00:00Z', {
              message: 'Torrent has no seeders',
            }),
          ],
        })
      );
      assert.equal(s.state, 'not_found');
    });

    it('fast-start rejection summaries become the not-found reason', () => {
      const s = buildEpisodeStatus(
        ep(5, 1, 5, { lastSearchTime: '2026-10-12T09:30:00Z' }),
        ctx({
          fastStart: {
            episodeId: 5,
            lastSearch: {
              at: '2026-10-12T09:30:00Z',
              outcome: 'all_rejected',
              releasesFound: 14,
              rejections: [
                { code: 'packs_only', count: 2 },
                {
                  code: 'custom_format',
                  count: 12,
                  examples: ['Foreign subs or dubs'],
                },
              ],
            },
          },
        })
      );
      assert.equal(s.state, 'not_found');
      assert.equal(s.reason?.code, 'custom_format');
      assert.deepEqual(s.reason?.details, [
        '12 × Only releases rejected by custom formats (Foreign subs or dubs)',
        '2 × Only season packs or bundles that could not be used',
      ]);
    });

    it('unaired and never-searched episodes', () => {
      assert.equal(
        buildEpisodeStatus(
          ep(9, 1, 9, { airDateUtc: '2027-01-01T00:00:00Z' }),
          ctx()
        ).state,
        'unaired'
      );
      assert.equal(buildEpisodeStatus(ep(9, 1, 9), ctx()).state, 'wanted');
    });
  });
});

describe('rollup / buildSeriesStatus', () => {
  it('rolls up seasons and the request, deduplicating release bytes', () => {
    const episodes = [
      ep(1, 1, 1, { hasFile: true }),
      ep(2, 1, 2),
      ep(3, 1, 3),
      ep(4, 1, 4, { lastSearchTime: '2026-10-12T09:00:00Z' }),
      ep(5, 2, 1),
      ep(6, 2, 2, { airDateUtc: '2027-01-01T00:00:00Z' }),
      ep(7, 3, 1), // not requested
      ep(8, 0, 1), // special, not requested
    ];
    const queue = [
      bundleRow(2, { size: 1000, sizeleft: 500 }),
      bundleRow(3, { size: 1000, sizeleft: 500 }),
    ];
    const built = buildSeriesStatus(
      {
        episodes,
        queue,
        commands: [],
        history: [],
        sonarrSeriesId: SERIES_ID,
        requestedSeasons: [1, 2],
      },
      NOW
    );

    assert.deepEqual(
      built.episodes.map((e) => [e.sonarrEpisodeId, e.state]),
      [
        [1, 'available'],
        [2, 'downloading'],
        [3, 'downloading'],
        [4, 'not_found'],
        [5, 'wanted'],
        [6, 'unaired'],
      ]
    );

    const [s1, s2] = built.seasons;
    assert.equal(s1.seasonNumber, 1);
    assert.equal(s1.total, 4);
    assert.equal(s1.percent, 50); // (1 + .5 + .5 + 0) / 4
    assert.equal(s1.state, 'downloading');
    assert.equal(s1.bytesTotal, 1000); // one release, counted once
    assert.equal(s1.bytesLeft, 500);
    assert.equal(s1.etaSeconds, 1200);

    assert.equal(s2.total, 1); // unaired excluded
    assert.equal(s2.percent, 0);
    assert.equal(s2.counts.unaired, 1);

    assert.equal(built.overall.total, 5);
    assert.equal(built.overall.percent, 40);
    assert.equal(built.overall.available, 1);
  });

  it('never shows 100% until everything is in', () => {
    const r = rollup([
      ...Array.from({ length: 199 }, (_, i) =>
        buildEpisodeStatus(ep(i + 1, 1, i + 1, { hasFile: true }), ctx())
      ),
      buildEpisodeStatus(ep(500, 1, 500), ctx()),
    ]);
    assert.equal(r.percent, 99);
    assert.equal(r.state, 'wanted');
  });

  it('without requested seasons, uses monitored non-special episodes', () => {
    const built = buildSeriesStatus(
      {
        episodes: [ep(1, 0, 1), ep(2, 1, 1), ep(3, 1, 2, { monitored: false })],
        queue: [],
        commands: [],
        history: [],
        sonarrSeriesId: SERIES_ID,
      },
      NOW
    );
    assert.deepEqual(
      built.episodes.map((e) => e.sonarrEpisodeId),
      [2]
    );
  });
});
