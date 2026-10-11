import logger from '@server/logger';
import axios from 'axios';

/**
 * Netflix publishes its weekly per-country Top 10 lists as a TSV download on
 * Tudum (https://www.netflix.com/tudum/top10). Columns:
 *   country_name, country_iso2, week, category (Films|TV), weekly_rank,
 *   show_title, season_title, cumulative_weeks_in_top_10
 *
 * The file covers every week since mid-2021 (~30 MB), so we stream it once,
 * keep only the latest week per country and cache that in memory.
 * Titles carry no IDs - matching to TMDB happens in the caller.
 */
export const NETFLIX_TOP10_COUNTRIES_URL =
  'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';

export const NETFLIX_TOP10_ATTRIBUTION =
  'Top 10 data: Netflix (netflix.com/tudum/top10)';

export interface NetflixTop10Entry {
  rank: number;
  category: 'Films' | 'TV';
  showTitle: string;
  seasonTitle?: string;
  weeksInTop10: number;
}

export interface NetflixTop10Week {
  country: string;
  week: string;
  films: NetflixTop10Entry[];
  tv: NetflixTop10Entry[];
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // file updates weekly (Tuesdays)

let cache: { fetchedAt: number; byCountry: Map<string, NetflixTop10Week> } = {
  fetchedAt: 0,
  byCountry: new Map(),
};
let inflight: Promise<void> | null = null;

const parseTsv = (text: string): Map<string, NetflixTop10Week> => {
  const byCountry = new Map<string, NetflixTop10Week>();
  const lines = text.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 8) continue;

    const [, iso2, week, category, rank, showTitle, seasonTitle, weeks] = cols;
    if (category !== 'Films' && category !== 'TV') continue;

    const country = iso2.toUpperCase();
    let entry = byCountry.get(country);

    // ISO dates compare lexically; keep only the newest week per country
    if (!entry || week > entry.week) {
      entry = { country, week, films: [], tv: [] };
      byCountry.set(country, entry);
    } else if (week < entry.week) {
      continue;
    }

    const item: NetflixTop10Entry = {
      rank: Number(rank),
      category,
      showTitle,
      seasonTitle: seasonTitle && seasonTitle !== 'N/A' ? seasonTitle : '',
      weeksInTop10: Number(weeks),
    };
    (category === 'Films' ? entry.films : entry.tv).push(item);
  }

  for (const entry of byCountry.values()) {
    entry.films.sort((a, b) => a.rank - b.rank);
    entry.tv.sort((a, b) => a.rank - b.rank);
  }

  return byCountry;
};

const refresh = async (): Promise<void> => {
  const response = await axios.get<string>(NETFLIX_TOP10_COUNTRIES_URL, {
    responseType: 'text',
    timeout: 60000,
    headers: { 'User-Agent': 'Seerr (provider-browse)' },
  });
  cache = { fetchedAt: Date.now(), byCountry: parseTsv(response.data) };
  logger.info('Refreshed Netflix Top 10 data', {
    label: 'Provider Browse',
    countries: cache.byCountry.size,
  });
};

export const getNetflixTop10 = async (
  country: string
): Promise<NetflixTop10Week | undefined> => {
  if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    try {
      await inflight;
    } catch (e) {
      // Serve stale data if we have any
      logger.warn('Failed to refresh Netflix Top 10 data', {
        label: 'Provider Browse',
        errorMessage: e.message,
      });
      if (cache.byCountry.size === 0) {
        throw e;
      }
    }
  }

  return cache.byCountry.get(country.toUpperCase());
};

export const netflixTop10Countries = async (): Promise<string[]> => {
  await getNetflixTop10('US');
  return [...cache.byCountry.keys()].sort();
};

// Exported for tests
export const __parseTsv = parseTsv;
