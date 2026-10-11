// Read-only probe: builds the per-episode request status for one Sonarr
// series straight from a Sonarr instance, without Seerr's database.
//
//   SONARR_API_KEY=... pnpm exec ts-node -r tsconfig-paths/register --files \
//     --project server/tsconfig.json server/scripts/requestStatusProbe.ts \
//     http://localhost:8989 <seriesId> [season,season,...] [--json]
//
// Only GET requests are made (episode, queue/details, command, history/series,
// faststart/status).

import SonarrAPI from '@server/api/servarr/sonarr';
import { buildSeriesStatus } from '@server/lib/requestStatus/build';

const main = async () => {
  const [url, seriesIdArg, seasonsArg, ...flags] = process.argv
    .slice(2)
    .filter(Boolean);
  const apiKey = process.env.SONARR_API_KEY;
  if (!url || !seriesIdArg || !apiKey) {
    console.error(
      'usage: SONARR_API_KEY=... requestStatusProbe.ts <sonarrUrl> <seriesId> [seasons] [--json]'
    );
    process.exit(2);
  }
  const seriesId = Number(seriesIdArg);
  const requestedSeasons =
    seasonsArg && seasonsArg !== '--json'
      ? seasonsArg.split(',').map(Number)
      : null;
  const asJson = flags.includes('--json') || seasonsArg === '--json';

  const sonarr = new SonarrAPI({
    apiKey,
    url: `${url.replace(/\/$/, '')}/api/v3`,
  });

  const started = Date.now();
  const [episodes, queue, commands, history, fastStart] = await Promise.all([
    sonarr.getEpisodes(seriesId),
    sonarr.getQueueDetails(seriesId),
    sonarr.getCommands(),
    sonarr.getSeriesHistory(seriesId),
    sonarr.getFastStartStatus(seriesId).catch(() => null),
  ]);
  const fetchMs = Date.now() - started;

  const built = buildSeriesStatus({
    episodes,
    queue,
    commands,
    history,
    sonarrSeriesId: seriesId,
    requestedSeasons,
    fastStart,
  });

  if (asJson) {
    console.log(JSON.stringify(built, null, 2));
    return;
  }

  console.log(
    `source=${fastStart ? 'sonarr-faststart' : 'sonarr'} fetch=${fetchMs}ms queueRows=${queue.length} history=${history.length} commands=${commands.length}`
  );
  const o = built.overall;
  console.log(
    `overall: ${o.percent}% state=${o.state} total=${o.total} available=${o.available} eta=${o.etaSeconds ?? '-'}s bytes=${o.bytesTotal - o.bytesLeft}/${o.bytesTotal}`
  );
  console.log(
    `counts: ${Object.entries(o.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`
  );
  for (const s of built.seasons) {
    console.log(
      `  S${String(s.seasonNumber).padStart(2, '0')}: ${s.percent}% ${s.state} (${s.available}/${s.total} available)`
    );
  }
  for (const a of built.activity) {
    console.log(`  activity: ${a.command} ${a.status} ${a.message ?? ''}`);
  }
  const sample = built.episodes.filter((e) => e.state !== 'available');
  for (const e of sample.slice(0, 12)) {
    const pct =
      e.downloadProgress !== null
        ? ` ${Math.round(e.downloadProgress * 100)}%(${e.progressScope})`
        : '';
    console.log(
      `    S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} ${e.state}${pct} ${e.detail ?? ''}`
    );
  }
  if (sample.length > 12) console.log(`    ... ${sample.length - 12} more`);
};

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
