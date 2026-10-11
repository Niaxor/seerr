import {
  getServiceHome,
  JUSTWATCH_ATTRIBUTION,
  listServices,
  resolveRegion,
  resolveRow,
} from '@server/lib/providerBrowse';
import {
  getNetflixTop10,
  netflixTop10Countries,
} from '@server/lib/providerBrowse/netflixTop10';
import logger from '@server/logger';
import { createTmdbWithRegionLanguage } from '@server/routes/discover';
import { Router } from 'express';

/**
 * "Browse by streaming service" API.
 *
 *   GET /api/v1/browse/regions                       watch-provider regions
 *   GET /api/v1/browse/services?region=AU[&all=true] service picker
 *   GET /api/v1/browse/services/:id?region=AU        service home: ordered rows
 *   GET /api/v1/browse/services/:id/rows/:row?region=AU&page=N
 *                                                    paged row results, same
 *                                                    shape as /discover/*
 *
 * Every row result is a standard Seerr search result (with mediaInfo), so
 * clients can reuse their existing poster/request UI.
 */
const browseRoutes = Router();

// Warm the Netflix Top 10 cache (a ~30 MB download) in the background so the
// first browse request does not pay for it.
getNetflixTop10('US').catch(() => undefined);

browseRoutes.get('/regions', async (req, res, next) => {
  try {
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const [regions, top10] = await Promise.all([
      tmdb.getAvailableWatchProviderRegions({}),
      netflixTop10Countries().catch(() => [] as string[]),
    ]);
    return res.status(200).json({
      defaultRegion: resolveRegion(undefined, req.user),
      regions: regions
        .map((r) => ({
          iso_3166_1: r.iso_3166_1,
          name: r.english_name,
          netflixTop10: top10.includes(r.iso_3166_1),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    logger.debug('Failed to list browse regions', {
      label: 'Provider Browse',
      errorMessage: e.message,
    });
    return next({ status: 500, message: 'Unable to retrieve regions.' });
  }
});

browseRoutes.get('/services', async (req, res, next) => {
  try {
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const region = resolveRegion(req.query.region, req.user);
    const services = await listServices(tmdb, region, {
      all: req.query.all === 'true',
    });
    return res.status(200).json({
      region,
      services,
      attribution: [JUSTWATCH_ATTRIBUTION],
    });
  } catch (e) {
    logger.debug('Failed to list browse services', {
      label: 'Provider Browse',
      errorMessage: e.message,
    });
    return next({ status: 500, message: 'Unable to retrieve services.' });
  }
});

browseRoutes.get<{ providerId: string }>(
  '/services/:providerId',
  async (req, res, next) => {
    const providerId = Number(req.params.providerId);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return next({ status: 400, message: 'Invalid provider id.' });
    }
    try {
      const home = await getServiceHome(
        {
          tmdb: createTmdbWithRegionLanguage(req.user),
          user: req.user,
          providerId,
          region: resolveRegion(req.query.region, req.user),
          language: req.locale,
        },
        { prune: req.query.prune !== 'false' }
      );
      if (!home) {
        return next({
          status: 404,
          message: 'Service is not available in this region.',
        });
      }
      return res.status(200).json(home);
    } catch (e) {
      logger.debug('Failed to build service home', {
        label: 'Provider Browse',
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Unable to build service home.' });
    }
  }
);

browseRoutes.get<{ providerId: string; rowId: string }>(
  '/services/:providerId/rows/:rowId',
  async (req, res, next) => {
    const providerId = Number(req.params.providerId);
    const page = Math.max(1, Number(req.query.page) || 1);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return next({ status: 400, message: 'Invalid provider id.' });
    }
    try {
      const results = await resolveRow(req.params.rowId, {
        tmdb: createTmdbWithRegionLanguage(req.user),
        user: req.user,
        providerId,
        region: resolveRegion(req.query.region, req.user),
        page,
        language: req.locale,
      });
      if (!results) {
        return next({ status: 404, message: 'Unknown row.' });
      }
      return res.status(200).json(results);
    } catch (e) {
      logger.debug('Failed to resolve browse row', {
        label: 'Provider Browse',
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Unable to retrieve row.' });
    }
  }
);

export default browseRoutes;
