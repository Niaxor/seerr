import type TheMovieDb from '@server/api/themoviedb';
import type { MovieSortOptions, TvSortOptions } from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
  TmdbWatchProviderDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import {
  NETFLIX_TOP10_ATTRIBUTION,
  getNetflixTop10,
  type NetflixTop10Entry,
} from './netflixTop10';

export const NETFLIX_PROVIDER_ID = 8;
export const TMDB_LOGO_BASE = 'https://image.tmdb.org/t/p/w300';
export const JUSTWATCH_ATTRIBUTION =
  'Streaming availability data provided by JustWatch (via TMDB)';

/**
 * Providers that are stores, add-on channels or aggregators rather than a
 * subscription service a user would "browse". They stay available with
 * ?all=true but are not featured in the service picker.
 */
const NON_SERVICE_PATTERN =
  /(amazon channel|apple tv channel|roku premium channel|store|google play|amazon video|^youtube$|microsoft|fetch tv|justwatch|rakuten|plex channel|with ads$|netflix kids|netflix basic)/i;

/**
 * Optional hand-curated service picker per region (TMDB provider ids, in
 * display order). TMDB's display_priority mixes niche services in above the
 * big ones, so regions we care about get an explicit list. Ids verified
 * against /watch/providers/{movie,tv}?watch_region=AU on 2026-10-12.
 */
export const FEATURED_BY_REGION: Record<string, number[]> = {
  AU: [
    8, // Netflix
    337, // Disney Plus
    119, // Amazon Prime Video
    21, // Stan
    385, // BINGE
    1899, // HBO Max
    350, // Apple TV
    531, // Paramount Plus
    134, // Foxtel Now
    283, // Crunchyroll
    135, // ABC iview
    132, // SBS On Demand
    378, // 9Now
    246, // 7plus
    82, // 10
    151, // BritBox
  ],
};

export type BrowseMediaType = 'movie' | 'tv';

export interface BrowseService {
  id: number;
  name: string;
  logoPath?: string;
  logoUrl?: string;
  displayPriority: number;
  mediaTypes: BrowseMediaType[];
  featured: boolean;
  hasTop10: boolean;
}

export interface BrowseRow {
  id: string;
  title: string;
  mediaType: BrowseMediaType;
  source: 'tmdb-discover' | 'netflix-top10' | 'seerr-requests';
  ranked: boolean;
  /** Relative Seerr API path that returns the row's paged results */
  path: string;
}

export interface BrowseRowContext {
  tmdb: TheMovieDb;
  user?: User;
  providerId: number;
  region: string;
  page: number;
  language?: string;
}

export interface BrowseRowResults {
  page: number;
  totalPages: number;
  totalResults: number;
  results: ((
    | ReturnType<typeof mapMovieResult>
    | ReturnType<typeof mapTvResult>
  ) & {
    rank?: number;
    rankLabel?: string;
  })[];
}

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

export const resolveRegion = (requested: unknown, user?: User): string => {
  if (typeof requested === 'string' && /^[a-zA-Z]{2}$/.test(requested)) {
    return requested.toUpperCase();
  }
  const userRegion = user?.settings?.streamingRegion;
  if (userRegion && userRegion !== 'all') {
    return userRegion.toUpperCase();
  }
  return (getSettings().main.streamingRegion || 'US').toUpperCase();
};

// ---------------------------------------------------------------------------
// Service picker
// ---------------------------------------------------------------------------

export const listServices = async (
  tmdb: TheMovieDb,
  region: string,
  { all = false }: { all?: boolean } = {}
): Promise<BrowseService[]> => {
  const [movieProviders, tvProviders] = await Promise.all([
    tmdb.getMovieWatchProviders({ watchRegion: region }),
    tmdb.getTvWatchProviders({ watchRegion: region }),
  ]);

  const merged = new Map<number, BrowseService>();
  const add = (p: TmdbWatchProviderDetails, type: BrowseMediaType) => {
    const existing = merged.get(p.provider_id);
    const priority = p.display_priority ?? 999;
    if (existing) {
      existing.mediaTypes.push(type);
      existing.displayPriority = Math.min(existing.displayPriority, priority);
      return;
    }
    merged.set(p.provider_id, {
      id: p.provider_id,
      name: p.provider_name,
      logoPath: p.logo_path,
      logoUrl: p.logo_path ? `${TMDB_LOGO_BASE}${p.logo_path}` : undefined,
      displayPriority: priority,
      mediaTypes: [type],
      featured: !NON_SERVICE_PATTERN.test(p.provider_name),
      hasTop10: p.provider_id === NETFLIX_PROVIDER_ID,
    });
  };
  movieProviders.forEach((p) => add(p, 'movie'));
  tvProviders.forEach((p) => add(p, 'tv'));

  const services = [...merged.values()].sort(
    (a, b) =>
      a.displayPriority - b.displayPriority || a.name.localeCompare(b.name)
  );

  const curated = FEATURED_BY_REGION[region];
  if (curated) {
    // Curated order first, then any other featured service by priority
    const rank = (id: number) => {
      const i = curated.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    services.forEach((s) => (s.featured = curated.includes(s.id)));
    services.sort(
      (a, b) => rank(a.id) - rank(b.id) || a.displayPriority - b.displayPriority
    );
  }

  return all ? services : services.filter((s) => s.featured).slice(0, 16);
};

// ---------------------------------------------------------------------------
// Row catalogue
// ---------------------------------------------------------------------------

interface DiscoverRowDef {
  kind: 'discover';
  id: string;
  title: (provider: string) => string;
  mediaType: BrowseMediaType;
  sortBy: MovieSortOptions | TvSortOptions;
  sinceDays?: number;
  untilToday?: boolean;
  voteCountGte?: number;
  genre?: string;
}

interface SpecialRowDef {
  kind: 'netflix-top10' | 'because-requested';
  id: string;
  title: (provider: string) => string;
  mediaType: BrowseMediaType;
  onlyProvider?: number;
}

type RowDef = DiscoverRowDef | SpecialRowDef;

const MOVIE_GENRES: [string, string][] = [
  ['28', 'Action'],
  ['35', 'Comedy'],
  ['53', 'Thriller'],
  ['18', 'Drama'],
  ['27', 'Horror'],
  ['878', 'Sci-Fi'],
  ['10749', 'Romance'],
  ['16', 'Animated'],
  ['10751', 'Family'],
  ['99', 'Documentary'],
];

const TV_GENRES: [string, string][] = [
  ['18', 'Drama'],
  ['35', 'Comedy'],
  ['80', 'Crime'],
  ['10765', 'Sci-Fi & Fantasy'],
  ['10759', 'Action & Adventure'],
  ['9648', 'Mystery'],
  ['16', 'Animated'],
  ['10764', 'Reality'],
  ['99', 'Docuseries'],
  ['10762', 'Kids'],
];

export const ROW_DEFS: RowDef[] = [
  {
    kind: 'netflix-top10',
    id: 'top10-tv',
    title: () => 'Top 10 Shows This Week',
    mediaType: 'tv',
    onlyProvider: NETFLIX_PROVIDER_ID,
  },
  {
    kind: 'netflix-top10',
    id: 'top10-movies',
    title: () => 'Top 10 Movies This Week',
    mediaType: 'movie',
    onlyProvider: NETFLIX_PROVIDER_ID,
  },
  {
    kind: 'discover',
    id: 'trending-tv',
    title: (p) => `Trending Shows on ${p}`,
    mediaType: 'tv',
    sortBy: 'popularity.desc',
    sinceDays: 365,
    untilToday: true,
  },
  {
    kind: 'discover',
    id: 'trending-movies',
    title: (p) => `Trending Movies on ${p}`,
    mediaType: 'movie',
    sortBy: 'popularity.desc',
    sinceDays: 365,
    untilToday: true,
  },
  {
    kind: 'because-requested',
    id: 'because-requested',
    title: (p) => `Because You Requested… (on ${p})`,
    mediaType: 'movie',
  },
  {
    kind: 'discover',
    id: 'new-tv',
    title: (p) => `New Shows on ${p}`,
    mediaType: 'tv',
    sortBy: 'first_air_date.desc',
    sinceDays: 120,
    untilToday: true,
  },
  {
    kind: 'discover',
    id: 'new-movies',
    title: (p) => `New Movies on ${p}`,
    mediaType: 'movie',
    sortBy: 'primary_release_date.desc',
    sinceDays: 120,
    untilToday: true,
  },
  {
    kind: 'discover',
    id: 'popular-tv',
    title: (p) => `Popular Shows on ${p}`,
    mediaType: 'tv',
    sortBy: 'popularity.desc',
  },
  {
    kind: 'discover',
    id: 'popular-movies',
    title: (p) => `Popular Movies on ${p}`,
    mediaType: 'movie',
    sortBy: 'popularity.desc',
  },
  {
    kind: 'discover',
    id: 'top-rated-tv',
    title: (p) => `Critically Acclaimed Shows on ${p}`,
    mediaType: 'tv',
    sortBy: 'vote_average.desc',
    voteCountGte: 300,
  },
  {
    kind: 'discover',
    id: 'top-rated-movies',
    title: (p) => `Critically Acclaimed Movies on ${p}`,
    mediaType: 'movie',
    sortBy: 'vote_average.desc',
    voteCountGte: 1000,
  },
  ...TV_GENRES.map(
    ([genre, name]): DiscoverRowDef => ({
      kind: 'discover',
      id: `genre-tv-${genre}`,
      title: () => `${name} Shows`,
      mediaType: 'tv',
      sortBy: 'popularity.desc',
      genre,
    })
  ),
  ...MOVIE_GENRES.map(
    ([genre, name]): DiscoverRowDef => ({
      kind: 'discover',
      id: `genre-movie-${genre}`,
      title: () => `${name} Movies`,
      mediaType: 'movie',
      sortBy: 'popularity.desc',
      genre,
    })
  ),
];

const rowPath = (providerId: number, rowId: string, region: string) =>
  `/api/v1/browse/services/${providerId}/rows/${rowId}?region=${region}`;

// ---------------------------------------------------------------------------
// Row resolution
// ---------------------------------------------------------------------------

const withMedia = async (
  user: User | undefined,
  items: {
    mediaType: BrowseMediaType;
    result: TmdbMovieResult | TmdbTvResult;
    rank?: number;
    rankLabel?: string;
  }[]
): Promise<BrowseRowResults['results']> => {
  const media = await Media.getRelatedMedia(
    user,
    items.map((i) => ({
      tmdbId: i.result.id,
      mediaType: i.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
    })),
    { includeActiveRequest: true }
  );

  return items.map((i) => {
    const mediaType = i.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV;
    const m = media.find(
      (x) => x.tmdbId === i.result.id && x.mediaType === mediaType
    );
    const mapped =
      i.mediaType === 'movie'
        ? mapMovieResult(i.result as TmdbMovieResult, m)
        : mapTvResult(i.result as TmdbTvResult, m);
    return {
      ...mapped,
      ...(i.rank ? { rank: i.rank } : {}),
      ...(i.rankLabel ? { rankLabel: i.rankLabel } : {}),
    };
  });
};

const resolveDiscoverRow = async (
  def: DiscoverRowDef,
  ctx: BrowseRowContext
): Promise<BrowseRowResults> => {
  const common = {
    page: ctx.page,
    language: ctx.language,
    watchRegion: ctx.region,
    watchProviders: String(ctx.providerId),
    watchMonetizationTypes: 'flatrate|free|ads',
    genre: def.genre,
    voteCountGte: def.voteCountGte ? String(def.voteCountGte) : undefined,
  };
  const since = def.sinceDays ? isoDaysAgo(def.sinceDays) : undefined;
  const until = def.untilToday ? isoDaysAgo(0) : undefined;

  if (def.mediaType === 'movie') {
    const data = await ctx.tmdb.getDiscoverMovies({
      ...common,
      sortBy: def.sortBy as MovieSortOptions,
      primaryReleaseDateGte: since,
      primaryReleaseDateLte: until,
    });
    return {
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: await withMedia(
        ctx.user,
        data.results.map((result) => ({ mediaType: 'movie' as const, result }))
      ),
    };
  }

  const data = await ctx.tmdb.getDiscoverTv({
    ...common,
    sortBy: def.sortBy as TvSortOptions,
    firstAirDateGte: since,
    firstAirDateLte: until,
  });
  return {
    page: data.page,
    totalPages: data.total_pages,
    totalResults: data.total_results,
    results: await withMedia(
      ctx.user,
      data.results.map((result) => ({ mediaType: 'tv' as const, result }))
    ),
  };
};

const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const isOnProvider = async (
  tmdb: TheMovieDb,
  mediaType: BrowseMediaType,
  tmdbId: number,
  region: string,
  providerId: number
): Promise<boolean> => {
  try {
    const byRegion = await tmdb.getTitleWatchProviders({ mediaType, tmdbId });
    const r = byRegion[region];
    return !!r?.flatrate?.some((p) => p.provider_id === providerId);
  } catch {
    return false;
  }
};

/**
 * Netflix Top 10 entries carry titles only. Match each to TMDB by searching
 * the title (and, for TV, the part before the first colon as a fallback for
 * anthology names like "Monster: The Lizzie Borden Story"), preferring a
 * candidate TMDB/JustWatch says is on Netflix in the region.
 */
const matchTop10Entry = async (
  tmdb: TheMovieDb,
  entry: NetflixTop10Entry,
  mediaType: BrowseMediaType,
  region: string
): Promise<TmdbMovieResult | TmdbTvResult | undefined> => {
  const queries = [entry.showTitle];
  if (mediaType === 'tv' && entry.showTitle.includes(':')) {
    queries.push(entry.showTitle.split(':')[0]);
  }

  for (const query of queries) {
    const search =
      mediaType === 'movie'
        ? await tmdb.searchMovies({ query })
        : await tmdb.searchTvShows({ query });
    const candidates = (
      search.results as (TmdbMovieResult | TmdbTvResult)[]
    ).slice(0, 5);
    if (!candidates.length) continue;

    const target = normalise(query);
    const titleOf = (c: TmdbMovieResult | TmdbTvResult) =>
      'title' in c ? c.title : c.name;
    const ordered = [
      ...candidates.filter((c) => normalise(titleOf(c)) === target),
      ...candidates.filter((c) => normalise(titleOf(c)) !== target),
    ];

    for (const c of ordered.slice(0, 3)) {
      if (
        await isOnProvider(tmdb, mediaType, c.id, region, NETFLIX_PROVIDER_ID)
      ) {
        return c;
      }
    }
    // Fall back to the best exact title match even if availability data lags
    const exact = ordered.find((c) => normalise(titleOf(c)) === target);
    if (exact) return exact;
  }
  return undefined;
};

const resolveTop10Row = async (
  def: SpecialRowDef,
  ctx: BrowseRowContext
): Promise<BrowseRowResults> => {
  const week = await getNetflixTop10(ctx.region);
  if (!week || ctx.page > 1) {
    return { page: ctx.page, totalPages: 1, totalResults: 0, results: [] };
  }
  const entries = def.mediaType === 'tv' ? week.tv : week.films;
  const matched = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      result: await matchTop10Entry(ctx.tmdb, entry, def.mediaType, ctx.region),
    }))
  );
  const found = matched.filter(
    (
      m
    ): m is {
      entry: NetflixTop10Entry;
      result: TmdbMovieResult | TmdbTvResult;
    } => !!m.result
  );
  const unmatched = matched
    .filter((m) => !m.result)
    .map((m) => m.entry.showTitle);
  if (unmatched.length) {
    logger.debug('Unmatched Netflix Top 10 titles', {
      label: 'Provider Browse',
      region: ctx.region,
      unmatched,
    });
  }

  const results = await withMedia(
    ctx.user,
    found.map((m) => ({
      mediaType: def.mediaType,
      result: m.result,
      rank: m.entry.rank,
      rankLabel: m.entry.seasonTitle || undefined,
    }))
  );
  return { page: 1, totalPages: 1, totalResults: results.length, results };
};

const latestRequests = async (user: User | undefined, take = 3) => {
  if (!user) return [];
  return getRepository(MediaRequest).find({
    where: { requestedBy: { id: user.id } },
    relations: { media: true },
    order: { createdAt: 'DESC' },
    take,
  });
};

const resolveBecauseRequested = async (
  ctx: BrowseRowContext
): Promise<
  BrowseRowResults & {
    basedOn?: { mediaType: BrowseMediaType; tmdbId: number };
  }
> => {
  const requests = await latestRequests(ctx.user, 5);
  const items: {
    mediaType: BrowseMediaType;
    result: TmdbMovieResult | TmdbTvResult;
  }[] = [];
  const seen = new Set<string>();
  let basedOn: { mediaType: BrowseMediaType; tmdbId: number } | undefined;

  for (const request of requests) {
    const mediaType: BrowseMediaType =
      request.media.mediaType === MediaType.MOVIE ? 'movie' : 'tv';
    const tmdbId = request.media.tmdbId;
    const recs =
      mediaType === 'movie'
        ? await ctx.tmdb.getMovieRecommendations({ movieId: tmdbId })
        : await ctx.tmdb.getTvRecommendations({ tvId: tmdbId });
    const checks = await Promise.all(
      (recs.results as (TmdbMovieResult | TmdbTvResult)[])
        .slice(0, 20)
        .map(async (r) => ({
          r,
          ok: await isOnProvider(
            ctx.tmdb,
            mediaType,
            r.id,
            ctx.region,
            ctx.providerId
          ),
        }))
    );
    for (const { r, ok } of checks) {
      const key = `${mediaType}-${r.id}`;
      if (ok && !seen.has(key)) {
        seen.add(key);
        items.push({ mediaType, result: r });
      }
    }
    if (items.length) {
      basedOn = { mediaType, tmdbId };
      break; // one "because you requested X" row, based on the newest request with hits
    }
  }

  const results = await withMedia(ctx.user, items);
  return {
    page: 1,
    totalPages: 1,
    totalResults: results.length,
    results,
    basedOn,
  };
};

export const resolveRow = async (
  rowId: string,
  ctx: BrowseRowContext
): Promise<BrowseRowResults | undefined> => {
  const def = ROW_DEFS.find((d) => d.id === rowId);
  if (!def) return undefined;

  switch (def.kind) {
    case 'discover':
      return resolveDiscoverRow(def, ctx);
    case 'netflix-top10':
      if (ctx.providerId !== NETFLIX_PROVIDER_ID) return undefined;
      return resolveTop10Row(def, ctx);
    case 'because-requested':
      return resolveBecauseRequested(ctx);
  }
};

// ---------------------------------------------------------------------------
// Service home (list of rows)
// ---------------------------------------------------------------------------

export interface ServiceHome {
  region: string;
  service: BrowseService;
  rows: BrowseRow[];
  attribution: string[];
}

export const getServiceHome = async (
  ctx: Omit<BrowseRowContext, 'page'>,
  { prune = true }: { prune?: boolean } = {}
): Promise<ServiceHome | undefined> => {
  const services = await listServices(ctx.tmdb, ctx.region, { all: true });
  const service = services.find((s) => s.id === ctx.providerId);
  if (!service) return undefined;

  const attribution = [JUSTWATCH_ATTRIBUTION];
  const rows: BrowseRow[] = [];

  const candidates = ROW_DEFS.filter(
    (d) =>
      (d.kind !== 'netflix-top10' || ctx.providerId === d.onlyProvider) &&
      (d.kind === 'because-requested' ||
        service.mediaTypes.includes(d.mediaType))
  );

  // Resolve page 1 of every row in parallel: prunes empty rows and warms the
  // cache, so the client's first page request for each row is a cache hit.
  const resolved = await Promise.all(
    candidates.map(async (def) => {
      if (!prune && def.kind === 'discover') {
        return {
          def,
          results: undefined,
          basedOnTitle: undefined,
          basedOnType: undefined,
        };
      }
      try {
        const results = await resolveRow(def.id, { ...ctx, page: 1 });
        let basedOnTitle: string | undefined;
        let basedOnType: BrowseMediaType | undefined;
        if (
          def.kind === 'because-requested' &&
          results &&
          'basedOn' in results &&
          results.basedOn
        ) {
          const b = results.basedOn as {
            mediaType: BrowseMediaType;
            tmdbId: number;
          };
          basedOnType = b.mediaType;
          basedOnTitle =
            b.mediaType === 'movie'
              ? (await ctx.tmdb.getMovie({ movieId: b.tmdbId })).title
              : (await ctx.tmdb.getTvShow({ tvId: b.tmdbId })).name;
        }
        return { def, results, basedOnTitle, basedOnType };
      } catch (e) {
        logger.warn('Failed to resolve browse row', {
          label: 'Provider Browse',
          row: def.id,
          errorMessage: e.message,
        });
        return {
          def,
          results: null,
          basedOnTitle: undefined,
          basedOnType: undefined,
        };
      }
    })
  );

  for (const { def, results, basedOnTitle, basedOnType } of resolved) {
    if (results === null) continue;
    if (results && results.totalResults === 0) continue;
    if (
      def.kind === 'netflix-top10' &&
      !attribution.includes(NETFLIX_TOP10_ATTRIBUTION)
    ) {
      attribution.push(NETFLIX_TOP10_ATTRIBUTION);
    }
    rows.push({
      id: def.id,
      title:
        def.kind === 'because-requested' && basedOnTitle
          ? `Because You Requested ${basedOnTitle}`
          : def.title(service.name),
      mediaType: basedOnType ?? def.mediaType,
      source:
        def.kind === 'discover'
          ? 'tmdb-discover'
          : def.kind === 'netflix-top10'
            ? 'netflix-top10'
            : 'seerr-requests',
      ranked: def.kind === 'netflix-top10',
      path: rowPath(ctx.providerId, def.id, ctx.region),
    });
  }

  return { region: ctx.region, service, rows, attribution };
};
