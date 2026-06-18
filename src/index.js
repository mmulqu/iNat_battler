import {
  chooseNpcAction,
  chooseNpcMove,
  createBattleCreature,
  createGenome,
  createSeededRng,
  resolveTurn,
  terrainForTeam,
  territoryBuffPctForBiomeCount,
  TERRAIN_MOVE_BONUS,
  TYPE_CHART
} from "./game.js";

// H3 geospatial indexing for the territory layer (pure-JS asm.js build, runs in
// workerd). Maps an observation's lat/lng to the tile it falls in, and powers the
// map view (cells in a viewport + their hex boundaries).
import { latLngToCell, cellToBoundary, polygonToCells } from "h3-js";

import {
  GENOME_VERSION_MOVES,
  assembleGenomeV2,
  buildSpriteSheetPromptV2,
  dossierMessages,
  validateDossier
} from "./moves.js";

import {
  RESPEC_COOLDOWN_MS,
  TRAINING_STATS,
  allocationsTotal,
  combinedBuffPct,
  groupTier,
  nextTierTarget,
  sanitizeAllocations,
  sanitizeNickname,
  speciesEarnedPoints,
  statCapFor,
  tierRank
} from "./training.js";

import {
  buildChallengePostRecord,
  buildShareTextPostRecord,
  clientMetadataDocument,
  exchangeAuthorizationCode,
  fetchPublicProfile,
  generateDpopKeyPair,
  getAuthServerMeta,
  oauthClientConfig,
  pdsXrpcCall,
  pkceChallengeFromVerifier,
  pushedAuthorizationRequest,
  randomToken,
  refreshAccessToken,
  resolveIdentity,
  searchActorsTypeahead
} from "./atproto.js";

import landingHeroBattleImage from "./assets/landing-hero-battle.webp";
import statusStunnedImage from "./assets/status-stunned.png";
import statusMarkedImage from "./assets/status-marked.png";
import statusPoisonedImage from "./assets/status-poisoned.png";
import statusShieldedImage from "./assets/status-shielded.png";
import statusRalliedImage from "./assets/status-rallied.png";
import iconImage192 from "./assets/icon-192.png";
import iconImage512 from "./assets/icon-512.png";
import iconImage512Maskable from "./assets/icon-512-maskable.png";
import appleTouchIcon180 from "./assets/apple-touch-icon-180.png";

// 4x4 sprite sheets (16 frames, left-to-right then top-to-bottom) rendered as
// small looping overlays above creatures with the matching status in battle.
const STATUS_EFFECT_IMAGES = {
  stunned: statusStunnedImage,
  marked: statusMarkedImage,
  poisoned: statusPoisonedImage,
  shielded: statusShieldedImage,
  rallied: statusRalliedImage
};

const ASSET_VERSION = 1;
const DEFAULT_ASSET_KIND = "sprite_sheet";
const INAT_API_BASE_URL = "https://api.inaturalist.org/v2";
const INAT_USER_AGENT = "inat-battler/0.1 (Cloudflare Worker; https://github.com/mmulqu/iNat_battler)";
const INAT_SPECIES_CACHE_TTL_SECONDS = 6 * 60 * 60;
const INAT_SPECIES_STALE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const INAT_TAXON_CACHE_TTL_SECONDS = 24 * 60 * 60;
const INAT_RATE_LIMIT_COOLDOWN_SECONDS = 5 * 60;
const TRAINING_COUNT_SOURCE_RESEARCH = "research_grade";
const TRAINING_COUNT_SOURCE_ROSTER_FALLBACK = "roster_fallback";
const D1_ID_CHUNK_SIZE = 80;
const INLINE_MOVE_GENERATION_LIMIT = 5;
const AUTO_MOVE_BATCH_SYNC_LIMIT = 3;
const AUTO_SPRITE_BATCH_SYNC_LIMIT = 2;
const AUTO_SPRITE_BATCH_SYNC_ITEMS = 50;
const MOVE_BATCH_TERMINAL_FAILURE_STATUSES = new Set(["cancelled", "canceled", "expired", "failed"]);
const INAT_SPECIES_COUNT_FIELDS = [
  "count",
  "taxon.id",
  "taxon.name",
  "taxon.preferred_common_name",
  "taxon.english_common_name",
  "taxon.rank",
  "taxon.iconic_taxon_name",
  "taxon.ancestry",
  "taxon.parent_id",
  "taxon.default_photo.medium_url",
  "taxon.default_photo.square_url",
  "taxon.default_photo.url"
].join(",");
const INAT_TAXON_FIELDS = [
  "id",
  "name",
  "preferred_common_name",
  "english_common_name",
  "rank",
  "iconic_taxon_name",
  "ancestry",
  "parent_id",
  "default_photo.medium_url",
  "default_photo.square_url",
  "default_photo.url"
].join(",");
const INAT_TAXON_INFO_FIELDS = [
  "id",
  "name",
  "rank",
  "complete_species_count"
].join(",");
const INAT_TAXON_WIKIPEDIA_FIELDS = [
  "id",
  "wikipedia_summary"
].join(",");
// Territory layer (Biome merge). res5 (~250 km2 hexes) for the MVP; res7 later.
const TERRITORY_H3_RESOLUTION = 5;
// Cap on hexes returned for a single map viewport (keeps payload + polygonToCells
// bounded; the client only requests tiles when zoomed in past TERRITORY_MIN_ZOOM).
const TERRITORY_MAX_TILES = 1500;
const INAT_OBSERVATION_GEO_FIELDS = [
  "id",
  "observed_on",
  "time_observed_at",
  "quality_grade",
  "geoprivacy",
  "taxon_geoprivacy",
  "obscured",
  "location",
  "geojson",
  "taxon.id",
  "taxon.name",
  "taxon.preferred_common_name",
  "taxon.iconic_taxon_name"
].join(",");

const GLOBAL_SEED_KEY = "na_europe_plants_animals_v1";
const GLOBAL_SEED_LIMIT_PER_GROUP = 1000;
const GLOBAL_SEED_BATCH_SIZE = 200;
const GLOBAL_SEED_PRIORITY = 120;
const GLOBAL_SEED_REGIONS = [
  { key: "north_america", label: "North America", placeId: 97394 },
  { key: "europe", label: "Europe", placeId: 67952 }
];
const GLOBAL_SEED_GROUPS = [
  // NOTE: filter by kingdom taxon_id, NOT iconic_taxa. In iNat, `iconic_taxa=Animalia`
  // is the catch-all bucket for invertebrates WITHOUT their own iconic taxon (woodlice,
  // sea stars, anemones, crabs...) and excludes Aves/Mammalia/Insecta/etc. The Animalia
  // *kingdom* (taxon_id=1) is what we actually want. Plantae kingdom = 47126.
  { key: "plants", label: "Plants", iconicTaxon: "Plantae", kingdomTaxonId: 47126 },
  { key: "animals", label: "Animals", iconicTaxon: "Animalia", kingdomTaxonId: 1 }
];
const DEMO_USER_ID = "demo:birds";
const DEMO_PLAYER_TAXON_IDS = [13858, 12727, 8229, 7428, 1965];
const DEMO_DUMMY_TAXA = [
  { taxonId: -101, commonName: "Gray Box Alpha", scientificName: "Placeholder alpha", iconicTaxonName: "Life", obsCount: 10, bondLevel: 8 },
  { taxonId: -102, commonName: "Gray Box Beta", scientificName: "Placeholder beta", iconicTaxonName: "Life", obsCount: 10, bondLevel: 8 },
  { taxonId: -103, commonName: "Gray Box Gamma", scientificName: "Placeholder gamma", iconicTaxonName: "Life", obsCount: 10, bondLevel: 8 },
  { taxonId: -104, commonName: "Gray Box Delta", scientificName: "Placeholder delta", iconicTaxonName: "Life", obsCount: 10, bondLevel: 8 },
  { taxonId: -105, commonName: "Gray Box Epsilon", scientificName: "Placeholder epsilon", iconicTaxonName: "Life", obsCount: 10, bondLevel: 8 }
];

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      console.error(error);
      return jsonResponse(
        { error: error instanceof Error ? error.message : "Unexpected error" },
        Number.isInteger(error?.status) ? error.status : 500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      await syncSpriteSubmissions(env, 25);
    } catch (error) {
      console.error(error);
    }

    try {
      await syncAutoMoveBatchImageSubmissions(env, AUTO_MOVE_BATCH_SYNC_LIMIT);
    } catch (error) {
      console.error(error);
    }

    try {
      await syncPendingSpriteBatches(env, AUTO_SPRITE_BATCH_SYNC_LIMIT, AUTO_SPRITE_BATCH_SYNC_ITEMS);
    } catch (error) {
      console.error(error);
    }

    try {
      await revertExpiredTiles(env); // forfeit ungarrisoned tiles past their grace window
    } catch (error) {
      console.error(error);
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      const jobId = body?.jobId;

      if (!jobId) {
        message.ack();
        continue;
      }

      try {
        if (spriteGenerationMode(env) === "batch") {
          message.ack();
          continue;
        }

        await processSpriteJob(env, body);
        message.ack();
      } catch (error) {
        console.error(error);
        const attempts = await markSpriteJobFailed(env, jobId, error);
        const maxAttempts = intEnv(env, "MAX_OPENAI_ATTEMPTS", 3);

        if (attempts >= maxAttempts) {
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  }
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/") {
    return htmlResponse(renderAppHtml());
  }

  if (request.method === "GET" && url.pathname === "/assets/landing-hero-battle.webp") {
    return bundledImageResponse(landingHeroBattleImage, "image/webp");
  }

  if (request.method === "GET" && url.pathname === "/assets/icon-192.png") {
    return bundledImageResponse(iconImage192, "image/png");
  }

  if (request.method === "GET" && url.pathname === "/assets/icon-512.png") {
    return bundledImageResponse(iconImage512, "image/png");
  }

  if (request.method === "GET" && url.pathname === "/assets/icon-512-maskable.png") {
    return bundledImageResponse(iconImage512Maskable, "image/png");
  }

  if (request.method === "GET" && url.pathname === "/assets/apple-touch-icon-180.png") {
    return bundledImageResponse(appleTouchIcon180, "image/png");
  }

  if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
    return manifestResponse();
  }

  if (request.method === "GET" && url.pathname === "/sw.js") {
    return serviceWorkerResponse();
  }

  const statusImageMatch = url.pathname.match(/^\/assets\/status-([a-z]+)\.png$/);
  if (request.method === "GET" && statusImageMatch && STATUS_EFFECT_IMAGES[statusImageMatch[1]]) {
    return bundledImageResponse(STATUS_EFFECT_IMAGES[statusImageMatch[1]], "image/png");
  }

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
    return jsonResponse({ ok: true, service: "inat-battler" });
  }

  if (url.pathname.startsWith("/api/assets/")) {
    return serveAsset(request, env);
  }

  if (request.method === "GET" && url.pathname === "/oauth/client-metadata.json") {
    return jsonResponse(clientMetadataDocument(env, url.origin));
  }

  if (request.method === "GET" && url.pathname === "/oauth/callback") {
    return handleOAuthCallback(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const payload = await readJson(request);
    return jsonResponse(await beginBlueskyLogin(env, url.origin, payload));
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return handleLogout(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    return jsonResponse(await getMe(request, env));
  }

  if (request.method === "GET" && url.pathname === "/api/bsky/typeahead") {
    const actors = await searchActorsTypeahead(url.searchParams.get("q"), 8);
    return jsonResponse({ actors });
  }

  if (request.method === "POST" && url.pathname === "/api/inat/link/start") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await startInatLink(env, session, payload.inatLogin));
  }

  if (request.method === "POST" && url.pathname === "/api/inat/link/confirm") {
    const session = await requireSession(request, env);
    return jsonResponse(await confirmInatLink(env, session, ctx));
  }

  if (request.method === "POST" && url.pathname === "/api/my-sprites/upload") {
    const session = await requireSession(request, env);
    return jsonResponse(await uploadUserSprite(request, env, session));
  }

  if (request.method === "GET" && url.pathname === "/api/my-sprites") {
    const session = await requireSession(request, env);
    return jsonResponse(await listUserSprites(env, session));
  }

  if (request.method === "POST" && url.pathname === "/api/sprite-submissions/sync") {
    return jsonResponse(await syncSpriteSubmissions(env, 25));
  }

  const submissionSyncMatch = url.pathname.match(/^\/api\/sprite-submissions\/([^/]+)\/sync$/);
  if (request.method === "POST" && submissionSyncMatch) {
    return jsonResponse(await syncSingleSubmission(env, decodeURIComponent(submissionSyncMatch[1])));
  }

  if (request.method === "GET" && url.pathname === "/api/training") {
    const session = await requireSession(request, env);
    return jsonResponse(await getTrainingOverview(env, session));
  }

  if (request.method === "POST" && url.pathname === "/api/training/sync") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    const rows = Array.isArray(payload?.speciesCounts) ? payload.speciesCounts.slice(0, 12000) : null;
    return jsonResponse(await syncTrainingData(env, session, rows));
  }

  if (request.method === "POST" && url.pathname === "/api/territory/sync") {
    const session = await requireSession(request, env);
    return jsonResponse(await syncTerritoryObservations(env, session));
  }

  // Browser-fetch path: the user's own browser pulls their observations from
  // iNaturalist (so the iNat rate limit is per-user, not on the Worker's shared
  // egress) and POSTs the raw rows here just to be persisted. Capped to bound
  // the D1 write budget.
  if (request.method === "POST" && url.pathname === "/api/territory/ingest") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    const rows = Array.isArray(payload?.observations) ? payload.observations.slice(0, 3000) : [];
    return jsonResponse(await ingestTerritoryObservations(env, session, rows));
  }

  if (request.method === "GET" && url.pathname === "/api/territory/tiles") {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryTiles(env, session, url));
  }

  if (request.method === "GET" && url.pathname === "/api/territory/observations") {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryObservations(env, session, url));
  }

  if (request.method === "GET" && url.pathname === "/api/avatar") {
    return proxyAvatar(url.searchParams.get("url") || "");
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/tiles/biomes.pmtiles") {
    return servePmtiles(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/territory/cell") {
    await requireSession(request, env);
    return jsonResponse(await getTerritoryCell(env, url));
  }

  if (request.method === "GET" && url.pathname === "/api/territory/claims") {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryClaims(env, session, url));
  }

  if (request.method === "GET" && url.pathname === "/api/territory/tile") {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryTileDetail(env, session, url.searchParams.get("h3")));
  }

  if (request.method === "POST" && url.pathname === "/api/territory/claim") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await claimTerritoryTile(env, session, String(payload.h3 ?? "")));
  }

  if (request.method === "POST" && url.pathname === "/api/territory/garrison") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await assignTileGarrison(env, session, String(payload.h3 ?? ""), payload.taxonIds));
  }

  if (request.method === "POST" && url.pathname === "/api/territory/contest") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await contestTerritoryTile(env, session, String(payload.h3 ?? ""), payload.taxonIds));
  }

  if (request.method === "POST" && url.pathname === "/api/training/allocate") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await allocateTrainingPoints(env, session, payload));
  }

  if (request.method === "POST" && url.pathname === "/api/training/respec") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await respecTraining(env, session, payload.taxonId));
  }

  if (request.method === "POST" && url.pathname === "/api/training/nickname") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await setTrainingNickname(env, session, payload.taxonId, payload.nickname));
  }

  if (request.method === "POST" && url.pathname === "/api/challenges") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await createChallenge(env, url.origin, session, payload));
  }

  if (request.method === "GET" && url.pathname === "/api/challenges") {
    const session = await requireSession(request, env);
    return jsonResponse(await listChallengesForSession(env, session));
  }

  const challengeAcceptMatch = url.pathname.match(/^\/api\/challenges\/([^/]+)\/accept$/);
  if (request.method === "POST" && challengeAcceptMatch) {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(
      await acceptChallenge(env, session, decodeURIComponent(challengeAcceptMatch[1]), payload.taxonIds ?? [])
    );
  }

  const challengeDeclineMatch = url.pathname.match(/^\/api\/challenges\/([^/]+)\/decline$/);
  if (request.method === "POST" && challengeDeclineMatch) {
    const session = await requireSession(request, env);
    return jsonResponse(await declineChallenge(env, session, decodeURIComponent(challengeDeclineMatch[1])));
  }

  const challengeMatch = url.pathname.match(/^\/api\/challenges\/([^/]+)$/);
  if (request.method === "GET" && challengeMatch) {
    return jsonResponse(await getChallengePublic(env, decodeURIComponent(challengeMatch[1])));
  }

  if (request.method === "POST" && url.pathname === "/api/import") {
    // Locked to the caller's own verified iNaturalist account — a user can only
    // import the profile they proved they own (see confirmInatLink), never an
    // arbitrary login. `speciesCounts` (optional) are rows the user's browser
    // already fetched from iNat so the Worker skips its own per-user call.
    const session = await requireSession(request, env);
    if (!session.inat_login) throw httpError("Link your iNaturalist account first", 400);
    const payload = await readJson(request);
    const rows = Array.isArray(payload?.speciesCounts) ? payload.speciesCounts.slice(0, 12000) : null;
    const result = await importUserByLogin(env, session.inat_login, rows);
    return jsonResponse(result);
  }

  if (request.method === "POST" && url.pathname === "/api/manual-sprites/upload") {
    return jsonResponse(await uploadManualSprite(request, env));
  }

  const rosterMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/roster$/);
  if (request.method === "GET" && rosterMatch) {
    const userId = decodeURIComponent(rosterMatch[1]);
    return jsonResponse(await getRoster(env, userId, rosterOptionsFromUrl(url)));
  }

  if (request.method === "GET" && url.pathname === "/api/roster") {
    const userId = url.searchParams.get("userId");
    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);

    return jsonResponse(await getRoster(env, userId, rosterOptionsFromUrl(url)));
  }

  const spritePreferenceMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/sprites\/(\d+)\/preference$/);
  if (request.method === "POST" && spritePreferenceMatch) {
    const userId = decodeURIComponent(spritePreferenceMatch[1]);
    const taxonId = Number(spritePreferenceMatch[2]);
    const payload = await readJson(request);
    return jsonResponse(await setUserSpritePreference(env, userId, taxonId, String(payload.assetId ?? "")));
  }

  const queueMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/sprites\/queue-missing$/);
  if (request.method === "POST" && queueMatch) {
    const userId = decodeURIComponent(queueMatch[1]);
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, maxQueueMoreLimit(env), 12);
    const queued = await queueMissingSpritesForUser(env, userId, limit, 80);
    return jsonResponse({ queued });
  }

  if (request.method === "POST" && url.pathname === "/api/sprite-jobs") {
    const payload = await readJson(request);
    const userId = String(payload.userId ?? "");
    const limit = clampInt(payload.limit, 1, maxQueueMoreLimit(env), 12);

    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);

    const queued = await queueMissingSpritesForUser(env, userId, limit, 80);
    return jsonResponse({ queued });
  }

  if (request.method === "GET" && url.pathname === "/api/sprite-jobs") {
    const status = url.searchParams.get("status") ?? "queued";
    const userId = url.searchParams.get("userId") ?? "";
    const limit = clampInt(url.searchParams.get("limit"), 1, maxQueueMoreLimit(env), 100);
    return jsonResponse(await listSpriteJobs(env, status, userId, limit));
  }

  if (request.method === "GET" && url.pathname === "/api/global-seed/status") {
    return jsonResponse(await getGlobalSeedStatus(env));
  }

  if (request.method === "GET" && url.pathname === "/api/global-seed/jobs") {
    const limit = clampInt(url.searchParams.get("limit"), 1, GLOBAL_SEED_BATCH_SIZE, GLOBAL_SEED_BATCH_SIZE);
    return jsonResponse({ jobs: await selectQueuedSpriteJobsForBatch(env, limit, "", true) });
  }

  if (request.method === "POST" && url.pathname === "/api/global-seed/dev-import") {
    const payload = await readJson(request);
    const limitPerGroup = clampInt(payload.limitPerGroup, 1, 1000, GLOBAL_SEED_LIMIT_PER_GROUP);
    return jsonResponse(await importGlobalSeedTaxa(env, limitPerGroup));
  }

  if (request.method === "POST" && url.pathname === "/api/global-seed/dev-queue") {
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, GLOBAL_SEED_BATCH_SIZE, GLOBAL_SEED_BATCH_SIZE);
    return jsonResponse(await queueMissingGlobalSeedSprites(env, limit));
  }

  if (request.method === "POST" && url.pathname === "/api/global-seed/dev-submit") {
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, GLOBAL_SEED_BATCH_SIZE, GLOBAL_SEED_BATCH_SIZE);
    return jsonResponse(await submitDevSpriteBatch(env, request.url, {
      limit,
      userId: "",
      queueMissing: false,
      seedOnly: true
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/sprite-batches/dev-submit") {
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, maxBatchSubmitLimit(env), 2);
    const taxonIds = Array.isArray(payload.taxonIds)
      ? payload.taxonIds.map((value) => Number.parseInt(value, 10)).filter(Number.isFinite).slice(0, limit)
      : [];
    if (taxonIds.length > 0) {
      return jsonResponse(await submitSpriteBatchForTaxa(env, request.url, taxonIds));
    }
    const userId = payload.userId ? String(payload.userId) : "";
    const queueMissing = payload.queueMissing !== false;
    return jsonResponse(await submitDevSpriteBatch(env, request.url, { limit, userId, queueMissing }));
  }

  if (request.method === "GET" && url.pathname === "/api/sprite-batches/latest") {
    return jsonResponse(await getLatestSpriteBatch(env));
  }

  if (request.method === "POST" && url.pathname === "/api/sprite-batches/dev-auto-sync") {
    const limit = clampInt(url.searchParams.get("limit"), 1, 10, AUTO_SPRITE_BATCH_SYNC_LIMIT);
    const maxItems = clampInt(url.searchParams.get("maxItems"), 1, 200, AUTO_SPRITE_BATCH_SYNC_ITEMS);
    return jsonResponse(await syncPendingSpriteBatches(env, limit, maxItems));
  }

  if (request.method === "POST" && url.pathname === "/api/move-batches/dev-submit") {
    const payload = await readJson(request);
    return jsonResponse(await submitMoveBatch(env, {
      limit: clampInt(payload.limit, 1, 60, 10),
      userId: payload.userId ? String(payload.userId) : ""
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/move-batches/dev-auto-sync") {
    const limit = clampInt(url.searchParams.get("limit"), 1, 20, AUTO_MOVE_BATCH_SYNC_LIMIT);
    return jsonResponse(await syncAutoMoveBatchImageSubmissions(env, limit));
  }

  const moveBatchSyncMatch = url.pathname.match(/^\/api\/move-batches\/([^/]+)\/sync$/);
  if (request.method === "POST" && moveBatchSyncMatch) {
    return jsonResponse(await syncMoveBatch(env, decodeURIComponent(moveBatchSyncMatch[1])));
  }

  const moveBatchMatch = url.pathname.match(/^\/api\/move-batches\/([^/]+)$/);
  if (request.method === "GET" && moveBatchMatch) {
    return jsonResponse(await getMoveBatch(env, decodeURIComponent(moveBatchMatch[1])));
  }

  if (request.method === "GET" && url.pathname === "/api/taxa/random-spriteless") {
    return jsonResponse(await getRandomSpritelessTaxon(env));
  }

  const movesGenerateMatch = url.pathname.match(/^\/api\/taxa\/(\d+)\/moves\/dev-generate$/);
  if (request.method === "POST" && movesGenerateMatch) {
    return jsonResponse(await generateMovesForTaxon(env, Number(movesGenerateMatch[1])));
  }

  const genomeMatch = url.pathname.match(/^\/api\/taxa\/(\d+)\/genome$/);
  if (request.method === "GET" && genomeMatch) {
    return jsonResponse(await getTaxonGenome(env, Number(genomeMatch[1])));
  }

  const devLabMatch = url.pathname.match(/^\/api\/taxa\/(\d+)\/dev-lab$/);
  if (request.method === "GET" && devLabMatch) {
    return jsonResponse(await getTaxonDevLab(env, Number(devLabMatch[1])));
  }

  const spriteQueueMatch = url.pathname.match(/^\/api\/taxa\/(\d+)\/sprites\/dev-queue$/);
  if (request.method === "POST" && spriteQueueMatch) {
    return jsonResponse(await queueSpriteJobForTaxon(env, Number(spriteQueueMatch[1]), 40));
  }

  const spriteGenerateMatch = url.pathname.match(/^\/api\/taxa\/(\d+)\/sprites\/dev-generate$/);
  if (request.method === "POST" && spriteGenerateMatch) {
    return jsonResponse(await devGenerateSpriteForTaxon(env, Number(spriteGenerateMatch[1])));
  }

  const spriteSubmitBatchMatch = url.pathname.match(/^\/api\/taxa\/(\d+)\/sprites\/dev-submit-batch$/);
  if (request.method === "POST" && spriteSubmitBatchMatch) {
    return jsonResponse(await submitSpriteBatchForTaxon(env, request.url, Number(spriteSubmitBatchMatch[1])));
  }

  const spriteBatchSyncMatch = url.pathname.match(/^\/api\/sprite-batches\/([^/]+)\/sync$/);
  if (request.method === "POST" && spriteBatchSyncMatch) {
    const maxItems = clampInt(url.searchParams.get("maxItems"), 1, 200, 25);
    return jsonResponse(await syncSpriteBatch(env, decodeURIComponent(spriteBatchSyncMatch[1]), { maxItems }));
  }

  const spriteBatchMatch = url.pathname.match(/^\/api\/sprite-batches\/([^/]+)$/);
  if (request.method === "GET" && spriteBatchMatch) {
    return jsonResponse(await getSpriteBatch(env, decodeURIComponent(spriteBatchMatch[1])));
  }

  if (request.method === "POST" && url.pathname === "/api/sprite-jobs/dev-generate-next") {
    return jsonResponse(await devGenerateNextSpriteJob(env));
  }

  const devGenerateMatch = url.pathname.match(/^\/api\/sprite-jobs\/([^/]+)\/dev-generate$/);
  if (request.method === "POST" && devGenerateMatch) {
    const jobId = decodeURIComponent(devGenerateMatch[1]);
    return jsonResponse(await devGenerateSpriteForJob(env, jobId));
  }

  if (request.method === "GET" && url.pathname === "/api/sprite-status") {
    const taxonIds = (url.searchParams.get("taxonIds") ?? "")
      .split(",")
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite)
      .slice(0, 100);

    return jsonResponse(await getSpriteStatus(env, taxonIds));
  }

  if (request.method === "GET" && url.pathname === "/api/sprite-tree") {
    const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 500);
    const q = String(url.searchParams.get("q") ?? "");
    return jsonResponse(await getSpriteTree(env, { limit, q }));
  }

  // Phase 0 (sprite taxonomic tree): list ancestor taxon IDs referenced by
  // ready-sprite taxa that are not yet stored as their own taxa rows, so the
  // backfill can fetch exactly the missing internal nodes (orders/families/...).
  if (request.method === "GET" && url.pathname === "/api/sprite-tree/dev-missing-ancestors") {
    return jsonResponse(await getMissingAncestorTaxonIds(env));
  }

  // Phase 0: bulk-upsert iNat taxon objects (fetched client-side) into taxa.
  if (request.method === "POST" && url.pathname === "/api/taxa/dev-bulk-upsert") {
    const payload = await readJson(request);
    const taxa = Array.isArray(payload.taxa) ? payload.taxa : [];
    return jsonResponse(await bulkUpsertTaxa(env, taxa));
  }

  if (request.method === "GET" && url.pathname === "/api/recent-sprites") {
    const limit = clampInt(url.searchParams.get("limit"), 1, 200, 80);
    const q = String(url.searchParams.get("q") ?? "");
    return jsonResponse(await getRecentSprites(env, { limit, q }));
  }

  const teamMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/teams$/);
  if (teamMatch && request.method === "GET") {
    const userId = decodeURIComponent(teamMatch[1]);
    return jsonResponse({ teams: await listTeams(env, userId) });
  }

  if (teamMatch && request.method === "POST") {
    const userId = decodeURIComponent(teamMatch[1]);
    const payload = await readJson(request);
    const name = String(payload.name ?? "Field Team");
    const taxonIds = Array.isArray(payload.taxonIds) ? payload.taxonIds.map(Number) : [];
    return jsonResponse(await saveTeam(env, userId, name, taxonIds));
  }

  if (request.method === "GET" && url.pathname === "/api/leaderboard") {
    const session = await getSession(request, env);
    const viewerUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;
    return jsonResponse(await getLeaderboard(env, viewerUserId));
  }

  if (request.method === "GET" && url.pathname === "/api/leaderboard/territory") {
    const session = await getSession(request, env);
    const viewerUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;
    return jsonResponse(await getTerritoryLeaderboard(env, viewerUserId));
  }

  if (request.method === "POST" && url.pathname === "/api/share/battle") {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await shareBattleToBluesky(env, session, String(payload.battleId ?? ""), url.origin));
  }

  if (request.method === "POST" && url.pathname === "/api/share/rank") {
    const session = await requireSession(request, env);
    return jsonResponse(await shareRankToBluesky(env, session, url.origin));
  }

  if (request.method === "POST" && url.pathname === "/api/battles/npc/start") {
    const payload = await readJson(request);
    const userId = String(payload.userId ?? "");
    const taxonIds = Array.isArray(payload.taxonIds) ? payload.taxonIds.map(Number) : [];
    const npcTemplate = String(payload.npcTemplate ?? "backyard_beginner");
    const difficulty = ["easy", "normal", "hard"].includes(payload.difficulty) ? payload.difficulty : "normal";

    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);
    return jsonResponse(await startNpcBattle(env, userId, taxonIds, npcTemplate, difficulty));
  }

  if (request.method === "POST" && url.pathname === "/api/battles/demo/start") {
    return jsonResponse(await startDemoBattle(env));
  }

  const battleMatch = url.pathname.match(/^\/api\/battles\/([^/]+)$/);
  if (battleMatch && request.method === "GET") {
    const battle = await getBattle(env, decodeURIComponent(battleMatch[1]));
    return battle ? jsonResponse(battle) : jsonResponse({ error: "Battle not found" }, 404);
  }

  const battleActionMatch = url.pathname.match(/^\/api\/battles\/([^/]+)\/action$/);
  if (battleActionMatch && request.method === "POST") {
    const payload = await readJson(request);
    return jsonResponse(await submitBattleMove(
      env,
      decodeURIComponent(battleActionMatch[1]),
      String(payload.moveId ?? ""),
      payload.switchIndex
    ));
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// `providedRows` (optional) are species_counts rows the user's browser already
// fetched from iNaturalist (see POST /api/import), so the Worker skips its own
// iNat call. When absent, the Worker fetches itself (the one-time auto-import
// after account linking, and the rate-limit fallback, both still use this).
async function importUserByLogin(env, rawLogin, providedRows = null) {
  const inatLogin = normalizeInatLogin(rawLogin);
  const now = new Date().toISOString();
  const userId = `inat:${inatLogin.toLowerCase()}`;

  await env.DB.prepare(`
    INSERT INTO users (id, inat_login, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      inat_login = excluded.inat_login,
      updated_at = excluded.updated_at
  `).bind(userId, inatLogin, now, now).run();

  let speciesRows;
  let importWarning = null;

  if (Array.isArray(providedRows)) {
    speciesRows = providedRows;
  } else {
  try {
    speciesRows = await fetchSpeciesCounts(env, inatLogin);
  } catch (error) {
    if (error?.code !== "INAT_RATE_LIMITED") throw error;

    const existingTaxa = await getExistingUserTaxaCount(env, userId);
    if (existingTaxa <= 0) {
      throw new Error("iNaturalist is rate limiting imports right now. Wait about a minute, then try again.");
    }

    const queuedSprites = await queueMissingSpritesForUser(env, userId, 0, 50);
    return {
      userId,
      inatLogin,
      importedTaxa: existingTaxa,
      queuedSprites,
      rateLimited: true,
      warning: "iNaturalist rate-limited the refresh, so the existing roster was loaded from D1."
    };
  }
  }

  // Batched so a full Research Grade roster (thousands of species) stays
  // within the per-invocation D1 query budget.
  for (const chunk of chunkArray(speciesRows, 40)) {
    const statements = [];
    for (const row of chunk) {
      const taxon = row.taxon;
      if (!taxon?.id || !taxon.name) continue;

      statements.push(prepareTaxonUpsert(env, taxon, now));

      const obsCount = Number(row.count ?? 0);
      const bondLevel = Math.floor(10 * Math.log10(1 + obsCount));

      statements.push(env.DB.prepare(`
        INSERT INTO user_taxa (
          user_id, taxon_id, obs_count, weighted_obs, bond_level, imported_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, taxon_id) DO UPDATE SET
          obs_count = excluded.obs_count,
          weighted_obs = excluded.weighted_obs,
          bond_level = excluded.bond_level,
          imported_at = excluded.imported_at
      `).bind(userId, taxon.id, obsCount, obsCount, bondLevel, now));
    }
    if (statements.length) await env.DB.batch(statements);
  }

  const initialLimit = intEnv(env, "MAX_INITIAL_SPRITE_JOBS", 12);
  const queuedSprites = await queueMissingSpritesForUser(env, userId, initialLimit, 50);

  return {
    userId,
    inatLogin,
    importedTaxa: speciesRows.length,
    queuedSprites,
    warning: importWarning
  };
}

async function upsertTaxonFromInat(env, taxon, now) {
  await prepareTaxonUpsert(env, taxon, now).run();
}

function prepareTaxonUpsert(env, taxon, now) {
  return env.DB.prepare(`
    INSERT INTO taxa (
      taxon_id, scientific_name, common_name, rank,
      iconic_taxon_name, ancestry, parent_id, default_photo_url, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(taxon_id) DO UPDATE SET
      scientific_name = excluded.scientific_name,
      common_name = excluded.common_name,
      rank = excluded.rank,
      iconic_taxon_name = excluded.iconic_taxon_name,
      ancestry = excluded.ancestry,
      parent_id = excluded.parent_id,
      default_photo_url = excluded.default_photo_url,
      updated_at = excluded.updated_at
  `).bind(
    taxon.id,
    taxon.name,
    taxon.preferred_common_name ?? taxon.english_common_name ?? null,
    taxon.rank ?? null,
    taxon.iconic_taxon_name ?? null,
    taxon.ancestry ?? null,
    taxon.parent_id ?? null,
    taxon.default_photo?.medium_url ??
      taxon.default_photo?.square_url ??
      taxon.default_photo?.url ??
      null,
    now
  );
}

async function fetchSpeciesCounts(env, inatLogin) {
  const cacheKey = `inat:species_counts:${inatLogin.toLowerCase()}:roster-rg:v1`;
  const cooldownKey = `inat:species_counts:${inatLogin.toLowerCase()}:roster-rg:cooldown`;
  const cached = await readSpeciesCountsCache(env, cacheKey);
  if (cached?.fresh) return cached.rows;
  if (await readInatCooldown(env, cooldownKey)) {
    if (cached?.rows?.length) return cached.rows;
    throw inatRateLimitError("iNaturalist rate limit reached");
  }

  const maxPages = intEnv(env, "MAX_IMPORT_PAGES", 1);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${INAT_API_BASE_URL}/observations/species_counts`);
    url.searchParams.set("user_login", inatLogin);
    url.searchParams.set("quality_grade", "research");
    url.searchParams.set("per_page", "500");
    url.searchParams.set("page", String(page));
    url.searchParams.set("fields", INAT_SPECIES_COUNT_FIELDS);
    url.searchParams.set("ttl", String(INAT_SPECIES_CACHE_TTL_SECONDS));

    const res = await fetchInatWithRetry(url.toString());

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429 && cached?.rows?.length) {
        await writeInatCooldown(env, cooldownKey);
        return cached.rows;
      }

      if (res.status === 429) {
        await writeInatCooldown(env, cooldownKey);
        throw inatRateLimitError("iNaturalist rate limit reached");
      }

      throw new Error(`iNaturalist species_counts failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const pageRows = Array.isArray(data.results) ? data.results : [];
    rows.push(...pageRows);

    if (pageRows.length < 500) break;
    if (page < maxPages) await sleep(1100);
  }

  await writeSpeciesCountsCache(env, cacheKey, rows);
  return rows;
}

async function fetchInatWithRetry(url) {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": INAT_USER_AGENT
    }
  });

  if (res.status !== 429) return res;

  const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  const waitMs = Number.isFinite(retryAfter)
    ? Math.min(10_000, Math.max(1_000, retryAfter * 1000))
    : 2500;
  await sleep(waitMs);

  return fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": INAT_USER_AGENT
    }
  });
}

async function readSpeciesCountsCache(env, cacheKey) {
  if (!env.CACHE) return null;

  const raw = await env.CACHE.get(cacheKey);
  if (!raw) return null;

  try {
    const cached = JSON.parse(raw);
    const ageMs = Date.now() - Date.parse(cached.cachedAt ?? 0);
    return {
      rows: Array.isArray(cached.rows) ? cached.rows : [],
      fresh: ageMs >= 0 && ageMs < INAT_SPECIES_CACHE_TTL_SECONDS * 1000
    };
  } catch {
    return null;
  }
}

async function writeSpeciesCountsCache(env, cacheKey, rows) {
  if (!env.CACHE) return;

  await env.CACHE.put(
    cacheKey,
    JSON.stringify({ cachedAt: new Date().toISOString(), rows }),
    { expirationTtl: INAT_SPECIES_STALE_CACHE_TTL_SECONDS }
  );
}

async function readInatCooldown(env, key) {
  if (!env.CACHE) return false;
  return Boolean(await env.CACHE.get(key));
}

async function writeInatCooldown(env, key) {
  if (!env.CACHE) return;
  await env.CACHE.put(key, new Date().toISOString(), {
    expirationTtl: INAT_RATE_LIMIT_COOLDOWN_SECONDS
  });
}

function inatRateLimitError(message) {
  const error = new Error(message);
  error.code = "INAT_RATE_LIMITED";
  return error;
}

async function importGlobalSeedTaxa(env, limitPerGroup = GLOBAL_SEED_LIMIT_PER_GROUP) {
  const now = new Date().toISOString();
  const groups = [];
  let importedTaxa = 0;

  for (const group of GLOBAL_SEED_GROUPS) {
    const rows = await fetchGlobalSeedSpeciesCounts(env, group, limitPerGroup);
    let groupImported = 0;
    let statements = [];

    for (const row of rows) {
      const taxon = row.taxon;
      if (!taxon?.id || !taxon.name) continue;

      statements.push(
        prepareTaxonUpsert(env, taxon, now),
        prepareGlobalSeedTaxonUpsert(env, group, row, now)
      );

      groupImported += 1;

      if (statements.length >= 100) {
        await env.DB.batch(statements);
        statements = [];
      }
    }

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }

    importedTaxa += groupImported;
    groups.push({
      key: group.key,
      label: group.label,
      importedTaxa: groupImported
    });
  }

  return {
    seedKey: GLOBAL_SEED_KEY,
    limitPerGroup,
    importedTaxa,
    groups,
    status: await getGlobalSeedStatus(env)
  };
}

function prepareGlobalSeedTaxonUpsert(env, group, row, now) {
  return env.DB.prepare(`
    INSERT INTO global_seed_taxa (
      seed_key, group_key, taxon_id, observed_count,
      region_keys, source_json, imported_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(seed_key, group_key, taxon_id)
    DO UPDATE SET
      observed_count = excluded.observed_count,
      region_keys = excluded.region_keys,
      source_json = excluded.source_json,
      imported_at = excluded.imported_at
  `).bind(
    GLOBAL_SEED_KEY,
    group.key,
    row.taxon.id,
    row.count,
    JSON.stringify(row.regionKeys),
    JSON.stringify({
      group: group.iconicTaxon,
      regions: row.regionCounts
    }),
    now
  );
}

async function fetchGlobalSeedSpeciesCounts(env, group, limitPerGroup) {
  const cacheKey = `inat:global_seed:${GLOBAL_SEED_KEY}:${group.key}:${limitPerGroup}:v3-kingdom:fields:v1`;
  const cached = await readSpeciesCountsCache(env, cacheKey);
  if (cached?.fresh) return cached.rows;

  const merged = new Map();
  const pages = Math.ceil(limitPerGroup / 500);

  for (const region of GLOBAL_SEED_REGIONS) {
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL(`${INAT_API_BASE_URL}/observations/species_counts`);
      url.searchParams.set("place_id", String(region.placeId));
      url.searchParams.set("rank", "species");
      url.searchParams.set("verifiable", "true");
      url.searchParams.set("photos", "true");
      url.searchParams.set("per_page", "500");
      url.searchParams.set("page", String(page));
      url.searchParams.set("taxon_id", String(group.kingdomTaxonId));
      url.searchParams.set("fields", INAT_SPECIES_COUNT_FIELDS);
      url.searchParams.set("ttl", String(INAT_SPECIES_CACHE_TTL_SECONDS));

      const res = await fetchInatWithRetry(url.toString());
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 429) {
          const error = new Error("iNaturalist rate limit reached while importing global seed taxa");
          error.code = "INAT_RATE_LIMITED";
          throw error;
        }

        throw new Error(`iNaturalist global seed species_counts failed: ${res.status} ${text}`);
      }

      const data = await res.json();
      const pageRows = Array.isArray(data.results) ? data.results : [];

      for (const row of pageRows) {
        const taxon = row.taxon;
        if (!taxon?.id || !taxon.name) continue;
        if (taxon.rank && taxon.rank !== "species") continue;

        const count = Number(row.count ?? 0);
        const current = merged.get(taxon.id) ?? {
          taxon,
          count: 0,
          regionKeys: [],
          regionCounts: {}
        };

        current.count += count;
        current.regionCounts[region.key] = (current.regionCounts[region.key] ?? 0) + count;
        if (!current.regionKeys.includes(region.key)) current.regionKeys.push(region.key);
        if (!current.taxon.default_photo && taxon.default_photo) current.taxon = taxon;
        merged.set(taxon.id, current);
      }

      if (pageRows.length < 500) break;
      await sleep(1100);
    }
  }

  const rows = Array.from(merged.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limitPerGroup);

  await writeSpeciesCountsCache(env, cacheKey, rows);
  return rows;
}

async function getGlobalSeedStatus(env) {
  const rows = await env.DB.prepare(`
    WITH seed_status AS (
      SELECT
        gst.group_key,
        EXISTS (
          SELECT 1 FROM sprite_assets sa
          WHERE sa.taxon_id = gst.taxon_id
            AND sa.asset_kind = ?
            AND sa.asset_version = ?
            AND sa.status = 'ready'
        ) AS has_ready,
        EXISTS (
          SELECT 1 FROM sprite_jobs sj
          WHERE sj.taxon_id = gst.taxon_id
            AND sj.asset_kind = ?
            AND sj.asset_version = ?
            AND sj.status = 'queued'
        ) AS has_queued,
        EXISTS (
          SELECT 1 FROM sprite_jobs sj
          WHERE sj.taxon_id = gst.taxon_id
            AND sj.asset_kind = ?
            AND sj.asset_version = ?
            AND sj.status = 'batch_submitted'
        ) AS has_batch_submitted,
        EXISTS (
          SELECT 1 FROM sprite_jobs sj
          WHERE sj.taxon_id = gst.taxon_id
            AND sj.asset_kind = ?
            AND sj.asset_version = ?
            AND sj.status = 'failed'
        ) AS has_failed
      FROM global_seed_taxa gst
      WHERE gst.seed_key = ?
    )
    SELECT
      group_key,
      COUNT(*) AS seed_count,
      SUM(CASE WHEN has_ready THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN NOT has_ready AND has_queued THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN NOT has_ready AND has_batch_submitted THEN 1 ELSE 0 END) AS batch_submitted_count,
      SUM(CASE WHEN NOT has_ready AND NOT has_queued AND NOT has_batch_submitted AND has_failed THEN 1 ELSE 0 END) AS failed_count
    FROM seed_status
    GROUP BY group_key
    ORDER BY group_key
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    GLOBAL_SEED_KEY
  ).all();

  const groups = GLOBAL_SEED_GROUPS.map((group) => {
    const row = (rows.results ?? []).find((item) => item.group_key === group.key) ?? {};
    const seedCount = Number(row.seed_count ?? 0);
    const readyCount = Number(row.ready_count ?? 0);
    const queuedCount = Number(row.queued_count ?? 0);
    const batchSubmittedCount = Number(row.batch_submitted_count ?? 0);
    const failedCount = Number(row.failed_count ?? 0);
    const activeCount = queuedCount + batchSubmittedCount;

    return {
      key: group.key,
      label: group.label,
      seedCount,
      readyCount,
      queuedCount,
      batchSubmittedCount,
      failedCount,
      missingCount: Math.max(0, seedCount - readyCount - activeCount - failedCount)
    };
  });

  return {
    seedKey: GLOBAL_SEED_KEY,
    limitPerGroup: GLOBAL_SEED_LIMIT_PER_GROUP,
    batchSize: GLOBAL_SEED_BATCH_SIZE,
    regions: GLOBAL_SEED_REGIONS,
    groups,
    totals: groups.reduce((totals, group) => ({
      seedCount: totals.seedCount + group.seedCount,
      readyCount: totals.readyCount + group.readyCount,
      queuedCount: totals.queuedCount + group.queuedCount,
      batchSubmittedCount: totals.batchSubmittedCount + group.batchSubmittedCount,
      failedCount: totals.failedCount + group.failedCount,
      missingCount: totals.missingCount + group.missingCount
    }), {
      seedCount: 0,
      readyCount: 0,
      queuedCount: 0,
      batchSubmittedCount: 0,
      failedCount: 0,
      missingCount: 0
    })
  };
}

async function queueMissingGlobalSeedSprites(env, limit = GLOBAL_SEED_BATCH_SIZE) {
  const rows = await env.DB.prepare(`
    SELECT gst.taxon_id
    FROM global_seed_taxa gst
    LEFT JOIN sprite_assets sa
      ON sa.taxon_id = gst.taxon_id
      AND sa.asset_kind = ?
      AND sa.asset_version = ?
      AND sa.status = 'ready'
    LEFT JOIN sprite_jobs sj
      ON sj.taxon_id = gst.taxon_id
      AND sj.asset_kind = ?
      AND sj.asset_version = ?
      AND sj.status IN ('queued', 'running', 'batch_submitted', 'ready')
    WHERE gst.seed_key = ?
      AND sa.asset_id IS NULL
      AND sj.job_id IS NULL
    ORDER BY gst.observed_count DESC
    LIMIT ?
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    GLOBAL_SEED_KEY,
    limit
  ).all();

  let queued = 0;
  for (const row of rows.results ?? []) {
    const didQueue = await ensureSpriteJob(
      env,
      Number(row.taxon_id),
      DEFAULT_ASSET_KIND,
      ASSET_VERSION,
      GLOBAL_SEED_PRIORITY
    );

    if (didQueue) queued += 1;
  }

  return {
    queued,
    requested: limit,
    status: await getGlobalSeedStatus(env)
  };
}

async function uploadManualSprite(request, env) {
  const form = await request.formData();
  const file = form.get("sprite");
  const taxonId = String(form.get("taxonId") ?? "").trim();
  const scientificName = String(form.get("scientificName") ?? "").trim();
  const commonName = String(form.get("commonName") ?? "").trim();
  const userId = String(form.get("userId") ?? "").trim();
  const addToRoster = String(form.get("addToRoster") ?? "false") === "true";

  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("Missing sprite image file");
  }

  const bytes = await file.arrayBuffer();
  const maxBytes = intEnv(env, "MAX_MANUAL_UPLOAD_BYTES", 12_000_000);
  if (bytes.byteLength <= 0) throw new Error("Sprite image file is empty");
  if (bytes.byteLength > maxBytes) throw new Error(`Sprite image file is larger than ${Math.floor(maxBytes / 1_000_000)} MB`);

  const contentType = normalizeImageContentType(file.type) ??
    contentTypeForAssetKey(file.name ?? "");
  if (!contentType) {
    throw new Error("Manual sprite must be PNG, JPEG, or WebP");
  }

  const taxon = await resolveInatTaxonForManualUpload({
    taxonId,
    scientificName,
    commonName
  });
  const now = new Date().toISOString();
  const taxonForDb = {
    ...taxon,
    preferred_common_name: commonName || taxon.preferred_common_name || taxon.english_common_name || null
  };

  await upsertTaxonFromInat(env, taxonForDb, now);

  const fileHash = await sha256ArrayBufferHex(bytes);
  const promptHash = `manual-upload:${fileHash.slice(0, 24)}`;
  const extension = extensionForContentType(contentType);
  const r2Key = `${speciesAssetPrefix(ASSET_VERSION, taxon.id, taxon.name)}/manual/${fileHash.slice(0, 16)}/${DEFAULT_ASSET_KIND}.${extension}`;
  const assetId = await sha256Hex(`${taxon.id}|${DEFAULT_ASSET_KIND}|${ASSET_VERSION}|${promptHash}`);
  const dimensions = readImageDimensions(bytes, contentType);

  await env.ASSETS.put(r2Key, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable"
    },
    customMetadata: {
      taxonId: String(taxon.id),
      promptHash,
      assetKind: DEFAULT_ASSET_KIND,
      assetVersion: String(ASSET_VERSION),
      scientificName: String(taxon.name ?? ""),
      commonName: String(taxonForDb.preferred_common_name ?? ""),
      speciesSlug: slugifyScientificName(taxon.name),
      source: "manual-upload",
      fileHash,
      uploadedAt: now
    }
  });

  await env.DB.prepare(`
    UPDATE sprite_assets
    SET status = 'superseded'
    WHERE taxon_id = ?
      AND asset_kind = ?
      AND asset_version = ?
      AND status = 'ready'
      AND (model = 'manual-upload' OR model = 'manual-upload-web' OR prompt_hash LIKE 'manual-upload:%')
      AND prompt_hash <> ?
  `).bind(taxon.id, DEFAULT_ASSET_KIND, ASSET_VERSION, promptHash).run();

  await env.DB.prepare(`
    INSERT INTO sprite_assets (
      asset_id, taxon_id, asset_kind, asset_version,
      model, prompt_hash, r2_key, status,
      width, height, content_type, cost_estimate_usd, usage_json, created_at
    )
    VALUES (?, ?, ?, ?, 'manual-upload', ?, ?, 'ready', ?, ?, ?, 0, ?, ?)
    ON CONFLICT(taxon_id, asset_kind, asset_version, prompt_hash)
    DO UPDATE SET
      model = excluded.model,
      r2_key = excluded.r2_key,
      status = 'ready',
      width = excluded.width,
      height = excluded.height,
      content_type = excluded.content_type,
      cost_estimate_usd = excluded.cost_estimate_usd,
      usage_json = excluded.usage_json
  `).bind(
    assetId,
    taxon.id,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    promptHash,
    r2Key,
    dimensions?.width ?? null,
    dimensions?.height ?? null,
    contentType,
    JSON.stringify({
      source: "manual-upload",
      file_name: file.name ?? null,
      file_size_bytes: bytes.byteLength,
      file_hash_sha256: fileHash,
      uploaded_at: now
    }),
    now
  ).run();

  const addedToRoster = addToRoster && userId
    ? await addManualSpriteToUserRoster(env, userId, taxonForDb, now)
    : false;

  const moves = await generateImageConditionedMoves(env, taxon.id, bytes, contentType);

  return {
    uploaded: true,
    taxonId: taxon.id,
    scientificName: taxon.name,
    commonName: taxonForDb.preferred_common_name ?? null,
    rank: taxon.rank ?? null,
    iconicTaxonName: taxon.iconic_taxon_name ?? null,
    assetId,
    r2Key,
    url: `/api/assets/${encodeR2Key(r2Key)}`,
    contentType,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    addedToRoster,
    moves
  };
}

async function resolveInatTaxonForManualUpload({ taxonId, scientificName, commonName }) {
  if (taxonId) {
    const id = Number.parseInt(taxonId, 10);
    if (!Number.isFinite(id)) throw new Error("Taxon ID must be a number");

    const url = new URL(`${INAT_API_BASE_URL}/taxa/${encodeURIComponent(String(id))}`);
    url.searchParams.set("fields", INAT_TAXON_FIELDS);
    url.searchParams.set("ttl", String(INAT_TAXON_CACHE_TTL_SECONDS));

    const res = await fetchInatWithRetry(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`iNaturalist taxon lookup failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const taxon = Array.isArray(data.results) ? data.results[0] : data;
    if (!taxon?.id || !taxon.name) throw new Error("iNaturalist did not return a taxon for that ID");
    return taxon;
  }

  const query = scientificName || commonName;
  if (!query) throw new Error("Provide a taxon ID, scientific name, or common name");

  const url = new URL(`${INAT_API_BASE_URL}/taxa/autocomplete`);
  url.searchParams.set("q", query);
  url.searchParams.set("is_active", "true");
  url.searchParams.set("per_page", "10");
  url.searchParams.set("fields", INAT_TAXON_FIELDS);
  url.searchParams.set("ttl", String(INAT_TAXON_CACHE_TTL_SECONDS));

  const res = await fetchInatWithRetry(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iNaturalist taxon lookup failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const rows = Array.isArray(data.results) ? data.results : [];
  if (rows.length === 0) throw new Error("No matching iNaturalist taxon found");

  const scientificLower = scientificName.toLowerCase();
  const commonLower = commonName.toLowerCase();
  const exactScientific = scientificLower
    ? rows.find((taxon) => String(taxon.name ?? "").toLowerCase() === scientificLower)
    : null;
  const exactCommon = commonLower
    ? rows.find((taxon) => String(taxon.preferred_common_name ?? taxon.english_common_name ?? "").toLowerCase() === commonLower)
    : null;
  const species = rows.find((taxon) => taxon.rank === "species");
  const taxon = exactScientific || exactCommon || species || rows[0];

  if (!taxon?.id || !taxon.name) throw new Error("iNaturalist returned an unusable taxon match");
  return taxon;
}

async function addManualSpriteToUserRoster(env, userId, taxon, now) {
  const user = await env.DB.prepare(`
    SELECT id
    FROM users
    WHERE id = ?
  `).bind(userId).first();

  if (!user) return false;

  await env.DB.prepare(`
    INSERT INTO user_taxa (
      user_id, taxon_id, obs_count, weighted_obs, bond_level, imported_at
    )
    VALUES (?, ?, 1, 1, 3, ?)
    ON CONFLICT(user_id, taxon_id) DO UPDATE SET
      obs_count = CASE
        WHEN user_taxa.obs_count < excluded.obs_count THEN excluded.obs_count
        ELSE user_taxa.obs_count
      END,
      weighted_obs = CASE
        WHEN user_taxa.weighted_obs < excluded.weighted_obs THEN excluded.weighted_obs
        ELSE user_taxa.weighted_obs
      END,
      bond_level = CASE
        WHEN user_taxa.bond_level < excluded.bond_level THEN excluded.bond_level
        ELSE user_taxa.bond_level
      END,
      imported_at = excluded.imported_at
  `).bind(userId, taxon.id, now).run();

  return true;
}

async function getExistingUserTaxaCount(env, userId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM user_taxa
    WHERE user_id = ?
  `).bind(userId).first();

  return Number(row?.count ?? 0);
}

async function queueMissingSpritesForUser(env, userId, limit, priority) {
  const budgetRemaining = await getUserQueueBudgetRemaining(env, userId);
  const effectiveLimit = Math.min(limit, budgetRemaining);

  if (effectiveLimit <= 0) return 0;

  const rows = await env.DB.prepare(`
    SELECT ut.taxon_id
    FROM user_taxa ut
    LEFT JOIN sprite_assets sa
      ON sa.taxon_id = ut.taxon_id
      AND sa.asset_kind = ?
      AND sa.asset_version = ?
      AND sa.status = 'ready'
    LEFT JOIN sprite_jobs sj
      ON sj.taxon_id = ut.taxon_id
      AND sj.asset_kind = ?
      AND sj.asset_version = ?
      AND sj.status IN ('queued', 'running', 'batch_submitted', 'ready')
    WHERE ut.user_id = ?
      AND sa.asset_id IS NULL
      AND sj.job_id IS NULL
    ORDER BY ut.obs_count DESC
    LIMIT ?
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    userId,
    effectiveLimit
  ).all();

  let queued = 0;
  for (const row of rows.results ?? []) {
    const didQueue = await ensureSpriteJob(
      env,
      Number(row.taxon_id),
      DEFAULT_ASSET_KIND,
      ASSET_VERSION,
      priority
    );

    if (didQueue) {
      await incrementUserQueueBudget(env, userId, 1);
      queued += 1;
    }
  }

  return queued;
}

async function ensureTaxonInDb(env, taxonId) {
  const existing = await env.DB.prepare("SELECT * FROM taxa WHERE taxon_id = ?").bind(taxonId).first();
  if (existing) return existing;

  const taxon = await resolveInatTaxonForManualUpload({ taxonId: String(taxonId), scientificName: "", commonName: "" });
  await upsertTaxonFromInat(env, taxon, new Date().toISOString());

  const row = await env.DB.prepare("SELECT * FROM taxa WHERE taxon_id = ?").bind(taxonId).first();
  if (!row) throw new Error(`Could not store taxon ${taxonId}`);
  return row;
}

async function currentSpritePromptInfo(env, taxonId) {
  const promptSpec = await getOrCreatePromptSpec(env, taxonId);
  const promptHash = await sha256Hex(promptSpec.sprite_prompt);
  return {
    promptSpec,
    promptHash,
    jobId: `${DEFAULT_ASSET_KIND}:v${ASSET_VERSION}:${taxonId}:${promptHash}`
  };
}

function spriteAssetSummary(row) {
  if (!row) return null;
  return {
    assetId: row.asset_id,
    promptHash: row.prompt_hash,
    model: row.model,
    status: row.status,
    contentType: row.content_type,
    r2Key: row.r2_key,
    url: row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null,
    createdAt: row.created_at
  };
}

async function getSpriteAssetForPrompt(env, taxonId, promptHash) {
  const row = await env.DB.prepare(`
    SELECT *
    FROM sprite_assets
    WHERE taxon_id = ?
      AND asset_kind = ?
      AND asset_version = ?
      AND prompt_hash = ?
      AND status = 'ready'
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(taxonId, DEFAULT_ASSET_KIND, ASSET_VERSION, promptHash).first();

  return spriteAssetSummary(row);
}

async function getLatestSpriteAssetForTaxon(env, taxonId) {
  const row = await env.DB.prepare(`
    SELECT *
    FROM sprite_assets
    WHERE taxon_id = ?
      AND asset_kind = ?
      AND asset_version = ?
      AND status = 'ready'
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(taxonId, DEFAULT_ASSET_KIND, ASSET_VERSION).first();

  return spriteAssetSummary(row);
}

async function getSpriteJobForPrompt(env, taxonId, promptHash) {
  return env.DB.prepare(`
    SELECT sj.*,
      (
        SELECT bi.batch_id
        FROM openai_sprite_batch_items bi
        WHERE bi.job_id = sj.job_id
        ORDER BY bi.created_at DESC
        LIMIT 1
      ) AS batch_id
    FROM sprite_jobs sj
    WHERE sj.taxon_id = ?
      AND sj.asset_kind = ?
      AND sj.asset_version = ?
      AND sj.prompt_hash = ?
    ORDER BY sj.created_at DESC
    LIMIT 1
  `).bind(taxonId, DEFAULT_ASSET_KIND, ASSET_VERSION, promptHash).first();
}

async function getRandomSpritelessTaxon(env) {
  const row = await env.DB.prepare(`
    SELECT t.taxon_id, t.scientific_name, t.common_name
    FROM taxa t
    WHERE (t.rank IS NULL OR t.rank = 'species')
      AND NOT EXISTS (
        SELECT 1 FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
      )
    ORDER BY RANDOM()
    LIMIT 1
  `).bind(DEFAULT_ASSET_KIND, ASSET_VERSION).first();

  if (!row) throw httpError("Every stored taxon already has a ready sprite", 404);

  return {
    taxonId: Number(row.taxon_id),
    name: row.common_name || row.scientific_name,
    scientificName: row.scientific_name
  };
}

async function getTaxonDevLab(env, taxonId) {
  const taxon = await ensureTaxonInDb(env, taxonId);
  // Load genome/moves/facts first — these must render even if the sprite
  // prompt or asset lookups below fail (e.g. taxon has no sprite yet).
  const genomeRow = await env.DB.prepare(`
    SELECT genome_version, genome_json, prompt_json
    FROM creature_genomes
    WHERE taxon_id = ?
    ORDER BY genome_version DESC
    LIMIT 1
  `).bind(taxonId).first();

  // Sprite prompt + asset lookups are best-effort: a failure here must never
  // suppress the moves/facts the dev lab is primarily there to show.
  let promptSpec = null;
  let promptHash = null;
  let jobId = null;
  let asset = null;
  let latestAsset = null;
  let job = null;
  try {
    const info = await currentSpritePromptInfo(env, taxonId);
    promptSpec = info.promptSpec;
    promptHash = info.promptHash;
    jobId = info.jobId;
    asset = await getSpriteAssetForPrompt(env, taxonId, promptHash);
    latestAsset = await getLatestSpriteAssetForTaxon(env, taxonId);
    job = await getSpriteJobForPrompt(env, taxonId, promptHash);
  } catch (error) {
    console.error(`Dev lab sprite lookup failed for taxon ${taxonId}:`, error);
  }

  const genome = genomeRow?.genome_json ? JSON.parse(genomeRow.genome_json) : promptSpec?.genome ?? null;

  return {
    taxon: {
      taxonId,
      name: taxon.common_name || taxon.scientific_name,
      scientificName: taxon.scientific_name,
      commonName: taxon.common_name,
      iconicTaxonName: taxon.iconic_taxon_name
    },
    genomeVersion: Number(genomeRow?.genome_version ?? promptSpec?.prompt_version ?? ASSET_VERSION),
    hasSignatureMoves: Boolean(Array.isArray(genome?.moves) && genome.moves.some((move) => move.signature)),
    facts: genome?.facts ?? [],
    moves: Array.isArray(genome?.moves) ? genome.moves : [],
    promptHash,
    promptVersion: promptSpec?.prompt_version ?? 1,
    jobId,
    asset,
    latestAsset,
    job: job ? {
      jobId: job.job_id,
      status: job.status,
      attempts: Number(job.attempts ?? 0),
      error: job.error ?? null,
      batchId: job.batch_id ?? null,
      updatedAt: job.updated_at
    } : null
  };
}

async function queueSpriteJobForTaxon(env, taxonId, priority) {
  await ensureTaxonInDb(env, taxonId);
  const { promptHash, jobId } = await currentSpritePromptInfo(env, taxonId);
  const asset = await getSpriteAssetForPrompt(env, taxonId, promptHash);
  if (asset) {
    return { queued: false, existingAsset: true, taxonId, jobId, promptHash, asset };
  }

  const queued = await ensureSpriteJob(env, taxonId, DEFAULT_ASSET_KIND, ASSET_VERSION, priority);
  const job = await getSpriteJobForPrompt(env, taxonId, promptHash);

  return {
    queued,
    existingAsset: false,
    taxonId,
    jobId,
    promptHash,
    job: job ? {
      jobId: job.job_id,
      status: job.status,
      batchId: job.batch_id ?? null,
      error: job.error ?? null
    } : null
  };
}

async function devGenerateSpriteForTaxon(env, taxonId) {
  const queued = await queueSpriteJobForTaxon(env, taxonId, 20);
  if (queued.existingAsset) {
    return {
      generated: false,
      message: "Current-prompt sprite already exists",
      taxonId,
      asset: queued.asset
    };
  }

  return {
    generated: true,
    taxonId,
    jobId: queued.jobId,
    ...(await devGenerateSpriteForJob(env, queued.jobId))
  };
}

async function submitSpriteBatchForTaxon(env, requestUrl, taxonId) {
  return submitSpriteBatchForTaxa(env, requestUrl, [taxonId]);
}

async function submitSpriteBatchForTaxa(env, requestUrl, taxonIds) {
  const cleanTaxonIds = [...new Set(
    taxonIds.map((taxonId) => Number.parseInt(taxonId, 10)).filter(Number.isFinite)
  )];
  if (cleanTaxonIds.length === 0) throw new Error("No taxon IDs provided");

  const jobs = [];
  const existingAssets = [];
  const skipped = [];

  for (const taxonId of cleanTaxonIds) {
    const queued = await queueSpriteJobForTaxon(env, taxonId, 20);
    if (queued.existingAsset) {
      existingAssets.push({ taxonId, asset: queued.asset });
      continue;
    }

    const jobId = queued.jobId || queued.job?.jobId;
    if (!jobId) {
      skipped.push({ taxonId, reason: "No sprite job was created" });
      continue;
    }

    const job = await getSpriteJobForBatch(env, jobId);
    if (!job) {
      skipped.push({ taxonId, reason: "Sprite job could not be loaded" });
      continue;
    }
    jobs.push(job);
  }

  if (jobs.length === 0) {
    return {
      submitted: false,
      message: existingAssets.length
        ? "Current-prompt sprites already exist for all provided taxa"
        : "No queued sprite jobs available for those taxa",
      existingAssets,
      skipped
    };
  }

  const result = await submitSpriteJobsBatch(env, requestUrl, jobs);
  return {
    ...result,
    existingAssets,
    skipped: [...(result.skipped ?? []), ...skipped]
  };
}

async function getSpriteJobForBatch(env, jobId) {
  return env.DB.prepare(`
    SELECT sj.*, t.scientific_name, t.common_name, t.iconic_taxon_name, t.default_photo_url
    FROM sprite_jobs sj
    JOIN taxa t ON t.taxon_id = sj.taxon_id
    WHERE sj.job_id = ?
  `).bind(jobId).first();
}

async function ensureSpriteJob(env, taxonId, assetKind, assetVersion, priority) {
  const promptSpec = await getOrCreatePromptSpec(env, taxonId);
  const promptHash = await sha256Hex(promptSpec.sprite_prompt);
  const jobId = `${assetKind}:v${assetVersion}:${taxonId}:${promptHash}`;

  const existingAsset = await env.DB.prepare(`
    SELECT asset_id
    FROM sprite_assets
    WHERE taxon_id = ?
      AND asset_kind = ?
      AND asset_version = ?
      AND prompt_hash = ?
      AND status = 'ready'
  `).bind(taxonId, assetKind, assetVersion, promptHash).first();

  if (existingAsset) return false;

  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO sprite_jobs (
      job_id, taxon_id, asset_kind, asset_version,
      prompt_hash, status, priority, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).bind(
    jobId,
    taxonId,
    assetKind,
    assetVersion,
    promptHash,
    priority,
    now,
    now
  ).run();

  if ((result.meta?.changes ?? 0) === 0) {
    const requeued = await env.DB.prepare(`
      UPDATE sprite_jobs
      SET status = 'queued',
          priority = ?,
          error = NULL,
          updated_at = ?
      WHERE job_id = ?
        AND status = 'failed'
        AND attempts < ?
    `).bind(
      priority,
      now,
      jobId,
      intEnv(env, "MAX_OPENAI_ATTEMPTS", 3)
    ).run();

    if ((requeued.meta?.changes ?? 0) === 0) return false;
  }

  await env.SPRITE_QUEUE.send({
    jobId,
    taxonId,
    assetKind,
    assetVersion,
    promptHash
  });

  return true;
}

async function processSpriteJob(env, job) {
  if (!job?.jobId || !job?.taxonId) {
    throw new Error("Invalid sprite job message");
  }

  const existing = await env.DB.prepare(`
    SELECT asset_id, r2_key
    FROM sprite_assets
    WHERE taxon_id = ?
      AND asset_kind = ?
      AND asset_version = ?
      AND prompt_hash = ?
      AND status = 'ready'
  `).bind(
    job.taxonId,
    job.assetKind,
    job.assetVersion,
    job.promptHash
  ).first();

  if (existing) {
    await markSpriteJobReady(env, job.jobId);
    return;
  }

  if (!env.OPENAI_API_KEY) {
    await markSpriteJobFailed(env, job.jobId, new Error("OPENAI_API_KEY is not configured"));
    return;
  }

  const claimed = await claimSpriteJob(env, job.jobId);
  if (!claimed) return;

  const taxon = await getTaxonForSpriteJob(env, job.taxonId);
  const promptSpec = await getOrCreatePromptSpec(env, job.taxonId);
  const reserved = await reserveGlobalGenerationAttempt(env);
  if (!reserved) {
    await markSpriteJobFailed(env, job.jobId, new Error("Daily sprite generation cap reached"));
    return;
  }

  const referenceImages = await loadSpriteReferenceImages(env, taxon);
  const generated = await generateSpriteWithOpenAI(env, promptSpec, referenceImages);
  const speciesPrefix = speciesAssetPrefix(job.assetVersion, job.taxonId, taxon.scientific_name);
  const r2Key = `${speciesPrefix}/${job.promptHash.slice(0, 16)}/${job.assetKind}.${generated.extension}`;

  await env.ASSETS.put(r2Key, generated.bytes, {
    httpMetadata: {
      contentType: generated.contentType,
      cacheControl: "public, max-age=31536000, immutable"
    },
    customMetadata: {
      taxonId: String(job.taxonId),
      promptHash: job.promptHash,
      assetKind: job.assetKind,
      assetVersion: String(job.assetVersion),
      scientificName: String(taxon.scientific_name ?? ""),
      speciesSlug: slugifyScientificName(taxon.scientific_name)
    }
  });

  const assetId = await sha256Hex(
    `${job.taxonId}|${job.assetKind}|${job.assetVersion}|${job.promptHash}`
  );
  const costEstimateUsd = estimateOpenAICostUsd(env, generated.usage);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO sprite_assets (
      asset_id, taxon_id, asset_kind, asset_version,
      model, prompt_hash, r2_key, status,
      content_type, cost_estimate_usd, usage_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
    ON CONFLICT(taxon_id, asset_kind, asset_version, prompt_hash)
    DO UPDATE SET
      r2_key = excluded.r2_key,
      status = 'ready',
      content_type = excluded.content_type,
      cost_estimate_usd = excluded.cost_estimate_usd,
      usage_json = excluded.usage_json
  `).bind(
    assetId,
    job.taxonId,
    job.assetKind,
    job.assetVersion,
    generated.model,
    job.promptHash,
    r2Key,
    generated.contentType,
    costEstimateUsd,
    generated.usage ? JSON.stringify(generated.usage) : null,
    now
  ).run();

  await addGlobalGenerationCost(env, costEstimateUsd ?? 0);
  await markSpriteJobReady(env, job.jobId);
}

async function claimSpriteJob(env, jobId) {
  const now = new Date().toISOString();
  const maxAttempts = intEnv(env, "MAX_OPENAI_ATTEMPTS", 3);

  const result = await env.DB.prepare(`
    UPDATE sprite_jobs
    SET status = 'running',
        attempts = attempts + 1,
        error = NULL,
        updated_at = ?
    WHERE job_id = ?
      AND status IN ('queued', 'failed')
      AND attempts < ?
  `).bind(now, jobId, maxAttempts).run();

  return (result.meta?.changes ?? 0) > 0;
}

async function markSpriteJobReady(env, jobId) {
  await env.DB.prepare(`
    UPDATE sprite_jobs
    SET status = 'ready', error = NULL, updated_at = ?
    WHERE job_id = ?
  `).bind(new Date().toISOString(), jobId).run();
}

async function markSpriteJobFailed(env, jobId, error) {
  const message = error instanceof Error ? error.message : String(error);

  await env.DB.prepare(`
    UPDATE sprite_jobs
    SET status = 'failed', error = ?, updated_at = ?
    WHERE job_id = ?
  `).bind(message.slice(0, 2000), new Date().toISOString(), jobId).run();

  const row = await env.DB.prepare(`
    SELECT attempts
    FROM sprite_jobs
    WHERE job_id = ?
  `).bind(jobId).first();

  return Number(row?.attempts ?? 0);
}

async function listSpriteJobs(env, status, userId = "", limit = 100) {
  const statement = userId
    ? env.DB.prepare(`
        SELECT sj.*, t.scientific_name, t.common_name, t.iconic_taxon_name, t.default_photo_url, ut.obs_count
        FROM sprite_jobs sj
        JOIN taxa t ON t.taxon_id = sj.taxon_id
        JOIN user_taxa ut
          ON ut.taxon_id = sj.taxon_id
          AND ut.user_id = ?
        LEFT JOIN sprite_assets sa
          ON sa.taxon_id = sj.taxon_id
          AND sa.asset_kind = sj.asset_kind
          AND sa.asset_version = sj.asset_version
          AND sa.status = 'ready'
        WHERE sj.status = ?
          AND sa.asset_id IS NULL
        ORDER BY sj.priority ASC, ut.obs_count DESC, sj.created_at ASC
        LIMIT ?
      `).bind(userId, status, limit)
    : env.DB.prepare(`
        SELECT sj.*, t.scientific_name, t.common_name, t.iconic_taxon_name, t.default_photo_url, NULL AS obs_count
        FROM sprite_jobs sj
        JOIN taxa t ON t.taxon_id = sj.taxon_id
        LEFT JOIN sprite_assets sa
          ON sa.taxon_id = sj.taxon_id
          AND sa.asset_kind = sj.asset_kind
          AND sa.asset_version = sj.asset_version
          AND sa.status = 'ready'
        WHERE sj.status = ?
          AND sa.asset_id IS NULL
        ORDER BY sj.priority ASC, sj.created_at ASC
        LIMIT ?
      `).bind(status, limit);

  const rows = await statement.all();

  return { jobs: rows.results ?? [] };
}

async function submitDevSpriteBatch(env, requestUrl, options) {
  if (options.userId && options.queueMissing !== false) {
    await queueMissingSpritesForUser(env, options.userId, options.limit, 80);
  }

  const jobs = await selectQueuedSpriteJobsForBatch(
    env,
    options.limit,
    options.userId,
    options.seedOnly === true
  );
  if (jobs.length === 0) {
    return { submitted: false, message: "No queued sprite jobs available for batch submission" };
  }

  return submitSpriteJobsBatch(env, requestUrl, jobs);
}

async function prepareSpriteJobsForImageBatch(env, jobs) {
  const sourceJobs = Array.isArray(jobs) ? jobs : [];
  const taxonIds = [...new Set(sourceJobs.map((job) => Number(job.taxon_id)).filter(Number.isFinite))];
  const existingMoveTaxa = await loadMoveGenomeTaxonIds(env, taxonIds);
  const missingMoveTaxa = taxonIds.filter((taxonId) => !existingMoveTaxa.has(taxonId));
  const skipped = [];
  let movesGenerated = 0;

  if (missingMoveTaxa.length > 0) {
    if (missingMoveTaxa.length > INLINE_MOVE_GENERATION_LIMIT) {
      const taxa = await loadTaxaRows(env, missingMoveTaxa);
      return {
        jobs: [],
        skipped,
        movesGenerated,
        moveBatch: await createMoveBatchForTaxa(env, taxa, { autoSubmitImages: true })
      };
    }

    for (const taxonId of missingMoveTaxa) {
      await generateMovesForTaxon(env, taxonId);
      movesGenerated += 1;
    }
  }

  const preparedJobs = [];
  for (const job of sourceJobs) {
    const taxonId = Number(job.taxon_id);
    if (!Number.isFinite(taxonId)) continue;

    const queued = await queueSpriteJobForTaxon(env, taxonId, Number(job.priority ?? 80));
    if (queued.existingAsset) {
      skipped.push({ taxonId, reason: "Current move-aware sprite already exists", asset: queued.asset });
      continue;
    }

    const jobId = queued.jobId || queued.job?.jobId;
    const currentJob = jobId ? await getSpriteJobForBatch(env, jobId) : null;
    if (!currentJob) {
      skipped.push({ taxonId, reason: "Current move-aware sprite job could not be loaded" });
      continue;
    }

    if (currentJob.status !== "queued") {
      skipped.push({
        taxonId,
        reason: `Current move-aware sprite job is ${currentJob.status}`,
        jobId: currentJob.job_id,
        batchId: queued.job?.batchId ?? null
      });
      continue;
    }

    preparedJobs.push(currentJob);
  }

  return { jobs: preparedJobs, skipped, movesGenerated, moveBatch: null };
}

async function loadMoveGenomeTaxonIds(env, taxonIds) {
  const ids = [...new Set(taxonIds.map(Number).filter(Number.isFinite))];
  const set = new Set();
  for (const chunk of chunkArray(ids, D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT taxon_id
      FROM creature_genomes
      WHERE genome_version >= ?
        AND taxon_id IN (${placeholders})
    `).bind(GENOME_VERSION_MOVES, ...chunk).all();

    for (const row of rows.results ?? []) set.add(Number(row.taxon_id));
  }
  return set;
}

async function loadTaxaRows(env, taxonIds) {
  const ids = [...new Set(taxonIds.map(Number).filter(Number.isFinite))];
  const rows = [];
  for (const chunk of chunkArray(ids, D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await env.DB.prepare(`
      SELECT *
      FROM taxa
      WHERE taxon_id IN (${placeholders})
    `).bind(...chunk).all();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

async function submitSpriteJobsBatch(env, requestUrl, jobs) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const prepared = await prepareSpriteJobsForImageBatch(env, jobs);
  if (prepared.moveBatch) {
    return {
      submitted: false,
      stage: "moves",
      message: `Submitted move batch ${prepared.moveBatch.batchId} for ${prepared.moveBatch.queued} taxa; the image batch will submit automatically after the moves finish.`,
      moveBatchId: prepared.moveBatch.batchId,
      moveBatch: prepared.moveBatch,
      skipped: prepared.skipped
    };
  }

  if (prepared.jobs.length === 0) {
    return {
      submitted: false,
      message: "No queued sprite jobs available after move-prep",
      movesGenerated: prepared.movesGenerated,
      skipped: prepared.skipped
    };
  }

  const endpoint = "/v1/images/edits";
  const jsonlLines = [];
  const items = [];

  for (const job of prepared.jobs) {
    const reserved = await reserveGlobalGenerationAttempt(env);
    if (!reserved) break;

    const promptSpec = await getOrCreatePromptSpec(env, Number(job.taxon_id));
    const references = buildBatchReferenceImages(env, requestUrl, job);
    const customId = customIdForBatchItem(job);
    const body = openAIImageEditJsonBody(env, promptSpec, references);

    jsonlLines.push(JSON.stringify({
      custom_id: customId,
      method: "POST",
      url: endpoint,
      body
    }));

    items.push({ customId, job });
  }

  if (items.length === 0) {
    throw new Error("Daily sprite generation cap reached");
  }

  const inputFile = await uploadOpenAIBatchFile(
    env,
    `${jsonlLines.join("\n")}\n`,
    `sprite-batch-${Date.now()}.jsonl`
  );

  const batch = await createOpenAIBatch(env, inputFile.id, endpoint, {
    kind: "sprite_generation",
    model: imageModel(env),
    item_count: String(items.length)
  });

  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO openai_sprite_batches (
      batch_id, input_file_id, output_file_id, error_file_id,
      endpoint, model, status, item_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    batch.id,
    inputFile.id,
    batch.output_file_id ?? null,
    batch.error_file_id ?? null,
    endpoint,
    imageModel(env),
    batch.status ?? "submitted",
    items.length,
    now,
    now
  ).run();

  for (const item of items) {
    await env.DB.prepare(`
      INSERT INTO openai_sprite_batch_items (
        batch_id, custom_id, job_id, taxon_id, status,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'submitted', ?, ?)
    `).bind(
      batch.id,
      item.customId,
      item.job.job_id,
      item.job.taxon_id,
      now,
      now
    ).run();

    await env.DB.prepare(`
      UPDATE sprite_jobs
      SET status = 'batch_submitted',
          attempts = attempts + 1,
          error = NULL,
          updated_at = ?
      WHERE job_id = ?
    `).bind(now, item.job.job_id).run();
  }

  return {
    submitted: true,
    batchId: batch.id,
    status: batch.status,
    inputFileId: inputFile.id,
    endpoint,
    itemCount: items.length,
    movesGenerated: prepared.movesGenerated,
    skipped: prepared.skipped,
    items: items.map((item) => ({
      customId: item.customId,
      jobId: item.job.job_id,
      taxonId: item.job.taxon_id,
      scientificName: item.job.scientific_name,
      references: buildBatchReferenceImages(env, requestUrl, item.job).map((reference) => ({
        kind: reference.kind,
        imageUrl: reference.imageUrl
      }))
    }))
  };
}

async function selectQueuedSpriteJobsForBatch(env, limit, userId = "", seedOnly = false) {
  const baseSelect = `
    SELECT sj.*, t.scientific_name, t.common_name, t.iconic_taxon_name, t.default_photo_url
      ${seedOnly ? ", gst.observed_count AS seed_observed_count, gst.group_key AS seed_group_key" : ""}
    FROM sprite_jobs sj
    JOIN taxa t ON t.taxon_id = sj.taxon_id
    ${seedOnly ? "JOIN global_seed_taxa gst ON gst.taxon_id = sj.taxon_id AND gst.seed_key = ?" : ""}
  `;
  const readyAssetJoin = `
    LEFT JOIN sprite_assets sa
      ON sa.taxon_id = sj.taxon_id
      AND sa.asset_kind = sj.asset_kind
      AND sa.asset_version = sj.asset_version
      AND sa.prompt_hash = sj.prompt_hash
      AND sa.status = 'ready'
  `;
  const whereClause = `
    WHERE sj.status = 'queued'
      AND sa.asset_id IS NULL
    ORDER BY ${seedOnly ? "gst.observed_count DESC," : ""} sj.priority ASC, sj.created_at ASC
    LIMIT ?
  `;

  const statement = seedOnly
    ? env.DB.prepare(`
        ${baseSelect}
        ${readyAssetJoin}
        ${whereClause}
      `).bind(GLOBAL_SEED_KEY, limit)
    : userId
    ? env.DB.prepare(`
        ${baseSelect}
        JOIN user_taxa ut
          ON ut.taxon_id = sj.taxon_id
          AND ut.user_id = ?
        ${readyAssetJoin}
        ${whereClause}
      `).bind(userId, limit)
    : env.DB.prepare(`
        ${baseSelect}
        ${readyAssetJoin}
        ${whereClause}
      `).bind(limit);

  const rows = await statement.all();
  return rows.results ?? [];
}

function buildBatchReferenceImages(env, requestUrl, taxon) {
  const references = [];
  const mode = String(env.IMAGE_REFERENCE_MODE ?? "default_photo").toLowerCase();

  if (mode !== "off" && mode !== "style_only" && isSafeReferenceImageUrl(taxon.default_photo_url)) {
    references.push({
      kind: "species_photo",
      imageUrl: taxon.default_photo_url
    });
  }

  if (mode !== "off" && env.IMAGE_STYLE_REFERENCE_R2_KEY) {
    references.push({
      kind: "style_sheet",
      imageUrl: new URL(
        `/api/assets/${encodeR2Key(env.IMAGE_STYLE_REFERENCE_R2_KEY)}`,
        requestUrl
      ).toString()
    });
  }

  return references;
}

function publicRequestUrl(env) {
  return `${publicBaseUrl(env)}/`;
}

function publicBaseUrl(env) {
  return String(env.PUBLIC_BASE_URL || "https://inat-battler.intrinsic3141.workers.dev").replace(/\/+$/, "");
}

function openAIImageEditJsonBody(env, promptSpec, referenceImages) {
  return {
    model: imageModel(env),
    prompt: composeOpenAIImagePrompt(promptSpec, imageModel(env), referenceImages),
    images: referenceImages.map((reference) => ({ image_url: reference.imageUrl })),
    size: env.IMAGE_SIZE || "1024x1024",
    quality: env.IMAGE_QUALITY || "medium",
    output_format: env.IMAGE_OUTPUT_FORMAT || "webp",
    background: imageBackgroundForModel(env, imageModel(env))
  };
}

async function uploadOpenAIBatchFile(env, jsonl, filename) {
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), filename);

  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: form
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI batch file upload failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function createOpenAIBatch(env, inputFileId, endpoint, metadata) {
  const response = await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint,
      completion_window: "24h",
      metadata
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI batch creation failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function getSpriteBatch(env, batchId) {
  const remote = env.OPENAI_API_KEY ? await retrieveOpenAIBatch(env, batchId) : null;
  if (remote) await updateStoredSpriteBatch(env, remote);

  const batch = await env.DB.prepare(`
    SELECT *
    FROM openai_sprite_batches
    WHERE batch_id = ?
  `).bind(batchId).first();

  if (!batch) throw new Error("Sprite batch not found");

  const items = await env.DB.prepare(`
    SELECT bi.*, t.scientific_name, t.common_name
    FROM openai_sprite_batch_items bi
    JOIN taxa t ON t.taxon_id = bi.taxon_id
    WHERE bi.batch_id = ?
    ORDER BY bi.created_at ASC
  `).bind(batchId).all();

  return {
    batch: {
      ...batch,
      remoteStatus: remote?.status ?? null,
      requestCounts: remote?.request_counts ?? null
    },
    items: items.results ?? []
  };
}

async function getLatestSpriteBatch(env) {
  const row = await env.DB.prepare(`
    SELECT batch_id
    FROM openai_sprite_batches
    ORDER BY created_at DESC
    LIMIT 1
  `).first();

  if (!row?.batch_id) {
    return { batch: null, items: [] };
  }

  return getSpriteBatch(env, row.batch_id);
}

async function syncSpriteBatch(env, batchId, options = {}) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const remote = await retrieveOpenAIBatch(env, batchId);
  await updateStoredSpriteBatch(env, remote);

  // A batch can expire/cancel with some requests done — OpenAI still puts those
  // completed results in the output file. Sync any terminal batch that has files,
  // not just "completed". Only bail while it is still running.
  const terminalWithFiles =
    remote.status === "completed" ||
    (["expired", "cancelled", "canceled", "failed"].includes(remote.status) &&
      (remote.output_file_id || remote.error_file_id));
  if (!terminalWithFiles) {
    return {
      synced: false,
      batchId,
      status: remote.status,
      requestCounts: remote.request_counts ?? null
    };
  }

  const pendingCustomIds = await getPendingBatchCustomIds(env, batchId);
  const maxItems = Math.max(1, Number(options.maxItems || 25));
  let processed = 0;
  let outputComplete = true;
  let errorComplete = true;

  if (pendingCustomIds.size > 0 && remote.output_file_id) {
    for await (const rawLine of streamOpenAIFileJsonlLines(env, remote.output_file_id)) {
      const customId = customIdFromJsonlLine(rawLine);
      if (customId && !pendingCustomIds.has(customId)) continue;

      const result = await syncSpriteBatchOutputLine(env, batchId, JSON.parse(rawLine));
      if (customId && (result === "ready" || result === "failed")) pendingCustomIds.delete(customId);
      if (result === "ready" || result === "failed") processed += 1;

      if (processed >= maxItems) {
        outputComplete = false;
        break;
      }
    }
  }

  if (pendingCustomIds.size > 0 && outputComplete && remote.error_file_id) {
    for await (const rawLine of streamOpenAIFileJsonlLines(env, remote.error_file_id)) {
      const line = JSON.parse(rawLine);
      const result = await markSpriteBatchItemFailed(
        env,
        batchId,
        line.custom_id,
        line.error?.message ?? JSON.stringify(line.error ?? line)
      );
      if (line.custom_id && result) pendingCustomIds.delete(line.custom_id);
      if (result) processed += 1;

      if (processed >= maxItems) {
        errorComplete = false;
        break;
      }
    }
  }

  // Expired/cancelled batches: requests that never ran are in neither file and
  // will never resolve. Once both files are fully drained, settle the leftovers
  // as failed so the batch reaches a terminal synced state.
  if (remote.status !== "completed" && outputComplete && errorComplete && pendingCustomIds.size > 0) {
    for (const customId of [...pendingCustomIds]) {
      if (processed >= maxItems) { errorComplete = false; break; }
      const result = await markSpriteBatchItemFailed(
        env,
        batchId,
        customId,
        `Batch ${remote.status} before this request completed`
      );
      if (result) {
        pendingCustomIds.delete(customId);
        processed += 1;
      }
    }
  }

  const counts = await getBatchItemSyncCounts(env, batchId);
  const synced = counts.itemCount > 0 && counts.ready + counts.failed >= counts.itemCount;

  return {
    synced,
    batchId,
    status: remote.status,
    ready: counts.ready,
    failed: counts.failed,
    itemCount: counts.itemCount,
    processed,
    remaining: Math.max(0, counts.itemCount - counts.ready - counts.failed),
    partial: !synced || !outputComplete || !errorComplete,
    requestCounts: remote.request_counts ?? null
  };
}

async function syncPendingSpriteBatches(
  env,
  batchLimit = AUTO_SPRITE_BATCH_SYNC_LIMIT,
  maxItems = AUTO_SPRITE_BATCH_SYNC_ITEMS
) {
  if (!env.OPENAI_API_KEY) {
    return { checked: 0, results: [], error: "OPENAI_API_KEY is not configured" };
  }

  const rows = await env.DB.prepare(`
    SELECT b.batch_id
    FROM openai_sprite_batches b
    WHERE b.status IN ('submitted', 'validating', 'in_progress', 'finalizing', 'completed', 'expired', 'cancelled', 'canceled')
      AND EXISTS (
        SELECT 1
        FROM openai_sprite_batch_items bi
        WHERE bi.batch_id = b.batch_id
          AND bi.status NOT IN ('ready', 'failed')
      )
    ORDER BY b.created_at ASC
    LIMIT ?
  `).bind(batchLimit).all();

  const results = [];
  for (const row of rows.results ?? []) {
    try {
      results.push(await syncSpriteBatch(env, row.batch_id, { maxItems }));
    } catch (error) {
      results.push({
        batchId: row.batch_id,
        synced: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { checked: results.length, results };
}

async function retrieveOpenAIBatch(env, batchId) {
  const response = await fetch(`https://api.openai.com/v1/batches/${encodeURIComponent(batchId)}`, {
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI batch retrieve failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function updateStoredSpriteBatch(env, batch) {
  await env.DB.prepare(`
    UPDATE openai_sprite_batches
    SET status = ?,
        output_file_id = ?,
        error_file_id = ?,
        updated_at = ?
    WHERE batch_id = ?
  `).bind(
    batch.status ?? "unknown",
    batch.output_file_id ?? null,
    batch.error_file_id ?? null,
    new Date().toISOString(),
    batch.id
  ).run();
}

async function* streamOpenAIFileJsonlLines(env, fileId) {
  const response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(fileId)}/content`, {
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI file content fetch failed: ${response.status} ${text}`);
  }

  if (!response.body) {
    throw new Error("OpenAI file content response did not include a readable body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReading = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (line) yield line;
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine) yield finalLine;
  } finally {
    if (!doneReading) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchOpenAIFileContent(env, fileId) {
  const lines = [];
  for await (const line of streamOpenAIFileJsonlLines(env, fileId)) {
    lines.push(line);
  }
  return lines.join("\n");
}

async function getPendingBatchCustomIds(env, batchId) {
  const rows = await env.DB.prepare(`
    SELECT custom_id
    FROM openai_sprite_batch_items
    WHERE batch_id = ?
      AND status NOT IN ('ready', 'failed')
  `).bind(batchId).all();

  return new Set((rows.results ?? []).map((row) => String(row.custom_id)));
}

async function getBatchItemSyncCounts(env, batchId) {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) AS item_count,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
    FROM openai_sprite_batch_items
    WHERE batch_id = ?
  `).bind(batchId).first();

  return {
    itemCount: Number(row?.item_count ?? 0),
    ready: Number(row?.ready_count ?? 0),
    failed: Number(row?.failed_count ?? 0)
  };
}

function customIdFromJsonlLine(line) {
  const match = String(line ?? "").match(/"custom_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : "";
}

async function syncSpriteBatchOutputLine(env, batchId, line) {
  if (line.error) {
    const didMark = await markSpriteBatchItemFailed(
      env,
      batchId,
      line.custom_id,
      line.error.message ?? JSON.stringify(line.error)
    );
    return didMark ? "failed" : "ignored";
  }

  if (line.response?.status_code < 200 || line.response?.status_code >= 300) {
    const didMark = await markSpriteBatchItemFailed(
      env,
      batchId,
      line.custom_id,
      JSON.stringify(line.response?.body ?? line.response ?? line)
    );
    return didMark ? "failed" : "ignored";
  }

  const item = await env.DB.prepare(`
    SELECT
      bi.custom_id,
      bi.status AS batch_item_status,
      bi.r2_key AS batch_item_r2_key,
      bi.job_id,
      sj.taxon_id,
      sj.asset_kind,
      sj.asset_version,
      sj.prompt_hash,
      t.scientific_name
    FROM openai_sprite_batch_items bi
    JOIN sprite_jobs sj ON sj.job_id = bi.job_id
    JOIN taxa t ON t.taxon_id = sj.taxon_id
    WHERE bi.batch_id = ?
      AND bi.custom_id = ?
  `).bind(batchId, line.custom_id).first();

  if (!item) return "ignored";
  if (item.batch_item_status === "ready" && item.batch_item_r2_key) return "already_ready";
  if (item.batch_item_status === "failed") return "already_failed";

  const body = line.response?.body ?? {};
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) {
    const didMark = await markSpriteBatchItemFailed(env, batchId, line.custom_id, "Batch output did not include b64_json");
    return didMark ? "failed" : "ignored";
  }

  const outputFormat = body.output_format ?? env.IMAGE_OUTPUT_FORMAT ?? "webp";
  const contentType = contentTypeForOutputFormat(outputFormat);
  const extension = extensionForOutputFormat(outputFormat);
  const r2Key = `${speciesAssetPrefix(item.asset_version, item.taxon_id, item.scientific_name)}/${String(item.prompt_hash).slice(0, 16)}/${item.asset_kind}.${extension}`;
  const imageBytes = base64ToArrayBuffer(b64);
  const usage = {
    ...(body.usage ?? {}),
    endpoint: "images.edits.batch",
    openai_batch_id: batchId,
    custom_id: line.custom_id,
    output_bytes: imageBytes.byteLength
  };
  const costEstimateUsd = estimateOpenAICostUsd(
    env,
    usage,
    floatEnv(env, "OPENAI_BATCH_DISCOUNT_MULTIPLIER", 0.5)
  );
  const assetId = await sha256Hex(`${item.taxon_id}|${item.asset_kind}|${item.asset_version}|${item.prompt_hash}`);
  const now = new Date().toISOString();

  await env.ASSETS.put(r2Key, imageBytes, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable"
    },
    customMetadata: {
      taxonId: String(item.taxon_id),
      promptHash: String(item.prompt_hash),
      assetKind: String(item.asset_kind),
      assetVersion: String(item.asset_version),
      scientificName: String(item.scientific_name ?? ""),
      speciesSlug: slugifyScientificName(item.scientific_name),
      openaiBatchId: batchId,
      outputBytes: String(imageBytes.byteLength)
    }
  });

  await env.DB.prepare(`
    INSERT INTO sprite_assets (
      asset_id, taxon_id, asset_kind, asset_version,
      model, prompt_hash, r2_key, status,
      content_type, cost_estimate_usd, usage_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
    ON CONFLICT(taxon_id, asset_kind, asset_version, prompt_hash)
    DO UPDATE SET
      r2_key = excluded.r2_key,
      status = 'ready',
      content_type = excluded.content_type,
      cost_estimate_usd = excluded.cost_estimate_usd,
      usage_json = excluded.usage_json
  `).bind(
    assetId,
    item.taxon_id,
    item.asset_kind,
    item.asset_version,
    body.model ?? imageModel(env),
    item.prompt_hash,
    r2Key,
    contentType,
    costEstimateUsd,
    JSON.stringify(usage),
    now
  ).run();

  await addGlobalGenerationCost(env, costEstimateUsd ?? 0);
  await markSpriteJobReady(env, item.job_id);

  await env.DB.prepare(`
    UPDATE openai_sprite_batch_items
    SET status = 'ready',
        r2_key = ?,
        usage_json = ?,
        error = NULL,
        updated_at = ?
    WHERE batch_id = ?
      AND custom_id = ?
  `).bind(r2Key, JSON.stringify(usage), now, batchId, line.custom_id).run();

  return "ready";
}

async function markSpriteBatchItemFailed(env, batchId, customId, error) {
  if (!customId) return false;

  const item = await env.DB.prepare(`
    SELECT job_id
    FROM openai_sprite_batch_items
    WHERE batch_id = ?
      AND custom_id = ?
  `).bind(batchId, customId).first();

  if (!item) return false;

  const message = String(error ?? "Batch item failed").slice(0, 2000);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE openai_sprite_batch_items
    SET status = 'failed',
        error = ?,
        updated_at = ?
    WHERE batch_id = ?
      AND custom_id = ?
  `).bind(message, now, batchId, customId).run();

  await markSpriteJobFailed(env, item.job_id, new Error(message));
  return true;
}

function parseJsonl(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function customIdForBatchItem(job) {
  return `sprite_${job.taxon_id}_${String(job.prompt_hash).slice(0, 16)}`;
}

async function devGenerateNextSpriteJob(env) {
  const row = await env.DB.prepare(`
    SELECT job_id
    FROM sprite_jobs
    WHERE status IN ('queued', 'failed')
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `).first();

  if (!row?.job_id) {
    return { generated: false, message: "No queued jobs" };
  }

  return {
    generated: true,
    ...(await devGenerateSpriteForJob(env, row.job_id))
  };
}

async function devGenerateSpriteForJob(env, jobId) {
  const job = await env.DB.prepare(`
    SELECT sj.*, t.scientific_name, t.common_name, t.iconic_taxon_name, t.ancestry
    FROM sprite_jobs sj
    JOIN taxa t ON t.taxon_id = sj.taxon_id
    WHERE sj.job_id = ?
  `).bind(jobId).first();

  if (!job) throw new Error("Job not found");

  const taxon = taxonSummaryFromRow(job);
  const promptSpec = await getOrCreatePromptSpec(env, Number(job.taxon_id));
  const genome = promptSpec.genome ?? createGenome(taxon);
  const svg = buildDevSvgSpriteSheet(genome);
  const speciesPrefix = speciesAssetPrefix(job.asset_version, job.taxon_id, job.scientific_name);
  const r2Key = `${speciesPrefix}/${String(job.prompt_hash).slice(0, 16)}/${job.asset_kind}.svg`;

  await env.ASSETS.put(r2Key, svg, {
    httpMetadata: {
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=31536000, immutable"
    },
    customMetadata: {
      taxonId: String(job.taxon_id),
      promptHash: String(job.prompt_hash),
      assetKind: String(job.asset_kind),
      assetVersion: String(job.asset_version),
      scientificName: String(job.scientific_name ?? ""),
      speciesSlug: slugifyScientificName(job.scientific_name),
      devGenerated: "true"
    }
  });

  const assetId = await sha256Hex(`${job.taxon_id}|${job.asset_kind}|${job.asset_version}|${job.prompt_hash}`);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO sprite_assets (
      asset_id, taxon_id, asset_kind, asset_version,
      model, prompt_hash, r2_key, status,
      width, height, content_type, cost_estimate_usd, usage_json, created_at
    )
    VALUES (?, ?, ?, ?, 'dev-svg', ?, ?, 'ready', 512, 512, 'image/svg+xml', 0, '{}', ?)
    ON CONFLICT(taxon_id, asset_kind, asset_version, prompt_hash)
    DO UPDATE SET
      model = excluded.model,
      r2_key = excluded.r2_key,
      status = 'ready',
      width = excluded.width,
      height = excluded.height,
      content_type = excluded.content_type,
      cost_estimate_usd = excluded.cost_estimate_usd,
      usage_json = excluded.usage_json
  `).bind(
    assetId,
    job.taxon_id,
    job.asset_kind,
    job.asset_version,
    job.prompt_hash,
    r2Key,
    now
  ).run();

  await markSpriteJobReady(env, jobId);

  return { assetId, r2Key, url: `/api/assets/${encodeR2Key(r2Key)}` };
}

// ---------------------------------------------------------------------------
// Species move dossiers (LLM-researched signature moves -> genome v2)
// ---------------------------------------------------------------------------

function moveModel(env) {
  return env.MOVE_MODEL || "gpt-5.4-nano";
}

async function fetchWikipediaSummaries(env, taxonIds) {
  const map = new Map();
  for (const chunk of chunkArray(taxonIds, 30)) {
    try {
      const url = new URL(`${INAT_API_BASE_URL}/taxa/${chunk.join(",")}`);
      url.searchParams.set("per_page", String(chunk.length));
      url.searchParams.set("fields", INAT_TAXON_WIKIPEDIA_FIELDS);
      url.searchParams.set("ttl", String(INAT_TAXON_CACHE_TTL_SECONDS));
      const res = await fetchInatWithRetry(url.toString());
      if (!res.ok) continue;
      const data = await res.json();
      for (const taxon of data.results ?? []) {
        if (taxon?.wikipedia_summary) {
          map.set(Number(taxon.id), String(taxon.wikipedia_summary).replace(/<[^>]+>/g, " "));
        }
      }
    } catch {
      // Summaries are best-effort grounding; the prompt handles their absence.
    }
    if (taxonIds.length > 30) await sleep(600);
  }
  return map;
}

async function writeGenomeV2(env, taxonRow, dossier) {
  const summary = taxonSummaryFromRow(taxonRow);
  summary.defaultPhotoUrl = taxonRow.default_photo_url ?? null;

  const genome = assembleGenomeV2(summary, dossier);
  const promptSpec = buildSpriteSheetPromptV2(summary, genome);

  await env.DB.prepare(`
    INSERT OR REPLACE INTO creature_genomes (
      taxon_id, genome_version, body_plan,
      ecological_types_json, battle_role,
      prompt_json, genome_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    taxonRow.taxon_id,
    GENOME_VERSION_MOVES,
    genome.bodyPlan,
    JSON.stringify(genome.types),
    genome.role,
    JSON.stringify(promptSpec),
    JSON.stringify(genome),
    new Date().toISOString()
  ).run();

  return genome;
}

async function loadSpeciesMovesMap(env, taxonIds) {
  const ids = [...new Set(taxonIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();

  const map = new Map();
  for (const chunk of chunkArray(ids, D1_ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT taxon_id, genome_json
      FROM creature_genomes
      WHERE genome_version >= ? AND taxon_id IN (${placeholders})
    `).bind(GENOME_VERSION_MOVES, ...chunk).all();

    for (const row of rows.results ?? []) {
      try {
        const genome = JSON.parse(row.genome_json);
        if (Array.isArray(genome.moves) && genome.moves.length === 4) {
          map.set(Number(row.taxon_id), genome);
        }
      } catch {
        // Ignore malformed rows; procedural moves remain the fallback.
      }
    }
  }
  return map;
}

async function generateMovesForTaxon(env, taxonId, options = {}) {
  if (!env.OPENAI_API_KEY) throw httpError("OPENAI_API_KEY is not configured", 400);

  const taxonRow = await ensureTaxonInDb(env, taxonId);
  const summaries = await fetchWikipediaSummaries(env, [taxonId]);
  const messages = dossierMessages(taxonSummaryFromRow(taxonRow), summaries.get(taxonId) ?? null, {
    imageDataUrl: options.imageDataUrl || null
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: moveModel(env),
      messages,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw httpError(`OpenAI chat failed (${res.status}): ${text.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const dossier = validateDossier(content, taxonId);
  const genome = await writeGenomeV2(env, taxonRow, dossier);

  return { taxonId, model: moveModel(env), genome };
}

async function getTaxonGenome(env, taxonId) {
  const row = await env.DB.prepare("SELECT * FROM creature_genomes WHERE taxon_id = ?").bind(taxonId).first();
  if (!row) throw httpError(`No genome stored for taxon ${taxonId}`, 404);
  return {
    taxonId,
    genomeVersion: row.genome_version,
    genome: JSON.parse(row.genome_json),
    promptSpec: JSON.parse(row.prompt_json)
  };
}

async function submitMoveBatch(env, { limit, userId }) {
  const rows = await env.DB.prepare(`
    SELECT t.*, (
      SELECT COUNT(*) FROM user_taxa ut2 WHERE ut2.taxon_id = t.taxon_id
    ) AS roster_count
    FROM taxa t
    WHERE t.taxon_id NOT IN (
        SELECT taxon_id FROM creature_genomes WHERE genome_version >= ?
      )
      AND (? = '' OR EXISTS (
        SELECT 1 FROM user_taxa ut WHERE ut.user_id = ? AND ut.taxon_id = t.taxon_id
      ))
      AND (
        EXISTS (SELECT 1 FROM user_taxa ut3 WHERE ut3.taxon_id = t.taxon_id)
        OR EXISTS (SELECT 1 FROM global_seed_taxa gst WHERE gst.taxon_id = t.taxon_id)
      )
    ORDER BY roster_count DESC, t.taxon_id ASC
    LIMIT ?
  `).bind(GENOME_VERSION_MOVES, userId, userId, limit).all();

  const taxa = rows.results ?? [];
  if (!taxa.length) {
    return { queued: 0, message: "Every eligible species already has signature moves." };
  }

  return createMoveBatchForTaxa(env, taxa);
}

async function createMoveBatchForTaxa(env, taxa, options = {}) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const cleanTaxa = (Array.isArray(taxa) ? taxa : []).filter((row) => Number.isFinite(Number(row.taxon_id)));
  if (!cleanTaxa.length) {
    return { queued: 0, message: "No taxa available for move batch." };
  }

  const taxonIds = cleanTaxa.map((row) => Number(row.taxon_id));
  const summaries = await fetchWikipediaSummaries(env, taxonIds);

  const jsonl = cleanTaxa.map((row) => JSON.stringify({
    custom_id: `moves:${row.taxon_id}`,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: moveModel(env),
      messages: dossierMessages(taxonSummaryFromRow(row), summaries.get(Number(row.taxon_id)) ?? null),
      response_format: { type: "json_object" }
    }
  })).join("\n");

  const inputFile = await uploadOpenAIBatchFile(env, jsonl, `move-batch-${Date.now()}.jsonl`);
  const batch = await createOpenAIBatch(env, inputFile.id, "/v1/chat/completions", {
    purpose: "species_moves"
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO move_batches (
      batch_id, input_file_id, status, model, item_count, taxon_ids_json,
      auto_submit_images, image_submit_status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    batch.id,
    inputFile.id,
    batch.status ?? "submitted",
    moveModel(env),
    cleanTaxa.length,
    JSON.stringify(taxonIds),
    options.autoSubmitImages === true ? 1 : 0,
    options.autoSubmitImages === true ? "pending" : null,
    now,
    now
  ).run();

  return {
    batchId: batch.id,
    status: batch.status,
    queued: cleanTaxa.length,
    taxonIds,
    autoSubmitImages: options.autoSubmitImages === true
  };
}

async function updateStoredMoveBatchRemoteStatus(env, batchId, batch, row = {}) {
  await env.DB.prepare(`
    UPDATE move_batches
    SET status = ?, output_file_id = ?, updated_at = ?
    WHERE batch_id = ?
  `).bind(
    batch.status ?? "unknown",
    batch.output_file_id ?? row.output_file_id ?? null,
    new Date().toISOString(),
    batchId
  ).run();
}

async function getMoveBatch(env, batchId) {
  const row = await env.DB.prepare("SELECT * FROM move_batches WHERE batch_id = ?").bind(batchId).first();
  if (!row) throw httpError("Move batch not found", 404);

  try {
    const batch = await retrieveOpenAIBatch(env, batchId);
    await updateStoredMoveBatchRemoteStatus(env, batchId, batch, row);
    row.status = batch.status;
    row.output_file_id = batch.output_file_id ?? row.output_file_id;
  } catch {
    // Offline or missing key: return the stored snapshot.
  }

  return {
    batchId: row.batch_id,
    status: row.status,
    model: row.model,
    itemCount: row.item_count,
    appliedCount: row.applied_count,
    failedCount: row.failed_count,
    error: row.error,
    autoSubmitImages: Number(row.auto_submit_images) === 1,
    imageBatchId: row.image_batch_id,
    imageSubmitStatus: row.image_submit_status,
    imageSubmitError: row.image_submit_error,
    imageSubmittedAt: row.image_submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function syncMoveBatch(env, batchId) {
  const row = await env.DB.prepare("SELECT * FROM move_batches WHERE batch_id = ?").bind(batchId).first();
  if (!row) throw httpError("Move batch not found", 404);

  const batch = await retrieveOpenAIBatch(env, batchId);
  await updateStoredMoveBatchRemoteStatus(env, batchId, batch, row);
  let applied = 0;
  let failed = 0;
  const errors = [];

  if (batch.output_file_id) {
    const content = await fetchOpenAIFileContent(env, batch.output_file_id);
    for (const line of parseJsonl(content)) {
      const taxonId = Number(String(line.custom_id ?? "").replace("moves:", ""));
      try {
        if (line.error) throw new Error(line.error.message ?? "batch line error");
        const messageContent = line.response?.body?.choices?.[0]?.message?.content;
        if (!messageContent) throw new Error("no completion content");

        const dossier = validateDossier(messageContent, taxonId);
        const taxonRow = await env.DB.prepare("SELECT * FROM taxa WHERE taxon_id = ?").bind(taxonId).first();
        if (!taxonRow) throw new Error("taxon missing from D1");

        await writeGenomeV2(env, taxonRow, dossier);
        applied += 1;
      } catch (error) {
        failed += 1;
        if (errors.length < 8) {
          errors.push(`${taxonId}: ${error instanceof Error ? error.message : "failed"}`);
        }
      }
    }
  }

  await env.DB.prepare(`
    UPDATE move_batches
    SET status = ?, output_file_id = ?, applied_count = ?, failed_count = ?, error = ?, updated_at = ?
    WHERE batch_id = ?
  `).bind(
    batch.status,
    batch.output_file_id ?? row.output_file_id,
    applied,
    failed,
    errors.length ? errors.join(" | ") : null,
    new Date().toISOString(),
    batchId
  ).run();

  return { batchId, status: batch.status, applied, failed, errors };
}

async function syncAutoMoveBatchImageSubmissions(env, limit = AUTO_MOVE_BATCH_SYNC_LIMIT) {
  if (!env.OPENAI_API_KEY) {
    return { checked: 0, results: [], error: "OPENAI_API_KEY is not configured" };
  }

  const rows = await env.DB.prepare(`
    SELECT *
    FROM move_batches
    WHERE auto_submit_images = 1
      AND image_batch_id IS NULL
      AND COALESCE(image_submit_status, 'pending') NOT IN ('submitted', 'skipped')
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(limit).all();

  const results = [];
  for (const row of rows.results ?? []) {
    results.push(await syncAutoMoveBatchImageSubmission(env, row));
  }

  return { checked: results.length, results };
}

async function syncAutoMoveBatchImageSubmission(env, row) {
  const moveBatchId = row.batch_id;
  const result = {
    moveBatchId,
    status: row.status,
    imageSubmitStatus: row.image_submit_status ?? "pending"
  };

  try {
    const remote = await retrieveOpenAIBatch(env, moveBatchId);
    await updateStoredMoveBatchRemoteStatus(env, moveBatchId, remote, row);
    result.status = remote.status;

    if (MOVE_BATCH_TERMINAL_FAILURE_STATUSES.has(String(remote.status ?? "").toLowerCase())) {
      const error = `Move batch ended with status ${remote.status}`;
      await setMoveBatchImageSubmitStatus(env, moveBatchId, {
        status: "skipped",
        error
      });
      return { ...result, imageSubmitStatus: "skipped", error };
    }

    if (remote.status !== "completed") {
      await setMoveBatchImageSubmitStatus(env, moveBatchId, { status: "waiting" });
      return { ...result, imageSubmitStatus: "waiting", requestCounts: remote.request_counts ?? null };
    }

    const syncResult = await syncMoveBatch(env, moveBatchId);
    const taxonIds = moveBatchTaxonIds(row);
    const moveGenomeTaxa = await loadMoveGenomeTaxonIds(env, taxonIds);
    const imageTaxonIds = taxonIds.filter((taxonId) => moveGenomeTaxa.has(taxonId));
    const skippedMoveTaxa = taxonIds.length - imageTaxonIds.length;

    if (imageTaxonIds.length === 0) {
      const error = "Move batch completed, but no taxa produced usable move genomes.";
      await setMoveBatchImageSubmitStatus(env, moveBatchId, {
        status: "skipped",
        error
      });
      return {
        ...result,
        imageSubmitStatus: "skipped",
        applied: syncResult.applied,
        failed: syncResult.failed,
        error
      };
    }

    const submitResult = await submitSpriteBatchForTaxa(env, publicRequestUrl(env), imageTaxonIds);
    if (submitResult.submitted) {
      await setMoveBatchImageSubmitStatus(env, moveBatchId, {
        status: "submitted",
        imageBatchId: submitResult.batchId
      });
      return {
        ...result,
        imageSubmitStatus: "submitted",
        imageBatchId: submitResult.batchId,
        applied: syncResult.applied,
        failed: syncResult.failed,
        skippedMoveTaxa,
        imageItemCount: submitResult.itemCount,
        existingAssets: submitResult.existingAssets?.length ?? 0
      };
    }

    const status = submitResult.stage === "moves" ? "error" : "skipped";
    const error = submitResult.message ?? "Image batch was not submitted.";
    await setMoveBatchImageSubmitStatus(env, moveBatchId, { status, error });
    return {
      ...result,
      imageSubmitStatus: status,
      applied: syncResult.applied,
      failed: syncResult.failed,
      skippedMoveTaxa,
      error,
      submitResult
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    await setMoveBatchImageSubmitStatus(env, moveBatchId, {
      status: "error",
      error: message
    });
    return { ...result, imageSubmitStatus: "error", error: message };
  }
}

function moveBatchTaxonIds(row) {
  try {
    const parsed = JSON.parse(row.taxon_ids_json ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((taxonId) => Number(taxonId)).filter(Number.isFinite))];
  } catch {
    return [];
  }
}

async function setMoveBatchImageSubmitStatus(env, batchId, { status, imageBatchId = null, error = null }) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE move_batches
    SET image_batch_id = ?,
        image_submit_status = ?,
        image_submit_error = ?,
        image_submitted_at = ?,
        updated_at = ?
    WHERE batch_id = ?
  `).bind(
    imageBatchId,
    status,
    error,
    imageBatchId ? now : null,
    now,
    batchId
  ).run();
}

async function loadReadySpriteVariantMap(env, taxonIds) {
  const ids = [...new Set(taxonIds.map(Number).filter(Number.isFinite))];
  const map = new Map();

  for (const chunk of chunkArray(ids, D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT
        asset_id,
        taxon_id,
        model,
        prompt_hash,
        r2_key,
        width,
        height,
        content_type,
        created_at
      FROM sprite_assets
      WHERE taxon_id IN (${placeholders})
        AND asset_kind = ?
        AND asset_version = ?
        AND status = 'ready'
      ORDER BY
        taxon_id ASC,
        CASE
          WHEN model = 'manual-upload' OR model = 'manual-upload-web' OR prompt_hash LIKE 'manual-upload:%' THEN 1
          WHEN prompt_hash LIKE 'manual-%' THEN 2
          ELSE 3
        END,
        created_at DESC,
        asset_id DESC
    `).bind(...chunk, DEFAULT_ASSET_KIND, ASSET_VERSION).all();

    for (const row of rows.results ?? []) {
      const taxonId = Number(row.taxon_id);
      if (!map.has(taxonId)) map.set(taxonId, []);
      map.get(taxonId).push(spriteVariantFromRow(row));
    }
  }

  for (const variants of map.values()) {
    variants.forEach((variant, index) => {
      variant.index = index;
      variant.count = variants.length;
      variant.label = `Sprite ${index + 1} of ${variants.length}`;
    });
  }

  return map;
}

function spriteVariantFromRow(row) {
  return {
    assetId: row.asset_id,
    taxonId: Number(row.taxon_id),
    r2Key: row.r2_key,
    url: `/api/assets/${encodeR2Key(row.r2_key)}`,
    model: row.model || null,
    promptHash: row.prompt_hash || null,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    contentType: row.content_type || null,
    createdAt: row.created_at,
    index: 0,
    count: 1,
    label: "Sprite 1 of 1"
  };
}

function publicSpriteVariant(variant) {
  if (!variant) return null;
  return {
    assetId: variant.assetId,
    url: variant.url,
    model: variant.model,
    promptHash: variant.promptHash,
    width: variant.width,
    height: variant.height,
    contentType: variant.contentType,
    createdAt: variant.createdAt,
    index: variant.index,
    count: variant.count,
    label: variant.label
  };
}

function selectSpriteVariant(variants, preferredAssetId) {
  const safeVariants = Array.isArray(variants) ? variants : [];
  if (safeVariants.length === 0) return null;

  if (preferredAssetId) {
    const preferred = safeVariants.find((variant) => variant.assetId === preferredAssetId);
    if (preferred) return preferred;
  }

  return safeVariants[0];
}

async function loadUserSpritePreferenceMap(env, userId, taxonIds) {
  const ids = [...new Set(taxonIds.map(Number).filter(Number.isFinite))];
  const map = new Map();

  for (const chunk of chunkArray(ids, D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT taxon_id, asset_id
      FROM user_sprite_preferences
      WHERE user_id = ?
        AND taxon_id IN (${placeholders})
    `).bind(userId, ...chunk).all();

    for (const row of rows.results ?? []) {
      map.set(Number(row.taxon_id), String(row.asset_id));
    }
  }

  return map;
}

async function setUserSpritePreference(env, userId, taxonId, assetId) {
  if (!userId) throw httpError("Missing userId", 400);
  if (!Number.isFinite(taxonId) || taxonId <= 0) throw httpError("Missing taxonId", 400);
  if (!assetId) throw httpError("Missing assetId", 400);

  const owned = await env.DB.prepare(`
    SELECT 1
    FROM user_taxa
    WHERE user_id = ?
      AND taxon_id = ?
  `).bind(userId, taxonId).first();
  if (!owned) throw httpError("That species is not in this user's roster", 404);

  const variants = (await loadReadySpriteVariantMap(env, [taxonId])).get(taxonId) ?? [];
  const selected = variants.find((variant) => variant.assetId === assetId);
  if (!selected) throw httpError("That sprite version is not available for this species", 400);

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO user_sprite_preferences (
      user_id, taxon_id, asset_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, taxon_id)
    DO UPDATE SET asset_id = excluded.asset_id, updated_at = excluded.updated_at
  `).bind(userId, taxonId, assetId, now, now).run();

  return {
    userId,
    taxonId,
    selectedAssetId: selected.assetId,
    sprite: {
      status: "ready",
      url: selected.url,
      assetId: selected.assetId,
      variantIndex: selected.index,
      variantCount: selected.count,
      variants: variants.map(publicSpriteVariant)
    }
  };
}

function rosterOptionsFromUrl(url) {
  return {
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
    q: url.searchParams.get("q") ?? "",
    sort: url.searchParams.get("sort") ?? "obs",
    status: url.searchParams.get("status") ?? "all",
    iconic: url.searchParams.get("iconic") ?? ""
  };
}

const ROSTER_SORT_CLAUSES = {
  obs: "obs_count DESC, taxon_id ASC",
  name: "lower(COALESCE(common_name, scientific_name)) ASC",
  affinity: "bond_level DESC, obs_count DESC",
  level: "COALESCE(points_spent, 0) DESC, obs_count DESC",
  status: "(r2_key IS NOT NULL OR custom_r2_key IS NOT NULL) DESC, obs_count DESC"
};

async function getRosterSummary(env, userId) {
  const row = await env.DB.prepare(`
    WITH roster_status AS (
      SELECT
        ut.obs_count,
        ut.bond_level,
        COALESCE(st.points_spent, 0) AS points_spent,
        EXISTS (
          SELECT 1
          FROM sprite_assets sa
          WHERE sa.taxon_id = ut.taxon_id
            AND sa.asset_kind = ?
            AND sa.asset_version = ?
            AND sa.status = 'ready'
        ) OR EXISTS (
          SELECT 1
          FROM user_sprite_submissions uss
          WHERE uss.user_id = ut.user_id
            AND uss.taxon_id = ut.taxon_id
            AND uss.status != 'rejected'
        ) AS has_ready,
        EXISTS (
          SELECT 1
          FROM sprite_jobs sj
          WHERE sj.taxon_id = ut.taxon_id
            AND sj.asset_kind = ?
            AND sj.asset_version = ?
            AND sj.status IN ('queued', 'running', 'batch_submitted')
        ) AS has_pending,
        EXISTS (
          SELECT 1
          FROM sprite_jobs sj
          WHERE sj.taxon_id = ut.taxon_id
            AND sj.asset_kind = ?
            AND sj.asset_version = ?
            AND sj.status = 'failed'
        ) AS has_failed
      FROM user_taxa ut
      LEFT JOIN species_training st ON st.user_id = ut.user_id AND st.taxon_id = ut.taxon_id
      WHERE ut.user_id = ?
    )
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN has_ready THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN NOT has_ready AND has_pending THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN NOT has_ready AND NOT has_pending AND has_failed THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN NOT has_ready AND NOT has_pending AND NOT has_failed THEN 1 ELSE 0 END) AS missing_count,
      SUM(COALESCE(obs_count, 0)) AS observation_total,
      SUM(COALESCE(bond_level, 0)) AS affinity_total,
      SUM(COALESCE(points_spent, 0)) AS training_spent
    FROM roster_status
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    userId
  ).first();

  return {
    totalCount: Number(row?.total_count ?? 0),
    readyCount: Number(row?.ready_count ?? 0),
    pendingCount: Number(row?.pending_count ?? 0),
    failedCount: Number(row?.failed_count ?? 0),
    missingCount: Number(row?.missing_count ?? 0),
    observationTotal: Number(row?.observation_total ?? 0),
    affinityTotal: Number(row?.affinity_total ?? 0),
    trainingSpent: Number(row?.training_spent ?? 0)
  };
}

async function getRoster(env, userId, options = {}) {
  const limit = clampInt(options.limit, 1, 250, 100);
  const offset = clampInt(options.offset, 0, 1000000, 0);
  const q = String(options.q ?? "");
  const iconic = String(options.iconic ?? "");
  const status = ["ready", "pending", "missing"].includes(options.status) ? options.status : "all";
  const orderBy = ROSTER_SORT_CLAUSES[options.sort] ?? ROSTER_SORT_CLAUSES.obs;

  const baseQuery = `
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.iconic_taxon_name,
      t.ancestry,
      t.default_photo_url,
      t.genus_id,
      t.family_id,
      ut.obs_count,
      ut.bond_level,
      ut.rg_obs_count,
      st.nickname,
      st.allocated_json,
      st.points_spent,
      (
        SELECT sa.r2_key
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.model = 'manual-upload' OR sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS r2_key,
      (
        SELECT sj.status
        FROM sprite_jobs sj
        WHERE sj.taxon_id = t.taxon_id
          AND sj.asset_kind = ?
          AND sj.asset_version = ?
        ORDER BY
          CASE sj.status
            WHEN 'running' THEN 1
            WHEN 'queued' THEN 2
            WHEN 'failed' THEN 3
            WHEN 'ready' THEN 4
            ELSE 5
          END,
          sj.updated_at DESC
        LIMIT 1
      ) AS sprite_job_status,
      (
        SELECT uss.r2_key
        FROM user_sprite_submissions uss
        WHERE uss.user_id = ut.user_id
          AND uss.taxon_id = t.taxon_id
          AND uss.status != 'rejected'
        ORDER BY uss.created_at DESC
        LIMIT 1
      ) AS custom_r2_key,
      (
        SELECT uss.status
        FROM user_sprite_submissions uss
        WHERE uss.user_id = ut.user_id
          AND uss.taxon_id = t.taxon_id
        ORDER BY uss.created_at DESC
        LIMIT 1
      ) AS custom_status
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    LEFT JOIN species_training st ON st.user_id = ut.user_id AND st.taxon_id = t.taxon_id
    WHERE ut.user_id = ?
      AND (
        ? = ''
        OR lower(t.scientific_name) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.common_name, '')) LIKE '%' || lower(?) || '%'
      )
      AND (? = '' OR COALESCE(t.iconic_taxon_name, 'Life') = ?)
  `;

  const baseBinds = [
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    userId,
    q,
    q,
    q,
    iconic,
    iconic
  ];

  // Sprite readiness lives in computed columns, so status filtering wraps the
  // base query rather than repeating the correlated subqueries in WHERE.
  const statusClause = `
    (
      ? = 'all'
      OR (? = 'ready' AND (r2_key IS NOT NULL OR custom_r2_key IS NOT NULL))
      OR (? = 'pending' AND r2_key IS NULL AND custom_r2_key IS NULL
          AND sprite_job_status IN ('queued', 'running'))
      OR (? = 'missing' AND r2_key IS NULL AND custom_r2_key IS NULL
          AND (sprite_job_status IS NULL OR sprite_job_status NOT IN ('queued', 'running')))
    )
  `;
  const statusBinds = [status, status, status, status];

  const rows = await env.DB.prepare(`
    SELECT * FROM (${baseQuery}) roster
    WHERE ${statusClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).bind(...baseBinds, ...statusBinds, limit, offset).all();

  const totalRow = await env.DB.prepare(`
    SELECT COUNT(*) AS total FROM (${baseQuery}) roster
    WHERE ${statusClause}
  `).bind(...baseBinds, ...statusBinds).first();

  const iconicRows = await env.DB.prepare(`
    SELECT COALESCE(t.iconic_taxon_name, 'Life') AS iconic, COUNT(*) AS count
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    WHERE ut.user_id = ?
    GROUP BY COALESCE(t.iconic_taxon_name, 'Life')
    ORDER BY count DESC, iconic ASC
  `).bind(userId).all();

  const buffMap = await loadUserBuffMap(env, userId);
  const rosterRows = rows.results ?? [];
  const rosterTaxonIds = rosterRows.map((row) => Number(row.taxon_id));
  const movesMap = await loadSpeciesMovesMap(env, rosterTaxonIds);
  const variantMap = await loadReadySpriteVariantMap(env, rosterTaxonIds);
  const preferenceMap = await loadUserSpritePreferenceMap(env, userId, rosterTaxonIds);

  return {
    userId,
    total: Number(totalRow?.total ?? rosterRows.length),
    summary: await getRosterSummary(env, userId),
    limit,
    offset,
    iconicCounts: (iconicRows.results ?? []).map((row) => ({
      iconic: row.iconic,
      count: Number(row.count)
    })),
    taxa: rosterRows.map((row) => {
      // The roster is the owner's own view, so pending or approved custom
      // sprites win here; rejected submissions fall back to the global sprite.
      const taxonId = Number(row.taxon_id);
      const variants = variantMap.get(taxonId) ?? [];
      const selectedVariant = selectSpriteVariant(variants, preferenceMap.get(taxonId));
      const finalKey = row.custom_r2_key || selectedVariant?.r2Key || row.r2_key;
      const spriteReady = Boolean(finalKey);
      const spriteUrl = spriteReady ? `/api/assets/${encodeR2Key(finalKey)}` : null;
      const taxon = taxonSummaryFromRow(row, spriteUrl);
      const genome = createGenome(taxon);
      const speciesGenome = movesMap.get(Number(row.taxon_id)) ?? null;
      const battleCreature = createBattleCreature(
        taxon,
        "roster",
        trainingFromRow(row, buffMap),
        speciesGenome?.moves ?? null
      );

      return {
        taxonId: row.taxon_id,
        name: row.common_name || row.scientific_name,
        scientificName: row.scientific_name,
        iconicTaxon: row.iconic_taxon_name,
        iconicTaxonName: row.iconic_taxon_name,
        obsCount: row.obs_count,
        bondLevel: row.bond_level,
        affinityLevel: row.bond_level,
        defaultPhotoUrl: row.default_photo_url,
        sprite: spriteReady
          ? {
              status: "ready",
              url: spriteUrl,
              assetId: row.custom_r2_key ? null : selectedVariant?.assetId ?? null,
              variantIndex: row.custom_r2_key ? 0 : selectedVariant?.index ?? 0,
              variantCount: row.custom_r2_key ? 1 : Math.max(1, variants.length),
              variants: row.custom_r2_key ? [] : variants.map(publicSpriteVariant)
            }
          : {
              status: row.sprite_job_status || "missing",
              url: null,
              placeholder: placeholderFor(row.iconic_taxon_name)
            },
        customSprite: row.custom_status ? { status: row.custom_status } : null,
        nickname: row.nickname ?? null,
        trainingLevel: Math.max(0, Number(row.points_spent ?? 0)),
        rgObsCount: Number(row.rg_obs_count ?? 0),
        bodyPlan: genome.bodyPlan,
        types: genome.types,
        role: genome.role,
        baseStats: genome.baseStats,
        stats: battleCreature.stats,
        maxHp: battleCreature.maxHp,
        moves: battleCreature.moves,
        facts: speciesGenome?.facts ?? null,
        hasSignatureMoves: Boolean(speciesGenome)
      };
    })
  };
}

async function getSpriteStatus(env, taxonIds) {
  if (taxonIds.length === 0) return { sprites: [] };

  const results = [];
  for (const chunk of chunkArray(taxonIds, D1_ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT
        t.taxon_id,
        (
          SELECT sa.r2_key
          FROM sprite_assets sa
          WHERE sa.taxon_id = t.taxon_id
            AND sa.asset_kind = ?
            AND sa.asset_version = ?
            AND sa.status = 'ready'
          ORDER BY
            CASE
              WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
              WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
              ELSE 3
            END,
            sa.created_at DESC
          LIMIT 1
        ) AS r2_key
      FROM taxa t
      WHERE t.taxon_id IN (${placeholders})
    `).bind(DEFAULT_ASSET_KIND, ASSET_VERSION, ...chunk).all();
    results.push(...(rows.results ?? []));
  }

  return {
    sprites: results.map((row) => ({
      taxonId: row.taxon_id,
      status: row.r2_key ? "ready" : "missing",
      url: row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null
    }))
  };
}

async function getSpriteTree(env, options = {}) {
  const q = String(options.q ?? "").trim();
  const rows = await env.DB.prepare(`
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.rank,
      t.iconic_taxon_name,
      t.ancestry,
      t.parent_id,
      (
        SELECT sa.r2_key
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS r2_key,
      (
        SELECT sa.model
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS sprite_model
    FROM taxa t
    WHERE EXISTS (
        SELECT 1
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
      )
      AND (
        ? = ''
        OR lower(t.scientific_name) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.common_name, '')) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.iconic_taxon_name, '')) LIKE '%' || lower(?) || '%'
      )
    ORDER BY COALESCE(t.iconic_taxon_name, 'Life') ASC, t.scientific_name ASC
    LIMIT ?
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    q,
    q,
    q,
    q,
    options.limit ?? 500
  ).all();

  const leaves = (rows.results ?? []).map((row) => ({
    key: `taxon:${row.taxon_id}`,
    taxonId: Number(row.taxon_id),
    name: row.common_name || row.scientific_name,
    scientificName: row.scientific_name,
    commonName: row.common_name ?? null,
    rank: row.rank || "taxon",
    iconicTaxonName: row.iconic_taxon_name || "Life",
    parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
    ancestorIds: parseTaxonAncestry(row.ancestry),
    sprite: {
      status: "ready",
      url: `/api/assets/${encodeR2Key(row.r2_key)}`,
      model: row.sprite_model || null
    },
    children: [],
    spriteCount: 1,
    leaf: true
  }));

  // Phase 1: load named ancestor taxa (orders/families/genera, backfilled in
  // Phase 0) so we can build a real taxonomic tree instead of iconic+genus.
  const ancestorMap = await loadAncestorTaxa(env, leaves);
  const tree = ancestorMap.size > 0
    ? buildTaxonomicTree(leaves, ancestorMap)
    : buildSpriteTree(leaves); // fallback if ancestors aren't backfilled yet

  return {
    totalSprites: leaves.length,
    limit: options.limit ?? 500,
    q,
    roots: tree
  };
}

async function loadAncestorTaxa(env, leaves) {
  const ids = new Set();
  for (const leaf of leaves) {
    for (const id of leaf.ancestorIds || []) ids.add(id);
  }
  const map = new Map();
  for (const chunk of chunkArray([...ids], D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT taxon_id, scientific_name, common_name, rank, iconic_taxon_name
       FROM taxa WHERE taxon_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const r of rows.results ?? []) {
      map.set(Number(r.taxon_id), {
        taxonId: Number(r.taxon_id),
        scientificName: r.scientific_name,
        commonName: r.common_name ?? null,
        rank: String(r.rank || "").toLowerCase(),
        iconicTaxonName: r.iconic_taxon_name || null
      });
    }
  }
  return map;
}

async function getRecentSprites(env, options = {}) {
  const q = String(options.q ?? "").trim();
  const limit = Math.max(1, Math.min(200, Number(options.limit ?? 80)));
  const rows = await env.DB.prepare(`
    SELECT
      sa.asset_id,
      sa.taxon_id,
      sa.model,
      sa.prompt_hash,
      sa.r2_key,
      sa.width,
      sa.height,
      sa.content_type,
      sa.created_at,
      t.scientific_name,
      t.common_name,
      t.rank,
      t.iconic_taxon_name
    FROM sprite_assets sa
    JOIN taxa t ON t.taxon_id = sa.taxon_id
    WHERE sa.asset_kind = ?
      AND sa.asset_version = ?
      AND sa.status = 'ready'
      AND (
        ? = ''
        OR lower(t.scientific_name) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.common_name, '')) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.iconic_taxon_name, '')) LIKE '%' || lower(?) || '%'
        OR CAST(sa.taxon_id AS TEXT) = ?
      )
    ORDER BY sa.created_at DESC, sa.asset_id DESC
    LIMIT ?
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    q,
    q,
    q,
    q,
    q,
    limit
  ).all();

  const sprites = (rows.results ?? []).map((row) => ({
    assetId: row.asset_id,
    taxonId: Number(row.taxon_id),
    name: row.common_name || row.scientific_name,
    scientificName: row.scientific_name,
    commonName: row.common_name ?? null,
    rank: row.rank || "taxon",
    iconicTaxonName: row.iconic_taxon_name || "Life",
    sprite: {
      status: "ready",
      url: `/api/assets/${encodeR2Key(row.r2_key)}`,
      model: row.model || null,
      promptHash: row.prompt_hash || null,
      width: row.width === null || row.width === undefined ? null : Number(row.width),
      height: row.height === null || row.height === undefined ? null : Number(row.height),
      contentType: row.content_type || null,
      createdAt: row.created_at
    }
  }));

  return {
    sprites,
    totalSprites: sprites.length,
    limit,
    q
  };
}

async function getMissingAncestorTaxonIds(env) {
  // Ancestry strings of every taxon that has a ready sprite.
  const rows = await env.DB.prepare(`
    SELECT DISTINCT t.taxon_id, t.ancestry
    FROM taxa t
    WHERE EXISTS (
      SELECT 1 FROM sprite_assets sa
      WHERE sa.taxon_id = t.taxon_id
        AND sa.asset_kind = ?
        AND sa.asset_version = ?
        AND sa.status = 'ready'
    )
  `).bind(DEFAULT_ASSET_KIND, ASSET_VERSION).all();

  const ancestorIds = new Set();
  const orphanTaxa = []; // ready-sprite taxa with no usable ancestry -> can't be placed in the tree
  let readyCount = 0;
  for (const row of rows.results ?? []) {
    readyCount += 1;
    const ids = parseTaxonAncestry(row.ancestry);
    if (ids.length === 0) orphanTaxa.push(Number(row.taxon_id));
    for (const id of ids) ancestorIds.add(id);
  }

  // Which of those ancestors already exist as their own taxa rows?
  const present = new Set();
  const allIds = [...ancestorIds];
  for (const chunk of chunkArray(allIds, D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const found = await env.DB.prepare(
      `SELECT taxon_id FROM taxa WHERE taxon_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const r of found.results ?? []) present.add(Number(r.taxon_id));
  }

  const missing = allIds.filter((id) => !present.has(id));
  return {
    readySpriteTaxa: readyCount,
    distinctAncestors: allIds.length,
    alreadyStored: present.size,
    missing,
    orphanTaxa
  };
}

async function bulkUpsertTaxa(env, taxa) {
  const now = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  let statements = [];
  for (const taxon of taxa) {
    const id = Number.parseInt(taxon?.id, 10);
    if (!Number.isFinite(id) || !taxon?.name) {
      skipped += 1;
      continue;
    }
    statements.push(prepareTaxonUpsert(env, { ...taxon, id }, now));
    upserted += 1;
    if (statements.length >= 50) {
      await env.DB.batch(statements);
      statements = [];
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return { upserted, skipped };
}

// We navigate by the major Linnaean rungs only. Each maps to itself and
// creates a visible tree level. EVERY other iNat rank (subphylum, subclass,
// suborder, superfamily, subfamily, tribe, section, subgenus, complex, ...) is
// a pass-through: it stays in the ancestry chain but creates no level, so each
// drill-down path is a consistent kingdom>phylum>class>order>family>genus>species.
const RANK_BAND = new Map(
  ["kingdom", "phylum", "class", "order", "family", "genus"].map((r) => [r, r])
);

// Build a real taxonomic tree: Life -> kingdom -> phylum -> class -> order ->
// family -> genus -> species(leaf), using backfilled ancestor names. Adapted
// from the rank-band approach in the iNat_trees client (its worker only does
// phylo file export; tree construction is client-side).
function buildTaxonomicTree(leaves, ancestorMap) {
  if (!Array.isArray(leaves) || leaves.length === 0) return [];

  const lifeNode = branchNode("taxon:life", "Life", "root");
  const ensureChild = (parent, key, factory) => {
    if (!parent.childMap.has(key)) parent.childMap.set(key, factory());
    return parent.childMap.get(key);
  };

  for (const leaf of leaves) {
    let cursor = lifeNode;
    for (const ancestorId of leaf.ancestorIds || []) {
      if (ancestorId === 48460) continue; // Life root, already represented
      const info = ancestorMap.get(ancestorId);
      if (!info) continue;
      const band = RANK_BAND.get(info.rank);
      if (!band) continue; // pass-through rank (subfamily/tribe/subgenus/...)
      const key = `taxon:${ancestorId}`;
      const node = ensureChild(cursor, key, () => branchNode(
        key,
        info.commonName || info.scientificName,
        band
      ));
      node.scientificName = info.scientificName;
      node.taxonId = ancestorId;
      if (info.iconicTaxonName) node.iconicTaxonName = info.iconicTaxonName;
      cursor = node;
    }
    cursor.children.push(leaf);
  }

  const finalize = (node) => {
    const direct = Array.isArray(node.children) ? node.children : [];
    if (node.childMap) {
      node.children = [...Array.from(node.childMap.values()), ...direct];
      delete node.childMap;
    }
    node.children = (node.children || []).map(finalize).sort(compareTreeNodes);
    node.spriteCount = node.leaf
      ? 1
      : node.children.reduce((sum, child) => sum + Number(child.spriteCount || 0), 0);
    return node;
  };

  return [finalize(lifeNode)];
}

function buildSpriteTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) return [];

  const lifeNode = branchNode("taxon:life", "Life", "root");
  const rootMap = lifeNode.childMap;

  const getBranch = (map, key, factory) => {
    if (!map.has(key)) map.set(key, factory());
    return map.get(key);
  };

  for (const leaf of leaves) {
    const iconic = leaf.iconicTaxonName || "Life";
    const iconicKey = `iconic:${iconic}`;
    const iconicNode = getBranch(rootMap, iconicKey, () => branchNode(iconicKey, iconic, "iconic"));

    const genusName = genusFromScientificName(leaf.scientificName);
    const branchName = genusName || rankBranchName(leaf);
    const branchKey = `${iconicKey}:branch:${branchName.toLowerCase()}`;
    const branch = getBranch(iconicNode.childMap, branchKey, () => branchNode(branchKey, branchName, genusName ? "genus" : "group"));

    branch.children.push(leaf);
  }

  const finalize = (node) => {
    const directChildren = Array.isArray(node.children) ? node.children : [];
    if (node.childMap) {
      node.children = [
        ...Array.from(node.childMap.values()),
        ...directChildren
      ];
      delete node.childMap;
    }

    node.children = (node.children || [])
      .map(finalize)
      .sort(compareTreeNodes);
    node.spriteCount = node.leaf
      ? 1
      : node.children.reduce((sum, child) => sum + Number(child.spriteCount || 0), 0);

    return node;
  };

  return [finalize(lifeNode)];
}

function branchNode(key, name, rank) {
  return {
    key,
    name,
    rank,
    children: [],
    childMap: new Map(),
    spriteCount: 0,
    leaf: false
  };
}

function compareTreeNodes(left, right) {
  if (left.leaf !== right.leaf) return left.leaf ? 1 : -1;
  const countDiff = Number(right.spriteCount || 0) - Number(left.spriteCount || 0);
  if (countDiff !== 0 && !left.leaf && !right.leaf) return countDiff;
  return String(left.name || "").localeCompare(String(right.name || ""), undefined, { sensitivity: "base" });
}

function genusFromScientificName(value) {
  const parts = String(value ?? "").trim().split(/\s+/);
  if (parts.length < 2) return "";
  return /^[A-Z][a-z-]+$/.test(parts[0]) ? parts[0] : "";
}

function rankBranchName(leaf) {
  const rank = String(leaf.rank ?? "taxon");
  if (rank && rank !== "species") return `${rank} taxa`;
  return "Other taxa";
}

function parseTaxonAncestry(value) {
  return String(value ?? "")
    .split(/[\/,\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
}

async function saveTeam(env, userId, name, taxonIds) {
  const cleanTaxonIds = taxonIds
    .map((taxonId) => Number.parseInt(taxonId, 10))
    .filter(Number.isFinite)
    .slice(0, 5);

  if (cleanTaxonIds.length !== 5) {
    throw new Error("Teams must contain exactly 5 taxa");
  }

  await assertUserOwnsReadyTaxa(env, userId, cleanTaxonIds);

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(`
    SELECT team_id
    FROM teams
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(userId).first();
  const teamId = existing?.team_id ?? randomId("team");

  await env.DB.prepare(`
    INSERT INTO teams (team_id, user_id, name, slots_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      name = excluded.name,
      slots_json = excluded.slots_json,
      updated_at = excluded.updated_at
  `).bind(teamId, userId, name.slice(0, 80), JSON.stringify(cleanTaxonIds), now, now).run();

  return { teamId, userId, name: name.slice(0, 80), taxonIds: cleanTaxonIds };
}

async function listTeams(env, userId) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM teams
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).bind(userId).all();

  return (rows.results ?? []).map((row) => ({
    teamId: row.team_id,
    userId: row.user_id,
    name: row.name,
    taxonIds: JSON.parse(row.slots_json),
    updatedAt: row.updated_at
  }));
}

async function loadUserBattleCreatures(env, userId, taxonIds, idPrefix, personalView = "owner", localTaxonIds = null) {
  const cleanTaxonIds = taxonIds
    .map((taxonId) => Number.parseInt(taxonId, 10))
    .filter(Number.isFinite)
    .slice(0, 5);

  if (cleanTaxonIds.length !== 5) {
    throw new Error("Choose exactly 5 creatures");
  }

  const placeholders = cleanTaxonIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.iconic_taxon_name,
      t.ancestry,
      t.genus_id,
      t.family_id,
      ut.obs_count,
      ut.bond_level,
      st.nickname,
      st.allocated_json,
      st.points_spent,
      (
        SELECT sa.r2_key
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS r2_key,
      (
        SELECT uss.r2_key
        FROM user_sprite_submissions uss
        WHERE uss.user_id = ut.user_id
          AND uss.taxon_id = t.taxon_id
          AND uss.status != 'rejected'
        ORDER BY uss.created_at DESC
        LIMIT 1
      ) AS own_custom_key,
      (
        SELECT uss.r2_key
        FROM user_sprite_submissions uss
        WHERE uss.user_id = ut.user_id
          AND uss.taxon_id = t.taxon_id
          AND uss.status = 'approved'
        ORDER BY uss.created_at DESC
        LIMIT 1
      ) AS approved_custom_key
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    LEFT JOIN species_training st ON st.user_id = ut.user_id AND st.taxon_id = t.taxon_id
    WHERE ut.user_id = ?
      AND t.taxon_id IN (${placeholders})
      AND (
        EXISTS (
          SELECT 1
          FROM sprite_assets sa
          WHERE sa.taxon_id = t.taxon_id
            AND sa.asset_kind = ?
            AND sa.asset_version = ?
            AND sa.status = 'ready'
        )
        OR EXISTS (
          SELECT 1
          FROM user_sprite_submissions uss
          WHERE uss.user_id = ut.user_id
            AND uss.taxon_id = t.taxon_id
            AND uss.status != 'rejected'
        )
      )
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    userId,
    ...cleanTaxonIds,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION
  ).all();

  const buffMap = await loadUserBuffMap(env, userId);
  const territoryBuffByBiome = await loadTerritoryBuffMap(env, userId);
  const movesMap = await loadSpeciesMovesMap(env, cleanTaxonIds);
  const variantMap = await loadReadySpriteVariantMap(env, cleanTaxonIds);
  const preferenceMap = await loadUserSpritePreferenceMap(env, userId, cleanTaxonIds);
  const byId = new Map((rows.results ?? []).map((row) => [Number(row.taxon_id), row]));
  return cleanTaxonIds.map((taxonId, index) => {
    const row = byId.get(taxonId);
    if (!row) throw new Error(`Taxon ${taxonId} is not a ready sprite in this user's roster`);

    // Owners see their own pending or approved custom sprite; everyone else
    // only sees it once Discord QA approved it. Rejected submissions fall
    // back to the shared global sprite for all viewers.
    const customKey = personalView === "owner" ? row.own_custom_key : row.approved_custom_key;
    const selectedVariant = selectSpriteVariant(variantMap.get(taxonId) ?? [], preferenceMap.get(taxonId));
    const finalKey = customKey || selectedVariant?.r2Key || row.r2_key;
    const spriteUrl = finalKey ? `/api/assets/${encodeR2Key(finalKey)}` : null;
    const localBuffPct = localTaxonIds && localTaxonIds.has(taxonId) ? TERRITORY_LOCAL_BUFF_PCT : 0;
    return createBattleCreature(
      taxonSummaryFromRow(row, spriteUrl),
      `${idPrefix}-${index}`,
      trainingFromRow(row, buffMap),
      movesMap.get(taxonId)?.moves ?? null,
      territoryBuffByBiome,
      localBuffPct
    );
  });
}

// Per-biome roster-power buff from the user's held tiles (Bridge 4).
async function loadTerritoryBuffMap(env, userId) {
  const rows = (await env.DB.prepare(
    "SELECT biome_type, count(*) AS n FROM tiles WHERE owner_id = ? GROUP BY biome_type"
  ).bind(userId).all()).results ?? [];
  const map = {};
  for (const row of rows) {
    const pct = territoryBuffPctForBiomeCount(Number(row.n));
    if (pct > 0) map[row.biome_type] = pct;
  }
  return map;
}

async function startNpcBattle(env, userId, taxonIds, npcTemplate, difficulty = "normal") {
  const creatures = await loadUserBattleCreatures(env, userId, taxonIds, "p");
  const cleanTaxonIds = creatures.map((creature) => Number(creature.taxonId)).filter(Number.isFinite);
  const opponent = await createRandomReadyNpcTeam(env, cleanTaxonIds, 5);

  const now = new Date().toISOString();
  const battleId = randomId("battle");
  const seed = randomId("seed");
  const state = {
    battleId,
    mode: "npc",
    difficulty,
    seed,
    turn: 1,
    terrain: terrainForTeam(opponent),
    player: { userId, name: "Your Team", activeIndex: 0, creatures },
    opponent,
    log: [{ turn: 0, text: `${opponent.name} challenges your field team. (${difficulty})` }],
    status: "active"
  };

  await env.DB.prepare(`
    INSERT INTO battle_instances (
      battle_id, mode, attacker_user_id, npc_template_id,
      state_json, seed, turn, status, created_at, updated_at
    )
    VALUES (?, 'npc', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    battleId,
    userId,
    npcTemplate || "random_ready",
    JSON.stringify(state),
    seed,
    state.turn,
    state.status,
    now,
    now
  ).run();

  return state;
}

async function createRandomReadyNpcTeam(env, excludedTaxonIds = [], size = 5) {
  const excluded = excludedTaxonIds
    .map((taxonId) => Number.parseInt(taxonId, 10))
    .filter(Number.isFinite);
  const exclusionClause = excluded.length
    ? `AND t.taxon_id NOT IN (${excluded.map(() => "?").join(",")})`
    : "";

  const rows = await env.DB.prepare(`
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.iconic_taxon_name,
      t.ancestry,
      COALESCE((
        SELECT MAX(gst.observed_count)
        FROM global_seed_taxa gst
        WHERE gst.taxon_id = t.taxon_id
      ), 10) AS obs_count,
      8 AS bond_level,
      (
        SELECT sa.r2_key
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS r2_key
    FROM taxa t
    WHERE EXISTS (
        SELECT 1
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
      )
      ${exclusionClause}
    ORDER BY RANDOM()
    LIMIT ?
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    ...excluded,
    size
  ).all();

  const npcRows = rows.results ?? [];
  const npcMovesMap = await loadSpeciesMovesMap(env, npcRows.map((row) => Number(row.taxon_id)));
  const creatures = npcRows.map((row, index) => {
    const spriteUrl = row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null;
    return createBattleCreature(
      taxonSummaryFromRow(row, spriteUrl),
      `npc-${index}`,
      null,
      npcMovesMap.get(Number(row.taxon_id))?.moves ?? null
    );
  });

  if (creatures.length < size) {
    throw new Error(`Need at least ${size} ready global sprites to start an NPC battle`);
  }

  return {
    name: "Wild Sprite Team",
    activeIndex: 0,
    creatures
  };
}

async function startDemoBattle(env) {
  const placeholders = DEMO_PLAYER_TAXON_IDS.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.iconic_taxon_name,
      t.ancestry,
      ut.obs_count,
      ut.bond_level,
      (
        SELECT sa.r2_key
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS r2_key
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    WHERE ut.user_id = ?
      AND t.taxon_id IN (${placeholders})
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEMO_USER_ID,
    ...DEMO_PLAYER_TAXON_IDS
  ).all();

  const byId = new Map((rows.results ?? []).map((row) => [Number(row.taxon_id), row]));
  const demoMovesMap = await loadSpeciesMovesMap(env, DEMO_PLAYER_TAXON_IDS);
  const creatures = DEMO_PLAYER_TAXON_IDS.map((taxonId, index) => {
    const row = byId.get(taxonId);
    if (!row) throw new Error("Demo sprite seed data is missing. Run D1 migrations.");

    const spriteUrl = row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null;
    return createBattleCreature(
      taxonSummaryFromRow(row, spriteUrl),
      `demo-${index}`,
      null,
      demoMovesMap.get(taxonId)?.moves ?? null
    );
  });
  const dummies = DEMO_DUMMY_TAXA.map((taxon, index) => ({
    ...createBattleCreature(taxon, `dummy-${index}`),
    placeholder: "gray-box",
    spriteUrl: null
  }));

  const now = new Date().toISOString();
  const battleId = randomId("battle");
  const seed = randomId("seed");
  const state = {
    battleId,
    mode: "npc",
    seed,
    turn: 1,
    terrain: "neutral",
    player: { userId: DEMO_USER_ID, name: "Manual Sprite Team", activeIndex: 0, creatures },
    opponent: { name: "Gray Box Bench", activeIndex: 0, creatures: dummies },
    log: [{ turn: 0, text: "A 5v5 sprite animation test battle begins." }],
    status: "active",
    demo: true
  };

  await env.DB.prepare(`
    INSERT INTO battle_instances (
      battle_id, mode, attacker_user_id, npc_template_id,
      state_json, seed, turn, status, created_at, updated_at
    )
    VALUES (?, 'npc', ?, 'graybox_5v5', ?, ?, ?, ?, ?, ?)
  `).bind(
    battleId,
    DEMO_USER_ID,
    JSON.stringify(state),
    seed,
    state.turn,
    state.status,
    now,
    now
  ).run();

  return state;
}

async function getBattle(env, battleId) {
  const row = await env.DB.prepare(`
    SELECT state_json
    FROM battle_instances
    WHERE battle_id = ?
  `).bind(battleId).first();

  return row?.state_json ? JSON.parse(row.state_json) : null;
}

async function submitBattleMove(env, battleId, moveId, switchIndex = null) {
  const state = await getBattle(env, battleId);
  if (!state) throw new Error("Battle not found");
  if (state.status !== "active") return state;

  let playerAction;
  if (switchIndex !== null && switchIndex !== undefined && switchIndex !== "") {
    const index = Number.parseInt(String(switchIndex), 10);
    const target = state.player.creatures[index];
    if (!Number.isFinite(index) || !target) throw new Error("Invalid switch target");
    if (target.fainted) throw new Error("That creature has fainted");
    if (index === state.player.activeIndex) throw new Error("That creature is already active");
    playerAction = { kind: "switch", index };
  } else {
    if (!moveId) throw new Error("Missing moveId");
    const active = state.player.creatures[state.player.activeIndex];
    if (moveId !== "struggle" && !active.moves.some((move) => move.id === moveId)) {
      throw new Error("Move is not available to the active creature");
    }
    playerAction = { kind: "move", moveId };
  }

  const difficulty = ["easy", "normal", "hard"].includes(state.difficulty) ? state.difficulty : "normal";
  const rng = createSeededRng(`${state.seed}:${state.turn}`);
  const npcAction = chooseNpcAction(state, difficulty, rng);
  const next = resolveTurn(state, playerAction, npcAction, rng);
  const now = new Date().toISOString();

  if (next.status !== "active") {
    // Attach the rating change to the final state so the result overlay can
    // show "+12 · 3-win streak" and a refresh doesn't lose it.
    next.ratingUpdate = await applyBattleResultToRatings(env, next, now);
  }

  await env.DB.prepare(`
    UPDATE battle_instances
    SET state_json = ?, turn = ?, status = ?, updated_at = ?
    WHERE battle_id = ?
  `).bind(JSON.stringify(next), next.turn, next.status, now, battleId).run();

  if (next.status !== "active") {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO battle_results (
        battle_id, winner_user_id, loser_user_id, result_json, created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      battleId,
      next.status === "won" ? next.player.userId ?? null : next.opponent?.userId ?? null,
      next.status === "won" ? next.opponent?.userId ?? null : next.player.userId ?? null,
      JSON.stringify({ status: next.status, turns: next.turn - 1 }),
      now
    ).run();

    await env.DB.prepare(`
      UPDATE challenges SET status = 'completed', updated_at = ? WHERE battle_id = ?
    `).bind(now, battleId).run();

    if (next.tileH3) {
      await resolveTileContest(env, next, now);
    }
  }

  return next;
}

async function assertUserOwnsReadyTaxa(env, userId, taxonIds) {
  const placeholders = taxonIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT DISTINCT ut.taxon_id
    FROM user_taxa ut
    WHERE ut.user_id = ?
      AND ut.taxon_id IN (${placeholders})
      AND (
        EXISTS (
          SELECT 1
          FROM sprite_assets sa
          WHERE sa.taxon_id = ut.taxon_id
            AND sa.asset_kind = ?
            AND sa.asset_version = ?
            AND sa.status = 'ready'
        )
        OR EXISTS (
          SELECT 1
          FROM user_sprite_submissions uss
          WHERE uss.user_id = ut.user_id
            AND uss.taxon_id = ut.taxon_id
            AND uss.status != 'rejected'
        )
      )
  `).bind(userId, ...taxonIds, DEFAULT_ASSET_KIND, ASSET_VERSION).all();

  if ((rows.results ?? []).length !== taxonIds.length) {
    throw new Error("Team must use 5 ready sprites from this user's roster");
  }
}

// ---------------------------------------------------------------------------
// Leaderboard: Elo-style Field Score, streaks, rank titles, Bluesky sharing
// ---------------------------------------------------------------------------

const RATING_BASE = 1000;
const RATING_K = 32;
const NPC_DIFFICULTY_RATING = { easy: 850, normal: 1000, hard: 1150 };
const RANK_TITLES = [
  { min: 1350, title: "Apex Predator", emoji: "🦅" },
  { min: 1250, title: "Canopy Ranger", emoji: "🦉" },
  { min: 1150, title: "Trailblazer", emoji: "🐾" },
  { min: 1050, title: "Field Naturalist", emoji: "🌿" },
  { min: 950, title: "Fledgling", emoji: "🐣" },
  { min: -Infinity, title: "Sprout", emoji: "🌱" }
];

function rankTitleFor(rating) {
  return RANK_TITLES.find((band) => rating >= band.min);
}

// Updates the player's rating row when an NPC battle finishes. Returns the
// summary attached to the final battle state (null for demo/unrated battles).
async function applyBattleResultToRatings(env, state, now) {
  const userId = state.player?.userId;
  if (!userId || state.demo || state.mode !== "npc") return null;
  if (userId.startsWith("demo:")) return null;
  if (!["won", "lost", "draw"].includes(state.status)) return null;

  const row = await env.DB.prepare(`
    SELECT * FROM player_ratings WHERE user_id = ?
  `).bind(userId).first();

  const rating = Number(row?.rating ?? RATING_BASE);
  const difficulty = ["easy", "normal", "hard"].includes(state.difficulty) ? state.difficulty : "normal";
  const opponentRating = NPC_DIFFICULTY_RATING[difficulty];
  const score = state.status === "won" ? 1 : state.status === "draw" ? 0.5 : 0;
  const expected = 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
  const newRating = Math.max(100, rating + RATING_K * (score - expected));
  const delta = newRating - rating;

  const winStreak = state.status === "won" ? Number(row?.win_streak ?? 0) + 1 : 0;
  const bestStreak = Math.max(Number(row?.best_streak ?? 0), winStreak);
  const turns = Math.max(1, Number(state.turn ?? 1) - 1);
  const fastestWin = state.status === "won"
    ? Math.min(Number(row?.fastest_win_turns ?? Infinity), turns)
    : Number(row?.fastest_win_turns ?? Infinity);

  await env.DB.prepare(`
    INSERT INTO player_ratings (
      user_id, rating, wins, losses, draws, battles, win_streak, best_streak,
      fastest_win_turns, last_result, last_battle_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      rating = excluded.rating,
      wins = player_ratings.wins + excluded.wins,
      losses = player_ratings.losses + excluded.losses,
      draws = player_ratings.draws + excluded.draws,
      battles = player_ratings.battles + 1,
      win_streak = excluded.win_streak,
      best_streak = excluded.best_streak,
      fastest_win_turns = excluded.fastest_win_turns,
      last_result = excluded.last_result,
      last_battle_at = excluded.last_battle_at,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    newRating,
    state.status === "won" ? 1 : 0,
    state.status === "lost" ? 1 : 0,
    state.status === "draw" ? 1 : 0,
    winStreak,
    bestStreak,
    Number.isFinite(fastestWin) ? fastestWin : null,
    state.status,
    now,
    now,
    now
  ).run();

  const rank = await getPlayerRank(env, newRating, userId);
  const band = rankTitleFor(newRating);

  return {
    rating: Math.round(newRating),
    delta: Math.round(delta),
    winStreak,
    bestStreak,
    rank,
    title: band.title,
    titleEmoji: band.emoji,
    difficulty
  };
}

async function getPlayerRank(env, rating, userId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS better
    FROM player_ratings
    WHERE rating > ? OR (rating = ? AND user_id < ?)
  `).bind(rating, rating, userId).first();
  return Number(row?.better ?? 0) + 1;
}

function leaderboardEntry(row, rank) {
  const rating = Math.round(Number(row.rating ?? RATING_BASE));
  const band = rankTitleFor(rating);
  return {
    rank,
    userId: row.user_id,
    name: row.bsky_display_name || row.user_display_name || row.bsky_handle || row.inat_login || row.user_id,
    handle: row.bsky_handle || null,
    inatLogin: row.inat_login || null,
    avatarUrl: row.avatar_url || null,
    rating,
    title: band.title,
    titleEmoji: band.emoji,
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    draws: Number(row.draws ?? 0),
    battles: Number(row.battles ?? 0),
    winStreak: Number(row.win_streak ?? 0),
    bestStreak: Number(row.best_streak ?? 0),
    fastestWinTurns: row.fastest_win_turns === null || row.fastest_win_turns === undefined
      ? null
      : Number(row.fastest_win_turns),
    lastBattleAt: row.last_battle_at || null
  };
}

const LEADERBOARD_SELECT = `
  SELECT
    pr.*,
    u.display_name AS user_display_name,
    u.inat_login,
    a.handle AS bsky_handle,
    a.display_name AS bsky_display_name,
    a.avatar_url
  FROM player_ratings pr
  LEFT JOIN users u ON u.id = pr.user_id
  LEFT JOIN accounts a ON a.did = (
    SELECT did FROM accounts
    WHERE inat_login = u.inat_login
    ORDER BY updated_at DESC
    LIMIT 1
  )
`;

async function getLeaderboard(env, viewerUserId = null, limit = 50) {
  const rows = await env.DB.prepare(`
    ${LEADERBOARD_SELECT}
    ORDER BY pr.rating DESC, pr.wins DESC, pr.user_id ASC
    LIMIT ?
  `).bind(limit).all();

  const entries = (rows.results ?? []).map((row, index) => leaderboardEntry(row, index + 1));
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM player_ratings`).first();
  const total = Number(totalRow?.total ?? entries.length);

  let you = viewerUserId ? entries.find((entry) => entry.userId === viewerUserId) ?? null : null;
  if (!you && viewerUserId) {
    const row = await env.DB.prepare(`
      ${LEADERBOARD_SELECT}
      WHERE pr.user_id = ?
    `).bind(viewerUserId).first();
    if (row) {
      you = leaderboardEntry(row, await getPlayerRank(env, Number(row.rating), viewerUserId));
    }
  }

  return { entries, totalPlayers: total, you };
}

function bskyPostWebUrl(session, postUri) {
  const rkey = String(postUri ?? "").split("/").pop();
  if (!rkey) return null;
  return `https://bsky.app/profile/${encodeURIComponent(session.handle || session.did)}/post/${rkey}`;
}

async function shareBattleToBluesky(env, session, battleId, origin) {
  const userId = requireLinkedUserId(session);
  const battle = await getBattle(env, battleId);
  if (!battle) throw httpError("Battle not found", 404);
  if (battle.player?.userId !== userId) throw httpError("This is not your battle", 403);
  if (battle.status !== "won") throw httpError("Only victories can be shared (win one first!)", 400);

  const turns = Math.max(1, Number(battle.turn ?? 1) - 1);
  const mvp = [...(battle.player.creatures ?? [])]
    .sort((a, b) => Number(b.damageDealt ?? 0) - Number(a.damageDealt ?? 0))[0];
  const update = battle.ratingUpdate;

  const ratingPart = update
    ? ` Now ${update.titleEmoji} ${update.title} · ${update.rating} Field Score` +
      (update.winStreak >= 2 ? ` · ${update.winStreak}-win streak 🔥` : "")
    : "";
  const mvpPart = mvp ? `My ${mvp.speciesName || mvp.name} led the team — ` : "";
  const text = `⚔️ Victory in iNat Battler! ${mvpPart}beat the ${battle.opponent?.name || "wild team"} in ${turns} turns.${ratingPart}\n\nBattle your own iNaturalist sightings: ${origin}`;

  const record = buildShareTextPostRecord({ text, linkUrl: origin });
  const result = await createSessionPost(env, session, record);
  return { ok: true, uri: result?.uri ?? null, webUrl: bskyPostWebUrl(session, result?.uri) };
}

async function shareRankToBluesky(env, session, origin) {
  const userId = requireLinkedUserId(session);
  const row = await env.DB.prepare(`
    ${LEADERBOARD_SELECT}
    WHERE pr.user_id = ?
  `).bind(userId).first();
  if (!row) throw httpError("Win a battle first to earn a leaderboard rank", 400);

  const rank = await getPlayerRank(env, Number(row.rating), userId);
  const entry = leaderboardEntry(row, rank);
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM player_ratings`).first();
  const total = Number(totalRow?.total ?? 1);

  const streakPart = entry.winStreak >= 2 ? ` and I'm on a ${entry.winStreak}-win streak 🔥` : "";
  const fastPart = entry.fastestWinTurns ? ` Fastest win: ${entry.fastestWinTurns} turns.` : "";
  const text = `🏆 Ranked #${rank} of ${total} on the iNat Battler leaderboard — ${entry.titleEmoji} ${entry.title} with a ${entry.rating} Field Score (${entry.wins}W/${entry.losses}L)${streakPart}.${fastPart}\n\nBuild a team from your own iNaturalist sightings and come take my spot: ${origin}`;

  const record = buildShareTextPostRecord({ text, linkUrl: origin });
  const result = await createSessionPost(env, session, record);
  return { ok: true, uri: result?.uri ?? null, webUrl: bskyPostWebUrl(session, result?.uri) };
}

// ---------------------------------------------------------------------------
// Bluesky (atproto) auth, iNaturalist linking, and battle challenges
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "inatbattler_sid";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_REQUEST_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_MESSAGE_MAX_LENGTH = 140;

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

async function getSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const sessionId = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT
      s.*,
      a.handle, a.display_name, a.avatar_url,
      a.inat_login, a.inat_user_id,
      a.inat_pending_login, a.inat_verification_code
    FROM oauth_sessions s
    JOIN accounts a ON a.did = s.did
    WHERE s.session_id = ?
  `).bind(sessionId).first();

  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await env.DB.prepare("DELETE FROM oauth_sessions WHERE session_id = ?").bind(sessionId).run();
    return null;
  }
  return row;
}

async function requireSession(request, env) {
  const session = await getSession(request, env);
  if (!session) throw httpError("Sign in with Bluesky first", 401);
  return session;
}

function inatUserIdFor(login) {
  return `inat:${String(login).toLowerCase()}`;
}

async function beginBlueskyLogin(env, origin, payload) {
  const returnTo =
    typeof payload.returnTo === "string" && payload.returnTo.startsWith("/") && !payload.returnTo.startsWith("//")
      ? payload.returnTo.slice(0, 512)
      : "/";

  const identity = await resolveIdentity(payload.handle);
  const authMeta = await getAuthServerMeta(identity.pdsUrl);
  const { clientId, redirectUri, scope } = oauthClientConfig(env, origin);

  const state = randomToken(32);
  const pkceVerifier = randomToken(48);
  const codeChallenge = await pkceChallengeFromVerifier(pkceVerifier);
  const dpopKey = await generateDpopKeyPair();

  const { requestUri } = await pushedAuthorizationRequest({
    authMeta,
    clientId,
    redirectUri,
    scope,
    state,
    handle: identity.handle,
    codeChallenge,
    dpopKey
  });

  const now = new Date().toISOString();
  await env.DB.prepare(
    "DELETE FROM oauth_requests WHERE created_at < ?"
  ).bind(new Date(Date.now() - 4 * OAUTH_REQUEST_TTL_MS).toISOString()).run();
  await env.DB.prepare(`
    INSERT INTO oauth_requests (
      state, did, handle, pds_url, issuer, client_id,
      pkce_verifier, dpop_private_jwk, dpop_public_jwk, return_to, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    state,
    identity.did,
    identity.handle,
    identity.pdsUrl,
    authMeta.issuer,
    clientId,
    pkceVerifier,
    JSON.stringify(dpopKey.privateJwk),
    JSON.stringify(dpopKey.publicJwk),
    returnTo,
    now
  ).run();

  const authorizeUrl = `${authMeta.authorization_endpoint}?${new URLSearchParams({
    client_id: clientId,
    request_uri: requestUri
  })}`;
  return { authorizeUrl, handle: identity.handle, did: identity.did };
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);

  try {
    const oauthErr = url.searchParams.get("error");
    if (oauthErr) {
      throw new Error(url.searchParams.get("error_description") || oauthErr);
    }

    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const iss = url.searchParams.get("iss") ?? "";
    if (!state || !code) throw new Error("Missing state or code");

    const row = await env.DB.prepare("SELECT * FROM oauth_requests WHERE state = ?").bind(state).first();
    await env.DB.prepare("DELETE FROM oauth_requests WHERE state = ?").bind(state).run();
    if (!row) throw new Error("Login attempt not found or already used. Try signing in again.");
    if (Date.parse(row.created_at) < Date.now() - OAUTH_REQUEST_TTL_MS) {
      throw new Error("Login attempt expired. Try signing in again.");
    }
    if (iss && iss.replace(/\/$/, "") !== String(row.issuer).replace(/\/$/, "")) {
      throw new Error("Authorization server mismatch");
    }

    const authMeta = await getAuthServerMeta(row.pds_url);
    const dpopKey = {
      privateJwk: JSON.parse(row.dpop_private_jwk),
      publicJwk: JSON.parse(row.dpop_public_jwk)
    };
    const { tokens, nonce } = await exchangeAuthorizationCode({
      authMeta,
      clientId: row.client_id,
      redirectUri: oauthClientConfig(env, url.origin).redirectUri,
      code,
      pkceVerifier: row.pkce_verifier,
      dpopKey
    });
    if (tokens.sub !== row.did) throw new Error("Signed-in account does not match the requested handle");

    const profile = await fetchPublicProfile(row.did);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO accounts (did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `).bind(
      row.did,
      profile.handle ?? row.handle,
      profile.displayName,
      profile.avatarUrl,
      now,
      now
    ).run();

    const sessionToken = randomToken(32);
    const sessionId = await sha256Hex(sessionToken);
    const tokenExpiresAt = new Date(Date.now() + Number(tokens.expires_in ?? 300) * 1000).toISOString();
    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    await env.DB.prepare(`
      INSERT INTO oauth_sessions (
        session_id, did, pds_url, issuer, client_id,
        access_token, refresh_token, token_expires_at,
        dpop_private_jwk, dpop_public_jwk, auth_nonce,
        expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      row.did,
      row.pds_url,
      row.issuer,
      row.client_id,
      tokens.access_token,
      tokens.refresh_token ?? null,
      tokenExpiresAt,
      row.dpop_private_jwk,
      row.dpop_public_jwk,
      nonce ?? null,
      sessionExpiresAt,
      now,
      now
    ).run();

    const returnTo = typeof row.return_to === "string" && row.return_to.startsWith("/") ? row.return_to : "/";
    return new Response(null, {
      status: 303,
      headers: {
        location: returnTo,
        "set-cookie": sessionCookieHeader(sessionToken, SESSION_TTL_SECONDS)
      }
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Bluesky sign-in failed";
    return new Response(null, {
      status: 303,
      headers: { location: `/?authError=${encodeURIComponent(message)}` }
    });
  }
}

async function handleLogout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const sessionId = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM oauth_sessions WHERE session_id = ?").bind(sessionId).run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": sessionCookieHeader("", 0)
    }
  });
}

async function getMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return { loggedIn: false };

  const pending = await env.DB.prepare(`
    SELECT COUNT(*) AS pending
    FROM challenges
    WHERE opponent_did = ? AND status = 'pending'
  `).bind(session.did).first();

  return {
    loggedIn: true,
    did: session.did,
    handle: session.handle,
    displayName: session.display_name,
    avatarUrl: session.avatar_url,
    inatLogin: session.inat_login,
    inatUserId: session.inat_user_id,
    userId: session.inat_login ? inatUserIdFor(session.inat_login) : null,
    inatPendingLogin: session.inat_pending_login,
    inatVerificationCode: session.inat_verification_code,
    pendingChallenges: Number(pending?.pending ?? 0)
  };
}

async function ensureFreshAccessToken(env, session) {
  const expiresAt = Date.parse(session.token_expires_at ?? "");
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) return session;
  if (!session.refresh_token) throw httpError("Bluesky session expired. Sign in again.", 401);

  const authMeta = await getAuthServerMeta(session.pds_url);
  const dpopKey = {
    privateJwk: JSON.parse(session.dpop_private_jwk),
    publicJwk: JSON.parse(session.dpop_public_jwk)
  };

  let refreshed;
  try {
    refreshed = await refreshAccessToken({
      authMeta,
      clientId: session.client_id,
      refreshToken: session.refresh_token,
      dpopKey,
      nonce: session.auth_nonce
    });
  } catch (error) {
    if (error?.code === "ATPROTO_REFRESH_FAILED") {
      await env.DB.prepare("DELETE FROM oauth_sessions WHERE session_id = ?").bind(session.session_id).run();
      throw httpError("Bluesky session expired. Sign in again.", 401);
    }
    throw error;
  }

  const { tokens, nonce } = refreshed;
  const now = new Date().toISOString();
  const tokenExpiresAt = new Date(Date.now() + Number(tokens.expires_in ?? 300) * 1000).toISOString();
  await env.DB.prepare(`
    UPDATE oauth_sessions
    SET access_token = ?, refresh_token = ?, token_expires_at = ?, auth_nonce = ?, updated_at = ?
    WHERE session_id = ?
  `).bind(
    tokens.access_token,
    tokens.refresh_token ?? session.refresh_token,
    tokenExpiresAt,
    nonce ?? session.auth_nonce,
    now,
    session.session_id
  ).run();

  return {
    ...session,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? session.refresh_token,
    token_expires_at: tokenExpiresAt,
    auth_nonce: nonce ?? session.auth_nonce
  };
}

async function createSessionPost(env, session, record) {
  const fresh = await ensureFreshAccessToken(env, session);
  const dpopKey = {
    privateJwk: JSON.parse(fresh.dpop_private_jwk),
    publicJwk: JSON.parse(fresh.dpop_public_jwk)
  };

  const result = await pdsXrpcCall(
    {
      pdsUrl: fresh.pds_url,
      accessToken: fresh.access_token,
      dpopKey,
      nonce: fresh.pds_nonce
    },
    "com.atproto.repo.createRecord",
    { repo: fresh.did, collection: "app.bsky.feed.post", record }
  );

  if (result.nonce && result.nonce !== fresh.pds_nonce) {
    await env.DB.prepare("UPDATE oauth_sessions SET pds_nonce = ? WHERE session_id = ?")
      .bind(result.nonce, fresh.session_id).run();
  }
  if (!result.ok) {
    throw new Error(`Bluesky post failed: ${result.data?.message || result.data?.error || `status ${result.status}`}`);
  }
  return result.data;
}

function generateVerificationCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `inat-battler-${suffix}`;
}

async function startInatLink(env, session, rawLogin) {
  const inatLogin = normalizeInatLogin(rawLogin);
  const code = generateVerificationCode();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE accounts
    SET inat_pending_login = ?, inat_verification_code = ?, updated_at = ?
    WHERE did = ?
  `).bind(inatLogin, code, now, session.did).run();

  return {
    inatLogin,
    code,
    editProfileUrl: "https://www.inaturalist.org/users/edit",
    instructions:
      `Add "${code}" anywhere in the bio/description of the iNaturalist profile "${inatLogin}" ` +
      "(Account Settings -> Profile), save it, then click Verify. You can remove the code afterwards."
  };
}

async function fetchInatUserProfile(login) {
  // The v2 API returns profile bios (v1 /users/{id} does not) and accepts logins directly.
  const url = new URL(`${INAT_API_BASE_URL}/users/${encodeURIComponent(login)}`);
  url.searchParams.set("fields", "id,login,description");

  const res = await fetchInatWithRetry(url.toString());
  if (res.status === 404) throw httpError(`iNaturalist user "${login}" was not found`, 404);
  if (!res.ok) throw httpError(`iNaturalist lookup failed (${res.status}). Try again shortly.`, 502);

  const data = await res.json();
  const profile = (data.results ?? []).find(
    (candidate) => String(candidate.login ?? "").toLowerCase() === login.toLowerCase()
  );
  if (!profile) throw httpError(`iNaturalist user "${login}" was not found`, 404);
  return profile;
}

async function confirmInatLink(env, session, ctx) {
  const pendingLogin = session.inat_pending_login;
  const code = session.inat_verification_code;
  if (!pendingLogin || !code) throw httpError("Start the iNaturalist link first", 400);

  const profile = await fetchInatUserProfile(pendingLogin);
  const description = String(profile.description ?? "");
  if (!description.includes(code)) {
    throw httpError(
      `Could not find "${code}" in the iNaturalist profile bio for "${pendingLogin}". ` +
      "Save the bio with the code included, then verify again.",
      400
    );
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE accounts
    SET inat_login = ?, inat_user_id = ?, inat_verified_at = ?,
        inat_pending_login = NULL, inat_verification_code = NULL, updated_at = ?
    WHERE did = ?
  `).bind(profile.login, profile.id, now, now, session.did).run();

  const importPromise = importUserByLogin(env, profile.login);
  if (ctx?.waitUntil) {
    ctx.waitUntil(importPromise.catch((error) => {
      console.error("Background iNaturalist import after link failed", error);
    }));

    return {
      ok: true,
      inatLogin: profile.login,
      inatUserId: profile.id,
      userId: inatUserIdFor(profile.login),
      importStarted: true,
      importedTaxa: null,
      queuedSprites: null,
      warning: "iNaturalist account linked. Roster import is running in the background."
    };
  }

  const importResult = await importPromise;
  return {
    ok: true,
    inatLogin: profile.login,
    inatUserId: profile.id,
    userId: importResult.userId,
    importedTaxa: importResult.importedTaxa,
    queuedSprites: importResult.queuedSprites,
    warning: importResult.warning ?? null
  };
}

function sanitizeChallengeMessage(rawMessage) {
  const message = String(rawMessage ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return message ? message.slice(0, CHALLENGE_MESSAGE_MAX_LENGTH) : null;
}

async function createChallenge(env, origin, session, payload) {
  if (!session.inat_login) {
    throw httpError("Link your iNaturalist account before challenging other players", 400);
  }

  const taxonIds = (payload.taxonIds ?? [])
    .map((taxonId) => Number.parseInt(taxonId, 10))
    .filter(Number.isFinite)
    .slice(0, 5);
  if (taxonIds.length !== 5) throw httpError("Pick exactly 5 ready creatures for your challenge team", 400);

  const challengerUserId = inatUserIdFor(session.inat_login);
  await assertUserOwnsReadyTaxa(env, challengerUserId, taxonIds);

  const opponent = await resolveIdentity(payload.opponentHandle);
  if (opponent.did === session.did) throw httpError("You cannot challenge yourself", 400);

  const challengeId = randomId("chal");
  const challengeUrl = `${origin}/?challenge=${challengeId}`;
  const message = sanitizeChallengeMessage(payload.message);

  let postUri = null;
  let postError = null;
  try {
    const record = buildChallengePostRecord({
      opponentHandle: opponent.handle,
      opponentDid: opponent.did,
      challengeUrl,
      message
    });
    const post = await createSessionPost(env, session, record);
    postUri = post?.uri ?? null;
  } catch (error) {
    if (error?.status === 401) throw error;
    postError = error instanceof Error ? error.message : "Bluesky post failed";
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO challenges (
      challenge_id, challenger_did, challenger_handle, challenger_inat_login,
      opponent_did, opponent_handle, team_json, message,
      status, post_uri, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(
    challengeId,
    session.did,
    session.handle,
    session.inat_login,
    opponent.did,
    opponent.handle,
    JSON.stringify(taxonIds),
    message,
    postUri,
    now,
    now
  ).run();

  return {
    challengeId,
    challengeUrl,
    opponentHandle: opponent.handle,
    opponentDid: opponent.did,
    status: "pending",
    postUri,
    postError
  };
}

function challengeSummary(row, viewerDid = null) {
  return {
    challengeId: row.challenge_id,
    direction: viewerDid ? (row.challenger_did === viewerDid ? "outgoing" : "incoming") : null,
    challengerHandle: row.challenger_handle,
    challengerDid: row.challenger_did,
    opponentHandle: row.opponent_handle,
    opponentDid: row.opponent_did,
    message: row.message,
    status: row.status,
    battleId: row.battle_id,
    postUri: row.post_uri,
    createdAt: row.created_at
  };
}

async function listChallengesForSession(env, session) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM challenges
    WHERE challenger_did = ? OR opponent_did = ?
    ORDER BY created_at DESC
    LIMIT 25
  `).bind(session.did, session.did).all();

  return { challenges: (rows.results ?? []).map((row) => challengeSummary(row, session.did)) };
}

async function getChallengePublic(env, challengeId) {
  const row = await env.DB.prepare("SELECT * FROM challenges WHERE challenge_id = ?").bind(challengeId).first();
  if (!row) throw httpError("Challenge not found", 404);
  return challengeSummary(row);
}

async function acceptChallenge(env, session, challengeId, rawTaxonIds) {
  const row = await env.DB.prepare("SELECT * FROM challenges WHERE challenge_id = ?").bind(challengeId).first();
  if (!row) throw httpError("Challenge not found", 404);
  if (row.opponent_did !== session.did) throw httpError("This challenge was sent to a different Bluesky account", 403);
  if (row.status !== "pending") throw httpError(`This challenge is already ${row.status}`, 400);
  if (!session.inat_login) throw httpError("Link your iNaturalist account before battling", 400);

  const taxonIds = (rawTaxonIds ?? [])
    .map((taxonId) => Number.parseInt(taxonId, 10))
    .filter(Number.isFinite)
    .slice(0, 5);
  if (taxonIds.length !== 5) throw httpError("Pick exactly 5 ready creatures to battle with", 400);

  const accepterUserId = inatUserIdFor(session.inat_login);
  await assertUserOwnsReadyTaxa(env, accepterUserId, taxonIds);

  const challengerUserId = inatUserIdFor(row.challenger_inat_login);
  const challengerTaxonIds = JSON.parse(row.team_json);

  const playerCreatures = await loadUserBattleCreatures(env, accepterUserId, taxonIds, "p", "owner");
  const opponentCreatures = await loadUserBattleCreatures(env, challengerUserId, challengerTaxonIds, "o", "public");

  const now = new Date().toISOString();
  const battleId = randomId("battle");
  const seed = randomId("seed");
  const state = {
    battleId,
    mode: "pvp_async",
    challengeId,
    seed,
    turn: 1,
    terrain: terrainForTeam({ creatures: playerCreatures }),
    player: { userId: accepterUserId, name: `@${session.handle}`, activeIndex: 0, creatures: playerCreatures },
    opponent: { userId: challengerUserId, name: `@${row.challenger_handle}`, activeIndex: 0, creatures: opponentCreatures },
    log: [{ turn: 0, text: `@${row.challenger_handle}'s team answers the field. Challenge accepted!` }],
    status: "active"
  };

  await env.DB.prepare(`
    INSERT INTO battle_instances (
      battle_id, mode, attacker_user_id, defender_user_id,
      state_json, seed, turn, status, created_at, updated_at
    )
    VALUES (?, 'pvp_async', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    battleId,
    accepterUserId,
    challengerUserId,
    JSON.stringify(state),
    seed,
    state.turn,
    state.status,
    now,
    now
  ).run();

  await env.DB.prepare(`
    UPDATE challenges SET status = 'accepted', battle_id = ?, updated_at = ? WHERE challenge_id = ?
  `).bind(battleId, now, challengeId).run();

  return state;
}

async function declineChallenge(env, session, challengeId) {
  const row = await env.DB.prepare("SELECT * FROM challenges WHERE challenge_id = ?").bind(challengeId).first();
  if (!row) throw httpError("Challenge not found", 404);
  if (row.opponent_did !== session.did) throw httpError("This challenge was sent to a different Bluesky account", 403);
  if (row.status !== "pending") throw httpError(`This challenge is already ${row.status}`, 400);

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE challenges SET status = 'declined', updated_at = ? WHERE challenge_id = ?
  `).bind(now, challengeId).run();

  return { challengeId, status: "declined" };
}

// ---------------------------------------------------------------------------
// Species training: observation-derived points, mastery tiers, stat allocation
// ---------------------------------------------------------------------------

const TRAINING_ANCESTOR_BATCH_SIZE = 30;
const TRAINING_MAX_ANCESTOR_BATCHES = 12;

function requireLinkedUserId(session) {
  if (!session.inat_login) throw httpError("Link your iNaturalist account first", 400);
  return inatUserIdFor(session.inat_login);
}

// --- Territory layer: geo-aware observation ingestion (Biome merge, Bridge 1) ---

function parseObsLatLng(obs) {
  // v2 geojson is [lng, lat]; the `location` string is "lat,lng".
  if (obs?.geojson && Array.isArray(obs.geojson.coordinates)) {
    const [lng, lat] = obs.geojson.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  if (typeof obs?.location === "string" && obs.location.includes(",")) {
    const [latStr, lngStr] = obs.location.split(",");
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

function obsIsObscured(obs) {
  // Obscured/private coords are randomized by ~0.2deg, enough to land in the
  // wrong res5 tile, so they can't be assigned precisely. Skip them.
  if (obs?.obscured === true) return true;
  const g = obs?.geoprivacy;
  const tg = obs?.taxon_geoprivacy;
  return g === "obscured" || g === "private" || tg === "obscured" || tg === "private";
}

async function fetchUserObservationsGeo(env, inatLogin) {
  const cooldownKey = `inat:observations_geo:${inatLogin.toLowerCase()}:cooldown`;
  if (await readInatCooldown(env, cooldownKey)) {
    throw inatRateLimitError("iNaturalist rate limit reached");
  }

  const maxPages = intEnv(env, "MAX_TERRITORY_SYNC_PAGES", 10);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${INAT_API_BASE_URL}/observations`);
    url.searchParams.set("user_login", inatLogin);
    url.searchParams.set("quality_grade", "research");
    url.searchParams.set("geo", "true");
    url.searchParams.set("order_by", "observed_on");
    url.searchParams.set("per_page", "200");
    url.searchParams.set("page", String(page));
    url.searchParams.set("fields", INAT_OBSERVATION_GEO_FIELDS);
    url.searchParams.set("ttl", String(INAT_SPECIES_CACHE_TTL_SECONDS));

    const res = await fetchInatWithRetry(url.toString());
    if (!res.ok) {
      if (res.status === 429) {
        await writeInatCooldown(env, cooldownKey);
        throw inatRateLimitError("iNaturalist rate limit reached");
      }
      const text = await res.text();
      throw new Error(`iNaturalist observations failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const pageRows = Array.isArray(data.results) ? data.results : [];
    rows.push(...pageRows);

    if (pageRows.length < 200) break;
    if (page < maxPages) await sleep(1100);
  }

  return rows;
}

function emptyTerritorySyncSummary() {
  return {
    scanned: 0,
    recorded: 0,
    skippedNoGeo: 0,
    skippedObscured: 0,
    distinctTiles: 0,
    resolution: TERRITORY_H3_RESOLUTION,
    warning: null
  };
}

// Server-side sync path: the Worker fetches the user's observations from
// iNaturalist and ingests them. This is the FALLBACK — the preferred path is
// the browser fetching its own observations (see /api/territory/ingest), so the
// iNat rate limit falls on each user's IP instead of funneling every user
// through the Worker's single shared egress.
async function syncTerritoryObservations(env, session) {
  let rows;
  try {
    rows = await fetchUserObservationsGeo(env, session.inat_login);
  } catch (error) {
    const summary = emptyTerritorySyncSummary();
    if (error?.code === "INAT_RATE_LIMITED") {
      summary.warning = "iNaturalist is rate-limiting observation sync; try again shortly";
    } else {
      summary.warning = error instanceof Error ? error.message : "Observation fetch failed";
    }
    return summary;
  }
  return ingestTerritoryObservations(env, session, rows);
}

// Process + persist raw iNaturalist v2 observation objects into territory tiles.
// `rows` come from either the Worker fetch (syncTerritoryObservations) or the
// user's own browser (POST /api/territory/ingest).
//
// TRUST NOTE: the account's iNat login IS verified — the user proved control of
// it via a one-time code in their iNaturalist profile bio, bound to their
// Bluesky DID (see confirmInatLink). What this browser-fetch path does NOT prove
// is that these POSTed rows are that user's real iNat observations: unlike the
// Worker fetch, the payload is client-supplied, so a technical user could
// fabricate observations (fake taxon/coords) to seed or garrison tiles they
// never visited. If tile integrity ever needs to be tamper-resistant, re-fetch
// the rows (or a sample) server-side here and reject mismatches.
async function ingestTerritoryObservations(env, session, rows) {
  const userId = requireLinkedUserId(session);
  const now = new Date().toISOString();
  const summary = emptyTerritorySyncSummary();

  if (!Array.isArray(rows)) return summary;

  // tile_observations references users(id); make sure the row exists even if the
  // player hasn't run a roster import yet.
  await env.DB.prepare(`
    INSERT INTO users (id, inat_user_id, inat_login, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(
    userId,
    session.inat_user_id ?? null,
    session.inat_login,
    session.display_name ?? session.inat_login,
    now,
    now
  ).run();

  // Per-user write cooldown: each sync can write up to ~2000 rows, so bound how
  // often a user can trigger one (protects the D1 write budget from spam),
  // regardless of whether the fetch happened on the Worker or in the browser.
  const syncCooldownKey = "territory:sync:" + userId + ":cooldown";
  if (env.CACHE && (await env.CACHE.get(syncCooldownKey))) {
    summary.warning = "Recently synced — your map is up to date. Try again in a few minutes.";
    return summary;
  }

  const statements = [];
  const tiles = new Set();

  for (const obs of rows) {
    summary.scanned += 1;
    const obsId = Number(obs?.id);
    if (!Number.isFinite(obsId)) {
      summary.skippedNoGeo += 1;
      continue;
    }
    if (obsIsObscured(obs)) {
      summary.skippedObscured += 1;
      continue;
    }
    const coords = parseObsLatLng(obs);
    if (!coords) {
      summary.skippedNoGeo += 1;
      continue;
    }
    let cell;
    try {
      cell = latLngToCell(coords.lat, coords.lng, TERRITORY_H3_RESOLUTION);
    } catch {
      summary.skippedNoGeo += 1;
      continue;
    }
    tiles.add(cell);

    const taxon = obs.taxon || {};
    statements.push(env.DB.prepare(`
      INSERT INTO tile_observations (
        inat_observation_id, user_id, latitude, longitude, h3_index,
        taxon_id, taxon_name, iconic_taxon_name, quality_grade, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inat_observation_id) DO UPDATE SET
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        h3_index = excluded.h3_index,
        taxon_id = excluded.taxon_id,
        taxon_name = excluded.taxon_name,
        iconic_taxon_name = excluded.iconic_taxon_name,
        quality_grade = excluded.quality_grade,
        observed_at = excluded.observed_at
    `).bind(
      obsId,
      userId,
      coords.lat,
      coords.lng,
      cell,
      taxon.id ?? null,
      taxon.name ?? null,
      taxon.iconic_taxon_name ?? null,
      obs.quality_grade ?? null,
      obs.observed_on ?? obs.time_observed_at ?? null,
      now
    ));
    summary.recorded += 1;
  }

  for (const chunk of chunkArray(statements, 50)) {
    if (chunk.length) await env.DB.batch(chunk);
  }

  if (env.CACHE) {
    await env.CACHE.put(syncCooldownKey, new Date().toISOString(), {
      expirationTtl: intEnv(env, "TERRITORY_SYNC_COOLDOWN_SECONDS", 120)
    });
  }

  summary.distinctTiles = tiles.size;
  return summary;
}

function parseBbox(url) {
  const n = Number(url.searchParams.get("n"));
  const s = Number(url.searchParams.get("s"));
  const e = Number(url.searchParams.get("e"));
  const w = Number(url.searchParams.get("w"));
  if (![n, s, e, w].every(Number.isFinite)) return null;
  return { n, s, e, w };
}

// Level-of-detail: coarse hexes when zoomed out, fine (claimable) when zoomed in.
// Keeps cell counts / D1 reads / payload bounded at every scale, so biomes can
// render globally. Only res5 tiles carry ownership.
const TERRITORY_AREA_PER_TILE_KM2 = { 2: 86745, 3: 12393, 5: 252 };
// Per-resolution cell cap: coarse layers cover the whole globe in few hexes, so
// they can afford a higher cap; res5 (claimable) stays tight.
const TERRITORY_MAX_CELLS = { 2: 8000, 3: 4000, 5: 1800 };
function resolutionForZoom(zoom) {
  if (zoom >= 8) return 5;
  if (zoom >= 4) return 3;
  return 2;
}

// H3 hexes straddling the ±180 antimeridian have boundaries that span the whole
// globe, which Leaflet draws as a stripe across the map. Skip them (a handful of
// mostly-ocean cells near the date line).
function boundaryCrossesAntimeridian(boundary) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of boundary) {
    if (p[1] < min) min = p[1];
    if (p[1] > max) max = p[1];
  }
  return max - min > 180;
}

function biomeTileObject(h3, biome) {
  const boundary = cellToBoundary(h3);
  if (boundaryCrossesAntimeridian(boundary)) return null;
  return { h3, biome, boundary, owner: null, mine: false, state: "neutral" };
}

async function getTerritoryTiles(env, session, url) {
  const bbox = parseBbox(url);
  if (!bbox) return { tiles: [], error: "bbox required" };
  const zoom = Number(url.searchParams.get("zoom")) || 9;
  const resolution = resolutionForZoom(zoom);

  // World layer (res2): polygonToCells mis-winds near-global spans, so just
  // return the whole (small) land set — it IS the world.
  if (resolution === 2) {
    const rows = (await env.DB.prepare(
      "SELECT h3_index, biome_type FROM tile_biomes WHERE resolution = 2 AND biome_type NOT IN ('ocean','unknown')"
    ).all()).results ?? [];
    return { tiles: rows.map((r) => biomeTileObject(r.h3_index, r.biome_type)).filter(Boolean), resolution: 2 };
  }

  const perTile = TERRITORY_AREA_PER_TILE_KM2[resolution];
  const maxCells = TERRITORY_MAX_CELLS[resolution];

  // Guard before polygonToCells: bound how many cells a viewport can enumerate.
  const midLat = (bbox.n + bbox.s) / 2;
  const areaKm2 =
    Math.abs(bbox.n - bbox.s) * 111 *
    Math.abs(bbox.e - bbox.w) * 111 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  if (areaKm2 / perTile > maxCells * 1.5) {
    return { tiles: [], tooMany: true, resolution };
  }

  // polygonToCells loop is [lat, lng] (isGeoJson=false). Clamp to valid lat range.
  const n = Math.min(89.9, bbox.n);
  const s = Math.max(-89.9, bbox.s);
  const loop = [[n, bbox.w], [n, bbox.e], [s, bbox.e], [s, bbox.w], [n, bbox.w]];
  let cells = [];
  try {
    cells = polygonToCells([loop], resolution);
  } catch {
    cells = [];
  }
  if (cells.length === 0) return { tiles: [], resolution };
  if (cells.length > maxCells) {
    return { tiles: [], tooMany: true, count: cells.length, resolution };
  }

  const biomeByCell = new Map();
  for (const chunk of chunkArray(cells, 200)) {
    const placeholders = chunk.map(() => "?").join(",");
    const res = await env.DB.prepare(
      "SELECT h3_index, biome_type FROM tile_biomes WHERE h3_index IN (" + placeholders + ")"
    ).bind(...chunk).all();
    for (const row of res.results ?? []) biomeByCell.set(row.h3_index, row.biome_type);
  }

  // Ownership is only meaningful at the claimable (res5) level.
  const ownerByCell = new Map();
  const myUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;
  if (resolution === 5) {
    for (const chunk of chunkArray(cells, 200)) {
      const placeholders = chunk.map(() => "?").join(",");
      const res = await env.DB.prepare(
        "SELECT h3_index, owner_id, state, garrison_deadline FROM tiles WHERE h3_index IN (" + placeholders + ")"
      ).bind(...chunk).all();
      for (const row of res.results ?? []) ownerByCell.set(row.h3_index, row);
    }
  }

  const tiles = [];
  for (const cell of cells) {
    const biome = biomeByCell.get(cell) || "unknown";
    // Only coastal ocean is stored at res5 (open ocean isn't), so showing 'ocean'
    // here surfaces the claimable coastal-water ring for marine observers.
    if (biome === "unknown") continue;
    const boundary = cellToBoundary(cell); // [[lat, lng], ...]
    if (boundaryCrossesAntimeridian(boundary)) continue;
    const owned = ownerByCell.get(cell) || null;
    tiles.push({
      h3: cell,
      biome,
      boundary,
      owner: owned?.owner_id ?? null,
      mine: Boolean(myUserId && owned?.owner_id === myUserId),
      state: owned?.state ?? "neutral"
    });
  }
  return { tiles, resolution };
}

async function getTerritoryObservations(env, session, url) {
  if (!session?.inat_login) return { observations: [] };
  const userId = inatUserIdFor(session.inat_login);
  const bbox = parseBbox(url);

  let query =
    "SELECT inat_observation_id AS id, latitude, longitude, taxon_id, taxon_name, " +
    "iconic_taxon_name, h3_index, observed_at FROM tile_observations WHERE user_id = ?";
  const binds = [userId];
  if (bbox) {
    query += " AND latitude <= ? AND latitude >= ? AND longitude <= ? AND longitude >= ?";
    binds.push(bbox.n, bbox.s, bbox.e, bbox.w);
  }
  query += " LIMIT 2000";

  const res = await env.DB.prepare(query).bind(...binds).all();
  return { observations: res.results ?? [] };
}

// Claimed tiles in view, each with its owner's Bluesky handle + avatar (for the
// "Claims" map mode: owner-colored territory clusters with PFP markers).
async function getTerritoryClaims(env, session, url) {
  const bbox = parseBbox(url);
  const myUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;

  const rows = (await env.DB.prepare(`
    SELECT t.h3_index, t.owner_id, t.biome_type, a.handle, a.avatar_url, a.did
    FROM tiles t
    LEFT JOIN users u ON u.id = t.owner_id
    LEFT JOIN accounts a ON a.inat_login = u.inat_login
    WHERE t.owner_id IS NOT NULL
    LIMIT 5000
  `).all()).results ?? [];

  const claims = [];
  for (const row of rows) {
    const boundary = cellToBoundary(row.h3_index); // [[lat, lng], ...]
    let lat = 0;
    let lng = 0;
    for (const point of boundary) {
      lat += point[0];
      lng += point[1];
    }
    lat /= boundary.length;
    lng /= boundary.length;
    if (bbox && (lat > bbox.n || lat < bbox.s || lng > bbox.e || lng < bbox.w)) continue;
    const login = ownerDisplayName(row.owner_id);
    claims.push({
      h3: row.h3_index,
      boundary,
      centroid: [lat, lng],
      biome: row.biome_type || null,
      login,
      handle: row.handle || login,
      avatarUrl: row.avatar_url || null,
      did: row.did || row.owner_id,
      mine: Boolean(myUserId && row.owner_id === myUserId)
    });
  }
  return { claims };
}

// Territory leaderboard: rank holders by tiles controlled (then biome variety).
const TERRITORY_LEADERBOARD_SELECT = `
  WITH holdings AS (
    SELECT
      owner_id,
      count(*) AS tiles,
      count(DISTINCT biome_type) AS biomes,
      (SELECT biome_type FROM tiles t2 WHERE t2.owner_id = t.owner_id
       GROUP BY biome_type ORDER BY count(*) DESC, biome_type ASC LIMIT 1) AS top_biome
    FROM tiles t
    WHERE owner_id IS NOT NULL
    GROUP BY owner_id
  )
  SELECT
    h.owner_id, h.tiles, h.biomes, h.top_biome,
    u.display_name AS user_display_name, u.inat_login,
    a.handle AS bsky_handle, a.display_name AS bsky_display_name, a.avatar_url
  FROM holdings h
  LEFT JOIN users u ON u.id = h.owner_id
  LEFT JOIN accounts a ON a.did = (
    SELECT did FROM accounts WHERE inat_login = u.inat_login ORDER BY updated_at DESC LIMIT 1
  )
`;

function territoryLeaderboardEntry(row, rank) {
  return {
    rank,
    userId: row.owner_id,
    name: row.bsky_display_name || row.user_display_name || row.bsky_handle || row.inat_login || ownerDisplayName(row.owner_id),
    handle: row.bsky_handle || null,
    avatarUrl: row.avatar_url || null,
    tiles: Number(row.tiles ?? 0),
    biomes: Number(row.biomes ?? 0),
    topBiome: row.top_biome || null
  };
}

async function getTerritoryLeaderboard(env, viewerUserId = null, limit = 50) {
  const rows = await env.DB.prepare(
    TERRITORY_LEADERBOARD_SELECT + " ORDER BY h.tiles DESC, h.biomes DESC, h.owner_id ASC LIMIT ?"
  ).bind(limit).all();
  const entries = (rows.results ?? []).map((row, index) => territoryLeaderboardEntry(row, index + 1));

  const totalRow = await env.DB.prepare(
    "SELECT count(DISTINCT owner_id) AS total FROM tiles WHERE owner_id IS NOT NULL"
  ).first();
  const total = Number(totalRow?.total ?? entries.length);

  let you = viewerUserId ? entries.find((entry) => entry.userId === viewerUserId) ?? null : null;
  if (!you && viewerUserId) {
    const row = await env.DB.prepare(TERRITORY_LEADERBOARD_SELECT + " WHERE h.owner_id = ?").bind(viewerUserId).first();
    if (row) {
      const rankRow = await env.DB.prepare(
        "SELECT count(*) + 1 AS rank FROM (SELECT owner_id, count(*) AS tiles FROM tiles WHERE owner_id IS NOT NULL GROUP BY owner_id) WHERE tiles > ?"
      ).bind(Number(row.tiles)).first();
      you = territoryLeaderboardEntry(row, Number(rankRow?.rank ?? 0));
    }
  }
  return { entries, totalPlayers: total, you };
}

// Same-origin proxy for Bluesky avatars so the client can read their pixels on a
// <canvas> (the bsky CDN doesn't send CORS headers, which taints the canvas and
// blocks dominant-color extraction). Host-allowlisted to avoid an open proxy.
async function proxyAvatar(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  const host = target.hostname;
  const allowed = host === "cdn.bsky.app" || host.endsWith(".bsky.app") || host.endsWith(".bsky.network");
  if (target.protocol !== "https:" || !allowed) {
    return new Response("forbidden host", { status: 403 });
  }
  const upstream = await fetch(target.toString(), {
    headers: { accept: "image/*" },
    cf: { cacheTtl: 86400, cacheEverything: true }
  });
  if (!upstream.ok) return new Response("upstream error", { status: 502 });
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") || "image/jpeg");
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "public, max-age=86400");
  return new Response(upstream.body, { status: 200, headers });
}

// --- Territory: claim & contest tiles (Biome merge, Bridge 3) ---

const TERRITORY_DAILY_ACTION_CAP_DEFAULT = 20;
const TERRITORY_MAX_DEFENSE = 5;
// You can only claim/contest a tile where you've documented real biodiversity:
// at least this many distinct research-grade species, observed in the tile.
const TERRITORY_MIN_LOCAL_SPECIES = 5;
// Bonus to a creature you've RG-observed *in this tile* — local knowledge, for
// both the attacker and the defender (stacks with terrain + held-territory).
const TERRITORY_LOCAL_BUFF_PCT = 0.04;
// Minutes a freshly-claimed/captured tile stays owned-but-undefended (and
// contest-locked) before you must garrison it or it reverts to neutral.
const TERRITORY_GARRISON_GRACE_MIN = 15;

function ownerDisplayName(userId) {
  if (!userId) return null;
  return userId.startsWith("inat:") ? userId.slice(5) : userId;
}

// Distinct research-grade species the user has observed in a given tile.
async function localSpeciesCount(env, userId, h3) {
  const row = await env.DB.prepare(
    "SELECT count(DISTINCT taxon_id) AS n FROM tile_observations WHERE user_id = ? AND h3_index = ? AND taxon_id IS NOT NULL"
  ).bind(userId, h3).first();
  return Number(row?.n ?? 0);
}

// The set of taxon ids the user has observed in a tile (for the local battle buff).
async function localTaxonSet(env, userId, h3) {
  const rows = (await env.DB.prepare(
    "SELECT DISTINCT taxon_id FROM tile_observations WHERE user_id = ? AND h3_index = ? AND taxon_id IS NOT NULL"
  ).bind(userId, h3).all()).results ?? [];
  return new Set(rows.map((r) => Number(r.taxon_id)));
}

async function territoryActionsToday(env, userId) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM territory_actions WHERE user_id = ? AND date(created_at) = date('now')"
  ).bind(userId).first();
  return Number(row?.n ?? 0);
}

async function userObservedTile(env, userId, h3) {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM tile_observations WHERE user_id = ? AND h3_index = ? LIMIT 1"
  ).bind(userId, h3).first();
  return Boolean(row);
}

async function tileBiomeFor(env, h3) {
  const row = await env.DB.prepare("SELECT biome_type FROM tile_biomes WHERE h3_index = ?").bind(h3).first();
  return row?.biome_type || "neutral";
}

async function logTerritoryAction(env, userId, h3, actionType, battleId) {
  await env.DB.prepare(
    "INSERT INTO territory_actions (user_id, h3_index, action_type, ap_spent, battle_id, created_at) VALUES (?, ?, ?, 1, ?, ?)"
  ).bind(userId, h3, actionType, battleId ?? null, new Date().toISOString()).run();
}

// Garrison home-field buff: defense_strength nudges the defenders' HP/guard up a
// touch (on top of terrain). Modest and capped.
function applyTileDefenseBuff(team, strength) {
  const s = Math.min(TERRITORY_MAX_DEFENSE, Math.max(0, Number(strength) || 0));
  if (s <= 0) return;
  const mult = 1 + s * 0.06;
  for (const creature of team.creatures) {
    const baseMax = creature.maxHp ?? creature.hp ?? 1;
    creature.maxHp = Math.round(baseMax * mult);
    creature.hp = creature.maxHp;
    if (creature.stats && creature.stats.guard) {
      creature.stats.guard = Math.round(creature.stats.guard * mult);
    }
  }
}

function garrisonDeadlineIso() {
  return new Date(Date.now() + TERRITORY_GARRISON_GRACE_MIN * 60 * 1000).toISOString();
}

async function tileGarrisonTaxa(env, h3) {
  const rows = (await env.DB.prepare(
    "SELECT taxon_id FROM tile_garrison WHERE h3_index = ?"
  ).bind(h3).all()).results ?? [];
  return rows.map((r) => Number(r.taxon_id));
}

async function revertTileToNeutral(env, h3, nowIso) {
  await env.DB.prepare(
    "UPDATE tiles SET owner_id = NULL, state = 'neutral', garrison_deadline = NULL, " +
    "defender_team_json = NULL, capture_progress = 0, defense_strength = 0, updated_at = ? WHERE h3_index = ?"
  ).bind(nowIso, h3).run();
  await env.DB.prepare("DELETE FROM tile_garrison WHERE h3_index = ?").bind(h3).run();
}

// If an owned tile's garrison grace window elapsed undefended, revert it now.
async function maybeRevertExpiredTile(env, tile, h3, nowIso) {
  if (!tile || !tile.garrison_deadline) return false;
  if (tile.garrison_deadline > nowIso) return false;
  await revertTileToNeutral(env, h3, nowIso);
  return true;
}

// Cron sweep: revert every expired, undefended tile to neutral.
async function revertExpiredTiles(env) {
  const nowIso = new Date().toISOString();
  const expired = (await env.DB.prepare(
    "SELECT h3_index FROM tiles WHERE garrison_deadline IS NOT NULL AND garrison_deadline < ?"
  ).bind(nowIso).all()).results ?? [];
  for (const row of expired) {
    await revertTileToNeutral(env, row.h3_index, nowIso);
  }
  return expired.length;
}

async function getTerritoryTileDetail(env, session, h3) {
  if (!h3) throw httpError("h3 required", 400);
  const myUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;
  const biome = await tileBiomeFor(env, h3);
  const nowIso = new Date().toISOString();
  let tile = await env.DB.prepare(
    "SELECT owner_id, state, defense_strength, garrison_deadline FROM tiles WHERE h3_index = ?"
  ).bind(h3).first();
  if (await maybeRevertExpiredTile(env, tile, h3, nowIso)) tile = null;

  const ownerId = tile?.owner_id ?? null;
  const mine = Boolean(myUserId && ownerId === myUserId);
  const pending = Boolean(ownerId && tile?.garrison_deadline);
  const defended = Boolean(ownerId && !pending);
  const minutesLeft = pending
    ? Math.max(0, Math.ceil((Date.parse(tile.garrison_deadline) - Date.now()) / 60000))
    : 0;
  const need = intEnv(env, "TERRITORY_MIN_LOCAL_SPECIES", TERRITORY_MIN_LOCAL_SPECIES);
  const localSpecies = myUserId ? await localSpeciesCount(env, myUserId, h3) : 0;
  const eligible = localSpecies >= need;
  const cap = intEnv(env, "TERRITORY_DAILY_ACTION_CAP", TERRITORY_DAILY_ACTION_CAP_DEFAULT);
  const actionsToday = myUserId ? await territoryActionsToday(env, myUserId) : 0;

  // Roster power: how many tiles of this biome the viewer holds, and the buff
  // their biome-native species get from it (Bridge 4).
  let biomeHoldings = 0;
  if (myUserId) {
    const hc = await env.DB.prepare(
      "SELECT count(*) AS n FROM tiles WHERE owner_id = ? AND biome_type = ?"
    ).bind(myUserId, biome).first();
    biomeHoldings = Number(hc?.n ?? 0);
  }

  return {
    h3,
    biome,
    owner: ownerDisplayName(ownerId),
    mine,
    owned: Boolean(ownerId),
    pending,
    defended,
    minutesLeft,
    state: tile?.state ?? "neutral",
    defenseStrength: Number(tile?.defense_strength ?? 0),
    localSpecies,
    speciesNeeded: need,
    eligible,
    canClaim: Boolean(myUserId && eligible && !ownerId),
    canContest: Boolean(myUserId && eligible && defended && !mine),
    canGarrison: mine,
    actionsLeftToday: Math.max(0, cap - actionsToday),
    favoredTypes: TERRAIN_MOVE_BONUS[biome] ?? [],
    biomeHoldings,
    biomeBuffPct: territoryBuffPctForBiomeCount(biomeHoldings)
  };
}

async function assertTerritoryActionAllowed(env, userId, h3) {
  const cap = intEnv(env, "TERRITORY_DAILY_ACTION_CAP", TERRITORY_DAILY_ACTION_CAP_DEFAULT);
  if ((await territoryActionsToday(env, userId)) >= cap) {
    throw httpError("Daily territory action limit reached — try again tomorrow", 429);
  }
  const need = intEnv(env, "TERRITORY_MIN_LOCAL_SPECIES", TERRITORY_MIN_LOCAL_SPECIES);
  const have = await localSpeciesCount(env, userId, h3);
  if (have < need) {
    throw httpError(
      "You need " + need + " research-grade species observed in this tile to act on it (you have " + have + ").",
      403
    );
  }
}

// Claim an unowned tile — takes the tile but leaves it UNDEFENDED on the grace
// clock; the player garrisons it as a separate step (assignTileGarrison).
async function claimTerritoryTile(env, session, h3) {
  const userId = requireLinkedUserId(session);
  if (!h3) throw httpError("h3 required", 400);
  await assertTerritoryActionAllowed(env, userId, h3);

  const now = new Date().toISOString();
  let existing = await env.DB.prepare(
    "SELECT owner_id, garrison_deadline FROM tiles WHERE h3_index = ?"
  ).bind(h3).first();
  if (await maybeRevertExpiredTile(env, existing, h3, now)) existing = null;
  if (existing?.owner_id) throw httpError("This tile is already claimed — contest it instead", 409);

  const biome = await tileBiomeFor(env, h3);
  const deadline = garrisonDeadlineIso();
  await env.DB.prepare(`
    INSERT INTO tiles (
      h3_index, resolution, biome_type, state, owner_id, capture_progress,
      defense_strength, garrison_deadline, defender_team_json, claimed_at, last_activity_at, created_at, updated_at
    )
    VALUES (?, ?, ?, 'claimed', ?, 100, 1, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(h3_index) DO UPDATE SET
      owner_id = excluded.owner_id, state = 'claimed', capture_progress = 100,
      defense_strength = 1, garrison_deadline = excluded.garrison_deadline, defender_team_json = NULL,
      claimed_at = excluded.claimed_at, biome_type = excluded.biome_type,
      last_activity_at = excluded.last_activity_at, updated_at = excluded.updated_at
  `).bind(h3, TERRITORY_H3_RESOLUTION, biome, userId, deadline, now, now, now, now).run();
  await env.DB.prepare("DELETE FROM tile_garrison WHERE h3_index = ?").bind(h3).run();

  await logTerritoryAction(env, userId, h3, "claim", null);
  return { ok: true, h3, biome, owner: ownerDisplayName(userId), mine: true, pending: true, garrisonDeadline: deadline };
}

// Assign (or swap) a tile's garrison from 5 of your FREE species — each species
// can defend only one tile. Clears the grace clock once defended.
async function assignTileGarrison(env, session, h3, rawTaxonIds) {
  const userId = requireLinkedUserId(session);
  if (!h3) throw httpError("h3 required", 400);
  const taxonIds = [...new Set((rawTaxonIds ?? []).map((id) => Number.parseInt(id, 10)).filter(Number.isFinite))].slice(0, 5);
  if (taxonIds.length !== 5) throw httpError("Pick exactly 5 ready creatures to garrison the tile", 400);

  const now = new Date().toISOString();
  let tile = await env.DB.prepare(
    "SELECT owner_id, garrison_deadline FROM tiles WHERE h3_index = ?"
  ).bind(h3).first();
  if (await maybeRevertExpiredTile(env, tile, h3, now)) tile = null;
  if (!tile?.owner_id) throw httpError("You don't hold this tile (it may have reverted to neutral).", 409);
  if (tile.owner_id !== userId) throw httpError("This tile isn't yours to garrison", 403);

  await assertUserOwnsReadyTaxa(env, userId, taxonIds);

  // Exclusivity: none of these may already defend a DIFFERENT tile of yours.
  const placeholders = taxonIds.map(() => "?").join(",");
  const conflicts = (await env.DB.prepare(
    "SELECT DISTINCT taxon_id FROM tile_garrison WHERE owner_id = ? AND h3_index != ? AND taxon_id IN (" + placeholders + ")"
  ).bind(userId, h3, ...taxonIds).all()).results ?? [];
  if (conflicts.length) {
    throw httpError("Some of those species already defend another tile — each can garrison only one.", 409);
  }

  await env.DB.prepare("DELETE FROM tile_garrison WHERE h3_index = ?").bind(h3).run();
  await env.DB.batch(taxonIds.map((tid) => env.DB.prepare(
    "INSERT INTO tile_garrison (h3_index, owner_id, taxon_id, created_at) VALUES (?, ?, ?, ?)"
  ).bind(h3, userId, tid, now)));
  await env.DB.prepare(
    "UPDATE tiles SET garrison_deadline = NULL, state = 'claimed', last_activity_at = ?, updated_at = ? WHERE h3_index = ?"
  ).bind(now, now, h3).run();

  return { ok: true, h3, defended: true };
}

async function contestTerritoryTile(env, session, h3, rawTaxonIds) {
  const userId = requireLinkedUserId(session);
  if (!h3) throw httpError("h3 required", 400);
  const taxonIds = (rawTaxonIds ?? []).map((id) => Number.parseInt(id, 10)).filter(Number.isFinite).slice(0, 5);
  if (taxonIds.length !== 5) throw httpError("Pick exactly 5 ready creatures to contest with", 400);

  await assertTerritoryActionAllowed(env, userId, h3);

  const now0 = new Date().toISOString();
  let tile = await env.DB.prepare(
    "SELECT owner_id, biome_type, defense_strength, garrison_deadline FROM tiles WHERE h3_index = ?"
  ).bind(h3).first();
  if (await maybeRevertExpiredTile(env, tile, h3, now0)) tile = null;
  if (!tile?.owner_id) throw httpError("This tile is unclaimed — claim it instead", 409);
  if (tile.owner_id === userId) throw httpError("You already hold this tile", 400);
  if (tile.garrison_deadline) throw httpError("This tile was just taken — its defenses are still being set up. Try again shortly.", 409);

  const defenderTaxonIds = await tileGarrisonTaxa(env, h3);
  if (!defenderTaxonIds.length) throw httpError("This tile has no defenders to fight", 409);

  await assertUserOwnsReadyTaxa(env, userId, taxonIds);

  const defenderUserId = tile.owner_id;
  // Local-knowledge bonus: each side's species RG-observed in this tile hit harder.
  const attackerLocals = await localTaxonSet(env, userId, h3);
  const defenderLocals = await localTaxonSet(env, defenderUserId, h3);
  const playerCreatures = await loadUserBattleCreatures(env, userId, taxonIds, "p", "owner", attackerLocals);
  const opponentCreatures = await loadUserBattleCreatures(env, defenderUserId, defenderTaxonIds, "o", "public", defenderLocals);

  const biome = tile.biome_type || (await tileBiomeFor(env, h3));
  const now = new Date().toISOString();
  const battleId = randomId("battle");
  const seed = randomId("seed");
  const defenderName = ownerDisplayName(defenderUserId);
  const state = {
    battleId,
    mode: "territory_contest",
    tileH3: h3,
    attackerTaxonIds: taxonIds,
    seed,
    turn: 1,
    terrain: biome,
    player: { userId, name: "Your Team", activeIndex: 0, creatures: playerCreatures },
    opponent: {
      userId: defenderUserId,
      name: "@" + defenderName + "'s garrison",
      activeIndex: 0,
      creatures: opponentCreatures
    },
    log: [{ turn: 0, text: "You invade the " + biome + " tile held by @" + defenderName + "." }],
    status: "active"
  };
  applyTileDefenseBuff(state.opponent, Number(tile.defense_strength ?? 0));

  await env.DB.prepare(`
    INSERT INTO battle_instances (
      battle_id, mode, attacker_user_id, defender_user_id,
      state_json, seed, turn, status, created_at, updated_at
    )
    VALUES (?, 'territory_contest', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(battleId, userId, defenderUserId, JSON.stringify(state), seed, state.turn, state.status, now, now).run();

  await logTerritoryAction(env, userId, h3, "contest", battleId);
  return state;
}

// Hook from the battle resolver: a finished contest flips (or fortifies) its tile.
// On a win the tile transfers but starts UNDEFENDED on the grace clock — the new
// owner must garrison it (the old garrison is freed).
async function resolveTileContest(env, state, now) {
  const h3 = state.tileH3;
  if (!h3) return;
  if (state.status === "won") {
    await env.DB.prepare(`
      UPDATE tiles SET owner_id = ?, defender_team_json = NULL, state = 'claimed',
        capture_progress = 100, defense_strength = 1, garrison_deadline = ?,
        claimed_at = ?, last_activity_at = ?, updated_at = ?
      WHERE h3_index = ?
    `).bind(state.player.userId, garrisonDeadlineIso(), now, now, now, h3).run();
    await env.DB.prepare("DELETE FROM tile_garrison WHERE h3_index = ?").bind(h3).run();
  } else if (state.status === "lost") {
    await env.DB.prepare(`
      UPDATE tiles SET defense_strength = MIN(defense_strength + 1, ?),
        last_activity_at = ?, updated_at = ?
      WHERE h3_index = ?
    `).bind(TERRITORY_MAX_DEFENSE, now, now, h3).run();
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchRgSpeciesCounts(env, inatLogin) {
  const cacheKey = `inat:species_counts:${inatLogin.toLowerCase()}:rg:v2`;
  const cooldownKey = `inat:species_counts:${inatLogin.toLowerCase()}:rg:cooldown`;
  const cached = await readSpeciesCountsCache(env, cacheKey);
  if (cached?.fresh) return cached.rows;
  if (await readInatCooldown(env, cooldownKey)) {
    if (cached?.rows?.length) return cached.rows;
    throw inatRateLimitError("iNaturalist Research Grade counts are temporarily rate-limited");
  }

  const maxPages = intEnv(env, "MAX_IMPORT_PAGES", 1);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${INAT_API_BASE_URL}/observations/species_counts`);
    url.searchParams.set("user_login", inatLogin);
    url.searchParams.set("quality_grade", "research");
    url.searchParams.set("per_page", "500");
    url.searchParams.set("page", String(page));
    url.searchParams.set("fields", INAT_SPECIES_COUNT_FIELDS);
    url.searchParams.set("ttl", String(INAT_SPECIES_CACHE_TTL_SECONDS));

    const res = await fetchInatWithRetry(url.toString());
    if (!res.ok) {
      if (res.status === 429) {
        await writeInatCooldown(env, cooldownKey);
        if (cached?.rows?.length) return cached.rows;
        throw inatRateLimitError(`iNaturalist Research Grade counts failed (${res.status})`);
      }
      const error = new Error(`iNaturalist Research Grade counts failed (${res.status})`);
      throw error;
    }

    const data = await res.json();
    const pageRows = Array.isArray(data.results) ? data.results : [];
    rows.push(...pageRows);
    if (pageRows.length < 500) break;
    if (page < maxPages) await sleep(1100);
  }

  await writeSpeciesCountsCache(env, cacheKey, rows);
  return rows;
}

async function loadTaxonInfoCache(env, taxonIds) {
  const map = new Map();
  for (const chunk of chunkArray(taxonIds, 80)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT * FROM taxon_info_cache WHERE taxon_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const row of rows.results ?? []) map.set(Number(row.taxon_id), row);
  }
  return map;
}

async function applyTrainingRosterFallback(env, userId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM user_taxa
    WHERE user_id = ?
      AND obs_count > 0
      AND COALESCE(training_count_source, '') != ?
  `).bind(userId, TRAINING_COUNT_SOURCE_RESEARCH).first();

  await env.DB.prepare(`
    UPDATE user_taxa
    SET rg_obs_count = obs_count,
        training_count_source = ?
    WHERE user_id = ?
      AND obs_count > 0
      AND COALESCE(training_count_source, '') != ?
  `).bind(
    TRAINING_COUNT_SOURCE_ROSTER_FALLBACK,
    userId,
    TRAINING_COUNT_SOURCE_RESEARCH
  ).run();

  return Number(row?.count ?? 0);
}

// `providedRows` (optional) are RG species_counts rows fetched in the user's
// browser (see POST /api/training/sync), so the Worker skips its own iNat call.
async function syncTrainingData(env, session, providedRows = null) {
  const userId = requireLinkedUserId(session);
  const now = new Date().toISOString();
  const summary = {
    rgSpeciesUpdated: 0,
    provisionalSpeciesUpdated: 0,
    taxaResolved: 0,
    unresolvedTaxa: 0,
    ancestorsFetched: 0,
    masteriesUpdated: 0,
    warning: null
  };

  // 1. Research Grade counts per species, with roster-count fallback during iNat rate limits.
  try {
    const rgRows = Array.isArray(providedRows)
      ? providedRows
      : await fetchRgSpeciesCounts(env, session.inat_login);
    await env.DB.prepare(`
      UPDATE user_taxa
      SET rg_obs_count = 0,
          training_count_source = ?
      WHERE user_id = ?
    `).bind(TRAINING_COUNT_SOURCE_RESEARCH, userId).run();

    for (const row of rgRows) {
      const taxon = row.taxon;
      if (!taxon?.id || !taxon.name) continue;
      const rgCount = Math.max(0, Number(row.count ?? 0));
      await upsertTaxonFromInat(env, taxon, now);
      await env.DB.prepare(`
        INSERT INTO user_taxa (
          user_id, taxon_id, obs_count, weighted_obs, bond_level,
          rg_obs_count, training_count_source, imported_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, taxon_id) DO UPDATE SET
          rg_obs_count = excluded.rg_obs_count,
          training_count_source = excluded.training_count_source
      `).bind(
        userId,
        taxon.id,
        rgCount,
        rgCount,
        Math.floor(10 * Math.log10(1 + rgCount)),
        rgCount,
        TRAINING_COUNT_SOURCE_RESEARCH,
        now
      ).run();
      summary.rgSpeciesUpdated += 1;
    }
  } catch (error) {
    if (error?.code === "INAT_RATE_LIMITED") {
      summary.provisionalSpeciesUpdated = await applyTrainingRosterFallback(env, userId);
      summary.warning = "iNaturalist Research Grade counts are rate-limited; using existing roster observation counts until RG refresh succeeds";
    } else {
      summary.warning = error instanceof Error ? error.message : "Research Grade fetch failed";
    }
  }

  // 2. Resolve genus/family ids for the user's taxa from their ancestry chains.
  const unresolved = await env.DB.prepare(`
    SELECT t.taxon_id, t.ancestry
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    WHERE ut.user_id = ?
      AND (t.genus_id IS NULL OR t.family_id IS NULL)
      AND t.ancestry IS NOT NULL
  `).bind(userId).all();
  const unresolvedRows = unresolved.results ?? [];

  const ancestorIds = new Set();
  for (const row of unresolvedRows) {
    for (const part of String(row.ancestry).split("/")) {
      const id = Number.parseInt(part, 10);
      if (Number.isFinite(id)) ancestorIds.add(id);
    }
  }

  const infoCache = await loadTaxonInfoCache(env, [...ancestorIds]);
  const missingIds = [...ancestorIds].filter((id) => !infoCache.has(id));

  let batches = 0;
  for (const chunk of chunkArray(missingIds, TRAINING_ANCESTOR_BATCH_SIZE)) {
    if (batches >= TRAINING_MAX_ANCESTOR_BATCHES) break;
    batches += 1;

    try {
      const url = new URL(`${INAT_API_BASE_URL}/taxa/${chunk.join(",")}`);
      url.searchParams.set("per_page", String(chunk.length));
      url.searchParams.set("fields", INAT_TAXON_INFO_FIELDS);
      url.searchParams.set("ttl", String(INAT_TAXON_CACHE_TTL_SECONDS));

      const res = await fetchInatWithRetry(url.toString());
      if (!res.ok) {
        summary.warning = summary.warning ?? `iNaturalist taxa lookup failed (${res.status}); sync again later for remaining taxa`;
        break;
      }
      const data = await res.json();
      for (const taxon of data.results ?? []) {
        const info = {
          taxon_id: taxon.id,
          rank: taxon.rank ?? null,
          name: taxon.name ?? null,
          complete_species_count: Number.isFinite(taxon.complete_species_count)
            ? taxon.complete_species_count
            : null,
          fetched_at: now
        };
        await env.DB.prepare(`
          INSERT OR REPLACE INTO taxon_info_cache (taxon_id, rank, name, complete_species_count, fetched_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(info.taxon_id, info.rank, info.name, info.complete_species_count, info.fetched_at).run();
        infoCache.set(Number(taxon.id), info);
        summary.ancestorsFetched += 1;
      }
    } catch (error) {
      summary.warning = summary.warning ?? (error instanceof Error ? error.message : "taxa lookup failed");
      break;
    }
    await sleep(600);
  }

  for (const row of unresolvedRows) {
    const chain = String(row.ancestry).split("/")
      .map((part) => Number.parseInt(part, 10))
      .filter(Number.isFinite);

    // Ancestry is ordered root -> leaf, so the last genus/family in the
    // chain is the closest to the species.
    let genus = null;
    let family = null;
    for (const id of chain) {
      const info = infoCache.get(id);
      if (!info) continue;
      if (info.rank === "genus") genus = info;
      if (info.rank === "family") family = info;
    }

    if (genus || family) {
      await env.DB.prepare(`
        UPDATE taxa
        SET genus_id = COALESCE(?, genus_id),
            genus_name = COALESCE(?, genus_name),
            family_id = COALESCE(?, family_id),
            family_name = COALESCE(?, family_name)
        WHERE taxon_id = ?
      `).bind(
        genus?.taxon_id ?? null,
        genus?.name ?? null,
        family?.taxon_id ?? null,
        family?.name ?? null,
        row.taxon_id
      ).run();
    }
    if (genus && family) summary.taxaResolved += 1;
    else summary.unresolvedTaxa += 1;
  }

  // 3. Mastery tiers (never downgraded once achieved).
  const context = await loadTrainingContext(env, userId);
  for (const kind of ["genus", "family"]) {
    const groups = kind === "genus" ? context.genusGroups : context.familyGroups;

    for (const [groupId, group] of groups) {
      if (group.observed <= 0) continue;
      const computedTier = groupTier(kind, group.observed, group.total);
      const existing = context.masteryMap.get(`${kind}:${groupId}`);
      const finalTier = existing && tierRank(existing.tier) > tierRank(computedTier)
        ? existing.tier
        : computedTier;
      if (finalTier === "none") continue;

      const achievedAt = existing && tierRank(existing.tier) >= tierRank(finalTier)
        ? existing.achieved_at
        : now;
      await env.DB.prepare(`
        INSERT INTO user_masteries (
          user_id, group_kind, group_id, group_name, tier,
          species_observed, species_total, achieved_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, group_kind, group_id) DO UPDATE SET
          group_name = excluded.group_name,
          tier = excluded.tier,
          species_observed = excluded.species_observed,
          species_total = excluded.species_total,
          achieved_at = excluded.achieved_at,
          updated_at = excluded.updated_at
      `).bind(
        userId,
        kind,
        groupId,
        group.name,
        finalTier,
        group.observed,
        group.total,
        achievedAt ?? now,
        now
      ).run();
      summary.masteriesUpdated += 1;
    }
  }

  return summary;
}

async function loadTrainingContext(env, userId) {
  const rows = await env.DB.prepare(`
    SELECT
      t.taxon_id, t.scientific_name, t.common_name, t.iconic_taxon_name, t.ancestry,
      t.genus_id, t.genus_name, t.family_id, t.family_name,
      ut.obs_count, ut.bond_level, ut.rg_obs_count, ut.training_count_source,
      st.nickname, st.allocated_json, st.points_spent, st.last_respec_at,
      (
        SELECT sa.r2_key
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
        ORDER BY
          CASE
            WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
            WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
            ELSE 3
          END,
          sa.created_at DESC
        LIMIT 1
      ) AS sprite_r2_key
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    LEFT JOIN species_training st ON st.user_id = ut.user_id AND st.taxon_id = ut.taxon_id
    WHERE ut.user_id = ?
    ORDER BY ut.rg_obs_count DESC, ut.obs_count DESC
  `).bind(DEFAULT_ASSET_KIND, ASSET_VERSION, userId).all();
  const speciesRows = rows.results ?? [];

  const genusGroups = new Map();
  const familyGroups = new Map();
  for (const row of speciesRows) {
    const hasRg = Number(row.rg_obs_count ?? 0) > 0;
    if (row.genus_id) {
      const group = genusGroups.get(row.genus_id) ?? { name: row.genus_name, observed: 0, total: null };
      if (hasRg) group.observed += 1;
      genusGroups.set(row.genus_id, group);
    }
    if (row.family_id) {
      const group = familyGroups.get(row.family_id) ?? { name: row.family_name, observed: 0, total: null };
      if (hasRg) group.observed += 1;
      familyGroups.set(row.family_id, group);
    }
  }

  const groupIds = [...genusGroups.keys(), ...familyGroups.keys()];
  if (groupIds.length) {
    const infoCache = await loadTaxonInfoCache(env, groupIds);
    for (const [groupId, group] of genusGroups) {
      group.total = infoCache.get(groupId)?.complete_species_count ?? null;
    }
    for (const [groupId, group] of familyGroups) {
      group.total = infoCache.get(groupId)?.complete_species_count ?? null;
    }
  }

  const masteryRows = await env.DB.prepare(
    "SELECT * FROM user_masteries WHERE user_id = ?"
  ).bind(userId).all();
  const masteryMap = new Map();
  for (const row of masteryRows.results ?? []) {
    masteryMap.set(`${row.group_kind}:${row.group_id}`, row);
  }

  return { speciesRows, genusGroups, familyGroups, masteryMap };
}

function trainingTiersForRow(row, masteryMap) {
  return {
    genusTier: row.genus_id ? masteryMap.get(`genus:${row.genus_id}`)?.tier ?? "none" : "none",
    familyTier: row.family_id ? masteryMap.get(`family:${row.family_id}`)?.tier ?? "none" : "none"
  };
}

function buildTrainingEntry(row, context) {
  const rg = Math.max(0, Number(row.rg_obs_count ?? 0));
  const hasRg = rg > 0 ? 1 : 0;
  const genusObserved = row.genus_id ? context.genusGroups.get(row.genus_id)?.observed ?? 0 : 0;
  const familyObserved = row.family_id ? context.familyGroups.get(row.family_id)?.observed ?? 0 : 0;
  const { genusTier, familyTier } = trainingTiersForRow(row, context.masteryMap);

  const earned = speciesEarnedPoints({
    rgObsCount: rg,
    genusOthers: Math.max(0, genusObserved - hasRg),
    familyOthers: Math.max(0, familyObserved - hasRg),
    genusTier,
    familyTier
  });

  const allocations = sanitizeAllocations(row.allocated_json);
  const spent = Math.max(0, Number(row.points_spent ?? 0));
  const available = Math.max(0, earned.total - spent);
  const buffPct = combinedBuffPct(genusTier, familyTier);
  const nickname = row.nickname ?? null;

  const summary = taxonSummaryFromRow(row);
  const baseCreature = createBattleCreature(summary, "train-base");
  const trainedCreature = createBattleCreature(summary, "train", {
    allocations,
    buffPct,
    nickname,
    level: spent
  });

  const stats = {};
  for (const stat of TRAINING_STATS) {
    stats[stat] = {
      base: baseCreature.stats[stat],
      allocated: allocations[stat] ?? 0,
      total: trainedCreature.stats[stat],
      cap: statCapFor(baseCreature.stats[stat])
    };
  }

  const lastRespec = row.last_respec_at ? Date.parse(row.last_respec_at) : null;
  const respecAvailableAt = lastRespec ? new Date(lastRespec + RESPEC_COOLDOWN_MS).toISOString() : null;

  return {
    taxonId: row.taxon_id,
    name: row.common_name || row.scientific_name,
    scientificName: row.scientific_name,
    iconicTaxonName: row.iconic_taxon_name ?? null,
    spriteUrl: row.sprite_r2_key ? `/api/assets/${encodeR2Key(row.sprite_r2_key)}` : null,
    nickname,
    level: spent,
    rgObsCount: rg,
    countSource: row.training_count_source ?? null,
    genus: row.genus_id ? { id: row.genus_id, name: row.genus_name, tier: genusTier } : null,
    family: row.family_id ? { id: row.family_id, name: row.family_name, tier: familyTier } : null,
    earned,
    spent,
    available,
    buffPct,
    maxHp: trainedCreature.maxHp,
    stats,
    respecAvailableAt,
    canRespec: spent > 0 && (!lastRespec || Date.now() - lastRespec >= RESPEC_COOLDOWN_MS)
  };
}

function masteryOverviewList(context) {
  const list = [];
  for (const kind of ["genus", "family"]) {
    const groups = kind === "genus" ? context.genusGroups : context.familyGroups;
    for (const [groupId, group] of groups) {
      if (group.observed <= 0) continue;
      const stored = context.masteryMap.get(`${kind}:${groupId}`);
      const tier = stored?.tier ?? groupTier(kind, group.observed, group.total);
      list.push({
        kind,
        groupId,
        name: group.name,
        tier,
        observed: group.observed,
        total: group.total,
        next: nextTierTarget(kind, tier),
        buffPct: combinedBuffPct(kind === "genus" ? tier : "none", kind === "family" ? tier : "none")
      });
    }
  }
  list.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.observed - a.observed);
  return list;
}

async function getTrainingOverview(env, session) {
  const userId = requireLinkedUserId(session);
  const context = await loadTrainingContext(env, userId);
  const species = context.speciesRows.map((row) => buildTrainingEntry(row, context));

  const totals = species.reduce(
    (acc, entry) => {
      acc.earned += entry.earned.total;
      acc.spent += entry.spent;
      acc.available += entry.available;
      return acc;
    },
    { earned: 0, spent: 0, available: 0 }
  );

  return {
    userId,
    totals,
    species,
    masteries: masteryOverviewList(context)
  };
}

async function upsertSpeciesTraining(env, userId, taxonId, fields) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO species_training (
      user_id, taxon_id, nickname, allocated_json, points_spent, last_respec_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, taxon_id) DO UPDATE SET
      nickname = COALESCE(excluded.nickname, species_training.nickname),
      allocated_json = COALESCE(excluded.allocated_json, species_training.allocated_json),
      points_spent = COALESCE(excluded.points_spent, species_training.points_spent),
      last_respec_at = COALESCE(excluded.last_respec_at, species_training.last_respec_at),
      updated_at = excluded.updated_at
  `).bind(
    userId,
    taxonId,
    fields.nickname ?? null,
    fields.allocatedJson ?? null,
    fields.pointsSpent ?? null,
    fields.lastRespecAt ?? null,
    now,
    now
  ).run();
}

async function findTrainingEntry(env, userId, taxonId) {
  const context = await loadTrainingContext(env, userId);
  const row = context.speciesRows.find((candidate) => Number(candidate.taxon_id) === taxonId);
  if (!row) throw httpError("That species is not in your roster", 404);
  return { context, row };
}

async function allocateTrainingPoints(env, session, payload) {
  const userId = requireLinkedUserId(session);
  const taxonId = Number.parseInt(payload.taxonId, 10);
  if (!Number.isFinite(taxonId)) throw httpError("Missing taxonId", 400);

  const additions = sanitizeAllocations(payload.allocations);
  const sumAdd = allocationsTotal(additions);
  if (sumAdd <= 0) throw httpError("No points to allocate", 400);

  const { context, row } = await findTrainingEntry(env, userId, taxonId);
  const entry = buildTrainingEntry(row, context);
  if (entry.available < sumAdd) {
    throw httpError(`Not enough points: ${entry.available} available, ${sumAdd} requested`, 400);
  }

  const merged = sanitizeAllocations(row.allocated_json);
  for (const stat of TRAINING_STATS) {
    const add = additions[stat] ?? 0;
    if (!add) continue;
    const next = (merged[stat] ?? 0) + add;
    if (next > entry.stats[stat].cap) {
      throw httpError(`${stat} is capped at +${entry.stats[stat].cap} for this species`, 400);
    }
    merged[stat] = next;
  }

  await upsertSpeciesTraining(env, userId, taxonId, {
    allocatedJson: JSON.stringify(merged),
    pointsSpent: entry.spent + sumAdd
  });

  row.allocated_json = JSON.stringify(merged);
  row.points_spent = entry.spent + sumAdd;
  return buildTrainingEntry(row, context);
}

async function respecTraining(env, session, rawTaxonId) {
  const userId = requireLinkedUserId(session);
  const taxonId = Number.parseInt(rawTaxonId, 10);
  if (!Number.isFinite(taxonId)) throw httpError("Missing taxonId", 400);

  const { context, row } = await findTrainingEntry(env, userId, taxonId);
  if (!row.points_spent) throw httpError("No allocated points to respec", 400);

  const lastRespec = row.last_respec_at ? Date.parse(row.last_respec_at) : null;
  if (lastRespec && Date.now() - lastRespec < RESPEC_COOLDOWN_MS) {
    const nextAt = new Date(lastRespec + RESPEC_COOLDOWN_MS).toISOString().slice(0, 10);
    throw httpError(`Free respec is once per week; next available ${nextAt}`, 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE species_training
    SET allocated_json = '{}', points_spent = 0, last_respec_at = ?, updated_at = ?
    WHERE user_id = ? AND taxon_id = ?
  `).bind(now, now, userId, taxonId).run();

  row.allocated_json = "{}";
  row.points_spent = 0;
  row.last_respec_at = now;
  return buildTrainingEntry(row, context);
}

async function setTrainingNickname(env, session, rawTaxonId, rawNickname) {
  const userId = requireLinkedUserId(session);
  const taxonId = Number.parseInt(rawTaxonId, 10);
  if (!Number.isFinite(taxonId)) throw httpError("Missing taxonId", 400);

  await findTrainingEntry(env, userId, taxonId);
  const nickname = sanitizeNickname(rawNickname);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO species_training (user_id, taxon_id, nickname, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, taxon_id) DO UPDATE SET
      nickname = excluded.nickname,
      updated_at = excluded.updated_at
  `).bind(userId, taxonId, nickname, now, now).run();

  return { taxonId, nickname };
}

async function loadUserBuffMap(env, userId) {
  const rows = await env.DB.prepare(`
    SELECT group_kind, group_id, tier
    FROM user_masteries
    WHERE user_id = ? AND tier IN ('gold', 'complete')
  `).bind(userId).all();

  const map = new Map();
  for (const row of rows.results ?? []) {
    map.set(`${row.group_kind}:${row.group_id}`, row.tier);
  }
  return map;
}

function trainingFromRow(row, buffMap) {
  const genusTier = row.genus_id ? buffMap.get(`genus:${row.genus_id}`) ?? "none" : "none";
  const familyTier = row.family_id ? buffMap.get(`family:${row.family_id}`) ?? "none" : "none";
  return {
    allocations: sanitizeAllocations(row.allocated_json),
    buffPct: combinedBuffPct(genusTier, familyTier),
    nickname: row.nickname ?? null,
    level: Math.max(0, Number(row.points_spent ?? 0))
  };
}

// ---------------------------------------------------------------------------
// Per-user custom sprites with Discord QA moderation
// ---------------------------------------------------------------------------

const DISCORD_API_URL = "https://discord.com/api/v10";
const QA_APPROVE_EMOJIS = new Set(["✅", "☑️", "✔️", "🟢"]);
const QA_REJECT_EMOJIS = new Set(["❌", "✖️", "🚫", "⛔", "🔴"]);

function discordConfig(env) {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_QA_CHANNEL_ID;
  if (!token || !channelId) {
    throw new Error(
      "Discord QA is not configured. Set the DISCORD_BOT_TOKEN secret and DISCORD_QA_CHANNEL_ID var."
    );
  }
  return { token, channelId };
}

async function postSpriteToDiscordQA(env, { submissionId, taxonLabel, inatLogin, handle, bytes, contentType, spriteUrl }) {
  const { token, channelId } = discordConfig(env);

  const content =
    `**Sprite QA** \`${submissionId}\`\n` +
    `Species: ${taxonLabel}\n` +
    `Player: @${handle} (iNat: ${inatLogin})\n` +
    `React ✅ to approve (visible to opponents) or ❌ to reject (visible only to the submitter).`;

  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content }));
  form.append(
    "files[0]",
    new Blob([bytes], { type: contentType }),
    `${submissionId}.${extensionForContentType(contentType)}`
  );

  const res = await fetch(`${DISCORD_API_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}` },
    body: form
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Discord post failed (${res.status}): ${detail.slice(0, 180)}`);
  }
  const message = await res.json();
  return { messageId: message.id, channelId };
}

async function fetchDiscordDecision(env, row) {
  const { token } = discordConfig(env);
  const res = await fetch(
    `${DISCORD_API_URL}/channels/${row.discord_channel_id}/messages/${row.discord_message_id}`,
    { headers: { authorization: `Bot ${token}` } }
  );
  if (res.status === 404) return { decision: null, error: "QA message was deleted on Discord" };
  if (!res.ok) return { decision: null, error: `Discord read failed (${res.status})` };

  const message = await res.json();
  const reactions = Array.isArray(message.reactions) ? message.reactions : [];
  const hasReject = reactions.some((r) => QA_REJECT_EMOJIS.has(r.emoji?.name) && r.count > 0);
  const hasApprove = reactions.some((r) => QA_APPROVE_EMOJIS.has(r.emoji?.name) && r.count > 0);

  if (hasReject) return { decision: "rejected", error: null };
  if (hasApprove) return { decision: "approved", error: null };
  return { decision: null, error: null };
}

async function uploadUserSprite(request, env, session) {
  if (!session.inat_login) throw httpError("Link your iNaturalist account first", 400);

  const form = await request.formData();
  const file = form.get("sprite");
  const taxonId = Number.parseInt(String(form.get("taxonId") ?? ""), 10);
  if (!Number.isFinite(taxonId)) throw httpError("Missing or invalid taxonId", 400);
  if (!file || typeof file.arrayBuffer !== "function") throw httpError("Missing sprite image file", 400);

  const bytes = await file.arrayBuffer();
  const maxBytes = intEnv(env, "MAX_MANUAL_UPLOAD_BYTES", 12_000_000);
  if (bytes.byteLength <= 0) throw httpError("Sprite image file is empty", 400);
  if (bytes.byteLength > maxBytes) {
    throw httpError(`Sprite image file is larger than ${Math.floor(maxBytes / 1_000_000)} MB`, 400);
  }

  const contentType = normalizeImageContentType(file.type) ?? contentTypeForAssetKey(file.name ?? "");
  if (!contentType) throw httpError("Custom sprite must be PNG, JPEG, or WebP", 400);

  const userId = inatUserIdFor(session.inat_login);
  let owned = await env.DB.prepare(`
    SELECT t.taxon_id, t.scientific_name, t.common_name
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    WHERE ut.user_id = ? AND ut.taxon_id = ?
  `).bind(userId, taxonId).first();

  const now = new Date().toISOString();
  if (!owned) {
    const taxon = await resolveInatTaxonForManualUpload({ taxonId: String(taxonId), scientificName: "", commonName: "" });
    const taxonForDb = {
      ...taxon,
      preferred_common_name: taxon.preferred_common_name || taxon.english_common_name || null
    };
    await upsertTaxonFromInat(env, taxonForDb, now);

    const addedToRoster = await addManualSpriteToUserRoster(env, userId, taxonForDb, now);
    if (!addedToRoster) throw httpError("Import your iNaturalist roster before submitting custom sprites", 400);

    owned = {
      taxon_id: taxon.id,
      scientific_name: taxon.name,
      common_name: taxonForDb.preferred_common_name
    };
  }

  const submissionId = randomId("usprite");
  const fileHash = await sha256ArrayBufferHex(bytes);
  const extension = extensionForContentType(contentType);
  const loginSlug = session.inat_login.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const r2Key = `users/${loginSlug}/sprites/v${ASSET_VERSION}/${taxonId}/${fileHash.slice(0, 16)}.${extension}`;
  const dimensions = readImageDimensions(bytes, contentType);

  await env.ASSETS.put(r2Key, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable"
    },
    customMetadata: {
      submissionId,
      taxonId: String(taxonId),
      userId,
      did: session.did,
      source: "user-sprite",
      fileHash,
      uploadedAt: now
    }
  });

  const taxonLabel = `${owned.common_name || owned.scientific_name} (${owned.scientific_name}, taxon ${taxonId})`;
  let discordMessageId = null;
  let discordChannelId = null;
  let discordError = null;
  try {
    const posted = await postSpriteToDiscordQA(env, {
      submissionId,
      taxonLabel,
      inatLogin: session.inat_login,
      handle: session.handle,
      bytes,
      contentType
    });
    discordMessageId = posted.messageId;
    discordChannelId = posted.channelId;
  } catch (error) {
    discordError = error instanceof Error ? error.message : "Discord post failed";
  }

  await env.DB.prepare(`
    INSERT INTO user_sprite_submissions (
      submission_id, did, user_id, taxon_id, r2_key, content_type,
      width, height, status, discord_message_id, discord_channel_id,
      discord_error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).bind(
    submissionId,
    session.did,
    userId,
    taxonId,
    r2Key,
    contentType,
    dimensions?.width ?? null,
    dimensions?.height ?? null,
    discordMessageId,
    discordChannelId,
    discordError,
    now,
    now
  ).run();

  const moves = await generateImageConditionedMoves(env, taxonId, bytes, contentType);

  return {
    submissionId,
    taxonId,
    name: owned.common_name || owned.scientific_name,
    status: "pending",
    url: `/api/assets/${encodeR2Key(r2Key)}`,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    discordMessageId,
    discordError,
    moves
  };
}

function userSpriteSummary(row) {
  return {
    submissionId: row.submission_id,
    taxonId: row.taxon_id,
    name: row.common_name || row.scientific_name || `taxon ${row.taxon_id}`,
    status: row.status,
    url: `/api/assets/${encodeR2Key(row.r2_key)}`,
    discordError: row.discord_error,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  };
}

async function listUserSprites(env, session) {
  const rows = await env.DB.prepare(`
    SELECT uss.*, t.common_name, t.scientific_name
    FROM user_sprite_submissions uss
    LEFT JOIN taxa t ON t.taxon_id = uss.taxon_id
    WHERE uss.did = ?
    ORDER BY uss.created_at DESC
    LIMIT 50
  `).bind(session.did).all();

  return { submissions: (rows.results ?? []).map(userSpriteSummary) };
}

async function applySubmissionDecision(env, submissionId, decision) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE user_sprite_submissions
    SET status = ?, decided_at = ?, updated_at = ?, discord_error = NULL
    WHERE submission_id = ?
  `).bind(decision, now, now, submissionId).run();

  if (decision === "approved") {
    return promoteApprovedUserSpriteIfMissing(env, submissionId, now);
  }
  if (decision === "rejected") {
    return demoteRejectedUserSpriteAsset(env, submissionId);
  }
  return { promoted: false, demoted: false };
}

async function promoteApprovedUserSpriteIfMissing(env, submissionId, now) {
  const promptHash = `user-approved:${submissionId}`;
  const assetId = await sha256Hex(`${DEFAULT_ASSET_KIND}|v${ASSET_VERSION}|${promptHash}`);
  const usageJson = JSON.stringify({
    source: "user-approved-sprite",
    submission_id: submissionId,
    approved_at: now
  });

  const result = await env.DB.prepare(`
    INSERT INTO sprite_assets (
      asset_id, taxon_id, asset_kind, asset_version,
      model, prompt_hash, r2_key, status,
      width, height, content_type, cost_estimate_usd, usage_json, created_at
    )
    SELECT
      ?, uss.taxon_id, ?, ?,
      'user-approved-upload', ?, uss.r2_key, 'ready',
      uss.width, uss.height, uss.content_type, 0, ?, ?
    FROM user_sprite_submissions uss
    WHERE uss.submission_id = ?
      AND uss.status = 'approved'
      AND NOT EXISTS (
        SELECT 1
        FROM sprite_assets existing
        WHERE existing.taxon_id = uss.taxon_id
          AND existing.asset_kind = ?
          AND existing.asset_version = ?
          AND existing.status = 'ready'
      )
    ON CONFLICT(taxon_id, asset_kind, asset_version, prompt_hash)
    DO UPDATE SET
      model = excluded.model,
      r2_key = excluded.r2_key,
      status = 'ready',
      width = excluded.width,
      height = excluded.height,
      content_type = excluded.content_type,
      cost_estimate_usd = excluded.cost_estimate_usd,
      usage_json = excluded.usage_json
  `).bind(
    assetId,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    promptHash,
    usageJson,
    now,
    submissionId,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION
  ).run();

  return { promoted: Number(result.meta?.changes ?? 0) > 0, demoted: false };
}

async function demoteRejectedUserSpriteAsset(env, submissionId) {
  const promptHash = `user-approved:${submissionId}`;
  const result = await env.DB.prepare(`
    UPDATE sprite_assets
    SET status = 'superseded'
    WHERE asset_kind = ?
      AND asset_version = ?
      AND prompt_hash = ?
      AND model = 'user-approved-upload'
      AND status = 'ready'
  `).bind(DEFAULT_ASSET_KIND, ASSET_VERSION, promptHash).run();

  return { promoted: false, demoted: Number(result.meta?.changes ?? 0) > 0 };
}

async function syncSpriteSubmissions(env, limit = 25) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM user_sprite_submissions
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(limit).all();

  const summary = { checked: 0, approved: 0, rejected: 0, promoted: 0, reposted: 0, errors: 0 };

  for (const row of rows.results ?? []) {
    summary.checked += 1;

    try {
      if (!row.discord_message_id) {
        const object = await env.ASSETS.get(row.r2_key);
        if (!object) throw new Error("Sprite bytes missing from R2");
        const taxon = await env.DB.prepare(
          "SELECT common_name, scientific_name FROM taxa WHERE taxon_id = ?"
        ).bind(row.taxon_id).first();
        const account = await env.DB.prepare(
          "SELECT handle, inat_login FROM accounts WHERE did = ?"
        ).bind(row.did).first();
        const posted = await postSpriteToDiscordQA(env, {
          submissionId: row.submission_id,
          taxonLabel: `${taxon?.common_name || taxon?.scientific_name || "Unknown"} (${taxon?.scientific_name ?? "?"}, taxon ${row.taxon_id})`,
          inatLogin: account?.inat_login ?? "unknown",
          handle: account?.handle ?? "unknown",
          bytes: await object.arrayBuffer(),
          contentType: row.content_type
        });
        await env.DB.prepare(`
          UPDATE user_sprite_submissions
          SET discord_message_id = ?, discord_channel_id = ?, discord_error = NULL, updated_at = ?
          WHERE submission_id = ?
        `).bind(posted.messageId, posted.channelId, new Date().toISOString(), row.submission_id).run();
        summary.reposted += 1;
        continue;
      }

      const { decision, error } = await fetchDiscordDecision(env, row);
      if (decision) {
        const result = await applySubmissionDecision(env, row.submission_id, decision);
        summary[decision === "approved" ? "approved" : "rejected"] += 1;
        if (result.promoted) summary.promoted += 1;
      } else if (error) {
        await env.DB.prepare(
          "UPDATE user_sprite_submissions SET discord_error = ?, updated_at = ? WHERE submission_id = ?"
        ).bind(error, new Date().toISOString(), row.submission_id).run();
        summary.errors += 1;
      }
    } catch (error) {
      summary.errors += 1;
      await env.DB.prepare(
        "UPDATE user_sprite_submissions SET discord_error = ?, updated_at = ? WHERE submission_id = ?"
      ).bind(
        error instanceof Error ? error.message : "sync failed",
        new Date().toISOString(),
        row.submission_id
      ).run();
    }
  }

  return summary;
}

async function syncSingleSubmission(env, submissionId) {
  const row = await env.DB.prepare(
    "SELECT * FROM user_sprite_submissions WHERE submission_id = ?"
  ).bind(submissionId).first();
  if (!row) throw httpError("Submission not found", 404);
  if (!row.discord_message_id) throw httpError("Submission has no Discord QA message yet; run a full sync first", 400);

  // Re-evaluates regardless of current status, so changing the reaction on
  // Discord overturns an earlier decision.
  const { decision, error } = await fetchDiscordDecision(env, row);
  if (error) throw httpError(error, 502);
  let result = { promoted: false, demoted: false };
  if (decision && decision !== row.status) {
    result = await applySubmissionDecision(env, submissionId, decision);
  }
  return {
    submissionId,
    status: decision ?? row.status,
    changed: Boolean(decision && decision !== row.status),
    globalPromoted: result.promoted,
    globalDemoted: result.demoted
  };
}

async function serveAsset(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace("/api/assets/", ""));

  if (!isAllowedAssetKey(key)) {
    return jsonResponse({ error: "Invalid asset key" }, 400);
  }

  const object = await env.ASSETS.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

// Serve the biome PMTiles archive from R2 with HTTP Range support, so the
// client's pmtiles.js can range-read tiles directly (no per-tile worker work).
const BIOMES_PMTILES_KEY = "tiles/biomes.pmtiles";
async function servePmtiles(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  const rangeHeader = request.headers.get("range");
  const object = rangeHeader
    ? await env.ASSETS.get(BIOMES_PMTILES_KEY, { range: request.headers })
    : await env.ASSETS.get(BIOMES_PMTILES_KEY);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=86400");

  if (rangeHeader && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? (object.size - offset);
    headers.set("content-range", "bytes " + offset + "-" + (offset + length - 1) + "/" + object.size);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

// Map a click (lat/lng) to its claimable res5 H3 cell + biome — lets the PMTiles
// biome basemap stay display-only while clicks still resolve to a tile.
async function getTerritoryCell(env, url) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError("lat/lng required", 400);
  const h3 = latLngToCell(lat, lng, TERRITORY_H3_RESOLUTION);
  const biome = await tileBiomeFor(env, h3);
  return { h3, biome };
}

async function getOrCreatePromptSpec(env, taxonId) {
  const existing = await env.DB.prepare(`
    SELECT prompt_json
    FROM creature_genomes
    WHERE taxon_id = ?
    ORDER BY genome_version DESC
    LIMIT 1
  `).bind(taxonId).first();

  if (existing?.prompt_json) return JSON.parse(existing.prompt_json);

  const taxon = await env.DB.prepare(`
    SELECT *
    FROM taxa
    WHERE taxon_id = ?
  `).bind(taxonId).first();

  if (!taxon) throw new Error(`Missing taxon ${taxonId}`);

  const promptSpec = buildSpritePromptFromTaxon(taxon);

  await env.DB.prepare(`
    INSERT INTO creature_genomes (
      taxon_id, genome_version, body_plan,
      ecological_types_json, battle_role,
      prompt_json, genome_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    taxonId,
    ASSET_VERSION,
    promptSpec.body_plan,
    JSON.stringify(promptSpec.ecological_types),
    promptSpec.battle_role,
    JSON.stringify(promptSpec),
    JSON.stringify(promptSpec.genome),
    new Date().toISOString()
  ).run();

  return promptSpec;
}

function buildSpritePromptFromTaxon(taxon) {
  const genome = createGenome(taxonSummaryFromRow(taxon));

  return {
    body_plan: genome.bodyPlan,
    ecological_types: genome.types,
    battle_role: genome.role,
    reference_image_url: taxon.default_photo_url ?? null,
    negative_prompt: genome.negativePrompt,
    genome,
    sprite_prompt: genome.prompt
  };
}

async function getTaxonForSpriteJob(env, taxonId) {
  const taxon = await env.DB.prepare(`
    SELECT taxon_id, scientific_name, common_name, iconic_taxon_name, default_photo_url
    FROM taxa
    WHERE taxon_id = ?
  `).bind(taxonId).first();

  if (!taxon) throw new Error(`Missing taxon ${taxonId}`);
  return taxon;
}

function taxonSummaryFromRow(row, spriteUrl = null) {
  return {
    taxonId: Number(row.taxon_id),
    scientificName: row.scientific_name,
    commonName: row.common_name ?? null,
    iconicTaxonName: row.iconic_taxon_name ?? null,
    ancestry: row.ancestry ?? null,
    obsCount: row.obs_count === undefined ? undefined : Number(row.obs_count),
    bondLevel: row.bond_level === undefined ? undefined : Number(row.bond_level),
    spriteUrl
  };
}

function buildDevSvgSpriteSheet(genome) {
  const type = genome.types?.[0] ?? "Urban";
  const palette = {
    Sky: { bg: "#e8f4ff", body: "#7b5c42", accent: "#d8ccb8", dark: "#28231f" },
    Urban: { bg: "#f0ede8", body: "#70625a", accent: "#d1b48c", dark: "#24201e" },
    Bloom: { bg: "#f2fff0", body: "#4e8a4b", accent: "#f5cf4a", dark: "#244423" },
    Fungus: { bg: "#fff5e8", body: "#d98f43", accent: "#fff0b3", dark: "#5a3218" },
    Wetland: { bg: "#e9fbff", body: "#3c7a70", accent: "#89d2c4", dark: "#1b3834" },
    Stone: { bg: "#f4f4f4", body: "#6f7378", accent: "#c9ced4", dark: "#34373b" },
    Swarm: { bg: "#fffbea", body: "#514335", accent: "#f1d45a", dark: "#201914" },
    Night: { bg: "#e9e8ff", body: "#35314f", accent: "#a8a0ff", dark: "#151323" }
  };
  const p = palette[type] ?? palette.Urban;
  const cell = 128;
  const parts = [];

  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = col * cell;
      const y = row * cell;
      const bob = Math.sin((col / 4) * Math.PI * 2) * 4;
      const wing = row === 3 ? 16 + col * 2 : row === 1 ? 4 + col : 0;
      const lean = row === 2 ? col * 3 : 0;
      const scale = 1 + (row === 3 && col === 2 ? 0.08 : 0);
      const special = row === 3
        ? `<path d="M28 80 C12 52, 28 34, 50 26" fill="none" stroke="${p.accent}" stroke-width="5" opacity="0.55"/>`
        : "";

      parts.push(`
        <g transform="translate(${x} ${y})">
          <rect width="128" height="128" fill="${p.bg}" opacity="0.22"/>
          <g transform="translate(${64 + lean} ${70 + bob}) scale(${scale})">
            <ellipse cx="0" cy="0" rx="31" ry="24" fill="${p.body}" stroke="${p.dark}" stroke-width="5"/>
            <circle cx="26" cy="-18" r="18" fill="${p.body}" stroke="${p.dark}" stroke-width="5"/>
            <circle cx="32" cy="-22" r="3" fill="${p.dark}"/>
            <path d="M42 -16 L62 -10 L42 -5 Z" fill="${p.accent}" stroke="${p.dark}" stroke-width="3"/>
            <ellipse cx="-6" cy="-2" rx="22" ry="13" fill="${p.accent}" opacity="0.85" stroke="${p.dark}" stroke-width="3" transform="rotate(${-8 - wing})"/>
            <path d="M-30 6 L-56 16 L-34 23 Z" fill="${p.body}" stroke="${p.dark}" stroke-width="4"/>
            <path d="M-8 23 L-12 38 M12 23 L16 38" stroke="${p.dark}" stroke-width="4" stroke-linecap="round"/>
            <circle cx="-14" cy="-10" r="4" fill="${p.accent}" opacity="0.9"/>
            <circle cx="0" cy="-13" r="3" fill="${p.accent}" opacity="0.85"/>
            <circle cx="13" cy="-9" r="3" fill="${p.accent}" opacity="0.85"/>
          </g>
          ${special}
        </g>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${parts.join("\n")}</svg>`;
}

async function generateSpriteWithOpenAI(env, promptSpec, referenceImages = []) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const imageReferences = Array.isArray(referenceImages) ? referenceImages : [];
  const model = imageModel(env);
  const outputFormat = env.IMAGE_OUTPUT_FORMAT || "webp";
  const prompt = composeOpenAIImagePrompt(promptSpec, model, imageReferences);
  const size = env.IMAGE_SIZE || "1024x1024";
  const quality = env.IMAGE_QUALITY || "medium";
  const background = imageBackgroundForModel(env, model);

  const endpoint = imageReferences.length > 0
    ? "https://api.openai.com/v1/images/edits"
    : "https://api.openai.com/v1/images/generations";

  const request = imageReferences.length > 0
    ? openAIImageEditRequest(apiKey, model, prompt, size, quality, outputFormat, background, imageReferences)
    : openAIImageGenerationRequest(apiKey, model, prompt, size, quality, outputFormat, background);

  const res = await fetch(endpoint, request);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI image generation failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI response did not include b64_json");

  return {
    model,
    bytes: base64ToArrayBuffer(b64),
    usage: {
      ...(json.usage ?? {}),
      endpoint: imageReferences.length > 0 ? "images.edits" : "images.generations",
      reference_image_count: imageReferences.length,
      reference_images: imageReferences.map((image) => ({
        kind: image.kind,
        source: image.source,
        content_type: image.contentType,
        byte_length: image.bytes.byteLength
      }))
    },
    extension: extensionForOutputFormat(outputFormat),
    contentType: contentTypeForOutputFormat(outputFormat)
  };
}

function openAIImageGenerationRequest(apiKey, model, prompt, size, quality, outputFormat, background) {
  return {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      quality,
      output_format: outputFormat,
      background
    })
  };
}

function openAIImageEditRequest(apiKey, model, prompt, size, quality, outputFormat, background, referenceImages) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  form.append("output_format", outputFormat);
  form.append("background", background);

  for (const referenceImage of referenceImages) {
    form.append(
      "image[]",
      new Blob([referenceImage.bytes], { type: referenceImage.contentType }),
      referenceImage.filename
    );
  }

  return {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`
    },
    body: form
  };
}

function composeOpenAIImagePrompt(promptSpec, model, referenceImages) {
  let prompt = String(promptSpec?.sprite_prompt ?? "");

  if (isGptImage2(model)) {
    prompt = prompt.replace(/transparent or very plain background/gi, "plain light neutral opaque background");
  }

  const parts = [prompt];

  const speciesReference = referenceImages.find((image) => image.kind === "species_photo");
  const styleReference = referenceImages.find((image) => image.kind === "style_sheet");

  if (speciesReference) {
    parts.push("Use the species photo reference for real anatomy, colors, proportions, and field marks.");
  }

  if (styleReference) {
    parts.push("Use the example sprite sheet reference for grid structure, sprite scale, outline weight, readability, and animation-frame consistency. Do not copy the House Sparrow creature design unless the target species is House Sparrow.");
  }

  if (referenceImages.length > 0) {
    parts.push(
      "Transform the references into an original 4x4 pixel-art battler sprite sheet for the target species; do not copy photo backgrounds, labels, or unrelated details."
    );
  }

  if (promptSpec?.negative_prompt) {
    parts.push(`Avoid: ${promptSpec.negative_prompt}`);
  }

  if (isGptImage2(model)) {
    parts.push("Use an opaque plain background. Do not request or create transparency.");
  }

  return parts.filter(Boolean).join("\n\n");
}

async function loadSpriteReferenceImages(env, taxon) {
  const references = [];
  const mode = String(env.IMAGE_REFERENCE_MODE ?? "default_photo").toLowerCase();
  if (mode === "off") return references;

  if (mode !== "style_only") {
    const speciesReference = await loadSpeciesPhotoReferenceImage(env, taxon);
    if (speciesReference) references.push(speciesReference);
  }

  const styleReference = await loadStyleSheetReferenceImage(env);
  if (styleReference) references.push(styleReference);

  return references;
}

async function loadSpeciesPhotoReferenceImage(env, taxon) {
  const sourceUrl = taxon?.default_photo_url;
  if (!sourceUrl || !isSafeReferenceImageUrl(sourceUrl)) return null;

  try {
    const response = await fetch(sourceUrl, {
      headers: { "User-Agent": "taxa-battler/0.1" }
    });

    if (!response.ok) return null;

    const contentType = normalizeImageContentType(response.headers.get("content-type"));
    if (!contentType) return null;

    const maxBytes = intEnv(env, "MAX_REFERENCE_IMAGE_BYTES", 8_000_000);
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) return null;

    return {
      bytes,
      contentType,
      kind: "species_photo",
      source: sourceUrl,
      filename: `taxon-${taxon.taxon_id}.${extensionForContentType(contentType)}`
    };
  } catch (error) {
    console.warn("Reference image could not be loaded", { taxonId: taxon?.taxon_id, error: String(error) });
    return null;
  }
}

async function loadStyleSheetReferenceImage(env) {
  const key = env.IMAGE_STYLE_REFERENCE_R2_KEY;
  if (!key) return null;

  try {
    const object = await env.ASSETS.get(key);
    if (!object) return null;

    const contentType = normalizeImageContentType(object.httpMetadata?.contentType) ??
      contentTypeForAssetKey(key);

    if (!contentType) return null;

    const bytes = await object.arrayBuffer();
    const maxBytes = intEnv(env, "MAX_REFERENCE_IMAGE_BYTES", 8_000_000);
    if (bytes.byteLength > maxBytes) return null;

    return {
      bytes,
      contentType,
      kind: "style_sheet",
      source: `r2:${key}`,
      filename: `style-reference.${extensionForContentType(contentType)}`
    };
  } catch (error) {
    console.warn("Style reference image could not be loaded", { key, error: String(error) });
    return null;
  }
}

function imageBackgroundForModel(env, model) {
  const configured = env.IMAGE_BACKGROUND;
  if (configured) return configured;
  return isGptImage2(model) ? "auto" : "transparent";
}

function imageModel(env) {
  return env.IMAGE_MODEL || "gpt-image-2";
}

function spriteGenerationMode(env) {
  return String(env.SPRITE_GENERATION_MODE ?? "on_demand").toLowerCase();
}

function generationLimitsDisabled(env) {
  return ["1", "true", "yes", "on"].includes(String(env.DISABLE_GENERATION_LIMITS ?? "").toLowerCase());
}

function maxQueueMoreLimit(env) {
  return generationLimitsDisabled(env) ? 500 : 48;
}

function maxBatchSubmitLimit(env) {
  return generationLimitsDisabled(env) ? 500 : 25;
}

function isGptImage2(model) {
  return String(model ?? "").toLowerCase() === "gpt-image-2";
}

function isSafeReferenceImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeImageContentType(value) {
  const contentType = String(value ?? "").split(";")[0].trim().toLowerCase();
  if (contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp") {
    return contentType;
  }
  return null;
}

function contentTypeForAssetKey(key) {
  const lower = String(key ?? "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function extensionForContentType(contentType) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "webp";
}

async function getUserQueueBudgetRemaining(env, userId) {
  if (generationLimitsDisabled(env)) return Number.MAX_SAFE_INTEGER;

  const day = currentDay();
  const cap = intEnv(env, "MAX_USER_DAILY_QUEUED_JOBS", 24);

  const row = await env.DB.prepare(`
    SELECT queued_count
    FROM user_generation_budget_daily
    WHERE user_id = ?
      AND day = ?
  `).bind(userId, day).first();

  return Math.max(0, cap - Number(row?.queued_count ?? 0));
}

async function incrementUserQueueBudget(env, userId, amount) {
  const day = currentDay();

  await env.DB.prepare(`
    INSERT INTO user_generation_budget_daily (user_id, day, queued_count)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET
      queued_count = queued_count + excluded.queued_count
  `).bind(userId, day, amount).run();
}

async function reserveGlobalGenerationAttempt(env) {
  const day = currentDay();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO generation_budget_daily (day, generated_count, estimated_cost_usd)
    VALUES (?, 0, 0)
  `).bind(day).run();

  if (generationLimitsDisabled(env)) {
    await env.DB.prepare(`
      UPDATE generation_budget_daily
      SET generated_count = generated_count + 1
      WHERE day = ?
    `).bind(day).run();

    return true;
  }

  const cap = intEnv(env, "MAX_GLOBAL_DAILY_GENERATIONS", 250);

  const result = await env.DB.prepare(`
    UPDATE generation_budget_daily
    SET generated_count = generated_count + 1
    WHERE day = ?
      AND generated_count < ?
  `).bind(day, cap).run();

  return (result.meta?.changes ?? 0) > 0;
}

async function addGlobalGenerationCost(env, costEstimateUsd) {
  const day = currentDay();

  await env.DB.prepare(`
    INSERT INTO generation_budget_daily (day, generated_count, estimated_cost_usd)
    VALUES (?, 0, ?)
    ON CONFLICT(day) DO UPDATE SET
      estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd
  `).bind(day, costEstimateUsd).run();
}

function estimateOpenAICostUsd(env, usage, multiplier = 1) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);

  if (!inputTokens && !outputTokens) return null;

  const inputRate = floatEnv(env, "OPENAI_IMAGE_INPUT_USD_PER_1M", 5);
  const outputRate = floatEnv(env, "OPENAI_IMAGE_OUTPUT_USD_PER_1M", 40);

  return ((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000) * multiplier;
}

function placeholderFor(iconicTaxonName) {
  const iconic = String(iconicTaxonName ?? "").toLowerCase();
  if (iconic.includes("bird")) return "bird";
  if (iconic.includes("mammal")) return "mammal";
  if (iconic.includes("reptile")) return "reptile";
  if (iconic.includes("amphibian")) return "amphibian";
  if (iconic.includes("fish")) return "fish";
  if (iconic.includes("insect") || iconic.includes("arachnid")) return "arthropod";
  if (iconic.includes("plant")) return "plant";
  if (iconic.includes("fung")) return "fungus";
  return "unknown";
}

function normalizeInatLogin(rawLogin) {
  const login = String(rawLogin ?? "").trim();

  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(login)) {
    throw new Error("Enter a valid iNaturalist username");
  }

  return login;
}

function encodeR2Key(key) {
  return String(key).split("/").map(encodeURIComponent).join("/");
}

function speciesAssetPrefix(assetVersion, taxonId, scientificName) {
  const slug = slugifyScientificName(scientificName) || "unknown";
  return `species/v${assetVersion}/${taxonId}-${slug}`;
}

function slugifyScientificName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isAllowedAssetKey(key) {
  return (
    typeof key === "string" &&
    !key.includes("..") &&
    (key.startsWith("species/") || key.startsWith("users/")) &&
    /\.(webp|png|jpg|jpeg|svg|json)$/i.test(key)
  );
}

function randomId(prefix) {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}_${id.replaceAll("-", "").slice(0, 24)}`;
}

function extensionForOutputFormat(format) {
  const safe = String(format || "webp").toLowerCase();
  if (safe === "jpeg") return "jpg";
  if (["webp", "png", "jpg"].includes(safe)) return safe;
  return "webp";
}

function contentTypeForOutputFormat(format) {
  const extension = extensionForOutputFormat(format);
  if (extension === "png") return "image/png";
  if (extension === "jpg") return "image/jpeg";
  return "image/webp";
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

const MAX_MOVE_IMAGE_PROMPT_BYTES = 8_000_000;

function imageDataUrlFromBytes(bytes, contentType) {
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > MAX_MOVE_IMAGE_PROMPT_BYTES) return null;

  const view = new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
  }

  return `data:${contentType || "image/png"};base64,${btoa(binary)}`;
}

// Shared by both custom-sprite upload paths: generate the species moves
// with the uploaded artwork attached so flavor/animations match the image.
// Skipped when the species already has moves globally (moves are per-species,
// so an upload must not re-roll them for everyone). Failures never fail the
// upload itself.
async function generateImageConditionedMoves(env, taxonId, bytes, contentType) {
  try {
    const existingMoveTaxa = await loadMoveGenomeTaxonIds(env, [taxonId]);
    if (existingMoveTaxa.has(Number(taxonId))) {
      return { generated: false, skipped: true, reason: "Species already has moves" };
    }

    const imageDataUrl = imageDataUrlFromBytes(bytes, contentType);
    const result = await generateMovesForTaxon(env, taxonId, { imageDataUrl });
    return {
      generated: true,
      model: result.model,
      imageConditioned: Boolean(imageDataUrl),
      signatureMoves: (result.genome?.moves ?? [])
        .filter((move) => move.signature)
        .map((move) => move.name)
    };
  } catch (error) {
    return {
      generated: false,
      error: error instanceof Error ? error.message : "Move generation failed"
    };
  }
}

async function sha256ArrayBufferHex(input) {
  const digest = await crypto.subtle.digest("SHA-256", input);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readImageDimensions(input, contentType) {
  const bytes = new Uint8Array(input);

  if (contentType === "image/png" && bytes.length >= 24) {
    return {
      width: readUint32BE(bytes, 16),
      height: readUint32BE(bytes, 20)
    };
  }

  if (contentType === "image/webp" && bytes.length >= 30) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (riff === "RIFF" && webp === "WEBP" && chunk === "VP8X") {
      return {
        width: 1 + readUint24LE(bytes, 24),
        height: 1 + readUint24LE(bytes, 27)
      };
    }
  }

  if (contentType === "image/jpeg") {
    return readJpegDimensions(bytes);
  }

  return null;
}

function readUint32BE(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readJpegDimensions(bytes) {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;

    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (length < 2) return null;

    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return {
        height: (bytes[offset + 5] << 8) + bytes[offset + 6],
        width: (bytes[offset + 7] << 8) + bytes[offset + 8]
      };
    }

    offset += 2 + length;
  }

  return null;
}

function currentDay() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intEnv(env, key, fallback) {
  const value = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(env, key, fallback) {
  const value = Number.parseFloat(env[key] ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function bundledImageResponse(bytes, contentType) {
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}

function manifestResponse() {
  const manifest = {
    name: "iNat Battler",
    short_name: "iNat Battler",
    description: "Turn your iNaturalist observations into a creature-battler roster.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f2ea",
    theme_color: "#047c78",
    icons: [
      { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/assets/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=3600"
    }
  });
}

// Minimal install-enabling service worker. Network-first for navigations
// (so the app never serves a stale shell while online), cache-first for the
// immutable bundled assets, with a precached "/" fallback for offline.
function serviceWorkerResponse() {
  const sw = `
const CACHE = "inat-battler-v1";
const PRECACHE = ["/", "/assets/icon-192.png", "/assets/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/").then((hit) => hit || Response.error()))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      }))
    );
  }
});
`;
  return new Response(sw, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,HEAD,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function renderAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#047c78">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="iNat Battler">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon-180.png">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin="" defer></script>
  <script src="https://unpkg.com/protomaps-leaflet@4.0.1/dist/protomaps-leaflet.js" crossorigin="" defer></script>
  <title>iNat Battler</title>
  <script>
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      });
    }
  </script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f2ea;
      --surface: #ffffff;
      --ink: #17201b;
      --muted: #60706a;
      --line: #d9ded4;
      --teal: #047c78;
      --green: #2f7d42;
      --amber: #b46b1b;
      --coral: #c54f45;
      --blue: #456da8;
      --shadow: 0 10px 30px rgba(22, 32, 27, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    /* The [hidden] attribute must always win, even over .layout/.login/etc.
       display rules (class selectors otherwise outrank the UA [hidden] rule). */
    [hidden] {
      display: none !important;
    }

    html {
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }

    body {
      margin: 0;
      min-height: 100vh;
      overflow-x: hidden;
      background:
        linear-gradient(180deg, rgba(4, 124, 120, 0.08), rgba(245, 242, 234, 0) 320px),
        var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button,
    input {
      font: inherit;
    }

    button {
      border: 0;
      cursor: pointer;
      -webkit-tap-highlight-color: rgba(0, 0, 0, 0.08);
      touch-action: manipulation;
    }

    img,
    canvas,
    svg {
      max-width: 100%;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.58;
    }

    .shell {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 20px;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 16px;
      align-items: center;
      min-height: 72px;
      border-bottom: 1px solid var(--line);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .mark {
      width: 42px;
      height: 42px;
      border-radius: 8px;
      background:
        radial-gradient(circle at 65% 34%, #f2ce72 0 14%, transparent 15%),
        linear-gradient(135deg, var(--teal), var(--green));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.55);
      flex: 0 0 auto;
    }

    h1 {
      margin: 0;
      font-size: 1.35rem;
      line-height: 1.1;
    }

    .subtle {
      color: var(--muted);
      font-size: 0.88rem;
    }

    .login {
      display: grid;
      grid-template-columns: minmax(180px, 300px) auto;
      gap: 8px;
      align-items: center;
    }

    .login input {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      background: var(--surface);
      color: var(--ink);
    }

    .landing {
      display: grid;
      gap: 28px;
      padding: 28px 0 42px;
    }

    .landing[hidden] {
      display: none;
    }

    .landing-hero {
      position: relative;
      display: grid;
      align-items: end;
      min-height: clamp(430px, 66vh, 680px);
      overflow: hidden;
      border-radius: 8px;
      background:
        linear-gradient(90deg, rgba(12, 21, 16, 0.78) 0%, rgba(12, 21, 16, 0.54) 36%, rgba(12, 21, 16, 0.16) 72%),
        linear-gradient(180deg, rgba(12, 21, 16, 0.08), rgba(12, 21, 16, 0.36)),
        url("/assets/landing-hero-battle.webp") center / cover no-repeat;
      box-shadow: 0 24px 70px rgba(22, 32, 27, 0.18);
      isolation: isolate;
    }

    .landing-copy {
      width: min(620px, 100%);
      padding: clamp(26px, 6vw, 64px);
      color: #fffaf0;
    }

    .landing-kicker {
      margin-bottom: 12px;
      color: #f4d487;
      font-size: 0.78rem;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .landing h2 {
      margin: 0;
      max-width: 10ch;
      color: #fffaf0;
      font-size: clamp(2.45rem, 7vw, 5.8rem);
      line-height: 0.94;
      letter-spacing: 0;
    }

    .landing-lede {
      max-width: 560px;
      margin: 18px 0 0;
      color: rgba(255, 250, 240, 0.9);
      font-size: clamp(1rem, 2vw, 1.24rem);
      line-height: 1.5;
      font-weight: 650;
    }

    .landing-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 24px;
    }

    .landing-actions .primary,
    .landing-actions .secondary {
      display: inline-flex;
      align-items: center;
      min-width: 156px;
      justify-content: center;
      text-decoration: none;
    }

    .landing-actions .secondary {
      color: #fffaf0;
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.34);
    }

    .landing-auth {
      display: grid;
      grid-template-columns: minmax(220px, 340px) auto;
      gap: 8px;
      align-items: start;
      width: min(540px, 100%);
      margin-top: 18px;
    }

    .landing-auth .typeahead,
    .landing-auth input {
      min-width: 0;
    }

    .landing-auth input {
      width: 100%;
      min-height: 42px;
      border: 1px solid rgba(255, 255, 255, 0.42);
      border-radius: 8px;
      padding: 0 12px;
      background: rgba(255, 255, 255, 0.92);
      color: var(--ink);
    }

    .landing-auth-note,
    .landing-auth .bsky-status {
      grid-column: 1 / -1;
    }

    .landing-auth-note {
      color: rgba(255, 250, 240, 0.82);
      font-size: 0.86rem;
      line-height: 1.45;
    }

    .landing-auth .bsky-status {
      background: rgba(255, 255, 255, 0.92);
    }

    .landing-section {
      display: grid;
      gap: 18px;
      padding: 8px 0;
    }

    .landing-section-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      border-bottom: 1px solid var(--line);
      padding-bottom: 10px;
    }

    .landing-section h3 {
      margin: 0;
      font-size: 1.12rem;
      line-height: 1.2;
    }

    .landing-section p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }

    .landing-steps,
    .landing-trust {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }

    .landing-step,
    .landing-trust-item {
      min-width: 0;
      border-left: 3px solid var(--teal);
      padding: 2px 12px 4px;
    }

    .landing-step strong,
    .landing-trust-item strong {
      display: block;
      margin-bottom: 5px;
      font-size: 0.96rem;
    }

    .landing-step span,
    .landing-trust-item span {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.45;
    }

    .primary,
    .secondary {
      min-height: 42px;
      border-radius: 8px;
      padding: 0 14px;
      color: #fff;
      background: var(--teal);
      font-weight: 700;
      white-space: nowrap;
    }

    .secondary {
      color: var(--ink);
      background: #e7eee9;
      border: 1px solid var(--line);
    }

    .layout {
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr);
      gap: 20px;
      padding-top: 20px;
    }

    .panel,
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
      box-shadow: var(--shadow);
    }

    .panel {
      position: sticky;
      top: 20px;
      align-self: start;
      padding: 16px;
    }

    .panel button + button {
      margin-top: 8px;
    }

    .settings-section {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.84);
      padding: 14px 16px;
      margin-bottom: 14px;
    }

    .settings-section > h3 {
      margin: 0 0 12px;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }

    .settings-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .settings-actions button {
      width: auto;
    }

    .settings-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 800;
      cursor: pointer;
    }

    .settings-toggle input {
      width: 20px;
      height: 20px;
    }

    .home-dashboard {
      display: grid;
      gap: 18px;
    }

    .home-hero-card {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
      gap: 18px;
      align-items: stretch;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(4, 124, 120, 0.12), rgba(244, 212, 135, 0.12)),
        rgba(255, 255, 255, 0.88);
      box-shadow: var(--shadow);
    }

    .home-hero-card h2,
    .home-panel h3 {
      margin: 0;
      line-height: 1.15;
    }

    .home-hero-card h2 {
      font-size: clamp(1.65rem, 3vw, 2.4rem);
    }

    .home-hero-card p,
    .home-panel p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .home-copy {
      display: grid;
      gap: 12px;
      align-content: start;
    }

    .home-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .home-actions .primary,
    .home-actions .secondary {
      width: auto;
    }

    .home-next {
      display: grid;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcf9;
    }

    .home-next strong {
      font-size: 1rem;
    }

    .home-metrics,
    .home-panels {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }

    .home-metric,
    .home-panel {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
      box-shadow: var(--shadow);
    }

    .home-metric {
      padding: 13px;
    }

    .home-metric strong {
      display: block;
      margin-top: 4px;
      font-size: 1.55rem;
      line-height: 1.05;
    }

    .home-panel {
      display: grid;
      gap: 12px;
      padding: 14px;
    }

    .home-panel.wide {
      grid-column: span 2;
    }

    .home-team-slots,
    .home-ready-list {
      display: grid;
      gap: 8px;
    }

    .home-team-slot,
    .home-ready-item {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      min-height: 54px;
      border: 1px solid #e5e9e2;
      border-radius: 8px;
      padding: 7px;
      background: #fbfcf9;
      text-align: left;
      color: var(--ink);
    }

    .home-team-slot.empty {
      grid-template-columns: 44px minmax(0, 1fr);
      color: var(--muted);
      /* Override the global .empty placeholder height (360px) for slots. */
      min-height: 54px;
      place-items: stretch;
      padding: 7px;
      text-align: left;
    }

    .home-slot-index,
    .home-ready-thumb {
      display: grid;
      place-items: center;
      width: 44px;
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      background: #e7eee9;
      color: var(--teal);
      font-weight: 900;
      overflow: hidden;
    }

    .home-ready-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .home-ready-thumb .sheet-sprite {
      width: 92%;
      filter: none;
    }

    .home-team-slot strong,
    .home-ready-item strong {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.9rem;
    }

    .home-team-slot span,
    .home-ready-item span {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 0.78rem;
    }

    .home-ready-item:hover {
      border-color: var(--teal);
      background: #eef7f0;
    }

    .home-progress {
      height: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: #dfe5df;
    }

    .home-progress > span {
      display: block;
      height: 100%;
      width: var(--progress, 0%);
      background: linear-gradient(90deg, var(--teal), var(--green));
    }

    .onboarding-card {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(300px, 0.95fr);
      gap: 18px;
      align-items: start;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(4, 124, 120, 0.12), rgba(242, 206, 114, 0.18)),
        rgba(255, 255, 255, 0.9);
      box-shadow: var(--shadow);
    }

    .onboarding-copy,
    .onboarding-form {
      display: grid;
      gap: 14px;
    }

    .onboarding-copy h2 {
      margin: 0;
      max-width: 12ch;
      font-size: clamp(1.9rem, 4vw, 3.2rem);
      line-height: 0.98;
    }

    .onboarding-form h3 {
      margin: 0;
    }

    .onboarding-copy p,
    .onboarding-form p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .onboarding-steps {
      display: grid;
      gap: 9px;
      margin-top: 4px;
    }

    .onboarding-step {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }

    .onboarding-step-index {
      display: grid;
      place-items: center;
      width: 34px;
      aspect-ratio: 1 / 1;
      border-radius: 50%;
      background: #e7eee9;
      color: var(--teal);
      font-weight: 900;
    }

    .onboarding-step.complete .onboarding-step-index {
      background: var(--teal);
      color: #fff;
    }

    .onboarding-step.active .onboarding-step-index {
      background: #f4d487;
      color: #533b0c;
    }

    .onboarding-step strong,
    .onboarding-step span {
      display: block;
      min-width: 0;
    }

    .onboarding-step span {
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.4;
    }

    .onboarding-form {
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcf9;
    }

    .onboarding-form label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 800;
    }

    .onboarding-form input {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
    }

    .onboarding-code {
      display: grid;
      gap: 6px;
      padding: 12px;
      border: 1px solid #bfd6cc;
      border-radius: 8px;
      background: #edf7f0;
    }

    .onboarding-code strong {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1rem;
      overflow-wrap: anywhere;
      user-select: all;
    }

    .onboarding-form .bsky-status {
      margin: 0;
    }

    .panel h2,
    .roster-head h2 {
      margin: 0;
      font-size: 1rem;
      line-height: 1.2;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 16px 0;
    }

    .stat {
      min-height: 74px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcf9;
    }

    .stat strong {
      display: block;
      font-size: 1.35rem;
      line-height: 1.1;
    }

    .status {
      min-height: 22px;
      color: var(--muted);
      font-size: 0.9rem;
    }

    .team-picker {
      display: grid;
      gap: 8px;
      margin: 12px 0;
      padding: 12px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }

    .team-picker-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }

    .team-count {
      font-weight: 900;
      color: var(--ink);
    }

    .dev-batch {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }

    .bsky-panel {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }

    .bsky-body {
      display: grid;
      gap: 8px;
      font-size: 0.85rem;
    }

    .bsky-body input {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 10px;
      background: var(--surface);
      color: var(--ink);
    }

    .bsky-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .bsky-row strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bsky-section {
      display: grid;
      gap: 8px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }

    .typeahead {
      position: relative;
      min-width: 0;
    }

    .typeahead-list {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 30;
      display: grid;
      max-height: 230px;
      overflow: auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .typeahead-item {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
      padding: 7px 10px;
      background: transparent;
      border: 0;
      border-bottom: 1px solid #eef1ea;
      text-align: left;
      font-size: 0.8rem;
      color: var(--ink);
    }

    .typeahead-item:last-child {
      border-bottom: 0;
    }

    .typeahead-item:hover,
    .typeahead-item:focus {
      background: #eef3ec;
    }

    .typeahead-item img,
    .typeahead-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: #e3e8e0;
    }

    .typeahead-item span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bsky-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #eef3ec;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 8px;
      user-select: all;
      overflow-wrap: anywhere;
    }

    .bsky-status {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 9px;
      background: #fbfcf9;
      color: var(--muted);
      font-weight: 800;
    }

    .bsky-status.success {
      border-color: #b7d8c2;
      background: #eef7f0;
      color: #285c38;
    }

    .bsky-status.error {
      border-color: #e3b6ad;
      background: #fff1ed;
      color: #7a2f20;
    }

    .challenge-banner {
      border: 1px solid var(--blue);
      border-radius: 8px;
      padding: 8px;
      background: #eef2fa;
      display: grid;
      gap: 6px;
    }

    .challenge-item {
      display: grid;
      gap: 4px;
      padding: 6px 0;
      border-bottom: 1px solid #e5e9e2;
      font-size: 0.8rem;
    }

    .challenge-item:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }

    .challenge-actions {
      display: flex;
      gap: 6px;
    }

    .challenge-actions .secondary,
    .bsky-body .secondary,
    .bsky-body .primary {
      min-height: 34px;
      padding: 0 10px;
      font-size: 0.8rem;
    }

    .dev-batch-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }

    details.dev-batch > summary.dev-batch-head {
      cursor: pointer;
      list-style: none;
      user-select: none;
    }

    details.dev-batch > summary.dev-batch-head::-webkit-details-marker {
      display: none;
    }

    details.dev-batch > summary.dev-batch-head h2::before {
      content: "▸ ";
      color: var(--teal);
      font-size: 0.8em;
    }

    details.dev-batch[open] > summary.dev-batch-head h2::before {
      content: "▾ ";
    }

    details.dev-batch > summary.dev-batch-head:hover h2 {
      color: var(--teal);
    }

    .dev-batch-hint {
      margin: 0;
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.45;
    }

    .batch-list {
      display: grid;
      gap: 6px;
      max-height: 190px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfcf9;
      font-size: 0.78rem;
    }

    .batch-item {
      display: grid;
      gap: 2px;
      min-width: 0;
      padding-bottom: 6px;
      border-bottom: 1px solid #e5e9e2;
    }

    .batch-item:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }

    .batch-item strong,
    .batch-item span {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .manual-upload {
      display: grid;
      gap: 8px;
    }

    .manual-upload input[type="text"],
    .manual-upload input[type="number"],
    .manual-upload input[type="file"] {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: #fbfcf9;
      color: var(--ink);
      font: inherit;
    }

    .manual-upload-check {
      display: flex;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
    }

    .manual-result-link {
      color: var(--teal);
      font-weight: 900;
      overflow-wrap: anywhere;
    }

    .roster-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 12px;
    }

    .view-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }

    .view-tab {
      min-height: 38px;
      border: 0;
      border-bottom: 3px solid transparent;
      border-radius: 0;
      padding: 0 12px;
      background: transparent;
      color: var(--muted);
      font-weight: 900;
    }

    .view-tab.active {
      border-bottom-color: var(--teal);
      color: var(--ink);
    }

    .view-panel[hidden] {
      display: none;
    }

    /* Mobile bottom navigation (shown only at <=720px; see media query) */
    .mobile-nav {
      display: none;
    }

    .mobile-sheet[hidden] {
      display: none;
    }

    .mobile-nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      flex: 1 1 0;
      min-height: 56px;
      padding: 6px 0 max(6px, env(safe-area-inset-bottom));
      background: transparent;
      color: var(--muted);
      font-weight: 700;
    }

    .mobile-nav-item.active {
      color: var(--teal);
    }

    .mobile-nav-ico {
      font-size: 19px;
      line-height: 1;
    }

    .mobile-nav-label {
      font-size: 11px;
      line-height: 1;
    }

    .mobile-sheet {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: flex-end;
    }

    .mobile-sheet-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(18, 26, 22, 0.42);
    }

    .mobile-sheet-panel {
      position: relative;
      width: 100%;
      background: var(--surface);
      border-radius: 16px 16px 0 0;
      padding: 8px 14px calc(14px + env(safe-area-inset-bottom));
      box-shadow: 0 -8px 30px rgba(22, 32, 27, 0.18);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .mobile-sheet-handle {
      width: 40px;
      height: 4px;
      border-radius: 999px;
      background: var(--line);
      margin: 6px auto 10px;
    }

    .mobile-sheet-item {
      text-align: left;
      background: transparent;
      color: var(--ink);
      font-weight: 700;
      min-height: 48px;
      padding: 0 8px;
      border-radius: 10px;
    }

    .mobile-sheet-item.active {
      color: var(--teal);
      background: rgba(4, 124, 120, 0.08);
    }

    .tree-tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }

    .tree-tools input:not([type="range"]),
    .tree-tools select,
    .roster-toolbar input:not([type="range"]),
    .roster-toolbar select {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      background: #fbfcf9;
      color: var(--ink);
      font: inherit;
    }

    .tree-tools input[type="search"],
    .tree-tools input:not([type="range"]):first-child {
      flex: 1 1 180px;
      min-width: 0;
    }

    .roster-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }

    .roster-toolbar input[type="search"] {
      flex: 1 1 180px;
      min-width: 0;
    }

    .zoom-control {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
    }

    .zoom-control input[type="range"] {
      width: 110px;
      accent-color: var(--teal);
    }

    .roster-pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 14px;
      margin-top: 16px;
    }

    .roster-pagination:empty {
      display: none;
    }

    .roster-pagination button {
      width: auto;
    }

    .roster-pagination .subtle {
      font-weight: 800;
    }

    .type-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }

    .type-chips:empty {
      display: none;
    }

    .type-chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 12px;
      background: #fbfcf9;
      color: var(--muted);
      font: inherit;
      font-size: 0.82rem;
      font-weight: 800;
      cursor: pointer;
    }

    .type-chip:hover {
      border-color: var(--teal);
      color: var(--teal);
    }

    .type-chip.active {
      border-color: var(--teal);
      background: rgba(4, 124, 120, 0.12);
      color: var(--teal);
    }

    .grid.sprite-mode {
      gap: 10px;
    }

    .sprite-tile {
      position: relative;
      display: grid;
      grid-template-rows: 1fr auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: var(--shadow);
      cursor: pointer;
      overflow: hidden;
      min-width: 0;
    }

    .sprite-tile.unselectable {
      cursor: default;
      opacity: 0.75;
    }

    .sprite-tile.selected {
      border-color: var(--teal);
      box-shadow: 0 0 0 3px rgba(4, 124, 120, 0.18), var(--shadow);
    }

    .sprite-tile:focus-visible {
      outline: 3px solid rgba(4, 124, 120, 0.35);
      outline-offset: 2px;
    }

    .sprite-tile .sprite-tile-art {
      display: grid;
      place-items: center;
      aspect-ratio: 1 / 1;
      background:
        linear-gradient(135deg, rgba(4, 124, 120, 0.12), rgba(180, 107, 27, 0.16)),
        #f8faf6;
      overflow: hidden;
    }

    .sprite-tile .sprite-tile-art img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .sprite-tile .sprite-tile-art .placeholder-shape {
      width: 60%;
      height: 60%;
    }

    .sprite-tile-caption {
      padding: 6px 8px;
      font-size: 0.8rem;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sprite-tile-caption .subtle {
      display: block;
      font-size: 0.72rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sprite-tile .badge,
    .recent-tile .badge {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 2;
    }

    .sprite-tile .select-mark {
      position: absolute;
      top: 6px;
      left: 6px;
      z-index: 2;
    }

    .recent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--tile-min, 150px), 1fr));
      gap: 10px;
    }

    .recent-tile {
      position: relative;
      display: grid;
      grid-template-rows: 1fr auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: var(--shadow);
      overflow: hidden;
      min-width: 0;
    }

    .recent-tile .sprite-tile-art {
      display: grid;
      place-items: center;
      aspect-ratio: 1 / 1;
      background: #eef2eb;
      overflow: hidden;
    }

    .recent-tile a.manual-result-link {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 2;
    }

    .tree-browser {
      display: grid;
      gap: 10px;
    }

    .tree-summary {
      color: var(--muted);
      font-weight: 800;
    }

    /* Phase 2 taxonomic navigator: breadcrumb trunk + swipe carousel + gallery */
    .tree-nav {
      --accent: var(--teal);
      display: grid;
      gap: 2px;
    }
    .tree-nav[data-group="animals"] { --accent: #2f6fb0; }
    .tree-nav[data-group="plants"]  { --accent: #3f9d52; }
    .tree-nav[data-group="fungi"]   { --accent: #b46b1b; }
    .tree-nav[data-group="other"]   { --accent: #7a5ea8; }

    .tree-breadcrumb {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 2px 2px;
      padding: 2px 0 8px;
    }

    .tree-crumb {
      border: 0;
      background: none;
      font: inherit;
      font-weight: 900;
      color: var(--accent);
      padding: 4px 5px;
      border-radius: 7px;
      cursor: pointer;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tree-crumb.current {
      color: var(--ink);
      cursor: default;
    }

    .tree-crumb:not(.current):hover,
    .tree-crumb:not(.current):focus-visible {
      background: rgba(4, 124, 120, 0.12);
    }

    .tree-crumb-sep {
      color: var(--muted);
      font-weight: 900;
    }

    .tree-focus {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 10px;
      padding-bottom: 10px;
      margin-bottom: 12px;
      border-bottom: 2px solid var(--accent);
    }

    .tree-focus-rank {
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 0.68rem;
      font-weight: 900;
      color: var(--accent);
    }

    .tree-focus-name {
      font-size: 1.25rem;
      font-weight: 900;
      overflow-wrap: anywhere;
    }

    .tree-focus-sub {
      color: var(--muted);
      font-weight: 800;
      font-size: 0.82rem;
    }

    .tree-carousel {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 4px 0 8px;
    }

    .tree-card {
      display: grid;
      gap: 8px;
      justify-items: center;
      border: 1px solid var(--line);
      border-top: 3px solid var(--accent);
      border-radius: 14px;
      padding: 12px 10px 14px;
      background: #ffffff;
      box-shadow: var(--shadow);
      color: var(--ink);
      font: inherit;
      cursor: pointer;
      text-align: center;
    }

    .tree-card:hover,
    .tree-card:focus-visible {
      border-color: var(--accent);
      transform: translateY(-2px);
    }

    .tree-card-art {
      display: grid;
      place-items: center;
      width: 100%;
      min-height: 112px;
      padding: 6px 0;
    }

    .tree-card-art .sheet-sprite { width: 76%; }
    .tree-card-art .placeholder-shape { width: 66px; height: 66px; }

    .tree-card-name {
      font-weight: 900;
      overflow-wrap: anywhere;
      line-height: 1.15;
    }

    .tree-card-meta {
      color: var(--muted);
      font-size: 0.76rem;
      font-weight: 800;
    }

    .tree-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(clamp(96px, var(--leaf-size, 120px), 200px), 1fr));
      gap: 10px;
      padding-top: 4px;
    }

    .tree-medallion {
      display: grid;
      gap: 3px;
      justify-items: center;
      text-align: center;
      text-decoration: none;
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 8px 6px 9px;
      background: #ffffff;
      box-shadow: var(--shadow);
    }

    .tree-medallion:hover,
    .tree-medallion:focus-visible {
      border-color: var(--accent);
    }

    .tree-medallion-art {
      width: 100%;
      aspect-ratio: 1 / 1;
      display: grid;
      place-items: center;
      background: #eef2eb;
      border-radius: 10px;
      overflow: hidden;
    }

    .tree-medallion-art .sheet-sprite { width: 92%; }
    .tree-medallion-art .placeholder-shape { width: 60%; height: 60%; }

    .tree-medallion-name {
      font-weight: 900;
      font-size: 0.8rem;
      overflow-wrap: anywhere;
      line-height: 1.12;
    }

    .tree-medallion-sci {
      color: var(--muted);
      font-size: 0.7rem;
      overflow-wrap: anywhere;
    }

    @media (prefers-reduced-motion: reduce) {
      .tree-card { transition: none; }
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--card-min, 190px), 1fr));
      gap: 14px;
    }

    .card {
      border: 0;
      background: transparent;
      box-shadow: none;
      cursor: pointer;
      overflow: visible;
      min-width: 0;
      perspective: 1100px;
    }

    .card.unselectable {
      cursor: default;
    }

    .card.selected .card-inner {
      border-color: var(--teal);
      box-shadow: 0 0 0 3px rgba(4, 124, 120, 0.18), var(--shadow);
    }

    .card:focus-visible {
      outline: 3px solid rgba(4, 124, 120, 0.35);
      outline-offset: 4px;
    }

    .card-inner {
      position: relative;
      display: grid;
      min-height: 240px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: var(--shadow);
      transform-style: preserve-3d;
      transition: transform 260ms ease;
    }

    .card.flipped .card-inner {
      transform: rotateY(180deg);
    }

    .card-actions {
      position: absolute;
      right: 8px;
      bottom: 8px;
      display: flex;
      gap: 6px;
      z-index: 4;
    }

    .card-action {
      min-height: 28px;
      border: 1px solid rgba(23, 32, 27, 0.18);
      border-radius: 999px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.92);
      color: var(--ink);
      font-size: 0.72rem;
      font-weight: 900;
    }

    .select-mark {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 4;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 2px solid rgba(23, 32, 27, 0.28);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.92);
      color: transparent;
      font-weight: 900;
    }

    .card.selected .select-mark {
      border-color: var(--teal);
      background: var(--teal);
      color: white;
    }

    .card.unselectable .select-mark {
      opacity: 0.42;
    }

    .card-face {
      grid-area: 1 / 1;
      min-width: 0;
      overflow: hidden;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.9);
      backface-visibility: hidden;
    }

    .card-back {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 10px;
      padding: 12px;
      padding-bottom: 44px;
      overflow: auto;
      background: #fbfcf9;
      transform: rotateY(180deg);
    }

    .card-back-head {
      display: grid;
      gap: 4px;
    }

    .stat-bars,
    .abilities {
      display: grid;
      gap: 7px;
    }

    .stat-row {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) 28px;
      gap: 8px;
      align-items: center;
      font-size: 0.74rem;
      font-weight: 800;
      color: #344139;
    }

    .stat-track {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: #e1e8e2;
    }

    .stat-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--teal), var(--green));
    }

    .ability {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 8px;
      background: #ffffff;
    }

    .ability strong,
    .ability span {
      display: block;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .ability strong {
      font-size: 0.82rem;
      line-height: 1.1;
    }

    .ability span {
      margin-top: 2px;
      color: var(--muted);
      font-size: 0.72rem;
      line-height: 1.2;
    }

    .ability-power {
      min-width: 34px;
      border-radius: 999px;
      padding: 3px 6px;
      background: #e4f2ef;
      color: #17433f;
      font-size: 0.72rem;
      font-weight: 900;
      text-align: center;
    }

    .sprite {
      position: relative;
      display: grid;
      place-items: center;
      aspect-ratio: 1 / 1;
      background:
        linear-gradient(135deg, rgba(4, 124, 120, 0.12), rgba(180, 107, 27, 0.16)),
        #f8faf6;
      overflow: hidden;
    }

    .sprite img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      image-rendering: auto;
    }

    .sprite.ready img {
      object-fit: contain;
      image-rendering: pixelated;
      padding: 8%;
    }

    .sheet-sprite {
      width: 86%;
      aspect-ratio: 1 / 1;
      background-repeat: no-repeat;
      background-size: 400% 400%;
      background-position: 0 var(--row-pos, 0);
      image-rendering: pixelated;
      animation: spriteFrames 900ms steps(1, end) infinite;
      filter: drop-shadow(0 10px 12px rgba(23, 32, 27, 0.18));
    }

    .sprite .sheet-sprite {
      width: 92%;
    }

    .sprite-picker {
      position: absolute;
      left: 50%;
      bottom: 8px;
      z-index: 4;
      display: grid;
      grid-template-columns: 28px auto 28px;
      align-items: center;
      gap: 5px;
      min-height: 30px;
      border: 1px solid rgba(23, 32, 27, 0.18);
      border-radius: 999px;
      padding: 3px 5px;
      background: rgba(255, 255, 255, 0.94);
      box-shadow: 0 8px 18px rgba(23, 32, 27, 0.12);
      transform: translateX(-50%);
    }

    .sprite-picker button {
      display: grid;
      place-items: center;
      width: 28px;
      height: 24px;
      min-height: 24px;
      border: 0;
      border-radius: 999px;
      padding: 0;
      background: #e4f2ef;
      color: #17433f;
      font-size: 0.9rem;
      font-weight: 900;
      line-height: 1;
    }

    .sprite-picker button:hover,
    .sprite-picker button:focus-visible {
      background: var(--teal);
      color: #fff;
    }

    .sprite-picker span {
      min-width: 28px;
      color: var(--muted);
      font-size: 0.72rem;
      font-weight: 900;
      text-align: center;
      white-space: nowrap;
    }

    .anim-idle { --row-pos: 0%; }
    .anim-move { --row-pos: 33.333333%; }
    .anim-attack { --row-pos: 66.666667%; animation-duration: 520ms; }
    .anim-special { --row-pos: 100%; animation-duration: 680ms; }

    @keyframes spriteFrames {
      0%, 24.999% { background-position: 0% var(--row-pos); }
      25%, 49.999% { background-position: 33.333333% var(--row-pos); }
      50%, 74.999% { background-position: 66.666667% var(--row-pos); }
      75%, 100% { background-position: 100% var(--row-pos); }
    }

    .placeholder-shape {
      width: 54%;
      height: 54%;
      opacity: 0.82;
      background: var(--teal);
      clip-path: polygon(50% 0, 88% 18%, 100% 60%, 70% 100%, 30% 100%, 0 60%, 12% 18%);
    }

    .placeholder-bird { clip-path: polygon(15% 54%, 45% 20%, 55% 45%, 94% 31%, 67% 63%, 76% 93%, 45% 72%, 12% 91%); background: var(--blue); }
    .placeholder-mammal { border-radius: 45% 45% 34% 34%; background: var(--amber); }
    .placeholder-reptile { clip-path: polygon(6% 58%, 26% 36%, 72% 31%, 97% 45%, 78% 66%, 32% 72%); background: var(--green); }
    .placeholder-amphibian { border-radius: 55% 55% 45% 45%; transform: scaleX(1.16); background: var(--green); }
    .placeholder-fish { clip-path: polygon(0 50%, 18% 25%, 70% 30%, 100% 50%, 70% 70%, 18% 75%); background: var(--blue); }
    .placeholder-arthropod { clip-path: polygon(50% 4%, 67% 26%, 96% 30%, 76% 52%, 86% 85%, 50% 68%, 14% 85%, 24% 52%, 4% 30%, 33% 26%); background: var(--coral); }
    .placeholder-plant { clip-path: polygon(46% 98%, 46% 55%, 13% 64%, 35% 38%, 7% 22%, 42% 24%, 50% 0, 58% 24%, 93% 22%, 65% 38%, 87% 64%, 54% 55%, 54% 98%); background: var(--green); }
    .placeholder-fungus { clip-path: polygon(18% 45%, 22% 22%, 50% 8%, 78% 22%, 82% 45%, 61% 45%, 65% 95%, 35% 95%, 39% 45%); background: var(--coral); }

    .badge {
      position: absolute;
      top: 8px;
      left: 8px;
      min-height: 24px;
      border-radius: 999px;
      padding: 4px 8px;
      background: rgba(23, 32, 27, 0.78);
      color: white;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .meta {
      display: grid;
      gap: 8px;
      padding: 12px;
      padding-bottom: 44px;
    }

    .name {
      font-weight: 800;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .sci {
      color: var(--muted);
      font-size: 0.84rem;
      font-style: italic;
      overflow-wrap: anywhere;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .chip {
      border-radius: 999px;
      padding: 4px 8px;
      background: #eef2eb;
      color: #344139;
      font-size: 0.78rem;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .empty {
      display: grid;
      place-items: center;
      min-height: 360px;
      border: 1px dashed #bcc6bc;
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255,255,255,0.56);
      text-align: center;
      padding: 24px;
    }

    .battle {
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.88);
      box-shadow: var(--shadow);
    }

    .battle[hidden] {
      display: none;
    }

    .battle-head-tools {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .battle-head-tools .secondary {
      min-height: 34px;
      padding: 0 10px;
      font-size: 0.8rem;
    }

    .battle-stage {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      align-items: stretch;
      min-height: 430px;
      padding: 16px;
      border-radius: 10px;
      border: 2px solid #2c3a30;
      overflow: hidden;
      background-color: #9fc28a;
      background-size: cover;
      background-position: center;
      image-rendering: pixelated;
    }

    .battle-stage.shake {
      animation: stageShake 320ms linear;
    }

    @keyframes stageShake {
      10% { transform: translate(-6px, 3px); }
      30% { transform: translate(6px, -3px); }
      50% { transform: translate(-4px, -2px); }
      70% { transform: translate(4px, 2px); }
      90% { transform: translate(-2px, 0); }
    }

    .stage-hurt-flash {
      position: absolute;
      inset: 0;
      z-index: 6;
      pointer-events: none;
      background: radial-gradient(ellipse at center, rgba(197,79,69,0) 35%, rgba(197,79,69,0.5));
      animation: hurtFade 360ms forwards;
    }

    @keyframes hurtFade {
      from { opacity: 1; }
      to { opacity: 0; }
    }

    .combatant {
      position: relative;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 8px;
      min-width: 0;
      z-index: 2;
    }

    .combatant.opponent {
      align-self: start;
    }

    .combatant.player {
      align-self: end;
      margin-top: 56px;
    }

    .combatant.player .plate {
      order: 2;
    }

    .combatant.player .combatant-sprite {
      order: 1;
    }

    .plate {
      display: grid;
      gap: 6px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid rgba(23, 32, 27, 0.25);
      background: rgba(252, 253, 250, 0.88);
      box-shadow: 0 4px 0 rgba(23, 32, 27, 0.18);
    }

    .combatant-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: start;
    }

    .combatant-name {
      min-width: 0;
      font-weight: 800;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .combatant-role {
      color: var(--muted);
      font-size: 0.82rem;
      white-space: nowrap;
    }

    .combatant-sprite {
      position: relative;
      display: grid;
      place-items: end center;
      min-height: 200px;
      overflow: visible;
    }

    .combatant-sprite .platform {
      position: absolute;
      bottom: 2px;
      left: 50%;
      transform: translateX(-50%);
      width: 78%;
      height: 22%;
      border-radius: 50%;
      background: radial-gradient(ellipse at center, rgba(20,28,22,0.4), rgba(20,28,22,0.16) 58%, rgba(20,28,22,0) 74%);
    }

    .combatant-sprite .sheet-sprite {
      position: relative;
      z-index: 2;
      width: min(82%, 250px);
      margin-bottom: 4%;
    }

    .combatant-sprite .dummy-sprite {
      position: relative;
      z-index: 2;
      margin-bottom: 4%;
    }

    /* Sprites are drawn facing right; mirror the opponent so the two combatants
       face each other. Uses the standalone scale property so it composes with
       the lunge/knockback translate and the faint transform without either one
       clobbering the flip. */
    .combatant.opponent .combatant-sprite .sheet-sprite,
    .combatant.opponent .combatant-sprite .dummy-sprite {
      scale: -1 1;
    }

    /* Movement arcs use the standalone translate property so they can
       run alongside spriteFrames (background-position), hitFlash (filter),
       and faintDrop (transform) without clobbering each other. The lunge
       distance and arc height come from CSS vars randomized per attack. */
    .combatant-sprite .sheet-sprite.lunge {
      animation:
        spriteFrames 900ms steps(1, end) infinite,
        lungeArc 560ms cubic-bezier(0.32, 0.05, 0.3, 1) 1;
      z-index: 3;
    }

    .combatant-sprite .dummy-sprite.lunge {
      animation: lungeArc 560ms cubic-bezier(0.32, 0.05, 0.3, 1) 1;
      z-index: 3;
    }

    @keyframes lungeArc {
      0% { translate: 0 0; }
      38% { translate: calc(var(--lunge-x, 44px) * 0.62) calc(var(--lunge-y, -26px) - var(--arc-h, 20px)); }
      58% { translate: var(--lunge-x, 44px) var(--lunge-y, -26px); }
      78% { translate: calc(var(--lunge-x, 44px) * 0.3) calc(var(--lunge-y, -26px) * 0.3); }
      100% { translate: 0 0; }
    }

    @keyframes knockBack {
      0% { translate: 0 0; }
      35% { translate: var(--kb-x, -14px) var(--kb-y, 6px); }
      70% { translate: calc(var(--kb-x, -14px) * 0.35) calc(var(--kb-y, 6px) * 0.35); }
      100% { translate: 0 0; }
    }

    .sheet-sprite.hit-flash {
      animation:
        spriteFrames 900ms steps(1, end) infinite,
        hitFlash 380ms steps(2, end) 1,
        knockBack 420ms ease-out 1;
    }

    @keyframes hitFlash {
      0%, 100% { filter: drop-shadow(0 10px 12px rgba(23, 32, 27, 0.18)); }
      20%, 70% { filter: sepia(1) saturate(9) hue-rotate(-46deg) brightness(1.3); }
      45% { filter: brightness(2.4) saturate(0.3); }
    }

    .dummy-sprite.hit-flash {
      animation:
        hitFlash 380ms steps(2, end) 1,
        knockBack 420ms ease-out 1;
    }

    .sheet-sprite.fainted,
    .dummy-sprite.fainted {
      animation: faintDrop 650ms ease-in forwards;
    }

    @keyframes faintDrop {
      to {
        transform: translateY(42%);
        opacity: 0;
      }
    }

    .status-sprites {
      position: absolute;
      top: -14px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 4px;
      z-index: 7;
      pointer-events: none;
    }

    .status-sprite {
      width: 38px;
      height: 38px;
      background-size: 400% 400%;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      animation: statusSheet16 1.28s step-end infinite;
      filter: drop-shadow(0 2px 2px rgba(13, 18, 15, 0.35));
    }

    @keyframes statusSheet16 {
      0% { background-position: 0% 0%; }
      6.25% { background-position: 33.34% 0%; }
      12.5% { background-position: 66.67% 0%; }
      18.75% { background-position: 100% 0%; }
      25% { background-position: 0% 33.34%; }
      31.25% { background-position: 33.34% 33.34%; }
      37.5% { background-position: 66.67% 33.34%; }
      43.75% { background-position: 100% 33.34%; }
      50% { background-position: 0% 66.67%; }
      56.25% { background-position: 33.34% 66.67%; }
      62.5% { background-position: 66.67% 66.67%; }
      68.75% { background-position: 100% 66.67%; }
      75% { background-position: 0% 100%; }
      81.25% { background-position: 33.34% 100%; }
      87.5% { background-position: 66.67% 100%; }
      93.75% { background-position: 100% 100%; }
    }

    .dmg-float {
      position: absolute;
      left: 50%;
      top: 26%;
      z-index: 8;
      transform: translateX(-50%);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.6rem;
      font-weight: 900;
      color: #fff;
      text-shadow: 2px 2px 0 #a4392f, -1px -1px 0 #a4392f, 1px -1px 0 #a4392f, -1px 1px 0 #a4392f;
      pointer-events: none;
      animation: dmgFloat 850ms ease-out forwards;
    }

    .dmg-float.heal {
      text-shadow: 2px 2px 0 #2f7d42, -1px -1px 0 #2f7d42, 1px -1px 0 #2f7d42, -1px 1px 0 #2f7d42;
    }

    .dmg-float.big {
      font-size: 2.1rem;
    }

    .dmg-float.word {
      font-size: 1rem;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }

    .dmg-float.buff {
      text-shadow: 2px 2px 0 #2f7d42, -1px -1px 0 #2f7d42, 1px -1px 0 #2f7d42, -1px 1px 0 #2f7d42;
    }

    .dmg-float.debuff {
      text-shadow: 2px 2px 0 #9a4a14, -1px -1px 0 #9a4a14, 1px -1px 0 #9a4a14, -1px 1px 0 #9a4a14;
    }

    .dmg-float.status-fx {
      text-shadow: 2px 2px 0 #6a3a8a, -1px -1px 0 #6a3a8a, 1px -1px 0 #6a3a8a, -1px 1px 0 #6a3a8a;
    }

    .dmg-float.miss {
      color: #f0f0f0;
      text-shadow: 2px 2px 0 #5a6068, -1px -1px 0 #5a6068, 1px -1px 0 #5a6068, -1px 1px 0 #5a6068;
    }

    .dmg-float.eff-strong {
      color: #eaffe9;
      font-size: 1.15rem;
      text-shadow: 2px 2px 0 #2e9e4f, -1px -1px 0 #2e9e4f, 1px -1px 0 #2e9e4f, -1px 1px 0 #2e9e4f;
    }

    .dmg-float.eff-weak {
      color: #e9e9e9;
      font-size: 0.92rem;
      text-shadow: 2px 2px 0 #6b7178, -1px -1px 0 #6b7178, 1px -1px 0 #6b7178, -1px 1px 0 #6b7178;
    }

    .dmg-float.crit {
      font-size: 2.1rem;
      color: #ffe066;
      text-shadow: 2px 2px 0 #8a2be2, -2px -2px 0 #8a2be2, 2px -2px 0 #8a2be2, -2px 2px 0 #8a2be2;
      animation: critFloat 950ms ease-out forwards;
    }

    @keyframes critFloat {
      0% { opacity: 0; transform: translate(-50%, 14px) scale(0.5) rotate(-8deg); }
      14% { opacity: 1; transform: translate(-50%, 0) scale(1.35) rotate(3deg); }
      30% { transform: translate(-50%, -6px) scale(1.05) rotate(-2deg); }
      100% { opacity: 0; transform: translate(-50%, -56px) scale(1); }
    }

    @keyframes dmgFloat {
      0% { opacity: 0; transform: translate(-50%, 10px); }
      18% { opacity: 1; }
      100% { opacity: 0; transform: translate(-50%, -48px); }
    }

    .battle-overlay {
      position: absolute;
      inset: 0;
      z-index: 12;
      display: grid;
      place-items: center;
      background: rgba(13, 18, 15, 0.55);
    }

    .battle-overlay.intro {
      animation: introPulse 1100ms forwards;
      pointer-events: none;
    }

    @keyframes introPulse {
      0% { opacity: 0; }
      18% { opacity: 1; }
      82% { opacity: 1; }
      100% { opacity: 0; }
    }

    .overlay-card {
      display: grid;
      gap: 12px;
      text-align: center;
      justify-items: center;
    }

    .overlay-title {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: clamp(1.8rem, 5vw, 3rem);
      font-weight: 900;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #fff;
      text-shadow: 4px 4px 0 rgba(0, 0, 0, 0.55);
    }

    .overlay-title.win { color: #f2ce72; }
    .overlay-title.lose { color: #ef8d84; }

    .overlay-sub {
      color: #dfe7e0;
      font-size: 0.92rem;
    }

    .hp > span.hp-low {
      background: linear-gradient(90deg, var(--coral), var(--amber));
    }

    .training-hint {
      padding: 10px 14px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--muted);
      font-size: 0.85rem;
    }

    .training-hint:empty {
      display: none;
    }

    .training-masteries {
      margin-top: 12px;
    }

    .training-masteries > summary {
      cursor: pointer;
      font-weight: 800;
      color: var(--muted);
      user-select: none;
    }

    .training-split {
      display: grid;
      grid-template-columns: minmax(230px, 300px) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
      margin-top: 14px;
    }

    .training-roster {
      display: grid;
      align-content: start;
      max-height: 72vh;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
    }

    .training-roster-row {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 7px 10px;
      border: 0;
      border-bottom: 1px solid #e5e9e2;
      background: transparent;
      font: inherit;
      color: var(--ink);
      text-align: left;
      cursor: pointer;
    }

    .training-roster-row:last-child {
      border-bottom: 0;
    }

    .training-roster-row:hover {
      background: #eef4f0;
    }

    .training-roster-row.active {
      background: #edf6f1;
      box-shadow: inset 3px 0 0 var(--teal);
    }

    .training-roster-sprite {
      display: grid;
      place-items: center;
      width: 44px;
      aspect-ratio: 1 / 1;
      border-radius: 6px;
      background: #eef2eb;
      overflow: hidden;
    }

    .training-roster-sprite .sheet-sprite {
      width: 94%;
    }

    .training-roster-sprite .placeholder-shape {
      width: 60%;
      height: 60%;
    }

    .training-roster-copy {
      min-width: 0;
      display: grid;
      gap: 1px;
    }

    .training-roster-copy strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.85rem;
    }

    .training-roster-copy .subtle {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.72rem;
    }

    .training-roster-pts {
      display: grid;
      gap: 2px;
      justify-items: end;
      font-size: 0.72rem;
      font-weight: 800;
      color: var(--muted);
      white-space: nowrap;
    }

    .training-roster-pts .pts {
      color: var(--teal);
    }

    .training-detail {
      min-width: 0;
    }

    .training-list {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }

    .train-row {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
    }

    .train-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    .train-ledger {
      color: var(--muted);
      font-size: 0.78rem;
    }

    .train-stats {
      display: grid;
      gap: 5px;
    }

    .train-stat {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr) 86px auto;
      gap: 10px;
      align-items: center;
      font-size: 0.8rem;
    }

    .train-stat .stat-track {
      height: 8px;
      border-radius: 999px;
      background: #e3e8e0;
      overflow: hidden;
      position: relative;
    }

    .train-stat .stat-base,
    .train-stat .stat-alloc {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
    }

    .train-stat .stat-base {
      background: linear-gradient(90deg, var(--green), var(--teal));
    }

    .train-stat .stat-alloc {
      background: var(--amber);
      opacity: 0.85;
    }

    .train-add {
      min-height: 26px;
      min-width: 34px;
      border-radius: 6px;
      background: var(--teal);
      color: #fff;
      font-weight: 800;
      font-size: 0.78rem;
    }

    .train-add:disabled {
      background: #b9c3bd;
    }

    .train-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .dev-lab-tools {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) repeat(6, auto);
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
    }

    .dev-lab-sync {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) auto;
      gap: 8px;
      margin-bottom: 14px;
    }

    .dev-summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(180px, 260px);
      gap: 12px;
      align-items: start;
    }

    .dev-sprite-preview {
      width: 100%;
      aspect-ratio: 1;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f7f7f1;
      display: grid;
      place-items: center;
      overflow: hidden;
    }

    .dev-sprite-preview .sheet-sprite {
      width: 96%;
    }

    .dev-meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 8px;
    }

    .dev-meta-grid .stat {
      min-height: auto;
    }

    .dev-output {
      display: grid;
      gap: 10px;
    }

    .dev-preview-controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .dev-preview-controls button {
      min-height: 32px;
      border-radius: 6px;
      font-size: 0.78rem;
      font-weight: 900;
      padding: 6px 8px;
    }

    .dev-preview-controls button.active {
      background: var(--teal);
      color: #fff;
      border-color: var(--teal);
    }

    .train-tools input {
      flex: 1;
      min-width: 120px;
      min-height: 32px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 8px;
      font-size: 0.8rem;
    }

    .train-tools .secondary {
      min-height: 32px;
      padding: 0 10px;
      font-size: 0.78rem;
    }

    .mastery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 8px;
      margin-top: 14px;
    }

    .mastery-card {
      display: grid;
      gap: 4px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
      font-size: 0.8rem;
    }

    .tier-chip {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: #e7ebe5;
      color: #5b675f;
    }

    .tier-chip.tier-bronze { background: #ead9c5; color: #7a5023; }
    .tier-chip.tier-silver { background: #e2e6ea; color: #4f5b66; }
    .tier-chip.tier-gold { background: #f4e3ae; color: #7c5e12; }
    .tier-chip.tier-complete { background: #cfe8d4; color: #1f6b34; }

    .lv-chip {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 0.7rem;
      font-weight: 900;
      background: #2c3a30;
      color: #f2ce72;
    }
    .lv-chip.terr-chip {
      background: #1f3a28;
      color: #8ef0a6;
    }
    .lv-chip.local-chip {
      background: #1f2f3a;
      color: #8ec9f0;
    }

    .sig-star {
      color: #b48a12;
    }

    .move-button.signature {
      border-color: #d9b545;
      background: #f8f2dc;
    }

    .status-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .status-chip {
      display: inline-block;
      padding: 0 7px;
      border-radius: 999px;
      font-size: 0.68rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      background: #e7ebe5;
      color: #5b675f;
    }

    .status-chip.status-stunned { background: #f4e3ae; color: #7c5e12; }
    .status-chip.status-marked { background: #f3d3cf; color: #93352c; }
    .status-chip.status-poisoned { background: #e2d4ef; color: #5e3a86; }
    .status-chip.status-shielded { background: #d4e4f1; color: #2d5a82; }

    .dummy-sprite {
      display: grid;
      place-items: center;
      width: min(68%, 210px);
      aspect-ratio: 1 / 1;
      border: 2px dashed #9da6a0;
      border-radius: 8px;
      background: repeating-linear-gradient(45deg, #d1d5d1, #d1d5d1 10px, #c1c7c2 10px, #c1c7c2 20px);
      color: #57605a;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .hp {
      height: 10px;
      border-radius: 999px;
      background: #dfe5df;
      overflow: hidden;
    }

    .hp > span {
      display: block;
      height: 100%;
      width: var(--hp, 100%);
      background: linear-gradient(90deg, var(--green), var(--teal));
    }

    .mana {
      height: 8px;
      border-radius: 999px;
      background: #d7e0ea;
      overflow: hidden;
      margin-top: 4px;
    }

    .mana > span {
      display: block;
      height: 100%;
      width: var(--mana, 100%);
      background: linear-gradient(90deg, #2f74d0, #5aa6f0);
    }

    .mana-text {
      color: #2f74d0;
    }

    .move-cost {
      font-weight: 900;
      color: #2f74d0;
      white-space: nowrap;
    }

    .move-button.unaffordable {
      opacity: 0.45;
    }

    .struggle-button {
      grid-column: 1 / -1;
      min-height: 44px;
      border-radius: 8px;
      background: #b4542a;
      color: #fff;
      font-weight: 800;
      text-align: left;
      padding: 8px 10px;
    }

    .battle-actions {
      display: grid;
      margin-top: 4px;
    }

    .swap-button {
      grid-column: 1 / -1;
      min-height: 44px;
      border-radius: 8px;
      background: var(--teal);
      color: #fff;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .swap-button .swap-count {
      display: inline-grid;
      place-items: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.26);
      font-size: 0.72rem;
    }

    .swap-modal {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: rgba(18, 26, 22, 0.5);
    }

    .swap-sheet {
      width: min(420px, 100%);
      max-height: 82vh;
      overflow-y: auto;
      background: var(--surface);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 18px 50px rgba(18, 26, 22, 0.35);
    }

    .swap-sheet-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .swap-sheet-head strong {
      font-size: 1.05rem;
    }

    .swap-sheet-head .secondary {
      width: auto;
      flex: 0 0 auto;
    }

    .swap-note {
      margin: 6px 0 10px;
    }

    .swap-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .swap-row {
      display: flex;
      align-items: center;
      gap: 12px;
      text-align: left;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fbfcf9;
      color: var(--ink);
    }

    .swap-row:hover {
      border-color: var(--teal);
      background: #f0f7f4;
    }

    .swap-row:disabled {
      opacity: 0.5;
    }

    .swap-thumb {
      width: 48px;
      height: 48px;
      flex: 0 0 auto;
      border-radius: 8px;
      background-color: #e7eee1;
      background-repeat: no-repeat;
      background-position: 0 0;
      background-size: 400% 400%;
      image-rendering: pixelated;
    }

    .swap-row-info {
      flex: 1 1 auto;
      min-width: 0;
      display: grid;
      gap: 4px;
    }

    .swap-row-name {
      font-weight: 800;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .swap-row-types {
      font-size: 0.72rem;
    }

    .team-picker select {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 10px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
    }

    .moves {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }

    .move-button {
      min-height: 44px;
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--ink);
      background: #edf1ec;
      border: 1px solid var(--line);
      font-weight: 800;
      text-align: left;
    }

    .move-button.eff-strong {
      border-color: #2e9e4f;
      box-shadow: inset 3px 0 0 #2e9e4f;
    }

    .move-button.eff-weak {
      border-color: #c0593a;
      box-shadow: inset 3px 0 0 #c0593a;
    }

    /* Terrain-favored move: warm leaf glow on the bottom edge. */
    .move-button.eff-terrain {
      box-shadow: inset 0 -3px 0 #3bbf57;
    }
    .move-button.eff-strong.eff-terrain {
      box-shadow: inset 3px 0 0 #2e9e4f, inset 0 -3px 0 #3bbf57;
    }
    .move-button .terrain-tag {
      font-size: 0.85em;
    }

    .terrain-banner {
      margin: 6px 0 0;
      padding: 7px 12px;
      border-radius: 10px;
      background: linear-gradient(90deg, rgba(59,191,87,0.16), rgba(59,191,87,0.04));
      border: 1px solid rgba(59,191,87,0.3);
      font-size: 0.86rem;
    }

    .move-button .eff-tag {
      font-weight: 900;
    }

    .move-button .move-meta {
      display: block;
      margin-top: 3px;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--muted);
    }

    .move-button .meta-dmg {
      color: #b3541e;
      font-weight: 900;
    }

    .stage-chip {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      font-weight: 800;
      letter-spacing: 0.03em;
    }

    .stage-chip.up {
      background: #1f4d2c;
      color: #9ff0b0;
    }

    .stage-chip.down {
      background: #5a2520;
      color: #f6b0a4;
    }

    .move-button.eff-strong .eff-tag {
      color: #2e9e4f;
    }

    .move-button.eff-weak .eff-tag {
      color: #c0593a;
    }

    .overlay-contrib {
      display: grid;
      gap: 3px;
      margin: 10px 0;
      font-size: 0.8rem;
      color: var(--muted);
      text-align: left;
    }

    .battle-log {
      display: grid;
      gap: 6px;
      max-height: 148px;
      overflow: auto;
      margin-top: 12px;
      padding: 10px;
      border-radius: 8px;
      background: #17201b;
      color: #edf4ef;
      font-size: 0.84rem;
    }

    .overlay-rating {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      justify-content: center;
      flex-wrap: wrap;
      padding: 8px 12px;
      border-radius: 10px;
      background: #1d2a22;
      color: #edf4ef;
      font-size: 0.9rem;
      font-weight: 700;
    }

    .rating-delta {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.15rem;
      font-weight: 900;
    }

    .rating-delta.up { color: #6fe08a; }
    .rating-delta.down { color: #f08a76; }

    .overlay-actions {
      display: flex;
      gap: 8px;
      justify-content: center;
      flex-wrap: wrap;
    }

    .lb-podium {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }

    .lb-podium-card {
      position: relative;
      display: grid;
      gap: 6px;
      justify-items: center;
      text-align: center;
      padding: 16px 10px 12px;
      border: 2px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      overflow: hidden;
    }

    .lb-podium-card.first {
      border-color: #d8a93a;
      box-shadow: 0 0 0 3px rgba(216, 169, 58, 0.25), 0 6px 18px rgba(216, 169, 58, 0.18);
      background: linear-gradient(180deg, rgba(216, 169, 58, 0.12), transparent 60%), var(--panel);
    }

    .lb-podium-card.second { border-color: #9aa7b4; }
    .lb-podium-card.third { border-color: #c08a5a; }

    .lb-medal { font-size: 1.7rem; line-height: 1; }

    .lb-podium-card .lb-name {
      font-weight: 800;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .lb-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 2px solid var(--line);
      object-fit: cover;
      background: #d7e2d4;
    }

    .lb-rating {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.25rem;
      font-weight: 900;
    }

    .lb-title-chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: #e7efe3;
      border: 1px solid var(--line);
      font-size: 0.74rem;
      font-weight: 700;
    }

    .lb-streak {
      color: #b3541e;
      font-weight: 800;
      font-size: 0.8rem;
    }

    .lb-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }

    .lb-table th,
    .lb-table td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      white-space: nowrap;
    }

    .lb-table th {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }

    .lb-table tr.lb-you {
      background: rgba(110, 160, 110, 0.16);
      outline: 2px solid #6ea06e;
      outline-offset: -2px;
    }

    .lb-row-name {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .lb-row-name .lb-avatar {
      width: 26px;
      height: 26px;
    }

    .lb-you-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 14px;
      padding: 12px 14px;
      border: 2px solid #6ea06e;
      border-radius: 12px;
      background: var(--panel);
    }

    .lb-you-card .lb-you-stats {
      display: flex;
      gap: 14px;
      align-items: baseline;
      flex-wrap: wrap;
    }

    .lb-you-rank {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.4rem;
      font-weight: 900;
    }

    .bsky-share-button {
      background: #1083fe;
      border-color: #0a6ad0;
      color: #fff;
    }

    .buddy-intro {
      margin: 0 0 12px;
      line-height: 1.5;
    }

    .buddy-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15) inset;
      vertical-align: middle;
    }

    .buddy-dot.online { background: #3fb950; box-shadow: 0 0 6px #3fb95088; }
    .buddy-dot.idle { background: #e3b341; }
    .buddy-dot.offline { background: #9aa3a3; }

    .buddy-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .buddy-group {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6b7a6b;
      margin: 14px 0 4px;
      padding-left: 2px;
    }

    .buddy-group:first-child {
      margin-top: 0;
    }

    .buddy-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 10px;
      min-height: 52px;
    }

    .buddy-row:hover {
      background: rgba(0, 0, 0, 0.04);
    }

    .buddy-row.offline {
      opacity: 0.66;
    }

    .buddy-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      object-fit: cover;
      flex: 0 0 auto;
      background: #d8e2d2;
    }

    .buddy-avatar-blank {
      display: inline-block;
    }

    .buddy-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1 1 auto;
    }

    .buddy-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .buddy-sub {
      font-size: 12px;
      color: #6b7a6b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .buddy-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }

    .buddy-profile {
      font-size: 13px;
      color: #1083fe;
      text-decoration: none;
    }

    .buddy-challenge {
      padding: 6px 12px;
      min-height: 36px;
    }

    @media (max-width: 880px) {
      .topbar,
      .layout {
        grid-template-columns: 1fr;
      }

      .lb-podium {
        grid-template-columns: 1fr;
      }

      .landing-section-head {
        display: grid;
      }

      .landing-steps,
      .landing-trust {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .home-hero-card,
      .onboarding-card,
      .home-panels {
        grid-template-columns: 1fr;
      }

      .home-panel.wide {
        grid-column: auto;
      }

      .home-metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .panel {
        position: static;
      }

      .login {
        grid-template-columns: 1fr auto;
      }

      /* Put dev/Bluesky tools below the active view instead of above it. */
      .layout > section {
        order: 1;
      }

      .layout > .panel {
        order: 2;
      }

      /* Keep focused tabs focused: the control sidebar stacks below every view
         on mobile, so make it contextual. Self-contained views (Map, Settings,
         Leaderboard, Training, Sprite Tree) hide the whole sidebar. Battle keeps
         only battle controls (Bluesky challenges + team picker + Battle NPC) and
         drops the roster sprite-queue button. */
      body[data-view="map"] .layout > .panel,
      body[data-view="settings"] .layout > .panel,
      body[data-view="leaderboard"] .layout > .panel,
      body[data-view="training"] .layout > .panel,
      body[data-view="tree"] .layout > .panel {
        display: none;
      }

      body[data-view="battle"] .layout > .panel > #queueMoreButton {
        display: none;
      }
    }

    @media (max-width: 720px) {
      .view-tabs {
        display: none;
      }

      body.app-active .mobile-nav {
        display: flex;
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 50;
        background: var(--surface);
        border-top: 1px solid var(--line);
        box-shadow: 0 -4px 18px rgba(22, 32, 27, 0.08);
      }

      body.app-active .shell {
        padding-bottom: calc(72px + env(safe-area-inset-bottom));
      }
    }

    @media (max-width: 520px) {
      .shell {
        padding: 14px;
      }

      .login,
      .landing-auth,
      .roster-head {
        grid-template-columns: 1fr;
        display: grid;
      }

      .landing {
        gap: 22px;
        padding-top: 18px;
      }

      .landing-hero {
        min-height: 520px;
        background-position: 58% center;
      }

      .landing-copy {
        padding: 24px;
      }

      .landing h2 {
        max-width: 9ch;
      }

      .landing-steps,
      .landing-trust {
        grid-template-columns: 1fr;
      }

      .home-metrics {
        grid-template-columns: 1fr;
      }

      .home-actions {
        display: grid;
      }

      .primary,
      .secondary {
        width: 100%;
      }

      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .battle-stage,
      .moves {
        grid-template-columns: 1fr;
      }

      .tree-tools {
        grid-template-columns: 1fr;
      }

      .dev-lab-tools,
      .dev-lab-sync,
      .dev-summary,
      .dev-meta-grid {
        grid-template-columns: 1fr;
      }

      .training-split {
        grid-template-columns: 1fr;
      }

      .training-roster {
        max-height: 38vh;
      }

      .meta {
        padding: 10px;
        padding-bottom: 40px;
      }

      .name {
        font-size: 0.9rem;
      }
    }

    /* ===== Mobile battle: fit stage + HP + status + moves on one screen =====
       The active battle becomes a fixed full-viewport surface so it escapes
       the topbar/tools; the stage flexes and the moves pin just below it. */
    @media (max-width: 760px) {
      body.battle-active .mobile-nav {
        display: none;
      }

      body.battle-active .battle:not([hidden]) {
        position: fixed;
        inset: 0;
        z-index: 45;
        margin: 0;
        background: var(--bg);
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px 8px calc(8px + env(safe-area-inset-bottom));
      }

      body.battle-active .battle > .roster-head {
        margin: 0;
        align-items: center;
      }

      body.battle-active .battle > .roster-head h2 {
        font-size: 1rem;
        line-height: 1.15;
      }

      body.battle-active .battle .battle-head-tools {
        gap: 6px;
        flex-wrap: wrap;
      }

      body.battle-active .battle .battle-head-tools .secondary {
        width: auto;
        padding: 4px 8px;
        min-height: 32px;
        font-size: 0.78rem;
      }

      /* Keep both combatants side-by-side (override the 520px single column).
         Constrain the single row to fill the stage (minmax(0,1fr)) instead of
         growing to the combatants' content — otherwise the row expands past the
         height-capped stage and the plates overflow the clip. */
      body.battle-active .battle .battle-stage {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: minmax(0, 1fr);
        gap: 6px;
        padding: 8px;
        min-height: 0;
      }

      /* The stage is height-capped (flex column) and clips overflow, so the
         PLATE (HP/mana — the important UI) must never be the clipped element.
         Stretch each combatant to the stage height and give the plate an
         auto (content) row while the sprite takes the shrinkable row and
         absorbs any clipping. */
      body.battle-active .battle .combatant {
        align-self: stretch;
        grid-template-rows: auto minmax(0, 1fr); /* opponent: plate top, sprite below */
      }

      body.battle-active .battle .combatant.player {
        margin-top: 0;
        grid-template-rows: minmax(0, 1fr) auto; /* player: sprite top, plate bottom */
      }

      body.battle-active .battle .combatant-sprite {
        min-height: 0;
        overflow: hidden;
      }

      /* Stack name above role so the name gets full width (no vertical wrap). */
      body.battle-active .battle .combatant-head {
        flex-direction: column;
        gap: 3px;
      }

      body.battle-active .battle .combatant-role {
        white-space: normal;
        font-size: 0.74rem;
      }

      /* 2x2 moves (override the 520px single column) so they don't stack tall. */
      body.battle-active .battle .moves {
        grid-template-columns: 1fr 1fr;
        margin-top: 0;
      }

      body.battle-active .battle .move-button {
        min-height: 0;
        padding: 6px 8px;
      }

      body.battle-active .battle .move-button .move-meta {
        font-size: 0.66rem;
      }

      /* Stage flexes to fill; moves pin just below it; log sits below. */
      body.battle-active .battle .battle-stage {
        flex: 1 1 auto;
        min-height: 38vh;
      }

      body.battle-active .battle .battle-actions,
      body.battle-active .battle .moves {
        flex: 0 0 auto;
      }

      body.battle-active .battle .battle-actions {
        margin-top: 0;
      }

      body.battle-active .battle .battle-log {
        flex: 0 0 auto;
        max-height: 4.6em;
        overflow-y: auto;
      }

      .map-stage {
        min-height: calc(100dvh - 196px);
      }
      .map-head {
        gap: 8px;
      }
      .map-head h2 {
        font-size: 1.1rem;
      }
      .map-head #mapSyncButton {
        width: auto;
      }
      .map-legend {
        font-size: 10px;
        padding: 6px 8px;
      }
    }

    /* -- Territory map (Leaflet) -- */
    .map-view {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .map-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .map-head-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .map-head-text h2 {
      margin: 0;
    }
    .map-stage {
      position: relative;
      flex: 1 1 auto;
      min-height: 62vh;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    #mapCanvas {
      position: absolute;
      inset: 0;
      background: #0c1116;
    }
    .leaflet-container {
      background: #0c1116;
      font: inherit;
    }
    .leaflet-container a {
      color: var(--teal);
    }
    /* No focus rectangle when a hex/marker SVG path is clicked. */
    .leaflet-interactive:focus {
      outline: none;
    }
    .map-legend {
      position: absolute;
      left: 10px;
      bottom: 10px;
      z-index: 500;
      display: flex;
      flex-direction: column;
      gap: 3px;
      background: rgba(12, 17, 22, 0.82);
      color: #e8eef0;
      padding: 8px 10px;
      border-radius: 10px;
      font-size: 11px;
      max-height: 46%;
      overflow: auto;
      pointer-events: none;
    }
    .map-legend-row {
      display: flex;
      align-items: center;
      gap: 6px;
      text-transform: capitalize;
    }
    .map-legend-sw {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      display: inline-block;
      flex: 0 0 auto;
    }

    .map-head-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .map-mode-toggle {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      background: var(--surface);
    }
    .map-mode-btn {
      border: none;
      background: transparent;
      padding: 7px 14px;
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--muted);
      cursor: pointer;
    }
    .map-mode-btn.active {
      background: var(--teal);
      color: #fff;
    }

    .owner-avatar-icon {
      background: transparent;
      border: none;
    }
    .owner-avatar-ring {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      border: 3px solid #888;
      overflow: hidden;
      background: #0c1116;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .owner-avatar-ring img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .owner-avatar-fallback {
      color: #fff;
      font-weight: 800;
      font-size: 1.2rem;
    }

    .tile-panel {
      position: absolute;
      right: 12px;
      top: 12px;
      z-index: 600;
      width: min(300px, calc(100% - 24px));
    }
    .tile-panel-body {
      position: relative;
      background: rgba(12, 17, 22, 0.94);
      color: #e8eef0;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 14px 14px 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    }
    .tile-panel-body h3 {
      margin: 0;
      font-size: 1.05rem;
      text-transform: capitalize;
    }
    .tile-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tile-biome-chip {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
    }
    .tile-panel .subtle {
      color: #aab6bd;
    }
    .tile-owner {
      display: inline-block;
      margin: 6px 0 2px;
      font-weight: 700;
      font-size: 0.9rem;
    }
    .tile-owner.mine {
      color: #6fe08a;
    }
    .tile-panel .primary {
      display: block;
      width: 100%;
      margin-top: 10px;
    }
    .tile-hint {
      margin: 10px 0 0;
      font-size: 0.85rem;
      color: #c7d0d5;
    }
    .tile-power {
      margin: 8px 0 0;
      padding: 7px 9px;
      border-radius: 9px;
      font-size: 0.82rem;
      background: rgba(59, 191, 87, 0.16);
      border: 1px solid rgba(59, 191, 87, 0.3);
      color: #d7f0dd;
    }
    .tile-local {
      margin: 8px 0 0;
      font-size: 0.82rem;
      color: #c7d0d5;
    }
    .tile-local.ok {
      color: #8ec9f0;
      font-weight: 600;
    }
    .tile-warn {
      margin: 8px 0 0;
      padding: 7px 9px;
      border-radius: 9px;
      font-size: 0.82rem;
      background: rgba(224, 133, 42, 0.16);
      border: 1px solid rgba(224, 133, 42, 0.35);
      color: #f0cba0;
    }
    .tile-power strong {
      color: #8ef0a6;
    }
    .tile-actions-left {
      margin: 10px 0 0;
      font-size: 0.74rem;
    }
    .tile-close {
      position: absolute;
      top: 6px;
      right: 8px;
      background: transparent;
      border: none;
      color: #aab6bd;
      font-size: 1.3rem;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
      width: auto;
    }
    @media (max-width: 720px) {
      .tile-panel {
        right: 8px;
        left: 8px;
        top: auto;
        bottom: 8px;
        width: auto;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div>
          <h1>iNat Battler</h1>
          <div class="subtle" id="accountLabel">No roster loaded</div>
        </div>
      </div>
      <form class="login" id="loginForm">
        <input id="inatLogin" name="inatLogin" autocomplete="username" placeholder="Link iNaturalist to import" maxlength="64" readonly title="Imports your linked iNaturalist account">
        <button class="primary" id="importButton" type="submit">Import</button>
      </form>
    </header>

    <section class="landing" id="publicLanding">
      <section class="landing-hero" aria-label="Fantasy biodiversity battle">
        <div class="landing-copy">
          <div class="landing-kicker">Pre-alpha creature battles from real observations</div>
          <h2>iNat Battler</h2>
          <p class="landing-lede">Turn your iNaturalist observations into a roster of species battlers, link them to your Bluesky identity, and challenge friends with creatures you actually found.</p>
          <div class="landing-actions">
            <a class="secondary" href="#how-it-works">See how it works</a>
          </div>
          <div class="landing-auth" id="landingAuth">Checking Bluesky session...</div>
        </div>
      </section>

      <section class="landing-section" id="how-it-works">
        <div class="landing-section-head">
          <h3>How It Works</h3>
          <p>Sign in, verify your iNaturalist account, import your public observations, then build a team from your real-life species list.</p>
        </div>
        <div class="landing-steps">
          <div class="landing-step">
            <strong>1. Sign in with Bluesky</strong>
            <span>Bluesky gives the app an identity for challenges and posts.</span>
          </div>
          <div class="landing-step">
            <strong>2. Verify iNaturalist</strong>
            <span>Paste a temporary code into your iNaturalist profile to prove ownership.</span>
          </div>
          <div class="landing-step">
            <strong>3. Import observations</strong>
            <span>Your public species counts become a playable roster.</span>
          </div>
          <div class="landing-step">
            <strong>4. Battle with species</strong>
            <span>Pick ready sprites, train favorites, and challenge other naturalists.</span>
          </div>
        </div>
      </section>

      <section class="landing-section">
        <div class="landing-section-head">
          <h3>Alpha Notes</h3>
          <p>The core systems are working, but broader public testing is still being prepared.</p>
        </div>
        <div class="landing-trust">
          <div class="landing-trust-item">
            <strong>Public iNat data</strong>
            <span>Uses public observation summaries and taxon metadata.</span>
          </div>
          <div class="landing-trust-item">
            <strong>No iNat password</strong>
            <span>Verification uses a profile code, not iNaturalist OAuth.</span>
          </div>
          <div class="landing-trust-item">
            <strong>Bluesky identity</strong>
            <span>Challenges are tied to your Bluesky account.</span>
          </div>
          <div class="landing-trust-item">
            <strong>Still pre-alpha</strong>
            <span>Expect rough edges while sprite generation and battles mature.</span>
          </div>
        </div>
      </section>
    </section>

    <section class="layout" id="appLayout">
      <aside class="panel">
        <details class="dev-batch bsky-panel" id="bskyPanelDetails" open>
          <summary class="dev-batch-head">
            <h2>Bluesky Battles</h2>
            <span class="subtle" id="bskyStateLabel">signed out</span>
          </summary>
          <div id="bskyBody" class="bsky-body">Loading Bluesky session…</div>
        </details>
        <div class="team-picker">
          <div class="team-picker-row">
            <div>
              <span class="subtle">Combat Team</span>
              <div class="team-count" id="teamCount">0 / 5 selected</div>
            </div>
            <button class="secondary" id="clearTeamButton" type="button" disabled>Clear</button>
          </div>
          <select id="npcDifficultySelect" aria-label="NPC difficulty">
            <option value="easy">Easy NPC</option>
            <option value="normal">Normal NPC</option>
            <option value="hard">Hard NPC</option>
          </select>
          <button class="primary" id="startBattleButton" type="button" disabled>Battle NPC</button>
        </div>
        <button class="secondary" id="queueMoreButton" type="button" disabled>Queue More</button>
        <p class="status" id="statusLine"></p>
      </aside>

      <section>
        <nav class="view-tabs" aria-label="Main views">
          <button class="view-tab active" id="homeTabButton" type="button" data-view-tab="home">Home</button>
          <button class="view-tab" id="rosterTabButton" type="button" data-view-tab="roster">Roster</button>
          <button class="view-tab" id="battleTabButton" type="button" data-view-tab="battle">Battle</button>
          <button class="view-tab" id="leaderboardTabButton" type="button" data-view-tab="leaderboard">Leaderboard</button>
          <button class="view-tab" id="buddiesTabButton" type="button" data-view-tab="buddies">Buddies</button>
          <button class="view-tab" id="mapTabButton" type="button" data-view-tab="map">Map</button>
          <button class="view-tab" id="trainingTabButton" type="button" data-view-tab="training">Training</button>
          <button class="view-tab" id="treeTabButton" type="button" data-view-tab="tree">Sprite Tree</button>
          <button class="view-tab" id="recentTabButton" type="button" data-view-tab="recent">Recently Added</button>
          <button class="view-tab" id="devTabButton" type="button" data-view-tab="dev">Dev Lab</button>
          <button class="view-tab" id="settingsTabButton" type="button" data-view-tab="settings">Settings</button>
        </nav>
        <section class="view-panel" id="homeView">
          <div class="home-dashboard" id="homeDashboard"></div>
        </section>
        <section class="view-panel" id="rosterView" hidden>
          <div class="roster-head">
            <h2>Roster</h2>
            <span class="subtle" id="refreshLabel"></span>
          </div>
          <div class="roster-toolbar">
            <input id="rosterSearchInput" type="search" placeholder="Search roster">
            <select id="rosterSortSelect" aria-label="Sort roster">
              <option value="default">Sort: Default</option>
              <option value="name">Name A&ndash;Z</option>
              <option value="obs">Most observations</option>
              <option value="affinity">Highest affinity</option>
              <option value="level">Training level</option>
              <option value="status">Ready sprites first</option>
            </select>
            <select id="rosterStatusFilter" aria-label="Filter by sprite status">
              <option value="all">All sprites</option>
              <option value="ready">Ready</option>
              <option value="pending">Queued / running</option>
              <option value="missing">Missing</option>
            </select>
            <label class="zoom-control" title="Card size">
              <span aria-hidden="true">&#x1F50D;</span>
              <input id="rosterZoomInput" type="range" min="140" max="380" step="10" aria-label="Card size">
            </label>
            <button class="secondary mode-toggle" id="rosterModeButton" type="button">Sprite Grid</button>
          </div>
          <div class="type-chips" id="rosterTypeChips" aria-label="Filter by taxon group"></div>
          <div class="grid" id="rosterGrid"></div>
          <div class="empty" id="emptyState">Link your iNaturalist account, then import your roster.</div>
          <div class="roster-pagination" id="rosterPagination"></div>
        </section>
        <section class="view-panel" id="battleView" hidden>
          <div class="empty" id="battleEmptyState">
            <div>
              <strong>No battle in progress.</strong><br>
              Phase 1: pick exactly 5 ready sprites in the Roster tab.<br>
              Phase 2: press Battle NPC, or accept a Bluesky challenge &mdash; the arena opens here.<br><br>
              <button class="secondary" id="demoBattleButton" type="button">Run 5v5 Test Battle</button>
            </div>
          </div>
          <section class="battle" id="battlePanel" hidden></section>
        </section>
        <section class="view-panel" id="leaderboardView" hidden>
          <div class="roster-head">
            <h2>Leaderboard</h2>
            <div class="battle-head-tools">
              <div class="map-mode-toggle" id="leaderboardModeToggle" role="group" aria-label="Leaderboard type">
                <button class="map-mode-btn active" type="button" data-lb-mode="battle">Battle</button>
                <button class="map-mode-btn" type="button" data-lb-mode="territory">Territory</button>
              </div>
              <span class="subtle" id="leaderboardMetaLabel"></span>
              <button class="secondary" id="leaderboardRefreshButton" type="button">Refresh</button>
            </div>
          </div>
          <div id="leaderboardPanel"></div>
        </section>
        <section class="view-panel" id="buddiesView" hidden>
          <div class="roster-head">
            <h2>Buddies</h2>
            <div class="battle-head-tools">
              <span class="subtle" id="buddiesMetaLabel"></span>
              <button class="secondary" id="buddiesRefreshButton" type="button">Refresh mutuals</button>
            </div>
          </div>
          <p class="subtle buddy-intro">Your Bluesky mutuals, live. Presence is read from the firehose: <span class="buddy-dot online"></span> active (posting), <span class="buddy-dot idle"></span> lurking (likes only), <span class="buddy-dot offline"></span> quiet. Challenge whoever is online now.</p>
          <div id="buddiesPanel"><p class="subtle">Open this tab to connect to the Bluesky firehose and load your buddy list.</p></div>
        </section>
        <section class="view-panel map-view" id="mapView" hidden>
          <div class="map-head">
            <div class="map-head-text">
              <h2>Territory</h2>
              <span class="subtle" id="mapStatusLabel">Your observations on the living map. Each hex is a real biome.</span>
            </div>
            <div class="map-head-tools">
              <div class="map-mode-toggle" id="mapModeToggle" role="group" aria-label="Map mode">
                <button class="map-mode-btn active" type="button" data-map-mode="biomes">Biomes</button>
                <button class="map-mode-btn" type="button" data-map-mode="claims">Claims</button>
              </div>
              <button class="secondary" id="mapSyncButton" type="button">Sync my observations</button>
            </div>
          </div>
          <div class="map-stage">
            <div id="mapCanvas"></div>
            <div class="map-legend" id="mapLegend" aria-hidden="true"></div>
            <div class="tile-panel" id="tilePanel" hidden></div>
          </div>
        </section>
        <section class="view-panel" id="trainingView" hidden>
          <div class="roster-head">
            <h2>Training</h2>
            <span class="subtle" id="trainingTotalsLabel"></span>
          </div>
          <div class="tree-tools">
            <input id="trainingFilterInput" placeholder="Filter species">
            <button class="secondary" id="trainingSyncButton" type="button">Sync iNat Data</button>
          </div>
          <div class="training-hint" id="trainingEmptyState"></div>
          <details class="training-masteries" id="trainingMasteries" hidden>
            <summary id="trainingMasteriesSummary">Masteries</summary>
            <div id="trainingMasteriesBody"></div>
          </details>
          <div class="training-split" id="trainingSplit" hidden>
            <div class="training-roster" id="trainingList" role="listbox" aria-label="Trainable species"></div>
            <div class="training-detail" id="trainingDetail"></div>
          </div>
        </section>
        <section class="view-panel" id="treeView" hidden>
          <div class="roster-head">
            <h2>Sprite Tree</h2>
            <span class="subtle" id="treeRefreshLabel"></span>
          </div>
          <div class="tree-tools">
            <input id="treeSearchInput" placeholder="Search sprites, taxa, or groups">
            <label class="zoom-control" title="Sprite size">
              <span aria-hidden="true">&#x1F50D;</span>
              <input id="treeZoomInput" type="range" min="44" max="160" step="4" aria-label="Sprite size">
            </label>
            <button class="secondary" id="treeRefreshButton" type="button">Refresh</button>
          </div>
          <div class="tree-browser" id="spriteTreePanel">
            <div class="empty">Load the sprite tree to browse ready assets.</div>
          </div>
        </section>
        <section class="view-panel" id="recentView" hidden>
          <div class="roster-head">
            <h2>Recently Added</h2>
            <span class="subtle" id="recentRefreshLabel"></span>
          </div>
          <div class="tree-tools">
            <input id="recentSearchInput" placeholder="Search recent sprites">
            <select id="recentSortSelect" aria-label="Sort recent sprites">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A&ndash;Z</option>
            </select>
            <select id="recentGroupFilter" aria-label="Filter by taxon group">
              <option value="all">All groups</option>
            </select>
            <label class="zoom-control" title="Sprite size">
              <span aria-hidden="true">&#x1F50D;</span>
              <input id="recentZoomInput" type="range" min="110" max="320" step="10" aria-label="Sprite size">
            </label>
            <button class="secondary" id="recentRefreshButton" type="button">Refresh</button>
          </div>
          <div class="tree-browser" id="recentSpritesPanel">
            <div class="empty">Open this tab to load recently added sprites.</div>
          </div>
        </section>
        <section class="view-panel" id="devView" hidden>
          <div class="roster-head">
            <h2>Dev Lab</h2>
            <span class="subtle" id="devLabState">idle</span>
          </div>
          <div class="dev-lab-tools">
            <input id="devTaxonIdInput" inputmode="numeric" placeholder="iNaturalist taxon ID">
            <button class="secondary" id="devRandomButton" type="button" title="Pick a random taxon that has no sprite yet">&#127922; Random</button>
            <button class="secondary" id="devInspectButton" type="button">Inspect</button>
            <button class="secondary" id="devMovesButton" type="button">Generate Moves</button>
            <button class="secondary" id="devQueueSpriteButton" type="button">Queue Sprite</button>
            <button class="primary" id="devGenerateSpriteButton" type="button">Generate Sprite</button>
            <button class="secondary" id="devGenerateSvgButton" type="button">Dev SVG</button>
          </div>
          <div class="dev-lab-sync">
            <input id="devBatchIdInput" placeholder="Sprite batch ID">
            <button class="secondary" id="devSyncBatchButton" type="button">Sync Batch</button>
          </div>
          <div class="batch-list" id="devLabPanel">
            <div class="empty">Enter a taxon ID.</div>
          </div>
          <details class="dev-batch">
            <summary class="dev-batch-head">
              <h2>Dev Batch</h2>
              <span class="subtle" id="batchQueueCount">0 queued</span>
            </summary>
            <p class="dev-batch-hint">Sprite generation for <strong>your roster</strong>. Queue More adds jobs for your taxa that are missing sprites; Submit Batch sends up to 100 queued jobs to OpenAI as one half-price image batch. Species without battle moves get those generated first.</p>
            <button class="secondary" id="batchPreviewButton" type="button" disabled>Show Batch Queue</button>
            <button class="secondary" id="batchSubmitButton" type="button" disabled>Submit Batch</button>
            <div class="batch-list" id="batchQueueList">Load a roster, then click Queue More.</div>
          </details>
          <details class="dev-batch">
            <summary class="dev-batch-head">
              <h2>Global Seed</h2>
              <span class="subtle" id="seedQueueCount">0 queued</span>
            </summary>
            <p class="dev-batch-hint">Builds the <strong>shared sprite library</strong> everyone draws from: the most-observed plant and animal species across North America and Europe. Queue 200 grabs the next 200 species that still lack a sprite (ready sprites and in-flight jobs are skipped); Submit 200 sends them to OpenAI — moves first, then sprite images. Repeat Queue &rarr; Submit to work through the pool.</p>
            <button class="secondary" id="seedImportButton" type="button">Import Plants + Animals</button>
            <button class="secondary" id="seedQueueButton" type="button">Queue 200</button>
            <button class="secondary" id="seedSubmitButton" type="button" disabled>Submit 200</button>
            <div class="batch-list" id="seedQueueList">Load seed status to start.</div>
          </details>
        </section>
        <section class="view-panel" id="settingsView" hidden>
          <div class="roster-head">
            <h2>Settings</h2>
            <span class="subtle" id="settingsState"></span>
          </div>
          <div class="settings-section">
            <h3>Account</h3>
            <div class="account-block">
              <div class="stats">
                <div class="stat"><span class="subtle">Taxa</span><strong id="taxaCount">0</strong></div>
                <div class="stat"><span class="subtle">Sprites</span><strong id="spriteCount">0</strong></div>
                <div class="stat"><span class="subtle">Queued</span><strong id="queuedCount">0</strong></div>
                <div class="stat"><span class="subtle">Affinity</span><strong id="bondCount">0</strong></div>
              </div>
            </div>
            <div class="settings-actions">
              <button class="secondary" id="settingsReimportButton" type="button">Re-import roster</button>
              <button class="secondary" id="settingsSignOutButton" type="button">Sign out</button>
            </div>
          </div>
          <div class="settings-section">
            <h3>Preferences</h3>
            <label class="settings-toggle">
              <input type="checkbox" id="settingsSoundToggle">
              <span>Sound effects</span>
            </label>
          </div>
          <div class="settings-section">
            <h3>Sprites</h3>
            <details class="dev-batch">
              <summary class="dev-batch-head">
                <h2>Manual Sprite</h2>
                <span class="subtle" id="manualUploadState">idle</span>
              </summary>
              <form class="manual-upload" id="manualSpriteForm">
                <input id="manualTaxonId" name="taxonId" inputmode="numeric" placeholder="iNaturalist taxon ID">
                <input id="manualScientificName" name="scientificName" placeholder="Scientific name">
                <input id="manualCommonName" name="commonName" placeholder="Common name">
                <input id="manualSpriteFile" name="sprite" type="file" accept="image/png,image/jpeg,image/webp" required>
                <label class="manual-upload-check">
                  <input id="manualAddToRoster" name="addToRoster" type="checkbox" checked>
                  Add to roster
                </label>
                <button class="secondary" id="manualUploadButton" type="submit">Upload Sprite</button>
              </form>
              <div class="batch-list" id="manualUploadResult">No manual upload yet.</div>
            </details>
          </div>
        </section>
      </section>
    </section>
  </main>

  <nav class="mobile-nav" id="mobileNav" aria-label="Primary">
    <button class="mobile-nav-item" type="button" data-mobile-nav="home">
      <span class="mobile-nav-ico">🏠</span><span class="mobile-nav-label">Home</span>
    </button>
    <button class="mobile-nav-item" type="button" data-mobile-nav="roster">
      <span class="mobile-nav-ico">🗂️</span><span class="mobile-nav-label">Roster</span>
    </button>
    <button class="mobile-nav-item" type="button" data-mobile-nav="battle">
      <span class="mobile-nav-ico">⚔️</span><span class="mobile-nav-label">Battle</span>
    </button>
    <button class="mobile-nav-item" type="button" data-mobile-nav="buddies">
      <span class="mobile-nav-ico">🟢</span><span class="mobile-nav-label">Buddies</span>
    </button>
    <button class="mobile-nav-item" type="button" id="mobileMoreButton">
      <span class="mobile-nav-ico">☰</span><span class="mobile-nav-label">More</span>
    </button>
  </nav>

  <div class="mobile-sheet" id="mobileSheet" hidden>
    <div class="mobile-sheet-backdrop" data-mobile-sheet-close></div>
    <div class="mobile-sheet-panel" role="menu" aria-label="More views">
      <div class="mobile-sheet-handle" aria-hidden="true"></div>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="map" role="menuitem">🗺️ Territory Map</button>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="leaderboard" role="menuitem">🏆 Leaderboard</button>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="training" role="menuitem">📈 Training</button>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="tree" role="menuitem">🌳 Sprite Tree</button>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="recent" role="menuitem">✨ Recently Added</button>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="dev" role="menuitem">🛠️ Dev Lab</button>
      <button class="mobile-sheet-item" type="button" data-mobile-nav="settings" role="menuitem">⚙️ Settings</button>
    </div>
  </div>

  <script>
    const LAST_BATCH_STORAGE_KEY = "inatBattler:lastBatch";
    const ROSTER_PAGE_SIZE = 100;
    ${placeholderFor.toString()}
    const TYPE_CHART = ${JSON.stringify(TYPE_CHART)};
    const TERRAIN_MOVE_BONUS = ${JSON.stringify(TERRAIN_MOVE_BONUS)};

    function terrainBoostsMove(moveType, terrain) {
      if (!terrain || terrain === "neutral") return false;
      const boosted = TERRAIN_MOVE_BONUS[terrain];
      return Array.isArray(boosted) && boosted.indexOf(moveType) !== -1;
    }

    function typeMultiplierFor(moveType, defenderTypes) {
      return (defenderTypes || []).reduce(
        (multiplier, defenderType) => multiplier * (TYPE_CHART[moveType]?.[defenderType] ?? 1),
        1
      );
    }

    function stagedStatValue(base, stage) {
      const clamped = Math.max(-4, Math.min(4, Number(stage) || 0));
      if (clamped >= 0) return base * (1 + clamped * 0.25);
      return base / (1 + Math.abs(clamped) * 0.25);
    }

    // Mirrors game.js moveManaCost — keep the two formulas in sync.
    function moveManaCost(move) {
      if (!move || move.id === "struggle") return 0;
      if (move.category === "status") return 3;
      const base = Math.round((Number(move.power) || 0) / 10);
      let cost = Math.max(2, Math.min(6, base));
      if (move.effect && move.effect.kind === "multihit") cost += 1;
      return cost;
    }

    // Mirrors the server damage formula (game.js estimateDamage) at mid
    // variance so move buttons can show an honest "~N dmg" against the
    // current opponent, including stat stages, STAB, and fatigue.
    function estimateMoveDamage(battle, attacker, defender, move) {
      if (!move || move.category === "status" || !move.power) return null;
      const attackKey = move.category === "physical" ? "strike" : "sense";
      const atk = stagedStatValue(attacker.stats[attackKey], attacker.statStages && attacker.statStages[attackKey]);
      const guard = stagedStatValue(defender.stats.guard, defender.statStages && defender.statStages.guard);
      const def = move.category === "physical"
        ? guard
        : (guard + stagedStatValue(defender.stats.sense, defender.statStages && defender.statStages.sense)) / 2;
      const stab = (attacker.types || []).includes(move.type) ? 1.15 : 1;
      const typeMult = typeMultiplierFor(move.type, defender.types || []);
      const terrain = terrainBoostsMove(move.type, battle.terrain) ? 1.15 : 1;
      const bond = 1 + Math.min(0.08, (attacker.bondLevel || 0) * 0.002);
      const fatigue = 1 + Math.max(0, (battle.turn || 0) - 20) * 0.06;
      const base = move.power * (atk / Math.max(1, def)) * stab * typeMult * terrain * bond * 0.6 * 0.975 * fatigue;
      return Math.max(1, Math.floor(base));
    }

    function describeMoveEffect(move) {
      const parts = [];
      if ((move.priority || 0) > 0) parts.push("strikes first");
      const effect = move.effect;
      if (!effect) return parts;
      const statLabel = { vigor: "Vigor", strike: "Strike", guard: "Guard", tempo: "Tempo", sense: "Sense" };

      if (effect.kind === "buff") {
        parts.push("+" + (effect.amount || 1) + " " + (statLabel[effect.stat] || effect.stat) + " self");
      } else if (effect.kind === "debuff") {
        parts.push("-" + (effect.amount || 1) + " " + (statLabel[effect.stat] || effect.stat) + " foe");
      } else if (effect.kind === "heal") {
        parts.push("heal " + (effect.amountPct || 0) + "% HP");
      } else if (effect.kind === "status") {
        const verb = { stunned: "stun", marked: "mark", poisoned: "poison", shielded: "shield" }[effect.status] || effect.status;
        const target = effect.status === "shielded" ? "self" : "foe";
        const chance = effect.chance && effect.chance < 100 ? effect.chance + "% " : "";
        parts.push(chance + verb + " " + target);
      } else if (effect.kind === "drain") {
        parts.push("drain " + (effect.pct || 30) + "% of dmg");
      } else if (effect.kind === "recoil") {
        parts.push((effect.pct || 25) + "% recoil");
      } else if (effect.kind === "multihit") {
        parts.push("hits " + (effect.min || 2) + "-" + (effect.max || 3) + "x");
      }
      return parts;
    }
    const BATCH_POLL_MS = 60000;
    const DEV_QUEUE_MORE_LIMIT = 100;
    const DEV_BATCH_SUBMIT_LIMIT = 100;
    const GLOBAL_SEED_BATCH_LIMIT = 200;
    const BATCH_SYNC_ITEM_LIMIT = 25;
    const ACTIVE_BATCH_STATUSES = new Set(["submitted", "validating", "in_progress", "finalizing", "cancelling"]);

    const state = {
      userId: localStorage.getItem("inatBattler:userId") || "",
      inatLogin: localStorage.getItem("inatBattler:inatLogin") || "",
      activeView: "home",
      taxa: [],
      rosterSummary: null,
      rosterSearch: "",
      rosterSort: "default",
      rosterStatus: "all",
      rosterIconic: "",
      rosterPage: 1,
      rosterTotal: 0,
      rosterIconicCounts: [],
      rosterZoom: Number(localStorage.getItem("inatBattler:rosterZoom")) || 190,
      rosterMode: localStorage.getItem("inatBattler:rosterMode") === "sprites" ? "sprites" : "cards",
      spriteTree: null,
      treeSearch: "",
      treeZoom: Number(localStorage.getItem("inatBattler:treeZoom")) || 58,
      recentSprites: null,
      recentSearch: "",
      recentSort: "newest",
      recentGroup: "all",
      recentZoom: Number(localStorage.getItem("inatBattler:recentZoom")) || 150,
      expandedTreeNodes: new Set(),
      treePath: [],
      selectedTaxa: new Set(),
      flippedTaxa: new Set(),
      batchJobs: [],
      seedJobs: [],
      seedStatus: null,
      lastBatch: readStoredBatch(),
      batchPolling: null,
      batchSyncing: false,
      battle: null,
      battleAnimation: "anim-idle",
      battleBusy: false,
      battlePhase: "idle",
      soundOn: localStorage.getItem("inatBattler:sound") !== "off",
      backdropCache: null,
      lastResultBattle: null,
      polling: null,
      me: null,
      presence: {
        started: false,
        status: "idle",
        ws: null,
        reconnectTimer: null,
        decayTimer: null,
        renderTimer: null,
        settleAt: 0,
        backfillStarted: false,
        buddies: new Map()
      },
      challenges: [],
      challengeInfo: null,
      inatLinkPending: null,
      mySprites: [],
      training: null,
      trainingFilter: "",
      trainingSelected: null,
      trainingBusy: false,
      devLab: null,
      devBusy: false,
      devBatchId: "",
      devPreviewAnimation: "anim-idle",
      devPreviewKey: "row1",
      bskyBusy: false,
      bskyAction: "",
      bskyMessage: "",
      bskyMessageKind: "info"
    };

    const els = {
      form: document.getElementById("loginForm"),
      input: document.getElementById("inatLogin"),
      importButton: document.getElementById("importButton"),
      publicLanding: document.getElementById("publicLanding"),
      landingAuth: document.getElementById("landingAuth"),
      appLayout: document.getElementById("appLayout"),
      queueMoreButton: document.getElementById("queueMoreButton"),
      batchPreviewButton: document.getElementById("batchPreviewButton"),
      batchSubmitButton: document.getElementById("batchSubmitButton"),
      batchQueueCount: document.getElementById("batchQueueCount"),
      batchQueueList: document.getElementById("batchQueueList"),
      seedImportButton: document.getElementById("seedImportButton"),
      seedQueueButton: document.getElementById("seedQueueButton"),
      seedSubmitButton: document.getElementById("seedSubmitButton"),
      seedQueueCount: document.getElementById("seedQueueCount"),
      seedQueueList: document.getElementById("seedQueueList"),
      manualSpriteForm: document.getElementById("manualSpriteForm"),
      manualTaxonId: document.getElementById("manualTaxonId"),
      manualScientificName: document.getElementById("manualScientificName"),
      manualCommonName: document.getElementById("manualCommonName"),
      manualSpriteFile: document.getElementById("manualSpriteFile"),
      manualAddToRoster: document.getElementById("manualAddToRoster"),
      manualUploadButton: document.getElementById("manualUploadButton"),
      manualUploadState: document.getElementById("manualUploadState"),
      manualUploadResult: document.getElementById("manualUploadResult"),
      teamCount: document.getElementById("teamCount"),
      clearTeamButton: document.getElementById("clearTeamButton"),
      startBattleButton: document.getElementById("startBattleButton"),
      npcDifficultySelect: document.getElementById("npcDifficultySelect"),
      statusLine: document.getElementById("statusLine"),
      accountLabel: document.getElementById("accountLabel"),
      taxaCount: document.getElementById("taxaCount"),
      spriteCount: document.getElementById("spriteCount"),
      queuedCount: document.getElementById("queuedCount"),
      bondCount: document.getElementById("bondCount"),
      refreshLabel: document.getElementById("refreshLabel"),
      homeTabButton: document.getElementById("homeTabButton"),
      homeView: document.getElementById("homeView"),
      homeDashboard: document.getElementById("homeDashboard"),
      rosterTabButton: document.getElementById("rosterTabButton"),
      treeTabButton: document.getElementById("treeTabButton"),
      recentTabButton: document.getElementById("recentTabButton"),
      rosterView: document.getElementById("rosterView"),
      treeView: document.getElementById("treeView"),
      recentView: document.getElementById("recentView"),
      treeSearchInput: document.getElementById("treeSearchInput"),
      treeRefreshButton: document.getElementById("treeRefreshButton"),
      treeRefreshLabel: document.getElementById("treeRefreshLabel"),
      treeZoomInput: document.getElementById("treeZoomInput"),
      spriteTreePanel: document.getElementById("spriteTreePanel"),
      recentSearchInput: document.getElementById("recentSearchInput"),
      recentRefreshButton: document.getElementById("recentRefreshButton"),
      recentRefreshLabel: document.getElementById("recentRefreshLabel"),
      recentSortSelect: document.getElementById("recentSortSelect"),
      recentGroupFilter: document.getElementById("recentGroupFilter"),
      recentZoomInput: document.getElementById("recentZoomInput"),
      recentSpritesPanel: document.getElementById("recentSpritesPanel"),
      rosterGrid: document.getElementById("rosterGrid"),
      emptyState: document.getElementById("emptyState"),
      rosterSearchInput: document.getElementById("rosterSearchInput"),
      rosterSortSelect: document.getElementById("rosterSortSelect"),
      rosterStatusFilter: document.getElementById("rosterStatusFilter"),
      rosterZoomInput: document.getElementById("rosterZoomInput"),
      rosterModeButton: document.getElementById("rosterModeButton"),
      rosterTypeChips: document.getElementById("rosterTypeChips"),
      rosterPagination: document.getElementById("rosterPagination"),
      battlePanel: document.getElementById("battlePanel"),
      battleTabButton: document.getElementById("battleTabButton"),
      battleView: document.getElementById("battleView"),
      battleEmptyState: document.getElementById("battleEmptyState"),
      demoBattleButton: document.getElementById("demoBattleButton"),
      leaderboardTabButton: document.getElementById("leaderboardTabButton"),
      leaderboardView: document.getElementById("leaderboardView"),
      leaderboardPanel: document.getElementById("leaderboardPanel"),
      leaderboardMetaLabel: document.getElementById("leaderboardMetaLabel"),
      leaderboardModeToggle: document.getElementById("leaderboardModeToggle"),
      leaderboardRefreshButton: document.getElementById("leaderboardRefreshButton"),
      buddiesTabButton: document.getElementById("buddiesTabButton"),
      buddiesView: document.getElementById("buddiesView"),
      buddiesPanel: document.getElementById("buddiesPanel"),
      buddiesMetaLabel: document.getElementById("buddiesMetaLabel"),
      buddiesRefreshButton: document.getElementById("buddiesRefreshButton"),
      mapTabButton: document.getElementById("mapTabButton"),
      mapView: document.getElementById("mapView"),
      mapCanvas: document.getElementById("mapCanvas"),
      mapLegend: document.getElementById("mapLegend"),
      mapStatusLabel: document.getElementById("mapStatusLabel"),
      mapSyncButton: document.getElementById("mapSyncButton"),
      mapModeToggle: document.getElementById("mapModeToggle"),
      tilePanel: document.getElementById("tilePanel"),
      mobileNav: document.getElementById("mobileNav"),
      mobileMoreButton: document.getElementById("mobileMoreButton"),
      mobileSheet: document.getElementById("mobileSheet"),
      trainingTabButton: document.getElementById("trainingTabButton"),
      trainingView: document.getElementById("trainingView"),
      trainingTotalsLabel: document.getElementById("trainingTotalsLabel"),
      trainingFilterInput: document.getElementById("trainingFilterInput"),
      trainingSyncButton: document.getElementById("trainingSyncButton"),
      trainingEmptyState: document.getElementById("trainingEmptyState"),
      trainingMasteries: document.getElementById("trainingMasteries"),
      trainingMasteriesSummary: document.getElementById("trainingMasteriesSummary"),
      trainingMasteriesBody: document.getElementById("trainingMasteriesBody"),
      trainingSplit: document.getElementById("trainingSplit"),
      trainingList: document.getElementById("trainingList"),
      trainingDetail: document.getElementById("trainingDetail"),
      devTabButton: document.getElementById("devTabButton"),
      devView: document.getElementById("devView"),
      settingsTabButton: document.getElementById("settingsTabButton"),
      settingsView: document.getElementById("settingsView"),
      settingsReimportButton: document.getElementById("settingsReimportButton"),
      settingsSignOutButton: document.getElementById("settingsSignOutButton"),
      settingsSoundToggle: document.getElementById("settingsSoundToggle"),
      devLabState: document.getElementById("devLabState"),
      devTaxonIdInput: document.getElementById("devTaxonIdInput"),
      devRandomButton: document.getElementById("devRandomButton"),
      devInspectButton: document.getElementById("devInspectButton"),
      devMovesButton: document.getElementById("devMovesButton"),
      devQueueSpriteButton: document.getElementById("devQueueSpriteButton"),
      devGenerateSpriteButton: document.getElementById("devGenerateSpriteButton"),
      devGenerateSvgButton: document.getElementById("devGenerateSvgButton"),
      devBatchIdInput: document.getElementById("devBatchIdInput"),
      devSyncBatchButton: document.getElementById("devSyncBatchButton"),
      devLabPanel: document.getElementById("devLabPanel"),
      bskyStateLabel: document.getElementById("bskyStateLabel"),
      bskyBody: document.getElementById("bskyBody")
    };

    els.input.value = state.inatLogin;
    renderLanding();

    els.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // Always imports your OWN linked profile; the typed field is ignored (the
      // server derives the login from your verified session either way).
      await importRoster();
    });

    els.homeTabButton.addEventListener("click", () => switchView("home"));
    els.rosterTabButton.addEventListener("click", () => switchView("roster"));
    els.battleTabButton.addEventListener("click", () => switchView("battle"));
    els.leaderboardTabButton.addEventListener("click", () => switchView("leaderboard"));
    els.buddiesTabButton.addEventListener("click", () => switchView("buddies"));
    els.mapTabButton.addEventListener("click", () => switchView("map"));
    els.mapSyncButton.addEventListener("click", syncTerritory);
    els.mapModeToggle.addEventListener("click", (event) => {
      const button = event.target.closest("[data-map-mode]");
      if (button) setMapMode(button.getAttribute("data-map-mode"));
    });
    els.tilePanel.addEventListener("click", (event) => {
      if (event.target.closest("[data-tile-close]")) { closeTilePanel(); return; }
      const claim = event.target.closest("[data-tile-claim]");
      if (claim) { claimTile(claim.getAttribute("data-tile-claim")); return; }
      const garrison = event.target.closest("[data-tile-garrison]");
      if (garrison) { garrisonTile(garrison.getAttribute("data-tile-garrison")); return; }
      const contest = event.target.closest("[data-tile-contest]");
      if (contest) { contestTile(contest.getAttribute("data-tile-contest")); return; }
    });
    els.trainingTabButton.addEventListener("click", () => switchView("training"));
    els.buddiesRefreshButton.addEventListener("click", () => startPresence(true));
    els.buddiesPanel.addEventListener("click", onBuddiesPanelClick);

    function setMobileSheet(open) {
      els.mobileSheet.hidden = !open;
    }

    els.mobileMoreButton.addEventListener("click", () => {
      playSfx("click");
      setMobileSheet(els.mobileSheet.hidden);
    });

    els.mobileNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mobile-nav]");
      if (!button) return;
      switchView(button.getAttribute("data-mobile-nav"));
    });

    els.mobileSheet.addEventListener("click", (event) => {
      if (event.target.closest("[data-mobile-sheet-close]")) {
        setMobileSheet(false);
        return;
      }
      const button = event.target.closest("[data-mobile-nav]");
      if (!button) return;
      setMobileSheet(false);
      switchView(button.getAttribute("data-mobile-nav"));
    });
    els.treeTabButton.addEventListener("click", () => switchView("tree"));
    els.recentTabButton.addEventListener("click", () => switchView("recent"));
    els.devTabButton.addEventListener("click", () => switchView("dev"));
    els.settingsTabButton.addEventListener("click", () => switchView("settings"));
    els.settingsReimportButton.addEventListener("click", () => importRoster());
    els.settingsSignOutButton.addEventListener("click", () => bskyLogout());
    els.settingsSoundToggle.addEventListener("change", () => {
      state.soundOn = els.settingsSoundToggle.checked;
      localStorage.setItem("inatBattler:sound", state.soundOn ? "on" : "off");
      if (state.battle) renderBattle();
    });

    els.trainingSyncButton.addEventListener("click", syncTraining);

    els.trainingFilterInput.addEventListener("input", debounce(() => {
      state.trainingFilter = els.trainingFilterInput.value.trim().toLowerCase();
      renderTraining();
    }, 200));

    els.trainingSplit.addEventListener("click", async (event) => {
      const selectRow = event.target.closest("[data-train-select]");
      if (selectRow) {
        state.trainingSelected = selectRow.getAttribute("data-train-select");
        renderTraining();
        return;
      }

      const addButton = event.target.closest("[data-train-add]");
      if (addButton) {
        await allocateStat(
          addButton.getAttribute("data-train-taxon"),
          addButton.getAttribute("data-train-add"),
          Number(addButton.getAttribute("data-train-amount") || 1)
        );
        return;
      }

      const respecButton = event.target.closest("[data-train-respec]");
      if (respecButton) {
        await respecSpecies(respecButton.getAttribute("data-train-respec"));
        return;
      }

      const nickButton = event.target.closest("[data-train-nick]");
      if (nickButton) {
        await saveNickname(nickButton.getAttribute("data-train-nick"));
      }
    });

    els.trainingSplit.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || !event.target.hasAttribute("data-train-nick-input")) return;
      event.preventDefault();
      await saveNickname(event.target.getAttribute("data-train-nick-input"));
    });

    els.devInspectButton.addEventListener("click", () => inspectDevLab(true));
    els.devRandomButton.addEventListener("click", async () => {
      try {
        setStatus("Picking a random spriteless taxon…");
        const res = await apiFetch("/api/taxa/random-spriteless");
        els.devTaxonIdInput.value = String(res.taxonId);
        await inspectDevLab(true);
      } catch (error) {
        setStatus(error.message);
      }
    });
    els.devMovesButton.addEventListener("click", generateDevMoves);
    els.devQueueSpriteButton.addEventListener("click", queueDevSprite);
    els.devGenerateSpriteButton.addEventListener("click", generateDevSpriteBatch);
    els.devGenerateSvgButton.addEventListener("click", generateDevSvg);
    els.devSyncBatchButton.addEventListener("click", syncDevSpriteBatch);
    els.devTaxonIdInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      inspectDevLab(true);
    });
    els.devLabPanel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-dev-preview-anim]");
      if (!button) return;
      state.devPreviewAnimation = button.getAttribute("data-dev-preview-anim") || "anim-idle";
      state.devPreviewKey = button.getAttribute("data-dev-preview-key") || "row1";
      renderDevLab();
    });

    els.treeRefreshButton.addEventListener("click", async () => {
      state.treeSearch = els.treeSearchInput.value.trim();
      await loadSpriteTree(true);
    });

    els.treeSearchInput.addEventListener("input", debounce(async () => {
      if (state.activeView !== "tree") return;
      state.treeSearch = els.treeSearchInput.value.trim();
      await loadSpriteTree(false);
    }, 250));

    els.recentRefreshButton.addEventListener("click", async () => {
      state.recentSearch = els.recentSearchInput.value.trim();
      await loadRecentSprites(true);
    });

    els.recentSearchInput.addEventListener("input", debounce(async () => {
      if (state.activeView !== "recent") return;
      state.recentSearch = els.recentSearchInput.value.trim();
      await loadRecentSprites(false);
    }, 250));

    els.queueMoreButton.addEventListener("click", async () => {
      if (!state.userId) return;
      setBusy(true, "Queueing sprites");

      try {
        const res = await apiFetch("/api/sprite-jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: state.userId, limit: DEV_QUEUE_MORE_LIMIT })
        });

        setStatus(res.queued > 0
          ? "Queued " + res.queued + " sprite jobs"
          : "No new sprite jobs queued. Existing jobs may still be running, or today's queue cap may be reached.");
        await loadRoster();
        await loadBatchQueue();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    });

    els.batchPreviewButton.addEventListener("click", async () => {
      await loadBatchQueue(true);
    });

    els.batchSubmitButton.addEventListener("click", async () => {
      if (!state.userId || state.batchJobs.length === 0) return;
      setBusy(true, "Submitting OpenAI batch");

      try {
        const res = await apiFetch("/api/sprite-batches/dev-submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: state.userId,
            limit: Math.min(DEV_BATCH_SUBMIT_LIMIT, state.batchJobs.length),
            queueMissing: false
          })
        });

        state.lastBatch = res.submitted ? normalizeSubmittedBatch(res) : null;
        saveLastBatch();
        setStatus(res.submitted
          ? "Submitted batch " + res.batchId + " with " + res.itemCount + " sprites"
          : (res.message || "No queued sprite jobs available for batch submission"));
        if (res.submitted) scheduleBatchPolling(5000);
        await loadBatchQueue();
        await loadRoster();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    });

    els.seedImportButton.addEventListener("click", async () => {
      setBusy(true, "Importing plant and animal seed taxa");

      try {
        const res = await apiFetch("/api/global-seed/dev-import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limitPerGroup: 1000 })
        });

        state.seedStatus = res.status || null;
        setStatus("Imported " + Number(res.importedTaxa || 0) + " global seed taxa");
        await loadGlobalSeedQueue();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    });

    els.seedQueueButton.addEventListener("click", async () => {
      setBusy(true, "Queueing global seed sprites");

      try {
        const res = await apiFetch("/api/global-seed/dev-queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: GLOBAL_SEED_BATCH_LIMIT })
        });

        state.seedStatus = res.status || null;
        setStatus(res.queued > 0
          ? "Queued " + res.queued + " global seed sprite jobs"
          : "No new global seed jobs queued. Import seed taxa first, or wait for submitted batches to finish.");
        await loadGlobalSeedQueue();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    });

    els.seedSubmitButton.addEventListener("click", async () => {
      if (state.seedJobs.length === 0) return;
      setBusy(true, "Submitting global seed batch");

      try {
        const res = await apiFetch("/api/global-seed/dev-submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: Math.min(GLOBAL_SEED_BATCH_LIMIT, state.seedJobs.length) })
        });

        state.lastBatch = res.submitted ? normalizeSubmittedBatch(res) : null;
        saveLastBatch();
        setStatus(res.submitted
          ? "Submitted seed batch " + res.batchId + " with " + res.itemCount + " sprites"
          : (res.message || "No global seed jobs available for batch submission"));
        if (res.submitted) scheduleBatchPolling(5000);
        await loadGlobalSeedQueue();
        await loadBatchQueue();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    });

    els.manualSpriteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await uploadManualSprite();
    });

    els.clearTeamButton.addEventListener("click", () => {
      state.selectedTaxa.clear();
      render();
    });

    els.startBattleButton.addEventListener("click", startNpcBattle);
    els.demoBattleButton.addEventListener("click", startDemoBattle);

    els.leaderboardRefreshButton.addEventListener("click", () => loadLeaderboard(true));
    els.leaderboardModeToggle.addEventListener("click", (event) => {
      const button = event.target.closest("[data-lb-mode]");
      if (button) setLeaderboardMode(button.getAttribute("data-lb-mode"));
    });

    els.leaderboardPanel.addEventListener("click", async (event) => {
      const shareButton = event.target.closest("[data-share-rank]");
      if (!shareButton || shareButton.disabled) return;

      shareButton.disabled = true;
      shareButton.textContent = "Posting…";
      try {
        const res = await apiFetch("/api/share/rank", { method: "POST" });
        shareButton.textContent = "Posted ✓";
        setStatus("Rank posted to Bluesky");
        if (res.webUrl) window.open(res.webUrl, "_blank", "noopener");
      } catch (error) {
        shareButton.disabled = false;
        shareButton.textContent = "Post my rank to Bluesky 🦋";
        setStatus(error.message);
      }
    });

    els.homeDashboard.addEventListener("click", async (event) => {
      const addButton = event.target.closest("[data-home-add-taxon]");
      if (addButton) {
        toggleTeamSelection(addButton.getAttribute("data-home-add-taxon"));
        return;
      }

      const actionButton = event.target.closest("[data-home-action]");
      if (!actionButton) return;

      const action = actionButton.getAttribute("data-home-action");
      if (action === "roster") {
        await switchView("roster");
      } else if (action === "ready-roster") {
        state.rosterStatus = "ready";
        state.rosterPage = 1;
        els.rosterStatusFilter.value = "ready";
        await reloadRosterPage(true);
        await switchView("roster");
      } else if (action === "battle") {
        await switchView("battle");
      } else if (action === "training") {
        await switchView("training");
      } else if (action === "recent") {
        await switchView("recent");
      } else if (action === "dev") {
        await switchView("dev");
      } else if (action === "start-battle") {
        await startNpcBattle();
      }
    });

    els.spriteTreePanel.addEventListener("click", (event) => {
      const descend = event.target.closest("[data-tree-descend]");
      if (descend) {
        const key = descend.getAttribute("data-tree-descend");
        if (key) {
          state.treePath = [...state.treePath, key];
          renderSpriteTree();
        }
        return;
      }

      const crumb = event.target.closest("[data-tree-nav]");
      if (crumb) {
        const idx = Number(crumb.getAttribute("data-tree-nav"));
        if (Number.isFinite(idx)) {
          state.treePath = state.treePath.slice(0, idx + 1);
          renderSpriteTree();
        }
      }
    });

    els.battlePanel.addEventListener("click", async (event) => {
      const soundButton = event.target.closest("[data-sound-toggle]");
      if (soundButton) {
        state.soundOn = !state.soundOn;
        localStorage.setItem("inatBattler:sound", state.soundOn ? "on" : "off");
        playSfx("click");
        renderBattle();
        return;
      }

      const openSwapButton = event.target.closest("[data-open-swap]");
      if (openSwapButton) {
        state.swapOpen = true;
        playSfx("click");
        renderBattle();
        return;
      }

      const swapRow = event.target.closest("[data-swap-index]");
      if (swapRow) {
        if (state.battleBusy || state.battlePhase === "intro") return;
        state.swapOpen = false;
        await submitBattleMove(null, Number(swapRow.getAttribute("data-swap-index")));
        return;
      }

      if (event.target.closest("[data-swap-close]") || event.target.classList.contains("swap-modal")) {
        state.swapOpen = false;
        renderBattle();
        return;
      }

      const exitButton = event.target.closest("[data-battle-exit]");
      if (exitButton) {
        state.battle = null;
        state.battlePhase = "idle";
        state.swapOpen = false;
        document.body.classList.remove("battle-active");
        renderBattle();
        switchView("roster");
        return;
      }

      const leaderboardButton = event.target.closest("[data-open-leaderboard]");
      if (leaderboardButton) {
        await switchView("leaderboard");
        return;
      }

      const shareBattleButton = event.target.closest("[data-share-battle]");
      if (shareBattleButton) {
        if (shareBattleButton.disabled || !state.battle) return;
        shareBattleButton.disabled = true;
        shareBattleButton.textContent = "Posting…";
        try {
          const res = await apiFetch("/api/share/battle", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ battleId: state.battle.battleId })
          });
          shareBattleButton.textContent = "Posted ✓";
          setStatus("Victory posted to Bluesky");
          if (res.webUrl) window.open(res.webUrl, "_blank", "noopener");
        } catch (error) {
          shareBattleButton.disabled = false;
          shareBattleButton.textContent = "Brag on Bluesky 🦋";
          setStatus(error.message);
        }
        return;
      }

      const button = event.target.closest("[data-move-id]");
      if (!button || state.battleBusy || state.battlePhase === "intro") return;
      await submitBattleMove(button.getAttribute("data-move-id"));
    });

    els.rosterGrid.addEventListener("click", async (event) => {
      const spriteButton = event.target.closest("[data-sprite-shift]");
      if (spriteButton) {
        event.stopPropagation();
        await chooseSpriteVariant(
          spriteButton.getAttribute("data-taxon-id"),
          Number(spriteButton.getAttribute("data-sprite-shift") || 0)
        );
        return;
      }

      const detailsButton = event.target.closest("[data-card-details]");
      if (detailsButton) {
        event.stopPropagation();
        toggleCardFlip(detailsButton.getAttribute("data-taxon-id"));
        return;
      }

      const card = event.target.closest("[data-taxon-card]");
      if (!card) return;
      toggleTeamSelection(card.getAttribute("data-taxon-id"));
    });

    els.rosterGrid.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;

      const card = event.target.closest("[data-taxon-card]");
      if (!card) return;

      event.preventDefault();
      toggleTeamSelection(card.getAttribute("data-taxon-id"));
    });

    els.rosterSearchInput.addEventListener("input", debounce(() => {
      state.rosterSearch = els.rosterSearchInput.value.trim();
      reloadRosterPage(true);
    }, 300));

    els.rosterSortSelect.addEventListener("change", () => {
      state.rosterSort = els.rosterSortSelect.value;
      reloadRosterPage(true);
    });

    els.rosterStatusFilter.addEventListener("change", () => {
      state.rosterStatus = els.rosterStatusFilter.value;
      reloadRosterPage(true);
    });

    els.rosterPagination.addEventListener("click", (event) => {
      const button = event.target.closest("[data-roster-page]");
      if (!button || button.disabled) return;
      const direction = button.getAttribute("data-roster-page");
      const pageCount = Math.max(1, Math.ceil(state.rosterTotal / ROSTER_PAGE_SIZE));
      const nextPage = direction === "prev" ? state.rosterPage - 1 : state.rosterPage + 1;
      if (nextPage < 1 || nextPage > pageCount) return;
      state.rosterPage = nextPage;
      els.rosterView.scrollIntoView({ behavior: "smooth", block: "start" });
      reloadRosterPage(false);
    });

    els.rosterZoomInput.addEventListener("input", () => {
      state.rosterZoom = Number(els.rosterZoomInput.value) || 190;
      localStorage.setItem("inatBattler:rosterZoom", String(state.rosterZoom));
      els.rosterGrid.style.setProperty("--card-min", state.rosterZoom + "px");
    });

    els.rosterModeButton.addEventListener("click", () => {
      state.rosterMode = state.rosterMode === "sprites" ? "cards" : "sprites";
      localStorage.setItem("inatBattler:rosterMode", state.rosterMode);
      render();
    });

    els.rosterTypeChips.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-type-chip]");
      if (!chip) return;
      const type = chip.getAttribute("data-type-chip");
      state.rosterIconic = state.rosterIconic === type ? "" : type;
      reloadRosterPage(true);
    });

    els.treeZoomInput.addEventListener("input", () => {
      state.treeZoom = Number(els.treeZoomInput.value) || 58;
      localStorage.setItem("inatBattler:treeZoom", String(state.treeZoom));
      els.spriteTreePanel.style.setProperty("--leaf-size", state.treeZoom + "px");
    });

    els.recentSortSelect.addEventListener("change", () => {
      state.recentSort = els.recentSortSelect.value;
      renderRecentSprites();
    });

    els.recentGroupFilter.addEventListener("change", () => {
      state.recentGroup = els.recentGroupFilter.value;
      renderRecentSprites();
    });

    els.recentZoomInput.addEventListener("input", () => {
      state.recentZoom = Number(els.recentZoomInput.value) || 150;
      localStorage.setItem("inatBattler:recentZoom", String(state.recentZoom));
      els.recentSpritesPanel.style.setProperty("--tile-min", state.recentZoom + "px");
    });

    els.npcDifficultySelect.value = localStorage.getItem("inatBattler:npcDifficulty") || "normal";
    els.npcDifficultySelect.addEventListener("change", () => {
      localStorage.setItem("inatBattler:npcDifficulty", els.npcDifficultySelect.value);
    });

    els.rosterZoomInput.value = String(state.rosterZoom);
    els.rosterGrid.style.setProperty("--card-min", state.rosterZoom + "px");
    els.treeZoomInput.value = String(state.treeZoom);
    els.spriteTreePanel.style.setProperty("--leaf-size", state.treeZoom + "px");
    els.recentZoomInput.value = String(state.recentZoom);
    els.recentSpritesPanel.style.setProperty("--tile-min", state.recentZoom + "px");

    function handleBskyContainerClick(event) {
      const pick = event.target.closest("[data-typeahead-pick]");
      if (pick) {
        const input = document.getElementById(pick.getAttribute("data-input-id"));
        if (input) {
          input.value = pick.getAttribute("data-typeahead-pick");
          input.focus();
        }
        closeTypeaheadLists();
        return;
      }

      const button = event.target.closest("[data-bsky-action]");
      if (!button) return;
      const action = button.getAttribute("data-bsky-action");
      button.disabled = true;
      button.textContent = bskyBusyButtonText(action);
      handleBskyAction(action, button.getAttribute("data-challenge-id"));
    }

    function handleBskyContainerInput(event) {
      if (event.target.getAttribute && event.target.getAttribute("data-bsky-typeahead")) {
        handleTypeaheadInput(event.target);
      }
    }

    function handleBskyContainerKeydown(event) {
      if (event.target.tagName !== "INPUT") return;

      if (event.key === "Escape") {
        closeTypeaheadLists();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      closeTypeaheadLists();
      const action = event.target.getAttribute("data-bsky-enter");
      if (action) handleBskyAction(action, null);
    }

    els.bskyBody.addEventListener("click", handleBskyContainerClick);
    els.bskyBody.addEventListener("input", handleBskyContainerInput);
    els.bskyBody.addEventListener("keydown", handleBskyContainerKeydown);
    els.landingAuth.addEventListener("click", handleBskyContainerClick);
    els.landingAuth.addEventListener("input", handleBskyContainerInput);
    els.landingAuth.addEventListener("keydown", handleBskyContainerKeydown);
    els.homeDashboard.addEventListener("click", handleBskyContainerClick);
    els.homeDashboard.addEventListener("input", handleBskyContainerInput);
    els.homeDashboard.addEventListener("keydown", handleBskyContainerKeydown);

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".typeahead")) closeTypeaheadLists();
    });

    if (state.userId) {
      loadRoster();
    }

    renderBatchQueue();
    hydrateBatchTracker();
    hydrateGlobalSeedStatus();
    initBlueskySession();

    // iNaturalist v2 species_counts fields the roster/training ingest needs.
    // Mirrors the server INAT_SPECIES_COUNT_FIELDS.
    var INAT_SPECIES_COUNT_FIELDS_CLIENT = "count,taxon.id,taxon.name,taxon.preferred_common_name,taxon.english_common_name,taxon.rank,taxon.iconic_taxon_name,taxon.ancestry,taxon.parent_id,taxon.default_photo.medium_url,taxon.default_photo.square_url,taxon.default_photo.url";

    // Fetch a user's research-grade species counts in their OWN browser (iNat v2
    // sends CORS headers for GET), so the iNat rate limit lands on each user's IP
    // instead of the Worker's shared egress. MAX_PAGES mirrors the server
    // MAX_IMPORT_PAGES (20 in prod) — up to ~10k species; breaks early for most.
    async function inatBrowserFetchSpeciesCounts(login, onProgress) {
      const MAX_PAGES = 20;
      const rows = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        if (onProgress) onProgress(page);
        const params = new URLSearchParams({
          user_login: login,
          quality_grade: "research",
          per_page: "500",
          page: String(page),
          fields: INAT_SPECIES_COUNT_FIELDS_CLIENT,
          ttl: "21600"
        });
        const res = await fetch("https://api.inaturalist.org/v2/observations/species_counts?" + params.toString());
        if (!res.ok) throw new Error("iNaturalist returned " + res.status);
        const data = await res.json();
        const pageRows = (data && Array.isArray(data.results)) ? data.results : [];
        for (let i = 0; i < pageRows.length; i += 1) rows.push(pageRows[i]);
        if (pageRows.length < 500) break;
        await new Promise(function (resolve) { setTimeout(resolve, 700); });
      }
      return rows;
    }

    // Import is locked to the signed-in user's OWN linked iNaturalist account.
    async function importRoster() {
      const login = (state.me && state.me.inatLogin) || state.inatLogin;
      if (!login) {
        setStatus("Link your iNaturalist account first.");
        return;
      }
      setBusy(true, "Importing roster");

      try {
        state.selectedTaxa.clear();
        state.flippedTaxa.clear();
        state.rosterPage = 1;
        state.rosterSearch = "";
        state.rosterIconic = "";
        state.activeView = "home";
        els.rosterSearchInput.value = "";

        // Preferred: fetch your species in the browser; the Worker just persists
        // them. Falls back to the Worker fetch on any CORS/network/iNat hiccup.
        let speciesCounts = null;
        try {
          speciesCounts = await inatBrowserFetchSpeciesCounts(login, function (page) {
            setBusy(true, "Fetching your species from iNaturalist… (page " + page + ")");
          });
        } catch (browserErr) {
          speciesCounts = null;
        }

        const res = await apiFetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(speciesCounts ? { speciesCounts: speciesCounts } : {})
        });

        state.userId = res.userId;
        state.inatLogin = res.inatLogin;
        localStorage.setItem("inatBattler:userId", state.userId);
        localStorage.setItem("inatBattler:inatLogin", state.inatLogin);
        setStatus((res.warning ? res.warning + " " : "") + "Imported " + res.importedTaxa + " taxa, queued " + res.queuedSprites + " sprites");
        await loadRoster();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function initBlueskySession() {
      const params = new URLSearchParams(window.location.search);
      const authError = params.get("authError");
      if (authError) {
        setStatus("Bluesky sign-in failed: " + authError);
        window.history.replaceState({}, "", window.location.pathname);
      }

      const challengeId = params.get("challenge");
      if (challengeId) {
        try {
          state.challengeInfo = await apiFetch("/api/challenges/" + encodeURIComponent(challengeId));
        } catch (error) {
          setStatus(error.message);
        }
      }

      await refreshMe();
    }

    async function refreshMe() {
      try {
        state.me = await apiFetch("/api/me");
      } catch (error) {
        state.me = { loggedIn: false };
      }

      if (state.me.loggedIn) {
        try {
          const res = await apiFetch("/api/challenges");
          state.challenges = res.challenges || [];
        } catch (error) {
          state.challenges = [];
        }

        if (state.me.inatLogin) {
          await loadMySprites();
        }

        if (state.me.userId && state.me.userId !== state.userId) {
          state.userId = state.me.userId;
          state.inatLogin = state.me.inatLogin || "";
          localStorage.setItem("inatBattler:userId", state.userId);
          localStorage.setItem("inatBattler:inatLogin", state.inatLogin);
          els.input.value = state.inatLogin;
          try {
            await loadRoster();
          } catch (error) {
            setStatus(error.message);
          }
        }
      } else {
        state.challenges = [];
        state.training = null;
        if (state.activeView === "training") renderTraining();
      }

      renderBsky();
      renderLanding();
      renderHome();
    }

    function selectedTeamIds() {
      return Array.from(state.selectedTaxa).map(Number);
    }

    async function handleBskyAction(action, challengeId) {
      if (state.bskyBusy) return;
      state.bskyBusy = true;
      state.bskyAction = action || "";
      state.bskyMessage = bskyProgressMessage(action);
      state.bskyMessageKind = "info";
      els.bskyStateLabel.textContent = "working";
      if (action === "inat-confirm") renderBsky();

      try {
        if (action === "login") await bskyLogin();
        else if (action === "logout") await bskyLogout();
        else if (action === "inat-start") await inatLinkStart();
        else if (action === "inat-confirm") await inatLinkConfirm();
        else if (action === "challenge-send") await sendChallenge();
        else if (action === "challenge-accept") await acceptChallengeAction(challengeId);
        else if (action === "challenge-decline") await declineChallengeAction(challengeId);
        else if (action === "battle-open") await openBattle(challengeId);
        else if (action === "sprite-upload") await uploadCustomSprite();
        else if (action === "sprites-sync") await syncMySprites();
      } catch (error) {
        state.bskyMessage = error.message;
        state.bskyMessageKind = "error";
        setStatus(error.message);
      } finally {
        state.bskyBusy = false;
        state.bskyAction = "";
        renderBsky();
        renderLanding();
        renderHome();
      }
    }

    function bskyProgressMessage(action) {
      if (action === "inat-confirm") return "Checking your iNaturalist profile for the verification code.";
      if (action === "inat-start") return "Creating a new iNaturalist verification code.";
      if (action === "login") return "Contacting your Bluesky host.";
      if (action === "challenge-send") return "Creating and posting the Bluesky challenge.";
      if (action === "challenge-accept") return "Accepting the challenge and opening battle.";
      if (action === "challenge-decline") return "Declining the challenge.";
      if (action === "sprite-upload") return "Submitting your custom sprite for Discord QA.";
      if (action === "sprites-sync") return "Checking Discord QA reactions.";
      return "Working.";
    }

    function bskyBusyButtonText(action) {
      if (action === "inat-confirm") return "Verifying...";
      if (action === "inat-start") return "Creating code...";
      if (action === "login") return "Signing in...";
      if (action === "challenge-send") return "Sending...";
      if (action === "challenge-accept") return "Accepting...";
      if (action === "challenge-decline") return "Declining...";
      if (action === "sprite-upload") return "Submitting...";
      if (action === "sprites-sync") return "Refreshing...";
      return "Working...";
    }

    async function bskyLogin() {
      const inputs = Array.from(document.querySelectorAll("[data-bsky-login-input]"));
      const input = inputs.find((candidate) => candidate.offsetParent !== null) || inputs[0] || null;
      const handle = input ? input.value.trim() : "";
      if (!handle) {
        setStatus("Enter your Bluesky handle (like name.bsky.social).");
        return;
      }

      setStatus("Contacting your Bluesky host…");
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: handle, returnTo: window.location.pathname + window.location.search })
      });
      window.location.href = res.authorizeUrl;
    }

    async function bskyLogout() {
      await apiFetch("/api/auth/logout", { method: "POST" });
      state.me = { loggedIn: false };
      state.challenges = [];
      stopPresence();
      state.presence.buddies = new Map();
      if (state.activeView === "buddies") {
        els.buddiesPanel.innerHTML = '<p class="subtle">Sign in with Bluesky to see which of your mutuals are online.</p>';
        els.buddiesMetaLabel.textContent = "";
      }
      setStatus("Signed out of Bluesky.");
    }

    async function inatLinkStart() {
      const inputs = Array.from(document.querySelectorAll("[data-inat-link-input]"));
      const activeInput = document.activeElement && document.activeElement.matches?.("[data-inat-link-input]")
        ? document.activeElement
        : null;
      const input = (activeInput && activeInput.value.trim() ? activeInput : null) ||
        inputs.find((candidate) => candidate.offsetParent !== null && candidate.value.trim()) ||
        inputs.find((candidate) => candidate.offsetParent !== null) ||
        inputs[0] ||
        null;
      const login = input ? input.value.trim() : "";
      if (!login) {
        setStatus("Enter your iNaturalist username first.");
        return;
      }

      await apiFetch("/api/inat/link/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inatLogin: login })
      });
      state.bskyMessage = "Verification code created. Add it to your iNaturalist bio, save, then click Verify Link.";
      state.bskyMessageKind = "success";
      setStatus("Code created. Add it to your iNaturalist profile bio, save, then click Verify.");
      await refreshMe();
    }

    async function inatLinkConfirm() {
      setStatus("Checking your iNaturalist profile…");
      const res = await apiFetch("/api/inat/link/confirm", { method: "POST" });
      const importText = res.importStarted
        ? " Roster import is running in the background."
        : " Imported " + Number(res.importedTaxa || 0) + " taxa.";
      const message = "Linked iNaturalist account " + res.inatLogin + "." + importText + " You can remove the code from your bio now.";
      state.bskyMessage = message;
      state.bskyMessageKind = "success";
      state.me = {
        ...(state.me || {}),
        loggedIn: true,
        inatLogin: res.inatLogin,
        inatPendingLogin: null,
        inatVerificationCode: null,
        userId: res.userId || ("inat:" + String(res.inatLogin || "").toLowerCase())
      };
      state.userId = state.me.userId || state.userId;
      state.inatLogin = res.inatLogin || state.inatLogin;
      if (state.userId) localStorage.setItem("inatBattler:userId", state.userId);
      if (state.inatLogin) {
        localStorage.setItem("inatBattler:inatLogin", state.inatLogin);
        els.input.value = state.inatLogin;
      }
      renderBsky();
      setStatus(message);
      await refreshMe();
      if (res.importStarted) {
        window.setTimeout(() => {
          loadRoster().catch((error) => setStatus(error.message));
        }, 8000);
      }
    }

    async function sendChallenge() {
      const team = selectedTeamIds();
      if (team.length !== 5) {
        setStatus("Select exactly 5 ready sprites for your challenge team first.");
        return;
      }

      const handleInput = document.getElementById("challengeHandleInput");
      const messageInput = document.getElementById("challengeMessageInput");
      const opponentHandle = handleInput ? handleInput.value.trim() : "";
      if (!opponentHandle) {
        setStatus("Enter the opponent's Bluesky handle.");
        return;
      }

      setStatus("Creating challenge and posting to Bluesky…");
      const res = await apiFetch("/api/challenges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opponentHandle: opponentHandle,
          message: messageInput ? messageInput.value : "",
          taxonIds: team
        })
      });

      if (res.postError) {
        setStatus("Challenge saved, but the Bluesky post failed: " + res.postError);
      } else {
        setStatus("Challenge sent! Posted to Bluesky for @" + res.opponentHandle + ".");
      }
      await refreshMe();
    }

    async function acceptChallengeAction(challengeId) {
      if (!challengeId) return;
      const team = selectedTeamIds();
      if (team.length !== 5) {
        setStatus("Select exactly 5 ready sprites from your roster, then accept.");
        return;
      }

      const battle = await apiFetch("/api/challenges/" + encodeURIComponent(challengeId) + "/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taxonIds: team })
      });

      if (state.challengeInfo && state.challengeInfo.challengeId === challengeId) {
        state.challengeInfo = null;
      }
      setStatus("Challenge accepted. Battle on!");
      enterBattle(battle);
      await refreshMe();
    }

    async function declineChallengeAction(challengeId) {
      if (!challengeId) return;
      await apiFetch("/api/challenges/" + encodeURIComponent(challengeId) + "/decline", { method: "POST" });
      if (state.challengeInfo && state.challengeInfo.challengeId === challengeId) {
        state.challengeInfo = null;
      }
      setStatus("Challenge declined.");
      await refreshMe();
    }

    async function openBattle(battleId) {
      if (!battleId) return;
      const battle = await apiFetch("/api/battles/" + encodeURIComponent(battleId));
      enterBattle(battle, { skipIntro: true });
    }

    async function loadMySprites() {
      try {
        const res = await apiFetch("/api/my-sprites");
        state.mySprites = res.submissions || [];
      } catch (error) {
        state.mySprites = [];
      }
    }

    async function uploadCustomSprite() {
      const input = document.getElementById("customSpriteFile");
      const file = input && input.files && input.files[0];
      const taxonInput = document.getElementById("customSpriteTaxonId");
      const manualTaxonInput = document.getElementById("manualTaxonId");
      const typedTaxonId = taxonInput ? taxonInput.value.trim() : "";
      const fallbackTaxonId = !typedTaxonId && manualTaxonInput ? manualTaxonInput.value.trim() : "";
      const rawTaxonId = typedTaxonId || fallbackTaxonId;
      if (!file) {
        throw new Error("Choose an image file first (PNG, JPEG, or WebP 4x4 sprite sheet).");
      }
      if (!rawTaxonId && state.selectedTaxa.size !== 1) {
        throw new Error("Enter an iNaturalist taxon ID in the Custom sprites field, or select one ready creature card.");
      }

      const typedTaxonMatch = rawTaxonId.match(/[0-9]+/);
      const taxonId = typedTaxonMatch ? typedTaxonMatch[0] : Array.from(state.selectedTaxa)[0];
      if (!taxonId || !/^[0-9]+$/.test(String(taxonId))) {
        throw new Error('Could not read a numeric iNaturalist taxon ID from "' + rawTaxonId + '".');
      }

      const form = new FormData();
      form.append("sprite", file);
      form.append("taxonId", String(taxonId));

      setStatus("Uploading custom sprite…");
      const res = await apiFetch("/api/my-sprites/upload", { method: "POST", body: form });
      const movesNote = res.moves?.generated
        ? " New image-matched moves: " + (res.moves.signatureMoves || []).join(", ") + "."
        : res.moves?.skipped
          ? ""
          : res.moves?.error
            ? " (Move generation failed: " + res.moves.error + ")"
            : "";
      const message = res.discordError
        ? "Sprite saved and live for you, but the Discord QA post failed: " + res.discordError + " (it will retry automatically)" + movesNote
        : "Custom sprite for " + res.name + " submitted for QA. It's live for you now; opponents see it once approved on Discord." + movesNote;
      if (res.discordError) {
        state.bskyMessageKind = "error";
      } else {
        state.bskyMessageKind = "success";
      }
      state.bskyMessage = message;
      setStatus(message);
      await loadMySprites();
      await loadRoster();
    }

    async function syncMySprites() {
      setStatus("Checking Discord QA reactions…");
      const res = await apiFetch("/api/sprite-submissions/sync", { method: "POST" });
      await loadMySprites();
      await loadRoster();
      setStatus("QA refresh: " + Number(res.approved || 0) + " approved, " + Number(res.rejected || 0) + " rejected, " + Number(res.checked || 0) + " checked.");
    }

    function renderMySpriteItem(item) {
      const badge = item.status === "approved" ? "✅" : item.status === "rejected" ? "❌" : "🕒";
      return '<div class="challenge-item">' +
        '<div>' + badge + ' <strong>' + escapeHtml(item.name) + '</strong> &mdash; ' + escapeHtml(item.status) +
        (item.discordError ? ' <span class="subtle">(Discord: ' + escapeHtml(item.discordError) + ')</span>' : '') +
        '</div>' +
      '</div>';
    }

    function renderCustomSpritePanel(busyAttr) {
      const list = state.mySprites.length
        ? state.mySprites.map(renderMySpriteItem).join("")
        : '<div class="challenge-item"><div class="subtle">No custom sprite submissions yet.</div></div>';

      return '<div class="bsky-section">' +
        '<div class="bsky-row">' +
          '<strong>Custom sprites</strong>' +
          '<button class="secondary" type="button" data-bsky-action="sprites-sync"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "sprites-sync" ? "Refreshing..." : "Refresh QA") +
          '</button>' +
        '</div>' +
        '<input id="customSpriteTaxonId" inputmode="numeric" placeholder="QA taxon ID, e.g. 145436">' +
        '<input id="customSpriteFile" type="file" accept="image/png,image/jpeg,image/webp">' +
        '<button class="primary" type="button" data-bsky-action="sprite-upload"' + busyAttr + '>' +
          (state.bskyBusy && state.bskyAction === "sprite-upload" ? "Submitting..." : "Submit for QA") +
        '</button>' +
        '<div class="batch-list">' + list + '</div>' +
      '</div>';
    }

    const TRAIN_STATS = ["vigor", "strike", "guard", "tempo", "sense"];

    async function loadTraining() {
      if (!state.me || !state.me.loggedIn || !state.me.inatLogin) {
        state.training = null;
        renderTraining();
        return;
      }

      try {
        state.training = await apiFetch("/api/training");
      } catch (error) {
        setStatus(error.message);
        state.training = null;
      }
      renderTraining();
    }

    async function syncTraining() {
      if (!state.me || !state.me.loggedIn || !state.me.inatLogin) {
        setStatus("Sign in with Bluesky and link your iNaturalist account first.");
        return;
      }
      if (state.trainingBusy) return;

      state.trainingBusy = true;
      els.trainingSyncButton.disabled = true;
      setStatus("Syncing iNaturalist training data...");

      try {
        // Fetch your RG species counts in your browser (per-user rate limit),
        // then hand them to the Worker; fall back to the Worker fetch on error.
        let speciesCounts = null;
        try {
          speciesCounts = await inatBrowserFetchSpeciesCounts(state.me.inatLogin, function (page) {
            setStatus("Fetching your Research Grade species from iNaturalist… (page " + page + ")");
          });
        } catch (browserErr) {
          speciesCounts = null;
        }
        const res = await apiFetch("/api/training/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(speciesCounts ? { speciesCounts: speciesCounts } : {})
        });
        let message = "Synced: " + Number(res.rgSpeciesUpdated || 0) + " RG species, " +
          Number(res.taxaResolved || 0) + " taxa classified, " +
          Number(res.masteriesUpdated || 0) + " masteries updated.";
        if (res.provisionalSpeciesUpdated > 0) {
          message += " " + Number(res.provisionalSpeciesUpdated || 0) + " species using roster-count fallback.";
        }
        const rateLimited = /429|rate.?limit/i.test(String(res.warning || ""));
        if (res.unresolvedTaxa > 0) {
          message += " " + res.unresolvedTaxa + " taxa pending" +
            (rateLimited ? " - wait a minute before retrying." : " - sync again to continue.");
        }
        if (res.warning) message += " (" + res.warning + ")";
        setStatus(message);
        await loadTraining();
        state.rosterStale = true;
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.trainingBusy = false;
        els.trainingSyncButton.disabled = false;
      }
    }

    function replaceTrainingEntry(entry) {
      if (!state.training) return;
      const index = state.training.species.findIndex((candidate) => candidate.taxonId === entry.taxonId);
      if (index >= 0) state.training.species[index] = entry;

      const totals = { earned: 0, spent: 0, available: 0 };
      for (const species of state.training.species) {
        totals.earned += species.earned.total;
        totals.spent += species.spent;
        totals.available += species.available;
      }
      state.training.totals = totals;
    }

    async function allocateStat(taxonId, stat, amount) {
      if (state.trainingBusy) return;
      state.trainingBusy = true;

      try {
        const allocations = {};
        allocations[stat] = amount;
        const entry = await apiFetch("/api/training/allocate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxonId: taxonId, allocations: allocations })
        });
        replaceTrainingEntry(entry);
        state.rosterStale = true;
        renderTraining();
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.trainingBusy = false;
      }
    }

    async function respecSpecies(taxonId) {
      if (state.trainingBusy) return;
      state.trainingBusy = true;

      try {
        const entry = await apiFetch("/api/training/respec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxonId: taxonId })
        });
        replaceTrainingEntry(entry);
        state.rosterStale = true;
        renderTraining();
        setStatus("Points refunded. Next free respec for this species in one week.");
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.trainingBusy = false;
      }
    }

    async function saveNickname(taxonId) {
      const input = document.getElementById("trainNick-" + taxonId);
      if (!input) return;

      try {
        const res = await apiFetch("/api/training/nickname", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxonId: taxonId, nickname: input.value })
        });
        const entry = state.training && state.training.species.find((candidate) => String(candidate.taxonId) === String(taxonId));
        if (entry) entry.nickname = res.nickname;
        state.rosterStale = true;
        renderTraining();
        setStatus(res.nickname ? "Nickname saved: " + res.nickname : "Nickname cleared.");
      } catch (error) {
        setStatus(error.message);
      }
    }

    function renderMasteryCard(mastery) {
      const kindLabel = mastery.kind === "genus" ? "Genus" : "Family";
      const progress = mastery.total
        ? mastery.observed + " / " + mastery.total + " species"
        : mastery.observed + " observed species";
      const buffPct = Math.round((mastery.buffPct || 0) * 100);
      const extras = [];
      if (mastery.next) extras.push("next: " + mastery.next.tier + " at " + mastery.next.threshold);
      else if (mastery.tier === "gold" && mastery.total) extras.push("complete at " + mastery.total);
      if (buffPct > 0) extras.push("+" + buffPct + "% stats");

      return '<div class="mastery-card">' +
        '<div><span class="tier-chip tier-' + escapeAttr(mastery.tier) + '">' + escapeHtml(mastery.tier) + '</span> ' +
          '<strong>' + escapeHtml(mastery.name || kindLabel + " " + mastery.groupId) + '</strong> ' +
          '<span class="subtle">' + kindLabel + '</span></div>' +
        '<div class="subtle">' + escapeHtml(progress + (extras.length ? " · " + extras.join(" · ") : "")) + '</div>' +
      '</div>';
    }

    function renderTrainStatRow(entry, stat) {
      const data = entry.stats[stat];
      const baseWidth = Math.max(2, Math.min(100, data.base));
      const totalWidth = Math.max(baseWidth, Math.min(100, data.total));
      const capReached = data.allocated >= data.cap;
      const noPoints = entry.available <= 0;
      const label = stat.charAt(0).toUpperCase() + stat.slice(1);

      return '<div class="train-stat">' +
        '<span>' + escapeHtml(label) + '</span>' +
        '<div class="stat-track">' +
          '<span class="stat-alloc" style="width:' + totalWidth + '%"></span>' +
          '<span class="stat-base" style="width:' + baseWidth + '%"></span>' +
        '</div>' +
        '<span class="subtle">' + data.total + ' (+' + data.allocated + '/' + data.cap + ')</span>' +
        '<span>' +
          '<button class="train-add" type="button" data-train-add="' + escapeAttr(stat) + '" data-train-taxon="' + escapeAttr(String(entry.taxonId)) + '" data-train-amount="1" ' + (capReached || noPoints ? "disabled" : "") + '>+1</button> ' +
          '<button class="train-add" type="button" data-train-add="' + escapeAttr(stat) + '" data-train-taxon="' + escapeAttr(String(entry.taxonId)) + '" data-train-amount="5" ' + (data.allocated + 5 > data.cap || entry.available < 5 ? "disabled" : "") + '>+5</button>' +
        '</span>' +
      '</div>';
    }

    function renderTrainRow(entry) {
      const provisional = entry.countSource === "roster_fallback";
      const countLabel = provisional ? "provisional obs" : "RG";
      const ledger = "Earned " + entry.earned.total + " pts = " +
        entry.earned.base + " " + countLabel + " (sqrt of " + entry.rgObsCount + " obs) + " +
        entry.earned.firstBonus + " first + " +
        entry.earned.genusSpill + " genus + " +
        entry.earned.familySpill + " family + " +
        (entry.earned.genusBonus + entry.earned.familyBonus) + " mastery";
      const groupChips =
        (entry.genus && entry.genus.tier !== "none" ? ' <span class="tier-chip tier-' + escapeAttr(entry.genus.tier) + '">' + escapeHtml(entry.genus.name || "genus") + '</span>' : "") +
        (entry.family && entry.family.tier !== "none" ? ' <span class="tier-chip tier-' + escapeAttr(entry.family.tier) + '">' + escapeHtml(entry.family.name || "family") + '</span>' : "");
      const buffPct = Math.round((entry.buffPct || 0) * 100);
      const respecLabel = entry.canRespec
        ? "Respec"
        : entry.spent > 0 && entry.respecAvailableAt
          ? "Respec " + entry.respecAvailableAt.slice(0, 10)
          : "Respec";

      return '<div class="train-row">' +
        '<div class="train-head">' +
          '<strong>' + escapeHtml(entry.nickname || entry.name) + '</strong>' +
          (entry.nickname ? '<span class="subtle">' + escapeHtml(entry.name) + '</span>' : "") +
          '<span class="subtle">' + escapeHtml(entry.scientificName) + '</span>' +
          (entry.level > 0 ? '<span class="lv-chip">Lv ' + entry.level + '</span>' : "") +
          '<span class="chip">' + entry.available + ' pts</span>' +
          '<span class="chip">' + entry.rgObsCount + ' ' + escapeHtml(countLabel) + '</span>' +
          (buffPct > 0 ? '<span class="chip">+' + buffPct + '% mastery</span>' : "") +
          groupChips +
        '</div>' +
        '<div class="train-ledger">' + escapeHtml(ledger) + '</div>' +
        '<div class="train-stats">' + TRAIN_STATS.map((stat) => renderTrainStatRow(entry, stat)).join("") + '</div>' +
        '<div class="train-tools">' +
          '<input id="trainNick-' + escapeAttr(String(entry.taxonId)) + '" data-train-nick-input="' + escapeAttr(String(entry.taxonId)) + '" placeholder="Nickname (yours only)" maxlength="24" value="' + escapeAttr(entry.nickname || "") + '">' +
          '<button class="secondary" type="button" data-train-nick="' + escapeAttr(String(entry.taxonId)) + '">Save Name</button>' +
          '<button class="secondary" type="button" data-train-respec="' + escapeAttr(String(entry.taxonId)) + '" ' + (entry.canRespec ? "" : "disabled") + '>' + escapeHtml(respecLabel) + '</button>' +
        '</div>' +
      '</div>';
    }

    function renderTraining() {
      const training = state.training;
      const linked = state.me && state.me.loggedIn && state.me.inatLogin;

      els.trainingEmptyState.hidden = Boolean(training);
      els.trainingMasteries.hidden = !training;
      els.trainingSplit.hidden = !training;

      if (!training) {
        els.trainingTotalsLabel.textContent = "";
        els.trainingEmptyState.textContent = linked
          ? "Press Sync iNat Data to pull your iNaturalist observations and start earning points."
          : "To train creatures: sign in with Bluesky (sidebar), link your iNaturalist account, then press Sync iNat Data. Research Grade observations earn training points.";
        return;
      }

      els.trainingEmptyState.textContent = "";
      els.trainingTotalsLabel.textContent =
        training.totals.available + " pts available · " +
        training.totals.spent + " spent · " +
        training.totals.earned + " earned";

      els.trainingMasteriesSummary.textContent = training.masteries.length
        ? "Masteries (" + training.masteries.length + ")"
        : "Masteries";
      els.trainingMasteriesBody.innerHTML = training.masteries.length
        ? '<div class="mastery-grid">' + training.masteries.map(renderMasteryCard).join("") + '</div>'
        : '<div class="subtle" style="margin-top:10px">No genus or family progress yet. Observe more species, then sync.</div>';

      const filter = state.trainingFilter;
      const visible = filter
        ? training.species.filter((entry) => (
            (entry.name || "").toLowerCase().includes(filter) ||
            (entry.scientificName || "").toLowerCase().includes(filter) ||
            (entry.nickname || "").toLowerCase().includes(filter)
          ))
        : training.species;

      const selected = visible.find((entry) => String(entry.taxonId) === String(state.trainingSelected))
        || visible[0]
        || null;
      if (selected) state.trainingSelected = String(selected.taxonId);

      els.trainingList.innerHTML = visible.length
        ? visible.map((entry) => renderTrainingListRow(entry, selected)).join("")
        : '<div class="subtle" style="padding:10px">No species match the filter.</div>';

      els.trainingDetail.innerHTML = selected
        ? renderTrainRow(selected)
        : '<div class="empty">Select a species on the left to allocate training points.</div>';
    }

    function renderTrainingListRow(entry, selected) {
      const isActive = selected && String(entry.taxonId) === String(selected.taxonId);
      const sprite = entry.spriteUrl
        ? renderSheetSprite(entry.spriteUrl, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(entry.iconicTaxonName)) + '"></div>';

      return '<button type="button" class="training-roster-row' + (isActive ? " active" : "") +
        '" data-train-select="' + escapeAttr(String(entry.taxonId)) + '" role="option" aria-selected="' + String(Boolean(isActive)) + '">' +
        '<span class="training-roster-sprite">' + sprite + '</span>' +
        '<span class="training-roster-copy">' +
          '<strong>' + escapeHtml(entry.nickname || entry.name) + '</strong>' +
          '<span class="subtle"><em>' + escapeHtml(entry.scientificName || "") + '</em></span>' +
        '</span>' +
        '<span class="training-roster-pts">' +
          (entry.level > 0 ? '<span>Lv ' + Number(entry.level) + '</span>' : '') +
          (entry.available > 0 ? '<span class="pts">' + Number(entry.available) + ' pts</span>' : '') +
        '</span>' +
      '</button>';
    }

    function renderChallengeBanner() {
      const info = state.challengeInfo;
      if (!info) return "";

      const me = state.me;
      const body = '<div><strong>@' + escapeHtml(info.challengerHandle) + '</strong> challenged <strong>@' +
        escapeHtml(info.opponentHandle) + '</strong>' +
        (info.message ? ': "' + escapeHtml(info.message) + '"' : " to an iNat Battle!") + '</div>';

      if (info.status !== "pending") {
        return '<div class="challenge-banner">' + body + '<div class="subtle">This challenge is ' + escapeHtml(info.status) + '.</div></div>';
      }
      if (!me || !me.loggedIn) {
        return '<div class="challenge-banner">' + body + '<div class="subtle">Sign in with Bluesky as @' + escapeHtml(info.opponentHandle) + ' to battle.</div></div>';
      }
      if (me.did !== info.opponentDid) {
        return '<div class="challenge-banner">' + body + '<div class="subtle">This challenge was sent to @' + escapeHtml(info.opponentHandle) + ', not your account.</div></div>';
      }

      const hint = me.inatLogin
        ? "Select 5 ready sprites from your roster, then accept."
        : "Link your iNaturalist account below, import your roster, select 5 sprites, then accept.";
      return '<div class="challenge-banner">' + body +
        '<div class="subtle">' + hint + '</div>' +
        '<div class="challenge-actions">' +
          '<button class="primary" type="button" data-bsky-action="challenge-accept" data-challenge-id="' + escapeAttr(info.challengeId) + '">Accept &amp; Battle</button>' +
          '<button class="secondary" type="button" data-bsky-action="challenge-decline" data-challenge-id="' + escapeAttr(info.challengeId) + '">Decline</button>' +
        '</div></div>';
    }

    function renderChallengeItem(challenge) {
      const isIncoming = challenge.direction === "incoming";
      const other = isIncoming ? challenge.challengerHandle : challenge.opponentHandle;
      let actions = "";

      if (isIncoming && challenge.status === "pending") {
        actions = '<div class="challenge-actions">' +
          '<button class="secondary" type="button" data-bsky-action="challenge-accept" data-challenge-id="' + escapeAttr(challenge.challengeId) + '">Accept</button>' +
          '<button class="secondary" type="button" data-bsky-action="challenge-decline" data-challenge-id="' + escapeAttr(challenge.challengeId) + '">Decline</button>' +
        '</div>';
      } else if (challenge.battleId && challenge.status === "accepted") {
        actions = '<div class="challenge-actions">' +
          '<button class="secondary" type="button" data-bsky-action="battle-open" data-challenge-id="' + escapeAttr(challenge.battleId) + '">Open Battle</button>' +
        '</div>';
      }

      return '<div class="challenge-item">' +
        '<div>' + (isIncoming ? "From" : "To") + ' <strong>@' + escapeHtml(other) + '</strong> &mdash; ' + escapeHtml(challenge.status) + '</div>' +
        actions +
      '</div>';
    }

    function renderTypeaheadInput(inputId, placeholder, enterAction) {
      const loginAttr = enterAction === "login" ? ' data-bsky-login-input="1"' : "";
      return '<div class="typeahead">' +
        '<input id="' + escapeAttr(inputId) + '" data-bsky-enter="' + escapeAttr(enterAction) + '" data-bsky-typeahead="1"' + loginAttr +
          ' placeholder="' + escapeAttr(placeholder) + '" autocomplete="off" spellcheck="false">' +
        '<div class="typeahead-list" hidden></div>' +
      '</div>';
    }

    function typeaheadListFor(input) {
      return input && input.parentElement ? input.parentElement.querySelector(".typeahead-list") : null;
    }

    function closeTypeaheadLists() {
      document.querySelectorAll(".typeahead-list").forEach((list) => {
        list.hidden = true;
        list.innerHTML = "";
      });
    }

    const runTypeahead = debounce(async (inputId, query) => {
      const input = document.getElementById(inputId);
      const list = typeaheadListFor(input);
      if (!input || !list) return;
      if (input.value.trim() !== query.trim()) return;

      let actors = [];
      try {
        const res = await apiFetch("/api/bsky/typeahead?q=" + encodeURIComponent(query.trim()));
        actors = res.actors || [];
      } catch (error) {
        actors = [];
      }

      if (input.value.trim() !== query.trim()) return;
      if (!actors.length) {
        list.hidden = true;
        list.innerHTML = "";
        return;
      }

      list.innerHTML = actors.map((actor) => (
        '<button type="button" class="typeahead-item" data-typeahead-pick="' + escapeAttr(actor.handle) + '" data-input-id="' + escapeAttr(inputId) + '">' +
          (actor.avatar
            ? '<img src="' + escapeAttr(actor.avatar) + '" alt="" loading="lazy">'
            : '<span class="typeahead-avatar"></span>') +
          '<span><strong>@' + escapeHtml(actor.handle) + '</strong>' +
            (actor.displayName ? ' ' + escapeHtml(actor.displayName) : '') +
          '</span>' +
        '</button>'
      )).join("");
      list.hidden = false;
    }, 250);

    function handleTypeaheadInput(input) {
      const query = input.value.trim().replace(/^@/, "");
      const list = typeaheadListFor(input);

      if (query.length < 2) {
        if (list) {
          list.hidden = true;
          list.innerHTML = "";
        }
        return;
      }
      runTypeahead(input.id, query);
    }

    function renderLanding() {
      if (!els.publicLanding || !els.appLayout || !els.landingAuth) return;

      const signedIn = Boolean(state.me && state.me.loggedIn);
      const showLanding = !state.userId && !signedIn;
      els.publicLanding.hidden = !showLanding;
      els.appLayout.hidden = showLanding;
      els.form.hidden = showLanding;
      document.body.classList.toggle("app-active", !showLanding);
      if (showLanding) els.mobileSheet.hidden = true;

      if (!showLanding) return;

      const busyAttr = state.bskyBusy ? " disabled" : "";
      if (!state.me) {
        els.landingAuth.innerHTML = '<div class="landing-auth-note">Checking Bluesky session...</div>';
        return;
      }

      els.landingAuth.innerHTML =
        renderBskyStatus() +
        renderTypeaheadInput("landingBskyHandleInput", "you.bsky.social", "login") +
        '<button class="primary" type="button" data-bsky-action="login"' + busyAttr + '>' +
          (state.bskyBusy && state.bskyAction === "login" ? "Signing in..." : "Sign in with Bluesky") +
        '</button>' +
        '<div class="landing-auth-note">Uses Bluesky OAuth for identity and challenge posts. iNaturalist linking happens after sign-in.</div>';
    }

    function renderBskyStatus() {
      if (!state.bskyMessage) return "";
      return '<div class="bsky-status ' + escapeAttr(state.bskyMessageKind || "info") + '">' +
        escapeHtml(state.bskyMessage) +
      '</div>';
    }

    function renderBsky() {
      if (!els.bskyBody) return;
      const me = state.me;
      const busyAttr = state.bskyBusy ? " disabled" : "";

      if (!me) {
        els.bskyStateLabel.textContent = state.bskyBusy ? "working" : "loading";
        els.bskyBody.innerHTML = '<div class="subtle">Loading Bluesky session…</div>';
        return;
      }

      if (!me.loggedIn) {
        els.bskyStateLabel.textContent = state.bskyBusy ? "working" : "signed out";
        els.bskyBody.innerHTML =
          renderChallengeBanner() +
          renderBskyStatus() +
          renderTypeaheadInput("bskyHandleInput", "you.bsky.social", "login") +
          '<button class="primary" type="button" data-bsky-action="login"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "login" ? "Signing in..." : "Sign in with Bluesky") +
          '</button>' +
          '<div class="subtle">Uses Bluesky OAuth and only asks for permission to create posts.</div>';
        return;
      }

      els.bskyStateLabel.textContent = state.bskyBusy ? "working" : "@" + me.handle;

      let html = renderBskyStatus() +
      '<div class="bsky-row">' +
        '<strong>' + escapeHtml(me.displayName || "@" + me.handle) + '</strong>' +
        '<button class="secondary" type="button" data-bsky-action="logout"' + busyAttr + '>Sign out</button>' +
      '</div>';

      if (me.inatLogin) {
        html += '<div class="subtle">iNaturalist: <strong>' + escapeHtml(me.inatLogin) + '</strong> (verified)</div>';
      } else {
        html += '<div class="subtle">Link your iNaturalist account by proving ownership &mdash; no iNat OAuth, no write access:</div>' +
          '<input id="inatLinkInput" data-inat-link-input="1" data-bsky-enter="inat-start" placeholder="iNaturalist username" value="' + escapeAttr(me.inatPendingLogin || "") + '">' +
          '<button class="secondary" type="button" data-bsky-action="inat-start"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "inat-start" ? "Creating code..." : "Get verification code") +
          '</button>';

        if (me.inatPendingLogin && me.inatVerificationCode) {
          html += '<div class="bsky-code">' + escapeHtml(me.inatVerificationCode) + '</div>' +
            '<div class="subtle">Add this code to the profile bio of "' + escapeHtml(me.inatPendingLogin) +
            '" in <a href="https://www.inaturalist.org/users/edit" target="_blank" rel="noopener">iNaturalist settings</a>, save, then verify. You can remove it afterwards.</div>' +
            '<button class="primary" type="button" data-bsky-action="inat-confirm"' + busyAttr + '>' +
              (state.bskyBusy && state.bskyAction === "inat-confirm" ? "Verifying..." : "Verify Link") +
            '</button>';
        }
      }

      html += renderChallengeBanner();

      if (me.inatLogin) {
        html += '<div class="subtle"><strong>Challenge a player</strong> (uses your selected 5)</div>' +
          renderTypeaheadInput("challengeHandleInput", "opponent.bsky.social", "challenge-send") +
          '<input id="challengeMessageInput" placeholder="Optional taunt (140 chars)" maxlength="140">' +
          '<button class="primary" type="button" data-bsky-action="challenge-send"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "challenge-send" ? "Sending..." : "Send Challenge via Bluesky") +
          '</button>' +
          renderCustomSpritePanel(busyAttr);
      }

      if (state.challenges.length) {
        html += '<div class="batch-list">' + state.challenges.map(renderChallengeItem).join("") + '</div>';
      }

      els.bskyBody.innerHTML = html;
    }

    async function loadRoster() {
      if (!state.userId) return;

      const params = new URLSearchParams({
        userId: state.userId,
        limit: String(ROSTER_PAGE_SIZE),
        offset: String((state.rosterPage - 1) * ROSTER_PAGE_SIZE)
      });
      if (state.rosterSearch) params.set("q", state.rosterSearch);
      if (state.rosterSort !== "default") params.set("sort", state.rosterSort);
      if (state.rosterStatus !== "all") params.set("status", state.rosterStatus);
      if (state.rosterIconic) params.set("iconic", state.rosterIconic);

      const res = await apiFetch("/api/roster?" + params.toString());
      state.taxa = res.taxa || [];
      state.rosterTotal = Number(res.total ?? state.taxa.length);
      state.rosterSummary = res.summary || null;
      state.rosterIconicCounts = Array.isArray(res.iconicCounts) ? res.iconicCounts : [];

      const pageCount = Math.max(1, Math.ceil(state.rosterTotal / ROSTER_PAGE_SIZE));
      if (state.taxa.length === 0 && state.rosterPage > pageCount) {
        state.rosterPage = pageCount;
        return loadRoster();
      }

      pruneSelectedTaxa();
      render();
      schedulePolling();
    }

    async function reloadRosterPage(resetPage) {
      if (resetPage) state.rosterPage = 1;
      try {
        await loadRoster();
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function switchView(view) {
      state.activeView = ["home", "roster", "tree", "recent", "battle", "leaderboard", "buddies", "map", "training", "dev", "settings"].includes(view) ? view : "home";
      renderViewTabs();

      if (state.activeView === "map") {
        initTerritoryMap();
      }

      if (state.activeView === "leaderboard") {
        await loadLeaderboard(!state.leaderboard);
      }
      if (state.activeView === "buddies") {
        startPresence(false);
      }
      if (state.activeView === "tree" && !state.spriteTree) {
        await loadSpriteTree(false);
      }
      if (state.activeView === "recent" && !state.recentSprites) {
        await loadRecentSprites(false);
      }
      if (state.activeView === "training" && !state.training) {
        await loadTraining();
      }
      if ((state.activeView === "home" || state.activeView === "roster") && state.rosterStale && state.userId) {
        state.rosterStale = false;
        try {
          await loadRoster();
        } catch (error) {
          setStatus(error.message);
        }
      }
    }

    function renderViewTabs() {
      const view = state.activeView;
      document.body.dataset.view = view;
      els.homeTabButton.classList.toggle("active", view === "home");
      els.rosterTabButton.classList.toggle("active", view === "roster");
      els.battleTabButton.classList.toggle("active", view === "battle");
      els.leaderboardTabButton.classList.toggle("active", view === "leaderboard");
      els.buddiesTabButton.classList.toggle("active", view === "buddies");
      els.mapTabButton.classList.toggle("active", view === "map");
      els.trainingTabButton.classList.toggle("active", view === "training");
      els.treeTabButton.classList.toggle("active", view === "tree");
      els.recentTabButton.classList.toggle("active", view === "recent");
      els.devTabButton.classList.toggle("active", view === "dev");
      els.settingsTabButton.classList.toggle("active", view === "settings");
      els.homeView.hidden = view !== "home";
      els.rosterView.hidden = view !== "roster";
      els.battleView.hidden = view !== "battle";
      els.leaderboardView.hidden = view !== "leaderboard";
      els.buddiesView.hidden = view !== "buddies";
      els.mapView.hidden = view !== "map";
      els.trainingView.hidden = view !== "training";
      els.treeView.hidden = view !== "tree";
      els.recentView.hidden = view !== "recent";
      els.devView.hidden = view !== "dev";
      els.settingsView.hidden = view !== "settings";
      if (view === "settings") els.settingsSoundToggle.checked = state.soundOn;
      els.battleTabButton.textContent = state.battle && state.battle.status === "active" ? "Battle ⚔" : "Battle";

      const primaryMobileViews = ["home", "roster", "battle", "buddies"];
      for (const button of els.mobileNav.querySelectorAll("[data-mobile-nav]")) {
        button.classList.toggle("active", button.getAttribute("data-mobile-nav") === view);
      }
      els.mobileMoreButton.classList.toggle("active", !primaryMobileViews.includes(view));
      for (const button of els.mobileSheet.querySelectorAll("[data-mobile-nav]")) {
        button.classList.toggle("active", button.getAttribute("data-mobile-nav") === view);
      }
    }

    // -- Territory map (Leaflet) --------------------------------------------

    const BIOME_COLORS = {
      shrubland: "#ccb35c", grassland: "#b8e05c", agricultural: "#e9d35f",
      urban: "#e60000", desert: "#c4b79f", polar: "#f0f0f0", freshwater: "#3a86d6",
      wetland: "#13b3b3", tundra: "#7dd67d", forest: "#3bbf57", woodland: "#7cc873",
      ocean: "#2e6f9e", unknown: "#808080"
    };
    const TAXA_COLORS = {
      Aves: "#3b82f6", Plantae: "#22c55e", Insecta: "#f59e0b", Fungi: "#a855f7",
      Mammalia: "#ef4444", Reptilia: "#84cc16", Amphibia: "#14b8a6", Arachnida: "#f97316",
      Mollusca: "#ec4899", Actinopterygii: "#06b6d4", Animalia: "#eab308", unknown: "#9ca3af"
    };
    const MAP_TILE_MIN_ZOOM = 6;

    function biomeColor(b) { return BIOME_COLORS[b] || BIOME_COLORS.unknown; }
    function taxaColor(t) { return TAXA_COLORS[t] || TAXA_COLORS.unknown; }

    function renderMapLegend() {
      const order = ["forest", "woodland", "grassland", "shrubland", "wetland", "freshwater", "ocean", "agricultural", "urban", "desert", "tundra", "polar"];
      let html = "";
      for (let i = 0; i < order.length; i += 1) {
        html += '<span class="map-legend-row"><span class="map-legend-sw" style="background:' + biomeColor(order[i]) + '"></span>' + order[i] + "</span>";
      }
      els.mapLegend.innerHTML = html;
    }

    function initTerritoryMap() {
      if (state.map) {
        setTimeout(() => { state.map.invalidateSize(); }, 60);
        return;
      }
      if (typeof L === "undefined") {
        els.mapStatusLabel.textContent = "Map library still loading — reopen this tab in a moment.";
        return;
      }
      const map = L.map(els.mapCanvas, { zoomControl: true, preferCanvas: false, worldCopyJump: true });
      state.map = map;
      state.mapTileLayer = L.layerGroup().addTo(map);
      state.mapClaimLayer = L.layerGroup().addTo(map);
      state.mapObsLayer = L.layerGroup().addTo(map);
      state.mapAvatarLayer = L.layerGroup().addTo(map);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
        subdomains: "abcd",
        maxZoom: 19
      }).addTo(map);

      // Biome basemap: vector hexes from a single PMTiles archive (range-read
      // client-side), styled by biome — LOD/global handled by the tile pyramid.
      if (typeof protomapsL !== "undefined") {
        try {
          state.biomeLayer = protomapsL.leafletLayer({
            // ?v bumps when the tileset is rebuilt, to bust browser/edge cache.
            url: "/tiles/biomes.pmtiles?v=2",
            // PMTiles (res2/res3) paints the fast world→regional view; the local
            // res5 grid (API, claimable) takes over at z>=8. Data caps at z7, but
            // we let it PAINT through z9 (overzoomed) as a fallback: PMTiles lives
            // in Leaflet's tilePane (below the overlayPane res5 hexes), so when the
            // res5 grid loads it overlays cleanly, and when a wide z8/z9 viewport
            // exceeds the res5 cell cap (returns tooMany) the coarse biome still
            // shows instead of a blank gap between the medium and finest scales.
            maxDataZoom: 7,
            paintRules: [{
              dataLayer: "biomes",
              minzoom: 0,
              maxzoom: 9,
              symbolizer: new protomapsL.PolygonSymbolizer({
                fill: (z, f) => biomeColor(f.props.biome),
                opacity: 0.5
              })
            }],
            backgroundColor: "rgba(0,0,0,0)"
          });
          state.biomeLayer.addTo(map);
        } catch (error) { /* fall back to no biome layer */ }
      }

      map.setView([20, 0], 2);
      renderMapLegend();

      let debounce = null;
      map.on("moveend", () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(loadMapData, 350);
      });

      // Click the biome basemap -> resolve the res5 cell -> open the tile panel.
      map.on("click", async (event) => {
        if (state.map.getZoom() < 8) {
          els.mapStatusLabel.textContent = "Zoom in to claim a tile.";
          return;
        }
        try {
          const res = await apiFetch("/api/territory/cell?lat=" + event.latlng.lat + "&lng=" + event.latlng.lng);
          if (res && res.h3) openTilePanel(res.h3);
        } catch (error) { /* ignore */ }
      });

      setTimeout(() => {
        map.invalidateSize();
        centerMapOnObservations();
      }, 90);
    }

    async function centerMapOnObservations() {
      if (!state.map) return;
      try {
        const res = await apiFetch("/api/territory/observations");
        const obs = (res && res.observations) || [];
        if (obs.length > 0) {
          const lats = obs.map((o) => o.latitude);
          const lngs = obs.map((o) => o.longitude);
          state.map.fitBounds(
            [[Math.min.apply(null, lats), Math.min.apply(null, lngs)], [Math.max.apply(null, lats), Math.max.apply(null, lngs)]],
            { padding: [30, 30], maxZoom: 9 }
          );
        } else {
          els.mapStatusLabel.textContent = "No observations synced yet — tap “Sync my observations.”";
        }
      } catch (error) {
        /* fall through to a normal load */
      }
      loadMapData();
    }

    let mapLoadToken = 0;
    async function loadMapData() {
      if (!state.map) return;
      const token = (mapLoadToken += 1);
      const b = state.map.getBounds();
      const zoom = Math.round(state.map.getZoom());
      const qs = "n=" + b.getNorth() + "&s=" + b.getSouth() + "&e=" + b.getEast() + "&w=" + b.getWest();
      const claims = state.mapMode === "claims";

      // World→regional biomes come from the PMTiles basemap (z<8). At local zoom
      // the res5 grid (claimable, ownership-aware) is drawn from the API.
      if (zoom >= 8) {
        try {
          const tres = await apiFetch("/api/territory/tiles?" + qs + "&zoom=" + zoom);
          if (token !== mapLoadToken) return;
          drawTiles((tres && tres.tiles) || [], 5, claims);
        } catch (error) { /* ignore */ }
      } else {
        state.mapTileLayer.clearLayers();
      }

      if (claims) {
        state.mapObsLayer.clearLayers();
        try {
          const cres = await apiFetch("/api/territory/claims?" + qs);
          if (token !== mapLoadToken) return;
          await drawClaims((cres && cres.claims) || []);
        } catch (error) { /* ignore */ }
      } else {
        state.mapClaimLayer.clearLayers();
        state.mapAvatarLayer.clearLayers();
        try {
          const ores = await apiFetch("/api/territory/observations?" + qs);
          if (token !== mapLoadToken) return;
          drawObservations((ores && ores.observations) || []);
        } catch (error) { /* ignore */ }
      }
    }

    // --- Claims mode: owner-colored territory + PFP cluster markers ---

    function hashColor(str) {
      let h = 0;
      const s = String(str || "");
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
      return "hsl(" + h + ", 65%, 55%)";
    }

    // Dominant color of a Bluesky avatar (most-populated coarse RGB bucket,
    // ignoring near-black/near-white). Falls back to a hash color if the image
    // is CORS-tainted or fails to load.
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      let h = 0;
      let s = 0;
      const l = (mx + mn) / 2;
      const d = mx - mn;
      if (d) {
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return [h, s, l];
    }

    // Dominant *characteristic* color of an avatar: weight pixels by saturation
    // AND brightness (so a vivid logo/garment beats a big muted background),
    // pick the strongest hue bucket, then re-render it at a fixed tile-friendly
    // lightness so it reads on the dark map (the raw pixel can be a dark brown).
    function avatarDominantColor(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const S = 32;
            const canvas = document.createElement("canvas");
            canvas.width = S;
            canvas.height = S;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, S, S);
            const data = ctx.getImageData(0, 0, S, S).data;
            const buckets = {};
            let best = null;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const bl = data[i + 2];
              if (data[i + 3] < 128) continue;
              const mx = Math.max(r, g, bl);
              const mn = Math.min(r, g, bl);
              if (mx < 40) continue;
              const sat = mx === 0 ? 0 : (mx - mn) / mx;
              if (sat < 0.28) continue; // skip near-grayscale (backgrounds)
              const w = sat * (mx / 255);
              const key = (r >> 5) + "," + (g >> 5) + "," + (bl >> 5);
              const bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, w: 0 });
              bk.r += r * w; bk.g += g * w; bk.b += bl * w; bk.w += w;
              if (!best || bk.w > best.w) best = bk;
            }
            if (!best) { resolve(null); return; }
            const hsl = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
            const sat = Math.round(Math.max(0.55, hsl[1]) * 100);
            resolve("hsl(" + Math.round(hsl[0]) + ", " + sat + "%, 55%)");
          } catch (error) {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }

    // Union-find clustering by centroid proximity (res5 hex spacing ~0.16deg).
    function clusterByProximity(tiles) {
      const parent = tiles.map((_, i) => i);
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const union = (a, b) => { parent[find(a)] = find(b); };
      const THRESH = 0.26;
      for (let i = 0; i < tiles.length; i += 1) {
        for (let j = i + 1; j < tiles.length; j += 1) {
          const a = tiles[i].centroid;
          const c = tiles[j].centroid;
          const dLat = a[0] - c[0];
          const dLng = (a[1] - c[1]) * Math.cos((a[0] * Math.PI) / 180);
          if (Math.sqrt(dLat * dLat + dLng * dLng) < THRESH) union(i, j);
        }
      }
      const groups = {};
      for (let i = 0; i < tiles.length; i += 1) {
        const root = find(i);
        (groups[root] || (groups[root] = [])).push(tiles[i]);
      }
      return Object.keys(groups).map((k) => groups[k]);
    }

    function ownerAvatarHtml(owner, color) {
      const inner = owner.avatarUrl
        ? '<img src="' + escapeAttr(owner.avatarUrl) + '" alt="" referrerpolicy="no-referrer">'
        : '<span class="owner-avatar-fallback">' + escapeHtml((owner.handle || "?").charAt(0).toUpperCase()) + '</span>';
      return '<div class="owner-avatar-ring" style="border-color:' + color + '">' + inner + '</div>';
    }

    async function drawClaims(claims) {
      // Biome grid stays (drawn by drawTiles); we overlay claims + avatars.
      state.mapClaimLayer.clearLayers();
      state.mapAvatarLayer.clearLayers();
      if (!claims.length) {
        els.mapStatusLabel.textContent = "Faint hexes are unclaimed — claim one to plant your flag.";
        return;
      }

      if (!state.ownerColors) state.ownerColors = {};
      const byDid = {};
      for (const claim of claims) (byDid[claim.did] || (byDid[claim.did] = [])).push(claim);
      const dids = Object.keys(byDid);

      await Promise.all(dids.map(async (did) => {
        if (state.ownerColors[did] !== undefined) return;
        const sample = byDid[did][0];
        let color = null;
        if (sample.avatarUrl) {
          // Read pixels through the same-origin proxy so the canvas isn't tainted.
          color = await avatarDominantColor("/api/avatar?url=" + encodeURIComponent(sample.avatarUrl));
        }
        state.ownerColors[did] = color || hashColor(did);
      }));

      for (const claim of claims) {
        const color = state.ownerColors[claim.did] || "#888";
        const poly = L.polygon(claim.boundary, {
          fillColor: color,
          // Near-opaque so the owner color is exact, not tinted by the biome
          // hex underneath (same owner -> same color regardless of habitat).
          fillOpacity: 0.95,
          color: claim.mine ? "#ffffff" : color,
          weight: claim.mine ? 2 : 1
        });
        const habitat = claim.biome ? escapeHtml(claim.biome) + " · " : "";
        poly.bindTooltip(habitat + "@" + escapeHtml(claim.handle), { sticky: true });
        const h3 = claim.h3;
        poly.on("click", () => openTilePanel(h3));
        state.mapClaimLayer.addLayer(poly);
      }

      for (const did of dids) {
        const color = state.ownerColors[did] || "#888";
        const owner = byDid[did][0];
        for (const cluster of clusterByProximity(byDid[did])) {
          let lat = 0;
          let lng = 0;
          for (const tile of cluster) { lat += tile.centroid[0]; lng += tile.centroid[1]; }
          lat /= cluster.length;
          lng /= cluster.length;
          const icon = L.divIcon({
            className: "owner-avatar-icon",
            html: ownerAvatarHtml(owner, color),
            iconSize: [46, 46],
            iconAnchor: [23, 23]
          });
          L.marker([lat, lng], { icon, title: "@" + owner.handle, interactive: false }).addTo(state.mapAvatarLayer);
        }
      }

      els.mapStatusLabel.textContent = claims.length + " claimed tiles · " + dids.length + " holder" + (dids.length === 1 ? "" : "s") + " in view.";
    }

    function setMapMode(mode) {
      state.mapMode = mode === "claims" ? "claims" : "biomes";
      if (els.mapModeToggle) {
        for (const button of els.mapModeToggle.querySelectorAll("[data-map-mode]")) {
          button.classList.toggle("active", button.getAttribute("data-map-mode") === state.mapMode);
        }
      }
      if (state.map) loadMapData();
    }

    function drawTiles(tiles, resolution, dim) {
      state.mapTileLayer.clearLayers();
      const claimable = resolution === 5;
      for (let i = 0; i < tiles.length; i += 1) {
        const t = tiles[i];
        if (!t.boundary || !t.boundary.length) continue;
        const poly = L.polygon(t.boundary, {
          fillColor: biomeColor(t.biome),
          fillOpacity: dim ? 0.22 : (t.mine ? 0.72 : 0.5),
          color: dim ? "rgba(255,255,255,0.12)" : (t.mine ? "#ffffff" : "rgba(255,255,255,0.35)"),
          weight: t.mine && !dim ? 2.5 : 1,
          interactive: claimable
        });
        poly.bindTooltip(t.biome + (t.mine ? " — yours" : ""), { sticky: true });
        if (claimable) {
          const h3 = t.h3;
          poly.on("click", () => openTilePanel(h3));
        }
        state.mapTileLayer.addLayer(poly);
      }
      // Keep observation points clickable above the hexes just drawn.
      state.mapObsLayer.eachLayer((layer) => { if (layer.bringToFront) layer.bringToFront(); });
      els.mapStatusLabel.textContent = tiles.length + " biome hexes in view"
        + (resolution !== 5 ? " (zoom in to claim)" : "") + ".";
    }

    function drawObservations(obs) {
      state.mapObsLayer.clearLayers();
      for (let i = 0; i < obs.length; i += 1) {
        const o = obs[i];
        if (!Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) continue;
        const marker = L.circleMarker([o.latitude, o.longitude], {
          radius: 6,
          fillColor: taxaColor(o.iconic_taxon_name),
          fillOpacity: 0.95,
          color: "#ffffff",
          weight: 1.2
        });
        const name = o.taxon_name || "Observation";
        marker.bindPopup('<strong>' + escapeHtml(name) + '</strong><br><span class="subtle">' + escapeHtml(o.iconic_taxon_name || '') + '</span>');
        state.mapObsLayer.addLayer(marker);
        marker.bringToFront();
      }
    }

    // iNaturalist v2 observation fields the territory ingest needs. Mirrors the
    // server INAT_OBSERVATION_GEO_FIELDS so browser-fetched rows match.
    var INAT_OBS_GEO_FIELDS = "id,observed_on,time_observed_at,quality_grade,geoprivacy,taxon_geoprivacy,obscured,location,geojson,taxon.id,taxon.name,taxon.preferred_common_name,taxon.iconic_taxon_name";

    // Fetch the signed-in user's research-grade geo observations straight from
    // iNaturalist in their OWN browser (iNat v2 sends CORS headers for GET), so
    // the iNat rate limit lands on each user's IP instead of funneling every
    // user through the Worker's shared egress. Returns the raw v2 rows.
    async function inatBrowserFetchObservations(login, onProgress) {
      const MAX_PAGES = 10;
      const rows = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        if (onProgress) onProgress(page);
        const params = new URLSearchParams({
          user_login: login,
          quality_grade: "research",
          geo: "true",
          order_by: "observed_on",
          per_page: "200",
          page: String(page),
          fields: INAT_OBS_GEO_FIELDS,
          ttl: "21600"
        });
        const res = await fetch("https://api.inaturalist.org/v2/observations?" + params.toString());
        if (!res.ok) throw new Error("iNaturalist returned " + res.status);
        const data = await res.json();
        const pageRows = (data && Array.isArray(data.results)) ? data.results : [];
        for (let i = 0; i < pageRows.length; i += 1) rows.push(pageRows[i]);
        if (pageRows.length < 200) break;
        // Be polite between pages (the Worker fallback waits ~1.1s).
        await new Promise(function (resolve) { setTimeout(resolve, 700); });
      }
      return rows;
    }

    async function syncTerritory() {
      els.mapSyncButton.disabled = true;
      els.mapStatusLabel.textContent = "Syncing observations from iNaturalist…";
      try {
        let res = null;
        const login = (state.me && state.me.inatLogin) || state.inatLogin;
        if (login) {
          // Preferred path: fetch in the user's browser, then hand the rows to
          // the Worker just to persist them (keeps iNat rate limits per-user).
          try {
            const obs = await inatBrowserFetchObservations(login, function (page) {
              els.mapStatusLabel.textContent = "Fetching your observations from iNaturalist… (page " + page + ")";
            });
            els.mapStatusLabel.textContent = "Saving " + obs.length + " observations…";
            res = await apiFetch("/api/territory/ingest", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ observations: obs })
            });
          } catch (browserErr) {
            // CORS/network/iNat hiccup -> let the Worker fetch instead.
            res = null;
          }
        }
        if (!res) {
          res = await apiFetch("/api/territory/sync", { method: "POST" });
        }
        if (res && res.warning) {
          els.mapStatusLabel.textContent = res.warning;
        } else {
          els.mapStatusLabel.textContent = "Synced " + Number(res.recorded || 0) + " observations across " + Number(res.distinctTiles || 0) + " tiles.";
        }
        await centerMapOnObservations();
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Sync failed";
      } finally {
        els.mapSyncButton.disabled = false;
      }
    }

    function closeTilePanel() {
      els.tilePanel.hidden = true;
      els.tilePanel.innerHTML = "";
    }

    function openTilePanel(h3) {
      els.tilePanel.hidden = false;
      els.tilePanel.innerHTML = '<div class="tile-panel-body"><p class="subtle">Loading tile…</p></div>';
      apiFetch("/api/territory/tile?h3=" + encodeURIComponent(h3))
        .then(renderTilePanel)
        .catch((error) => {
          els.tilePanel.innerHTML = '<div class="tile-panel-body"><button class="tile-close" type="button" data-tile-close aria-label="Close">×</button><p class="subtle">' + escapeHtml(error.message || "Failed to load tile") + '</p></div>';
        });
    }

    function renderTilePanel(d) {
      const name = d.biome.charAt(0).toUpperCase() + d.biome.slice(1);
      const teamReady = state.selectedTaxa && state.selectedTaxa.size === 5;
      let ownerLine;
      if (d.mine) ownerLine = '<span class="tile-owner mine">★ You hold this tile</span>';
      else if (d.owned) ownerLine = '<span class="tile-owner">Held by @' + escapeHtml(d.owner) + '</span>';
      else ownerLine = '<span class="tile-owner">Unclaimed</span>';

      const favored = (d.favoredTypes && d.favoredTypes.length)
        ? '<p class="subtle">Favors ' + escapeHtml(d.favoredTypes.join(" · ")) + ' moves (+15%)</p>'
        : "";

      // Roster power: holdings of this biome buff your biome-native species.
      const holdings = (Number(d.biomeBuffPct) > 0)
        ? '<p class="tile-power">🏞️ You hold ' + Number(d.biomeHoldings) + ' ' + escapeHtml(d.biome) +
          ' tiles → <strong>+' + Math.round(Number(d.biomeBuffPct) * 100) + '%</strong> to your ' +
          escapeHtml(d.biome) + '-native species in battle.</p>'
        : (Number(d.biomeHoldings) === 0
          ? '<p class="subtle">Hold ' + escapeHtml(d.biome) + ' tiles to buff your ' + escapeHtml(d.biome) + '-native species.</p>'
          : "");

      // Local presence: distinct RG species you've observed here vs. the gate.
      const localLine = '<p class="tile-local' + (d.eligible ? ' ok' : '') + '">📍 ' + Number(d.localSpecies) +
        ' / ' + Number(d.speciesNeeded) + ' research-grade species observed here' +
        (d.eligible ? ' — your locals fight +' + Math.round(0.04 * 100) + '%' : '') + '.</p>';

      const garrisonBtn = (label, cls) => '<button class="' + cls + '" type="button" data-tile-garrison="' + escapeAttr(d.h3) + '">' + label + '</button>';
      let action;
      if (d.mine && d.pending) {
        // You just took it — undefended on the clock.
        action = '<p class="tile-warn">⏳ Undefended — ' + Number(d.minutesLeft) + 'm left to garrison or it reverts to neutral.</p>' +
          (teamReady ? garrisonBtn("Garrison with my 5", "primary") : '<p class="tile-hint">Select 5 ready creatures in Roster, then garrison.</p>');
      } else if (d.mine) {
        action = '<p class="tile-hint">Defended by your garrison (defense ' + Number(d.defenseStrength) + ').</p>' +
          (teamReady ? garrisonBtn("Re-garrison with my 5", "secondary") : "");
      } else if (!d.eligible) {
        action = '<p class="tile-hint">Observe ' + Math.max(0, Number(d.speciesNeeded) - Number(d.localSpecies)) +
          ' more research-grade species here to claim or contest this tile.</p>';
      } else if (d.canClaim) {
        action = '<button class="primary" type="button" data-tile-claim="' + escapeAttr(d.h3) + '">Claim this tile</button>';
      } else if (d.pending) {
        // Owned by someone else but undefended — contest-locked grace window.
        action = '<p class="tile-hint">Just taken by @' + escapeHtml(d.owner || "someone") + ' — its defenses are being set up.</p>';
      } else if (d.canContest) {
        action = teamReady
          ? '<button class="primary" type="button" data-tile-contest="' + escapeAttr(d.h3) + '">Contest — battle the garrison' + (Number(d.defenseStrength) > 0 ? " (def +" + Number(d.defenseStrength) + ")" : "") + '</button>'
          : '<p class="tile-hint">Select 5 ready creatures in Roster to contest.</p>';
      } else {
        action = "";
      }

      els.tilePanel.hidden = false;
      els.tilePanel.innerHTML =
        '<div class="tile-panel-body">' +
          '<button class="tile-close" type="button" data-tile-close aria-label="Close">×</button>' +
          '<div class="tile-head"><span class="tile-biome-chip" style="background:' + biomeColor(d.biome) + '"></span>' +
          '<h3>' + escapeHtml(name) + ' tile</h3></div>' +
          ownerLine +
          favored +
          localLine +
          holdings +
          action +
          '<p class="subtle tile-actions-left">' + Number(d.actionsLeftToday) + ' actions left today</p>' +
        '</div>';
    }

    async function claimTile(h3) {
      try {
        await apiFetch("/api/territory/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ h3: h3 })
        });
        els.mapStatusLabel.textContent = "Tile claimed — garrison it before the timer runs out.";
        openTilePanel(h3);
        loadMapData();
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Claim failed";
      }
    }

    async function garrisonTile(h3) {
      const taxonIds = Array.from(state.selectedTaxa || []).map(Number);
      if (taxonIds.length !== 5) { els.mapStatusLabel.textContent = "Select 5 ready creatures in Roster first."; return; }
      try {
        await apiFetch("/api/territory/garrison", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ h3: h3, taxonIds: taxonIds })
        });
        els.mapStatusLabel.textContent = "Tile garrisoned — it's defended now.";
        openTilePanel(h3);
        loadMapData();
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Garrison failed";
      }
    }

    async function contestTile(h3) {
      const taxonIds = Array.from(state.selectedTaxa || []).map(Number);
      if (taxonIds.length !== 5) { els.mapStatusLabel.textContent = "Select 5 ready creatures first."; return; }
      try {
        const battle = await apiFetch("/api/territory/contest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ h3: h3, taxonIds: taxonIds })
        });
        closeTilePanel();
        enterBattle(battle);
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Contest failed";
      }
    }

    async function loadSpriteTree(showStatus) {
      const q = state.treeSearch || "";
      if (showStatus) setStatus("Loading sprite tree");

      try {
        const previousQuery = state.spriteTree?.q || "";
        const res = await apiFetch("/api/sprite-tree?limit=1000&q=" + encodeURIComponent(q));
        state.spriteTree = res;
        syncTreePath(res, q, previousQuery);
        renderSpriteTree();
        if (showStatus) setStatus("Loaded " + Number(res.totalSprites || 0) + " ready sprites in the tree");
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function loadRecentSprites(showStatus) {
      const q = state.recentSearch || "";
      if (showStatus) setStatus("Loading recently added sprites");

      try {
        const res = await apiFetch("/api/recent-sprites?limit=100&q=" + encodeURIComponent(q));
        state.recentSprites = res;
        renderRecentSprites();
        if (showStatus) setStatus("Loaded " + Number(res.totalSprites || 0) + " recently added sprites");
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function loadLeaderboard(showStatus) {
      if (showStatus) setStatus("Loading leaderboard");
      const territory = state.leaderboardMode === "territory";
      try {
        const board = await apiFetch(territory ? "/api/leaderboard/territory" : "/api/leaderboard");
        if (territory) state.territoryLeaderboard = board;
        else state.leaderboard = board;
        renderLeaderboard();
        if (showStatus) setStatus("Leaderboard updated");
      } catch (error) {
        setStatus(error.message);
      }
    }

    function setLeaderboardMode(mode) {
      state.leaderboardMode = mode === "territory" ? "territory" : "battle";
      for (const button of els.leaderboardModeToggle.querySelectorAll("[data-lb-mode]")) {
        button.classList.toggle("active", button.getAttribute("data-lb-mode") === state.leaderboardMode);
      }
      const cached = state.leaderboardMode === "territory" ? state.territoryLeaderboard : state.leaderboard;
      if (cached) renderLeaderboard();
      else loadLeaderboard(true);
    }

    function streakHtml(entry) {
      if (Number(entry.winStreak) >= 2) {
        return '<span class="lb-streak">' + Number(entry.winStreak) + 'W streak 🔥</span>';
      }
      return "";
    }

    function lbAvatar(entry) {
      return entry.avatarUrl
        ? '<img class="lb-avatar" src="' + escapeAttr(entry.avatarUrl) + '" alt="" loading="lazy">'
        : '<span class="lb-avatar" aria-hidden="true"></span>';
    }

    function lbDisplayName(entry) {
      const name = escapeHtml(entry.name || entry.userId);
      const handle = entry.handle ? ' <span class="subtle">@' + escapeHtml(entry.handle) + '</span>' : "";
      return name + handle;
    }

    function renderLeaderboard() {
      if (state.leaderboardMode === "territory") {
        renderTerritoryLeaderboard();
        return;
      }
      const board = state.leaderboard;
      if (!board) {
        els.leaderboardPanel.innerHTML = "";
        return;
      }

      const entries = board.entries || [];
      els.leaderboardMetaLabel.textContent = entries.length
        ? board.totalPlayers + " ranked naturalist" + (board.totalPlayers === 1 ? "" : "s")
        : "";

      if (!entries.length) {
        els.leaderboardPanel.innerHTML =
          '<div class="empty"><div><strong>The leaderboard is unclaimed.</strong><br>' +
          'Win a rated NPC battle and the #1 spot is yours — someone has to found the food chain.</div></div>';
        return;
      }

      const medals = ["🥇", "🥈", "🥉"];
      const podiumClasses = ["first", "second", "third"];
      const podium = entries.slice(0, 3).map((entry, index) =>
        '<div class="lb-podium-card ' + podiumClasses[index] + '">' +
          '<div class="lb-medal">' + medals[index] + '</div>' +
          lbAvatar(entry) +
          '<div class="lb-name">' + lbDisplayName(entry) + '</div>' +
          '<div class="lb-rating">' + entry.rating + '</div>' +
          '<span class="lb-title-chip">' + escapeHtml(entry.titleEmoji + " " + entry.title) + '</span>' +
          '<div class="subtle">' + entry.wins + 'W / ' + entry.losses + 'L</div>' +
          streakHtml(entry) +
        '</div>'
      ).join("");

      const youId = board.you ? board.you.userId : null;
      const tableRows = entries.slice(3).map((entry) =>
        '<tr' + (entry.userId === youId ? ' class="lb-you"' : "") + '>' +
          '<td>#' + entry.rank + '</td>' +
          '<td><span class="lb-row-name">' + lbAvatar(entry) + lbDisplayName(entry) + '</span></td>' +
          '<td><span class="lb-title-chip">' + escapeHtml(entry.titleEmoji + " " + entry.title) + '</span></td>' +
          '<td><strong>' + entry.rating + '</strong></td>' +
          '<td>' + entry.wins + 'W / ' + entry.losses + 'L</td>' +
          '<td>' + (Number(entry.winStreak) >= 2 ? streakHtml(entry) : "&mdash;") + '</td>' +
          '<td>' + (entry.fastestWinTurns ? entry.fastestWinTurns + " turns" : "&mdash;") + '</td>' +
        '</tr>'
      ).join("");
      const table = entries.length > 3
        ? '<table class="lb-table"><thead><tr>' +
            '<th>Rank</th><th>Naturalist</th><th>Title</th><th>Score</th><th>Record</th><th>Streak</th><th>Fastest win</th>' +
          '</tr></thead><tbody>' + tableRows + '</tbody></table>'
        : "";

      let youCard = "";
      if (board.you) {
        const you = board.you;
        youCard =
          '<div class="lb-you-card">' +
            '<div class="lb-you-stats">' +
              '<span class="lb-you-rank">#' + you.rank + '</span>' +
              '<span class="lb-title-chip">' + escapeHtml(you.titleEmoji + " " + you.title) + '</span>' +
              '<strong>' + you.rating + '</strong>' +
              '<span class="subtle">' + you.wins + 'W / ' + you.losses + 'L &middot; best streak ' + you.bestStreak + '</span>' +
              streakHtml(you) +
            '</div>' +
            '<button class="secondary bsky-share-button" type="button" data-share-rank>Post my rank to Bluesky 🦋</button>' +
          '</div>';
      } else if (state.me && state.me.loggedIn && state.me.inatLogin) {
        youCard = '<div class="lb-you-card"><span class="subtle">Win a rated NPC battle to enter the rankings.</span></div>';
      } else {
        youCard = '<div class="lb-you-card"><span class="subtle">Sign in with Bluesky and link your iNaturalist account to get ranked.</span></div>';
      }

      els.leaderboardPanel.innerHTML = '<div class="lb-podium">' + podium + '</div>' + table + youCard;
    }

    function renderTerritoryLeaderboard() {
      const board = state.territoryLeaderboard;
      if (!board) {
        els.leaderboardPanel.innerHTML = "";
        return;
      }
      const entries = board.entries || [];
      els.leaderboardMetaLabel.textContent = entries.length
        ? board.totalPlayers + " landholder" + (board.totalPlayers === 1 ? "" : "s")
        : "";

      if (!entries.length) {
        els.leaderboardPanel.innerHTML =
          '<div class="empty"><div><strong>No territory claimed yet.</strong><br>' +
          'Open the Map, sync your observations, and claim a tile to top this board.</div></div>';
        return;
      }

      const biomeChip = (b) => b
        ? '<span class="lb-title-chip">' + escapeHtml(b.charAt(0).toUpperCase() + b.slice(1)) + '</span>'
        : "&mdash;";
      const medals = ["🥇", "🥈", "🥉"];
      const podiumClasses = ["first", "second", "third"];
      const podium = entries.slice(0, 3).map((entry, index) =>
        '<div class="lb-podium-card ' + podiumClasses[index] + '">' +
          '<div class="lb-medal">' + medals[index] + '</div>' +
          lbAvatar(entry) +
          '<div class="lb-name">' + lbDisplayName(entry) + '</div>' +
          '<div class="lb-rating">' + entry.tiles + '</div>' +
          '<div class="subtle">tiles</div>' +
          biomeChip(entry.topBiome) +
          '<div class="subtle">' + entry.biomes + ' biome' + (entry.biomes === 1 ? "" : "s") + '</div>' +
        '</div>'
      ).join("");

      const youId = board.you ? board.you.userId : null;
      const tableRows = entries.slice(3).map((entry) =>
        '<tr' + (entry.userId === youId ? ' class="lb-you"' : "") + '>' +
          '<td>#' + entry.rank + '</td>' +
          '<td><span class="lb-row-name">' + lbAvatar(entry) + lbDisplayName(entry) + '</span></td>' +
          '<td><strong>' + entry.tiles + '</strong></td>' +
          '<td>' + entry.biomes + '</td>' +
          '<td>' + biomeChip(entry.topBiome) + '</td>' +
        '</tr>'
      ).join("");
      const table = entries.length > 3
        ? '<table class="lb-table"><thead><tr>' +
            '<th>Rank</th><th>Holder</th><th>Tiles</th><th>Biomes</th><th>Top biome</th>' +
          '</tr></thead><tbody>' + tableRows + '</tbody></table>'
        : "";

      let youCard;
      if (board.you) {
        const you = board.you;
        youCard =
          '<div class="lb-you-card"><div class="lb-you-stats">' +
            '<span class="lb-you-rank">#' + you.rank + '</span>' +
            '<strong>' + you.tiles + ' tiles</strong>' +
            '<span class="subtle">' + you.biomes + ' biome' + (you.biomes === 1 ? "" : "s") +
              (you.topBiome ? " &middot; mostly " + escapeHtml(you.topBiome) : "") + '</span>' +
          '</div></div>';
      } else if (state.me && state.me.loggedIn && state.me.inatLogin) {
        youCard = '<div class="lb-you-card"><span class="subtle">Claim a tile on the Map to enter the territory rankings.</span></div>';
      } else {
        youCard = '<div class="lb-you-card"><span class="subtle">Sign in and link iNaturalist, then claim tiles to get ranked.</span></div>';
      }

      els.leaderboardPanel.innerHTML = '<div class="lb-podium">' + podium + '</div>' + table + youCard;
    }

    function currentDevTaxonId() {
      const id = Number.parseInt(String(els.devTaxonIdInput.value || "").trim(), 10);
      if (!Number.isFinite(id) || id <= 0) throw new Error("Enter a numeric iNaturalist taxon ID.");
      return id;
    }

    async function inspectDevLab(showStatus) {
      const taxonId = currentDevTaxonId();
      const previousTaxonId = Number(state.devLab?.taxon?.taxonId || 0);
      if (previousTaxonId !== taxonId) {
        state.devPreviewAnimation = "anim-idle";
        state.devPreviewKey = "row1";
      }
      state.devBusy = true;
      renderDevLab();
      if (showStatus) setStatus("Loading dev taxon " + taxonId);

      try {
        state.devLab = await apiFetch("/api/taxa/" + encodeURIComponent(String(taxonId)) + "/dev-lab");
        renderDevLab();
        if (showStatus) setStatus("Loaded " + (state.devLab.taxon?.name || "taxon " + taxonId));
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.devBusy = false;
        renderDevLab();
      }
    }

    async function generateDevMoves() {
      const taxonId = currentDevTaxonId();
      state.devBusy = true;
      renderDevLab();
      setStatus("Generating signature moves for taxon " + taxonId);

      try {
        await apiFetch("/api/taxa/" + encodeURIComponent(String(taxonId)) + "/moves/dev-generate", { method: "POST" });
        await inspectDevLab(false);
        state.rosterStale = true;
        setStatus("Generated signature moves for taxon " + taxonId);
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.devBusy = false;
        renderDevLab();
      }
    }

    async function queueDevSprite() {
      const taxonId = currentDevTaxonId();
      state.devBusy = true;
      renderDevLab();
      setStatus("Queueing current-prompt sprite for taxon " + taxonId);

      try {
        const res = await apiFetch("/api/taxa/" + encodeURIComponent(String(taxonId)) + "/sprites/dev-queue", { method: "POST" });
        await inspectDevLab(false);
        setStatus(res.existingAsset ? "Current-prompt sprite already exists." : "Queued sprite job " + (res.jobId || ""));
        await loadBatchQueue(false);
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.devBusy = false;
        renderDevLab();
      }
    }

    async function generateDevSpriteBatch() {
      const taxonId = currentDevTaxonId();
      state.devBusy = true;
      renderDevLab();
      setStatus("Submitting one-sprite OpenAI batch for taxon " + taxonId);

      try {
        const res = await apiFetch("/api/taxa/" + encodeURIComponent(String(taxonId)) + "/sprites/dev-submit-batch", { method: "POST" });
        if (res.batchId) {
          state.devBatchId = res.batchId;
          els.devBatchIdInput.value = res.batchId;
          state.lastBatch = normalizeSubmittedBatch(res);
          saveLastBatch();
          scheduleBatchPolling();
        }
        await inspectDevLab(false);
        setStatus(res.submitted ? "Submitted sprite batch " + res.batchId : (res.message || "Sprite batch was not submitted."));
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.devBusy = false;
        renderDevLab();
      }
    }

    async function generateDevSvg() {
      const taxonId = currentDevTaxonId();
      state.devBusy = true;
      renderDevLab();
      setStatus("Generating dev SVG sprite for taxon " + taxonId);

      try {
        const res = await apiFetch("/api/taxa/" + encodeURIComponent(String(taxonId)) + "/sprites/dev-generate", { method: "POST" });
        await inspectDevLab(false);
        state.rosterStale = true;
        setStatus(res.generated ? "Generated dev SVG sprite." : (res.message || "Dev SVG sprite was not generated."));
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.devBusy = false;
        renderDevLab();
      }
    }

    async function syncDevSpriteBatch() {
      const batchId = String(els.devBatchIdInput.value || state.devBatchId || "").trim();
      if (!batchId) {
        setStatus("Enter a sprite batch ID.");
        return;
      }

      state.devBusy = true;
      renderDevLab();
      setStatus("Syncing sprite batch " + batchId);

      try {
        const res = await apiFetch("/api/sprite-batches/" + encodeURIComponent(batchId) + "/sync?maxItems=" + BATCH_SYNC_ITEM_LIMIT, { method: "POST" });
        state.devBatchId = batchId;
        const hydrated = await apiFetch("/api/sprite-batches/" + encodeURIComponent(batchId));
        state.lastBatch = normalizeBatchResponse(hydrated);
        saveLastBatch();
        await inspectDevLab(false);
        state.rosterStale = true;
        setStatus("Synced sprite batch " + batchId + ": " + Number(res.ready || 0) + " ready, " + Number(res.failed || 0) + " failed.");
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.devBusy = false;
        renderDevLab();
      }
    }

    function renderDevLab() {
      const busy = state.devBusy;
      els.devLabState.textContent = busy ? "busy" : "idle";
      els.devRandomButton.disabled = busy;
      els.devInspectButton.disabled = busy;
      els.devMovesButton.disabled = busy;
      els.devQueueSpriteButton.disabled = busy;
      els.devGenerateSpriteButton.disabled = busy;
      els.devGenerateSvgButton.disabled = busy;
      els.devSyncBatchButton.disabled = busy;
      els.devTaxonIdInput.disabled = busy;
      els.devBatchIdInput.disabled = busy;

      const lab = state.devLab;
      if (!lab) {
        els.devLabPanel.innerHTML = '<div class="empty">Enter a taxon ID.</div>';
        return;
      }

      const taxon = lab.taxon || {};
      const currentAsset = lab.asset || null;
      const previewAsset = currentAsset || lab.latestAsset || null;
      const job = lab.job || null;
      const batchId = job?.batchId || state.devBatchId || "";
      if (batchId && !els.devBatchIdInput.value) els.devBatchIdInput.value = batchId;
      const previewAnimation = state.devPreviewAnimation || "anim-idle";

      const spritePreview = previewAsset?.url
        ? renderSheetSprite(previewAsset.url, previewAnimation)
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(taxon.iconicTaxonName)) + '"></div>';
      const previewControls = renderDevPreviewControls(lab.moves || [], state.devPreviewKey || "row1");

      const assetLabel = currentAsset
        ? "current prompt"
        : previewAsset
          ? "latest sprite"
          : "no sprite";

      const movesHtml = Array.isArray(lab.moves) && lab.moves.length
        ? renderMoveRows(lab.moves)
        : '<div class="ability"><div><strong>No moves</strong><span>Generate moves first.</span></div></div>';

      const factsHtml = Array.isArray(lab.facts) && lab.facts.length
        ? lab.facts.map((fact) => '<div class="subtle">' + escapeHtml(fact) + '</div>').join("")
        : '<div class="subtle">No facts stored.</div>';

      els.devLabPanel.innerHTML =
        '<div class="dev-summary">' +
          '<div class="dev-output">' +
            '<div class="batch-item">' +
              '<strong>' + escapeHtml(taxon.name || "Taxon " + Number(taxon.taxonId || 0)) + '</strong>' +
              '<span><em>' + escapeHtml(taxon.scientificName || "") + '</em></span>' +
              '<span>taxon ' + Number(taxon.taxonId || 0) + ' / genome v' + Number(lab.genomeVersion || 0) + ' / prompt v' + Number(lab.promptVersion || 0) + '</span>' +
              '<span>prompt ' + escapeHtml(String(lab.promptHash || "").slice(0, 16)) + '</span>' +
            '</div>' +
            '<div class="batch-item">' +
              '<strong>Moves</strong>' +
              '<div>' + movesHtml + '</div>' +
            '</div>' +
            '<div class="batch-item">' +
              '<strong>Facts</strong>' +
              '<div>' + factsHtml + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="dev-output">' +
            '<div class="dev-sprite-preview">' + spritePreview + '</div>' +
            previewControls +
            '<div class="dev-meta-grid">' +
              '<div class="stat"><span class="subtle">Sprite</span><strong>' + escapeHtml(assetLabel) + '</strong></div>' +
              '<div class="stat"><span class="subtle">Job</span><strong>' + escapeHtml(job?.status || "none") + '</strong></div>' +
              '<div class="stat"><span class="subtle">Batch</span><strong>' + escapeHtml(batchId || "none") + '</strong></div>' +
              '<div class="stat"><span class="subtle">Source</span><strong>' + escapeHtml(previewAsset?.model || "none") + '</strong></div>' +
            '</div>' +
            (previewAsset?.url ? '<a class="manual-result-link" href="' + escapeAttr(previewAsset.url) + '" target="_blank" rel="noreferrer">Open Sprite</a>' : '') +
            (job?.error ? '<div class="subtle">' + escapeHtml(job.error) + '</div>' : '') +
          '</div>' +
        '</div>';
    }

    function renderDevPreviewControls(moves, activeKey) {
      const baseButtons = [
        { key: "row1", label: "Row 1", title: "Idle loop", anim: "anim-idle" },
        { key: "row2", label: "Row 2", title: "Movement loop", anim: "anim-move" }
      ];
      const moveButtons = (Array.isArray(moves) ? moves : []).slice(0, 4).map((move, index) => ({
        key: "move" + (index + 1),
        label: "Move " + (index + 1),
        title: move?.name || "Move " + (index + 1),
        anim: moveAnimationClass(move)
      }));
      const buttons = baseButtons.concat(moveButtons);

      return '<div class="dev-preview-controls">' + buttons.map((button) => (
        '<button class="secondary' + (button.key === activeKey ? ' active' : '') + '" type="button" ' +
          'data-dev-preview-key="' + escapeAttr(button.key) + '" data-dev-preview-anim="' + escapeAttr(button.anim) + '" title="' + escapeAttr(button.title) + '">' +
          escapeHtml(button.label) +
        '</button>'
      )).join("") + '</div>';
    }

    function moveAnimationClass(move) {
      if (move && Number(move.animRow) === 4) return "anim-special";
      if (move && Number(move.animRow) === 3) return "anim-attack";
      return move && move.category === "special" ? "anim-special" : "anim-attack";
    }

    function formatHomeNumber(value) {
      return Number(value || 0).toLocaleString();
    }

    function currentRosterSummary() {
      const summary = state.rosterSummary || {};
      const pageReady = state.taxa.filter((taxon) => taxon.sprite.status === "ready").length;
      const pagePending = state.taxa.filter((taxon) => ["queued", "running", "batch_submitted"].includes(taxon.sprite.status)).length;
      const totalCount = Number(summary.totalCount ?? state.rosterTotal ?? state.taxa.length);
      const readyCount = Number(summary.readyCount ?? pageReady);
      const pendingCount = Number(summary.pendingCount ?? pagePending);
      const failedCount = Number(summary.failedCount ?? 0);
      const missingCount = Number(summary.missingCount ?? Math.max(0, totalCount - readyCount - pendingCount - failedCount));

      return {
        totalCount,
        readyCount,
        pendingCount,
        failedCount,
        missingCount,
        observationTotal: Number(summary.observationTotal ?? state.taxa.reduce((sum, taxon) => sum + Number(taxon.obsCount || 0), 0)),
        affinityTotal: Number(summary.affinityTotal ?? state.taxa.reduce((sum, taxon) => sum + Number(affinityLevel(taxon) || 0), 0)),
        trainingSpent: Number(summary.trainingSpent ?? 0)
      };
    }

    function homeNextStep(summary, selectedCount) {
      if (!state.me || !state.me.loggedIn) {
        return {
          title: "Sign in with Bluesky",
          body: "Use the Bluesky panel to sign in before sending or accepting player challenges.",
          action: null,
          label: ""
        };
      }

      if (!state.me.inatLogin) {
        return {
          title: "Verify your iNaturalist account",
          body: "Use the Bluesky panel to create a profile code, verify ownership, and import your observations.",
          action: null,
          label: ""
        };
      }

      if (!summary.totalCount) {
        return {
          title: "Import your observations",
          body: "Enter your iNaturalist username in the top bar to build your species roster.",
          action: null,
          label: ""
        };
      }

      if (summary.readyCount < 5) {
        return {
          title: "Get five ready sprites",
          body: "You need at least five ready sprites to battle. Queue missing sprites or use the ready species already available.",
          action: "ready-roster",
          label: "Show Ready Species"
        };
      }

      if (selectedCount < 5) {
        return {
          title: "Pick your battle team",
          body: "Select " + (5 - selectedCount) + " more ready " + (5 - selectedCount === 1 ? "species" : "species") + " to open battle options.",
          action: "ready-roster",
          label: "Pick Ready Species"
        };
      }

      return {
        title: "Team ready",
        body: "Your five-species team is selected. Start an NPC battle or send a Bluesky challenge.",
        action: "start-battle",
        label: "Battle NPC"
      };
    }

    function renderHome() {
      if (!els.homeDashboard) return;

      if (state.me?.loggedIn && !state.me.inatLogin) {
        els.homeDashboard.innerHTML = renderOnboardingHome();
        return;
      }

      const summary = currentRosterSummary();
      const selectedCount = state.selectedTaxa.size;
      const readyPct = summary.totalCount > 0 ? Math.round((summary.readyCount / summary.totalCount) * 100) : 0;
      const next = homeNextStep(summary, selectedCount);
      const handle = state.me?.handle ? "@" + state.me.handle : (state.inatLogin ? "@" + state.inatLogin : "Field naturalist");
      const groupText = state.rosterIconicCounts.length
        ? state.rosterIconicCounts.slice(0, 4).map((row) => row.iconic + " " + row.count).join(" / ")
        : "Import a roster to see your largest groups.";

      els.homeDashboard.innerHTML =
        '<section class="home-hero-card">' +
          '<div class="home-copy">' +
            '<div class="subtle">Player Home</div>' +
            '<h2>' + escapeHtml(handle) + '</h2>' +
            '<p>Manage your observed-species roster, pick a five-creature team, train favorites, and jump into battles without scrolling through the full collection first.</p>' +
            '<div class="home-actions">' +
              '<button class="primary" type="button" data-home-action="ready-roster">Pick Team</button>' +
              '<button class="secondary" type="button" data-home-action="training">Training</button>' +
              '<button class="secondary" type="button" data-home-action="recent">Recently Added</button>' +
            '</div>' +
          '</div>' +
          '<div class="home-next">' +
            '<span class="subtle">Next Action</span>' +
            '<strong>' + escapeHtml(next.title) + '</strong>' +
            '<p>' + escapeHtml(next.body) + '</p>' +
            (next.action ? '<button class="primary" type="button" data-home-action="' + escapeAttr(next.action) + '">' + escapeHtml(next.label) + '</button>' : '') +
          '</div>' +
        '</section>' +
        '<section class="home-metrics" aria-label="Roster summary">' +
          renderHomeMetric("Taxa", summary.totalCount, "Imported species") +
          renderHomeMetric("Ready", summary.readyCount, readyPct + "% battle-art ready") +
          renderHomeMetric("Queued", summary.pendingCount, "Sprite jobs active") +
          renderHomeMetric("Missing", summary.missingCount, "Need generated art") +
        '</section>' +
        '<section class="home-panels">' +
          '<div class="home-panel wide">' +
            '<div>' +
              '<h3>Battle Team</h3>' +
              '<p>' + selectedCount + ' / 5 ready species selected.</p>' +
            '</div>' +
            renderHomeTeamSlots() +
            '<div class="home-actions">' +
              '<button class="secondary" type="button" data-home-action="ready-roster">Edit Team</button>' +
              '<button class="primary" type="button" data-home-action="start-battle"' + (selectedCount === 5 ? "" : " disabled") + '>Battle NPC</button>' +
            '</div>' +
          '</div>' +
          '<div class="home-panel wide">' +
            '<div>' +
              '<h3>Ready Picks</h3>' +
              '<p>Quick-add ready species from the current roster page.</p>' +
            '</div>' +
            renderHomeReadyPicks() +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Roster Progress</h3>' +
            '<p>' + formatHomeNumber(summary.readyCount) + ' of ' + formatHomeNumber(summary.totalCount) + ' imported taxa have ready sprites.</p>' +
            '<div class="home-progress" aria-label="Ready sprite progress"><span style="--progress:' + Math.max(0, Math.min(100, readyPct)) + '%"></span></div>' +
            '<p class="subtle">' + escapeHtml(groupText) + '</p>' +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Training</h3>' +
            '<p>' + formatHomeNumber(summary.trainingSpent) + ' points spent. ' + formatHomeNumber(summary.affinityTotal) + ' total roster affinity.</p>' +
            '<button class="secondary" type="button" data-home-action="training">Open Training</button>' +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Sprite Library</h3>' +
            '<p>Browse the shared tree or inspect the newest global sprites added to the game.</p>' +
            '<div class="home-actions">' +
              '<button class="secondary" type="button" data-home-action="recent">Recent</button>' +
              '<button class="secondary" type="button" data-home-action="dev">Dev Lab</button>' +
            '</div>' +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Observations</h3>' +
            '<p>' + formatHomeNumber(summary.observationTotal) + ' imported observations across your current roster.</p>' +
            '<button class="secondary" type="button" data-home-action="roster">Open Roster</button>' +
          '</div>' +
        '</section>';
    }

    function renderHomeMetric(label, value, detail) {
      return '<div class="home-metric">' +
        '<span class="subtle">' + escapeHtml(label) + '</span>' +
        '<strong>' + formatHomeNumber(value) + '</strong>' +
        '<span class="subtle">' + escapeHtml(detail) + '</span>' +
      '</div>';
    }

    function renderHomeTeamSlots() {
      const ids = Array.from(state.selectedTaxa);
      const slots = [];
      for (let index = 0; index < 5; index += 1) {
        const taxonId = ids[index];
        const taxon = taxonId ? state.taxa.find((candidate) => String(candidate.taxonId) === String(taxonId)) : null;
        if (!taxonId) {
          slots.push('<div class="home-team-slot empty"><div class="home-slot-index">' + (index + 1) + '</div><div><strong>Open slot</strong><span>Select a ready species</span></div></div>');
        } else if (taxon) {
          slots.push('<div class="home-team-slot">' +
            renderHomeThumb(taxon) +
            '<div><strong>' + escapeHtml(taxon.name || taxon.scientificName || "Selected species") + '</strong><span><em>' + escapeHtml(taxon.scientificName || "") + '</em></span></div>' +
            '<span class="subtle">' + escapeHtml((taxon.types || []).join(" / ")) + '</span>' +
          '</div>');
        } else {
          slots.push('<div class="home-team-slot empty"><div class="home-slot-index">' + (index + 1) + '</div><div><strong>Selected taxon ' + escapeHtml(String(taxonId)) + '</strong><span>Open roster page for details</span></div></div>');
        }
      }
      return '<div class="home-team-slots">' + slots.join("") + '</div>';
    }

    function renderHomeReadyPicks() {
      const picks = state.taxa
        .filter((taxon) => taxon.sprite?.status === "ready" && !state.selectedTaxa.has(String(taxon.taxonId)))
        .slice(0, 5);

      if (!picks.length) {
        return '<p class="subtle">No unselected ready species on this page. Open the ready roster filter to browse more.</p>' +
          '<button class="secondary" type="button" data-home-action="ready-roster">Browse Ready Species</button>';
      }

      return '<div class="home-ready-list">' + picks.map((taxon) => (
        '<button class="home-ready-item" type="button" data-home-add-taxon="' + escapeAttr(String(taxon.taxonId)) + '">' +
          renderHomeThumb(taxon) +
          '<div><strong>' + escapeHtml(taxon.name || taxon.scientificName || "Ready species") + '</strong><span><em>' + escapeHtml(taxon.scientificName || "") + '</em> / ' + Number(taxon.obsCount || 0) + ' obs</span></div>' +
          '<span class="subtle">Add</span>' +
        '</button>'
      )).join("") + '</div>';
    }

    function renderHomeThumb(taxon) {
      if (taxon.sprite?.url) {
        return '<div class="home-ready-thumb">' + renderSheetSprite(taxon.sprite.url, "anim-idle") + '</div>';
      }
      return '<div class="home-ready-thumb">' + escapeHtml((taxon.iconicTaxonName || "Life").slice(0, 1).toUpperCase()) + '</div>';
    }

    function renderOnboardingHome() {
      const me = state.me || {};
      const busyAttr = state.bskyBusy ? " disabled" : "";
      const pendingLogin = me.inatPendingLogin || "";
      const hasCode = Boolean(me.inatPendingLogin && me.inatVerificationCode);

      return '<section class="onboarding-card">' +
        '<div class="onboarding-copy">' +
          '<div class="subtle">Setup</div>' +
          '<h2>Link your field life.</h2>' +
          '<p>You are signed in with Bluesky. One quick iNaturalist verification connects your real observations to the game roster.</p>' +
          '<div class="onboarding-steps">' +
            renderOnboardingStep("1", "Bluesky connected", "Signed in as @" + (me.handle || "Bluesky"), "complete") +
            renderOnboardingStep("2", "Choose iNaturalist username", "Enter the public iNaturalist account you want to battle with.", hasCode ? "complete" : "active") +
            renderOnboardingStep("3", "Paste code and verify", "Add the code to your iNaturalist profile bio, verify here, then remove it.", hasCode ? "active" : "") +
          '</div>' +
        '</div>' +
        '<div class="onboarding-form">' +
          '<h3>Verify iNaturalist</h3>' +
          renderBskyStatus() +
          '<label>iNaturalist username' +
            '<input id="homeInatLinkInput" data-inat-link-input="1" data-bsky-enter="inat-start" placeholder="mmulqueen" value="' + escapeAttr(pendingLogin) + '">' +
          '</label>' +
          '<button class="secondary" type="button" data-bsky-action="inat-start"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "inat-start" ? "Creating code..." : (hasCode ? "Refresh Code" : "Get Verification Code")) +
          '</button>' +
          (hasCode
            ? '<div class="onboarding-code">' +
                '<span class="subtle">Add this code to your iNaturalist profile bio</span>' +
                '<strong>' + escapeHtml(me.inatVerificationCode) + '</strong>' +
                '<span class="subtle">Use iNaturalist settings for "' + escapeHtml(pendingLogin) + '", save, then verify below.</span>' +
              '</div>' +
              '<a class="manual-result-link" href="https://www.inaturalist.org/users/edit" target="_blank" rel="noopener">Open iNaturalist settings</a>' +
              '<button class="primary" type="button" data-bsky-action="inat-confirm"' + busyAttr + '>' +
                (state.bskyBusy && state.bskyAction === "inat-confirm" ? "Verifying..." : "Verify and Import") +
              '</button>'
            : '<p>No iNaturalist password or write access needed. The temporary bio code only proves that the public profile is yours.</p>') +
        '</div>' +
      '</section>';
    }

    function renderOnboardingStep(index, title, body, stateClass) {
      const className = stateClass ? " " + stateClass : "";
      const marker = index;
      return '<div class="onboarding-step' + className + '">' +
        '<div class="onboarding-step-index">' + escapeHtml(marker) + '</div>' +
        '<div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(body) + '</span></div>' +
      '</div>';
    }

    function render() {
      renderLanding();
      els.accountLabel.textContent = state.inatLogin ? "@" + state.inatLogin : "No roster loaded";

      const hasFilters = Boolean(state.rosterSearch || state.rosterIconic || state.rosterStatus !== "all");
      els.emptyState.style.display = state.taxa.length ? "none" : "grid";
      els.emptyState.textContent = hasFilters
        ? "No roster creatures match these filters."
        : "Link your iNaturalist account, then import your roster.";
      els.rosterGrid.classList.toggle("sprite-mode", state.rosterMode === "sprites");
      els.rosterModeButton.textContent = state.rosterMode === "sprites" ? "Card View" : "Sprite Grid";
      els.rosterGrid.innerHTML = state.taxa
        .map(state.rosterMode === "sprites" ? renderSpriteTile : renderCard)
        .join("");
      renderTypeChips();
      renderRosterPagination();

      const summary = currentRosterSummary();
      const selectedCount = state.selectedTaxa.size;

      els.taxaCount.textContent = String(summary.totalCount || state.rosterTotal || state.taxa.length);
      els.spriteCount.textContent = String(summary.readyCount);
      els.queuedCount.textContent = String(summary.pendingCount);
      els.bondCount.textContent = String(summary.affinityTotal);
      els.teamCount.textContent = selectedCount + " / 5 selected";
      els.clearTeamButton.disabled = selectedCount === 0;
      els.startBattleButton.disabled = !state.userId || selectedCount !== 5;
      els.queueMoreButton.disabled = !state.userId;
      els.batchPreviewButton.disabled = !state.userId;
      els.batchSubmitButton.disabled = !state.userId || state.batchJobs.length === 0;
      els.refreshLabel.textContent = state.rosterTotal
        ? (state.rosterTotal > ROSTER_PAGE_SIZE
          ? rosterRangeLabel() + " of " + state.rosterTotal
          : String(state.rosterTotal) + " species")
        : "";
      renderBatchQueue();
      renderGlobalSeedQueue();
      renderViewTabs();
      renderHome();
      renderSpriteTree();
      renderRecentSprites();
      renderDevLab();
      renderBattle();
    }

    function rosterRangeLabel() {
      const start = (state.rosterPage - 1) * ROSTER_PAGE_SIZE + 1;
      const end = Math.min(state.rosterTotal, start + state.taxa.length - 1);
      return start + "–" + end;
    }

    function renderRosterPagination() {
      const pageCount = Math.max(1, Math.ceil(state.rosterTotal / ROSTER_PAGE_SIZE));
      if (state.rosterTotal <= ROSTER_PAGE_SIZE) {
        els.rosterPagination.innerHTML = "";
        return;
      }

      els.rosterPagination.innerHTML =
        '<button class="secondary" type="button" data-roster-page="prev"' +
          (state.rosterPage <= 1 ? " disabled" : "") + '>&larr; Prev</button>' +
        '<span class="subtle">Page ' + state.rosterPage + ' of ' + pageCount +
          ' &middot; ' + state.rosterTotal + ' species</span>' +
        '<button class="secondary" type="button" data-roster-page="next"' +
          (state.rosterPage >= pageCount ? " disabled" : "") + '>Next &rarr;</button>';
    }

    function renderTypeChips() {
      const counts = state.rosterIconicCounts;
      if (!Array.isArray(counts) || counts.length < 2) {
        els.rosterTypeChips.innerHTML = "";
        return;
      }

      els.rosterTypeChips.innerHTML = counts.map((row) =>
        '<button type="button" class="type-chip' + (state.rosterIconic === row.iconic ? " active" : "") +
          '" data-type-chip="' + escapeAttr(row.iconic) + '">' +
          escapeHtml(row.iconic) + ' <span class="subtle">' + Number(row.count) + '</span>' +
        '</button>'
      ).join("");
    }

    function renderSpriteTile(taxon) {
      const status = taxon.sprite.status;
      const isReady = status === "ready";
      const taxonId = String(taxon.taxonId);
      const isSelected = state.selectedTaxa.has(taxonId);
      const imageUrl = isReady ? taxon.sprite.url : taxon.defaultPhotoUrl;
      const image = isReady && imageUrl
        ? renderSheetSprite(imageUrl, "anim-idle")
        : imageUrl
        ? '<img alt="" loading="lazy" src="' + escapeAttr(imageUrl) + '">'
        : '<div class="placeholder-shape placeholder-' + escapeAttr(taxon.sprite.placeholder || "unknown") + '"></div>';

      return '<article class="sprite-tile ' + (isSelected ? "selected " : "") + (!isReady ? "unselectable" : "") +
        '" data-taxon-card data-taxon-id="' + escapeAttr(taxonId) + '" tabindex="0" role="button" aria-pressed="' + String(isSelected) +
        '" aria-label="' + escapeAttr((taxon.nickname || taxon.name || taxon.scientificName || "Taxon") + " combat selection") + '">' +
        '<div class="sprite-tile-art">' + image + '</div>' +
        (!isReady ? '<span class="badge">' + escapeHtml(status) + '</span>' : '') +
        '<div class="select-mark" aria-hidden="true">' + (isSelected ? "OK" : "") + '</div>' +
        '<div class="sprite-tile-caption">' + escapeHtml(taxon.nickname || taxon.name || taxon.scientificName || "") +
          '<span class="subtle">' + escapeHtml(taxon.scientificName || "") + '</span>' +
        '</div>' +
      '</article>';
    }

    // Phase 2: mobile taxonomic navigator. Vertical = depth (breadcrumb trunk +
    // drill down), horizontal swipe = sibling clades at the current rank
    // (scroll-snap carousel). Genus level becomes a gallery of animated sprites.
    function renderSpriteTree() {
      const tree = state.spriteTree;

      if (!tree) {
        els.treeRefreshLabel.textContent = "";
        els.spriteTreePanel.innerHTML = '<div class="empty">Open this tab to load the ready sprite tree.</div>';
        return;
      }

      els.treeRefreshLabel.textContent = Number(tree.totalSprites || 0) + " ready sprites";

      if (!Array.isArray(tree.roots) || tree.roots.length === 0) {
        els.spriteTreePanel.innerHTML = '<div class="empty">No ready sprites match this search.</div>';
        return;
      }

      // Search mode: a flat gallery of every matched species (lineage nav off).
      if (String(tree.q || "").trim()) {
        const matched = collectTreeLeaves(tree.roots);
        els.spriteTreePanel.innerHTML =
          '<div class="tree-summary">' + treeSummaryText(tree) + '</div>' +
          (matched.length
            ? renderTreeGallery(matched)
            : '<div class="empty">No ready sprites match this search.</div>');
        return;
      }

      const node = treeNodeByPath(tree.roots, state.treePath);
      const group = treeGroupToken(tree.roots, state.treePath);
      const branches = (node.children || []).filter((c) => !c.leaf);
      const leaves = (node.children || []).filter((c) => c.leaf);

      els.spriteTreePanel.innerHTML =
        '<div class="tree-nav" data-group="' + escapeAttr(group) + '">' +
          renderTreeBreadcrumb(tree.roots, state.treePath) +
          renderTreeFocusHeader(node) +
          (branches.length ? renderTreeCarousel(branches) : "") +
          (leaves.length ? renderTreeGallery(leaves) : "") +
          (!branches.length && !leaves.length ? '<div class="empty">Nothing here yet.</div>' : "") +
        '</div>';
    }

    function syncTreePath(tree, query, previousQuery) {
      const roots = Array.isArray(tree?.roots) ? tree.roots : [];
      const root = roots[0];
      if (!root) { state.treePath = []; return; }
      if (String(query || "") !== String(previousQuery || "") || !treePathResolves(roots, state.treePath)) {
        state.treePath = [String(root.key)];
      }
    }

    function treePathResolves(roots, path) {
      if (!Array.isArray(path) || path.length === 0) return false;
      const root = roots[0];
      if (!root || String(path[0]) !== String(root.key)) return false;
      let node = root;
      for (let i = 1; i < path.length; i += 1) {
        const next = (node.children || []).find((c) => !c.leaf && String(c.key) === String(path[i]));
        if (!next) return false;
        node = next;
      }
      return true;
    }

    function treeNodeByPath(roots, path) {
      let node = roots[0];
      for (let i = 1; i < (path || []).length; i += 1) {
        const next = (node.children || []).find((c) => !c.leaf && String(c.key) === String(path[i]));
        if (!next) break;
        node = next;
      }
      return node;
    }

    // Kingdom (path[1]) -> a stable token used for per-group color theming.
    function treeGroupToken(roots, path) {
      if (!Array.isArray(path) || path.length < 2) return "life";
      const kingdom = (roots[0].children || []).find((c) => String(c.key) === String(path[1]));
      const name = String(kingdom?.name || kingdom?.scientificName || "").toLowerCase();
      if (name.includes("animal")) return "animals";
      if (name.includes("plant")) return "plants";
      if (name.includes("fungi")) return "fungi";
      return "other";
    }

    function renderTreeBreadcrumb(roots, path) {
      const crumbs = [];
      let node = roots[0];
      crumbs.push({ name: node.name || "Life", idx: 0 });
      for (let i = 1; i < path.length; i += 1) {
        const next = (node.children || []).find((c) => !c.leaf && String(c.key) === String(path[i]));
        if (!next) break;
        node = next;
        crumbs.push({ name: node.name || "Taxon", idx: i });
      }
      return '<nav class="tree-breadcrumb" aria-label="Lineage">' +
        crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return '<button type="button" class="tree-crumb' + (last ? " current" : "") + '"' +
              ' data-tree-nav="' + c.idx + '"' + (last ? ' aria-current="true"' : "") + '>' +
              escapeHtml(c.name) +
            '</button>' +
            (last ? "" : '<span class="tree-crumb-sep" aria-hidden="true">&rsaquo;</span>');
        }).join("") +
      '</nav>';
    }

    function renderTreeFocusHeader(node) {
      const rank = node.rank && node.rank !== "root" ? node.rank : "life";
      const branchCount = (node.children || []).filter((c) => !c.leaf).length;
      const sub = branchCount
        ? branchCount + " " + childRankPlural(node) + " · " + Number(node.spriteCount || 0) + " sprites"
        : Number(node.spriteCount || 0) + " sprites";
      return '<div class="tree-focus">' +
        '<span class="tree-focus-rank">' + escapeHtml(rank) + '</span>' +
        '<span class="tree-focus-name">' + escapeHtml(node.name || "Life") + '</span>' +
        '<span class="tree-focus-sub">' + escapeHtml(sub) + '</span>' +
      '</div>';
    }

    function childRankPlural(node) {
      const child = (node.children || []).find((c) => !c.leaf);
      const map = {
        kingdom: "kingdoms", phylum: "phyla", class: "classes",
        order: "orders", family: "families", genus: "genera"
      };
      return map[child?.rank] || "groups";
    }

    function renderTreeCarousel(branches) {
      return '<div class="tree-carousel" role="list">' +
        branches.map(renderTreeCard).join("") +
      '</div>';
    }

    function renderTreeCard(branch) {
      const preview = collectTreeLeaves([branch], 1)[0];
      const art = preview && preview.sprite?.url
        ? renderSheetSprite(preview.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(branch.iconicTaxonName)) + '"></div>';
      return '<button type="button" class="tree-card" role="listitem" data-tree-descend="' + escapeAttr(String(branch.key)) + '">' +
        '<span class="tree-card-art">' + art + '</span>' +
        '<span class="tree-card-name">' + escapeHtml(branch.name || "Taxon") + '</span>' +
        '<span class="tree-card-meta">' + escapeHtml(branch.rank || "") + ' · ' + Number(branch.spriteCount || 0) + '</span>' +
      '</button>';
    }

    function renderTreeGallery(leaves) {
      return '<div class="tree-gallery" role="list">' +
        leaves.map(renderTreeMedallion).join("") +
      '</div>';
    }

    function renderTreeMedallion(leaf) {
      const art = leaf.sprite?.url
        ? renderSheetSprite(leaf.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(leaf.iconicTaxonName)) + '"></div>';
      const title = (leaf.scientificName || "") + " · taxon " + Number(leaf.taxonId || 0);
      return '<a class="tree-medallion" role="listitem" href="' + escapeAttr(leaf.sprite?.url || "#") + '"' +
          ' target="_blank" rel="noreferrer" title="' + escapeAttr(title) + '">' +
        '<span class="tree-medallion-art">' + art + '</span>' +
        '<span class="tree-medallion-name">' + escapeHtml(leaf.name || leaf.scientificName || "Unnamed") + '</span>' +
        '<span class="tree-medallion-sci"><em>' + escapeHtml(leaf.scientificName || "") + '</em></span>' +
      '</a>';
    }

    // Depth-first collection of leaf (species) descendants, optionally capped.
    function collectTreeLeaves(nodes, limit) {
      const out = [];
      const visit = (n) => {
        if (limit && out.length >= limit) return;
        if (n.leaf) { out.push(n); return; }
        for (const child of n.children || []) {
          if (limit && out.length >= limit) break;
          visit(child);
        }
      };
      for (const n of nodes || []) {
        if (limit && out.length >= limit) break;
        visit(n);
      }
      return out;
    }

    function renderRecentSprites() {
      const recent = state.recentSprites;

      if (!recent) {
        els.recentRefreshLabel.textContent = "";
        els.recentSpritesPanel.innerHTML = '<div class="empty">Open this tab to load recently added sprites.</div>';
        return;
      }

      const allSprites = Array.isArray(recent.sprites) ? recent.sprites : [];
      els.recentRefreshLabel.textContent = Number(recent.totalSprites || allSprites.length) + " newest sprites";
      syncRecentGroupFilter(allSprites);

      let sprites = state.recentGroup === "all"
        ? allSprites.slice()
        : allSprites.filter((item) => (item.iconicTaxonName || "Life") === state.recentGroup);

      const createdMs = (item) => {
        const time = new Date(item.sprite?.createdAt || 0).getTime();
        return Number.isNaN(time) ? 0 : time;
      };
      if (state.recentSort === "oldest") sprites.sort((a, b) => createdMs(a) - createdMs(b));
      else if (state.recentSort === "name") {
        sprites.sort((a, b) => String(a.name || a.scientificName || "").localeCompare(String(b.name || b.scientificName || "")));
      } else sprites.sort((a, b) => createdMs(b) - createdMs(a));

      if (sprites.length === 0) {
        els.recentSpritesPanel.innerHTML = '<div class="empty">No ready sprites match this search.</div>';
        return;
      }

      els.recentSpritesPanel.innerHTML =
        '<div class="tree-summary">' + recentSummaryText(recent) + '</div>' +
        '<div class="recent-grid" role="list">' +
          sprites.map(renderRecentSprite).join("") +
        '</div>';
    }

    function syncRecentGroupFilter(sprites) {
      const groups = [...new Set(sprites.map((item) => item.iconicTaxonName || "Life"))].sort();
      if (state.recentGroup !== "all" && !groups.includes(state.recentGroup)) state.recentGroup = "all";

      els.recentGroupFilter.innerHTML =
        '<option value="all">All groups</option>' +
        groups.map((group) =>
          '<option value="' + escapeAttr(group) + '"' + (state.recentGroup === group ? " selected" : "") + '>' +
            escapeHtml(group) +
          '</option>'
        ).join("");
    }

    function recentSummaryText(recent) {
      const q = String(recent.q || "").trim();
      const total = Number(recent.totalSprites || 0);
      if (q) return total + ' newest ready sprites matching "' + escapeHtml(q) + '"';
      return total + " newest ready sprites, newest first";
    }

    function renderRecentSprite(item) {
      const sprite = item.sprite?.url
        ? renderSheetSprite(item.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(item.iconicTaxonName)) + '"></div>';
      const createdAt = formatRecentSpriteDate(item.sprite?.createdAt);
      const model = item.sprite?.model || "sprite";
      const dimensions = item.sprite?.width && item.sprite?.height
        ? Number(item.sprite.width) + "x" + Number(item.sprite.height)
        : "";
      const meta = [
        escapeHtml((item.rank || "taxon") + " / " + (item.iconicTaxonName || "Life")),
        "taxon " + Number(item.taxonId || 0),
        escapeHtml(model),
        escapeHtml(dimensions)
      ].filter(Boolean).join(" / ");

      return '<div class="recent-tile" role="listitem">' +
        '<div class="sprite-tile-art">' + sprite + '</div>' +
        '<a class="manual-result-link" href="' + escapeAttr(item.sprite?.url || "#") + '" target="_blank" rel="noreferrer">Open</a>' +
        '<div class="sprite-tile-caption" title="' + escapeAttr(meta) + '">' +
          escapeHtml(item.name || item.scientificName || "Unnamed taxon") +
          '<span class="subtle"><em>' + escapeHtml(item.scientificName || "") + '</em></span>' +
          '<span class="subtle">added ' + escapeHtml(createdAt) + '</span>' +
        '</div>' +
      '</div>';
    }

    function formatRecentSpriteDate(value) {
      if (!value) return "unknown";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    }

    function treeSummaryText(tree) {
      const q = String(tree.q || "").trim();
      const total = Number(tree.totalSprites || 0);
      if (q) return total + ' ready sprites matching "' + escapeHtml(q) + '"';
      return total + " ready sprites by taxonomic branch";
    }

    async function loadBatchQueue(showStatus) {
      if (!state.userId) return;

      const res = await apiFetch(
        "/api/sprite-jobs?status=queued&userId=" +
          encodeURIComponent(state.userId) +
          "&limit=" +
          DEV_BATCH_SUBMIT_LIMIT
      );
      state.batchJobs = res.jobs || [];

      if (showStatus) {
        setStatus(state.batchJobs.length
          ? state.batchJobs.length + " queued sprite jobs ready for batch"
          : "No queued batch jobs. Click Queue More first.");
      }

      renderBatchQueue();
    }

    async function hydrateGlobalSeedStatus() {
      try {
        const res = await apiFetch("/api/global-seed/status");
        state.seedStatus = res || null;
        await loadGlobalSeedQueue();
      } catch (error) {
        console.warn("Could not hydrate global seed status", error);
        renderGlobalSeedQueue();
      }
    }

    async function loadGlobalSeedQueue() {
      try {
        const status = await apiFetch("/api/global-seed/status");
        const queue = await apiFetch("/api/global-seed/jobs?limit=" + GLOBAL_SEED_BATCH_LIMIT);
        state.seedStatus = status || null;
        state.seedJobs = queue.jobs || [];
        renderGlobalSeedQueue();
      } catch (error) {
        setStatus("Global seed status failed: " + error.message);
        renderGlobalSeedQueue();
      }
    }

    function renderBatchQueue() {
      const count = state.batchJobs.length;
      els.batchQueueCount.textContent = count + " queued";
      els.batchSubmitButton.disabled = !state.userId || count === 0;

      if (state.lastBatch) {
        els.batchQueueList.innerHTML = '<div class="batch-item">' +
          '<strong>Last batch</strong>' +
          '<span>' + escapeHtml(state.lastBatch.batchId) + '</span>' +
          '<span>' + escapeHtml(batchStatusText(state.lastBatch)) + '</span>' +
          (state.batchSyncing ? '<span>Syncing outputs to R2...</span>' : '') +
        '</div>' + (count
          ? '<div class="batch-item"><strong>Pending next batch</strong><span>' + count + ' queued sprites are not in the last synced batch.</span></div>' + renderBatchJobList(state.batchJobs)
          : "");
        return;
      }

      if (!state.userId) {
        els.batchQueueList.textContent = "Load a roster, then click Queue More.";
        return;
      }

      if (count === 0) {
        els.batchQueueList.textContent = "No queued jobs. Click Queue More to prepare sprites for batch.";
        return;
      }

      els.batchQueueList.innerHTML = renderBatchJobList(state.batchJobs);
    }

    function renderGlobalSeedQueue() {
      const count = state.seedJobs.length;
      els.seedQueueCount.textContent = count + " queued";
      els.seedSubmitButton.disabled = count === 0;

      const status = state.seedStatus;
      if (!status || Number(status.totals?.seedCount || 0) === 0) {
        els.seedQueueList.textContent = "Click Import Plants + Animals to load the top seed taxa from iNaturalist.";
        return;
      }

      const totals = status.totals || {};
      const summary = '<div class="batch-item">' +
        '<strong>Seed catalog</strong>' +
        '<span>' + Number(totals.seedCount || 0) + ' taxa / ' +
          Number(totals.readyCount || 0) + ' ready / ' +
          Number(totals.batchSubmittedCount || 0) + ' submitted / ' +
          Number(totals.queuedCount || 0) + ' queued / ' +
          Number(totals.missingCount || 0) + ' missing</span>' +
        renderSeedGroupStatus(status.groups || []) +
      '</div>';

      els.seedQueueList.innerHTML = summary + (count
        ? '<div class="batch-item"><strong>Next seed batch</strong><span>' + count + ' queued sprites ready to submit.</span></div>' + renderBatchJobList(state.seedJobs)
        : '<div class="batch-item"><strong>No queued seed jobs</strong><span>Click Queue 200 to prepare the next missing global seed sprites.</span></div>');
    }

    function renderSeedGroupStatus(groups) {
      return groups.map((group) => (
        '<span>' + escapeHtml(group.label || group.key) + ': ' +
        Number(group.seedCount || 0) + ' taxa, ' +
        Number(group.readyCount || 0) + ' ready, ' +
        Number(group.missingCount || 0) + ' missing</span>'
      )).join("");
    }

    async function uploadManualSprite() {
      const file = els.manualSpriteFile.files && els.manualSpriteFile.files[0];
      const hasTaxonLabel = els.manualTaxonId.value.trim() ||
        els.manualScientificName.value.trim() ||
        els.manualCommonName.value.trim();

      if (!file) {
        setStatus("Choose a sprite sheet image first.");
        return;
      }

      if (!hasTaxonLabel) {
        setStatus("Add a taxon ID, scientific name, or common name.");
        return;
      }

      const formData = new FormData(els.manualSpriteForm);
      formData.set("addToRoster", els.manualAddToRoster.checked ? "true" : "false");
      if (state.userId) formData.set("userId", state.userId);

      setBusy(true, "Uploading manual sprite");
      els.manualUploadState.textContent = "uploading";

      try {
        const result = await apiFetch("/api/manual-sprites/upload", {
          method: "POST",
          body: formData
        });

        els.manualUploadState.textContent = "ready";
        els.manualUploadResult.innerHTML = renderManualUploadResult(result);
        setStatus("Uploaded manual sprite for " + (result.commonName || result.scientificName));

        if (state.userId) {
          await loadRoster();
        }

        if (state.activeView === "tree") {
          await loadSpriteTree(false);
        }
      } catch (error) {
        els.manualUploadState.textContent = "failed";
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    function renderManualUploadResult(result) {
      const size = result.width && result.height
        ? result.width + " x " + result.height
        : "size unknown";

      return '<div class="batch-item">' +
        '<strong>' + escapeHtml(result.commonName || result.scientificName || "Uploaded sprite") + '</strong>' +
        '<span><em>' + escapeHtml(result.scientificName || "") + '</em></span>' +
        '<span>taxon ' + Number(result.taxonId || 0) + ' / ' + escapeHtml(size) + ' / ' + escapeHtml(result.contentType || "") + '</span>' +
        renderUploadMovesSummary(result.moves) +
        '<a class="manual-result-link" href="' + escapeAttr(result.url || "#") + '" target="_blank" rel="noreferrer">Open asset</a>' +
      '</div>';
    }

    function renderUploadMovesSummary(moves) {
      if (!moves) return "";
      if (moves.skipped) {
        return '<span class="subtle">Existing species moves kept.</span>';
      }
      if (!moves.generated) {
        return '<span class="subtle">Moves not generated: ' + escapeHtml(moves.error || "unknown error") + '</span>';
      }
      const names = Array.isArray(moves.signatureMoves) && moves.signatureMoves.length
        ? moves.signatureMoves.join(", ")
        : "signature moves";
      return '<span class="subtle">' +
        (moves.imageConditioned ? "Image-conditioned moves: " : "Moves regenerated: ") +
        escapeHtml(names) +
      '</span>';
    }

    async function hydrateBatchTracker() {
      if (state.lastBatch && state.lastBatch.batchId) {
        renderBatchQueue();
        await refreshBatchStatus(false);
        return;
      }

      try {
        const latest = await apiFetch("/api/sprite-batches/latest");
        const summary = normalizeBatchStatus(latest);
        if (!summary) return;

        state.lastBatch = summary;
        saveLastBatch();
        renderBatchQueue();

        if (summary.status === "completed" && !summary.synced) {
          await syncLastBatch(false);
        } else if (isActiveBatchStatus(summary.status)) {
          scheduleBatchPolling(5000);
        }
      } catch (error) {
        console.warn("Could not hydrate batch tracker", error);
      }
    }

    async function refreshBatchStatus(showStatus) {
      if (!state.lastBatch || !state.lastBatch.batchId) return;

      try {
        const res = await apiFetch("/api/sprite-batches/" + encodeURIComponent(state.lastBatch.batchId));
        state.lastBatch = normalizeBatchStatus(res) || state.lastBatch;
        saveLastBatch();
        renderBatchQueue();

        if (state.lastBatch.status === "completed" && !state.lastBatch.synced) {
          await syncLastBatch(true);
          return;
        }

        if (showStatus) {
          setStatus(batchStatusText(state.lastBatch));
        }

        if (isActiveBatchStatus(state.lastBatch.status)) {
          scheduleBatchPolling(BATCH_POLL_MS);
        }
      } catch (error) {
        setStatus("Batch status check failed: " + error.message);
        scheduleBatchPolling(BATCH_POLL_MS);
      }
    }

    async function syncLastBatch(showStatus) {
      if (!state.lastBatch || !state.lastBatch.batchId || state.batchSyncing) return;

      state.batchSyncing = true;
      renderBatchQueue();

      try {
        const res = await apiFetch(
          "/api/sprite-batches/" +
            encodeURIComponent(state.lastBatch.batchId) +
            "/sync?maxItems=" +
            BATCH_SYNC_ITEM_LIMIT,
          {
          method: "POST"
          }
        );

        if (res.synced) {
          state.lastBatch = {
            ...state.lastBatch,
            status: res.status || state.lastBatch.status,
            synced: true,
            ready: Number(res.ready ?? 0),
            failed: Number(res.failed ?? 0),
            itemCount: Number(res.itemCount ?? state.lastBatch.itemCount ?? 0),
            requestCounts: res.requestCounts || state.lastBatch.requestCounts || null
          };
          saveLastBatch();
          setStatus("Batch synced: " + state.lastBatch.ready + " sprites ready, " + state.lastBatch.failed + " failed");
          await loadBatchQueue();
          await loadRoster();
        } else {
          state.lastBatch = {
            ...state.lastBatch,
            status: res.status || state.lastBatch.status,
            synced: false,
            ready: Number(res.ready ?? state.lastBatch.ready ?? 0),
            failed: Number(res.failed ?? state.lastBatch.failed ?? 0),
            itemCount: Number(res.itemCount ?? state.lastBatch.itemCount ?? 0),
            requestCounts: res.requestCounts || state.lastBatch.requestCounts || null
          };
          saveLastBatch();
          setStatus(
            "Batch sync in progress: " +
              state.lastBatch.ready +
              " ready, " +
              state.lastBatch.failed +
              " failed, " +
              Number(res.remaining || 0) +
              " remaining"
          );
          scheduleBatchPolling(5000);
        }
      } catch (error) {
        setStatus("Batch sync failed: " + error.message);
        scheduleBatchPolling(BATCH_POLL_MS);
      } finally {
        state.batchSyncing = false;
        renderBatchQueue();
      }
    }

    function scheduleBatchPolling(delayMs) {
      if (state.batchPolling) clearTimeout(state.batchPolling);
      if (!state.lastBatch || !shouldPollBatch(state.lastBatch)) return;

      state.batchPolling = setTimeout(() => {
        refreshBatchStatus(false);
      }, delayMs || BATCH_POLL_MS);
    }

    function shouldPollBatch(batch) {
      const status = String(batch?.status || "").toLowerCase();
      return isActiveBatchStatus(status) || (status === "completed" && !batch.synced);
    }

    function normalizeSubmittedBatch(batch) {
      return {
        batchId: batch.batchId,
        status: batch.status || "submitted",
        itemCount: Number(batch.itemCount || 0),
        synced: false,
        ready: 0,
        failed: 0,
        requestCounts: null
      };
    }

    function normalizeBatchStatus(response) {
      const batch = response && response.batch;
      if (!batch) return null;

      const items = Array.isArray(response.items) ? response.items : [];
      const ready = items.filter((item) => item.status === "ready").length;
      const failed = items.filter((item) => item.status === "failed").length;
      const itemCount = Number(batch.item_count ?? batch.itemCount ?? items.length ?? 0);

      return {
        batchId: batch.batch_id || batch.batchId,
        status: batch.remoteStatus || batch.status || "submitted",
        itemCount,
        synced: itemCount > 0 && ready + failed >= itemCount,
        ready,
        failed,
        requestCounts: batch.requestCounts || batch.request_counts || null
      };
    }

    function batchStatusText(batch) {
      const status = batch.status || "submitted";
      const itemCount = Number(batch.itemCount || 0);
      const counts = batch.requestCounts;
      const progress = counts
        ? " / " + Number(counts.completed || 0) + " completed, " + Number(counts.failed || 0) + " failed"
        : "";
      const synced = batch.synced
        ? " / synced " + Number(batch.ready || 0) + " ready, " + Number(batch.failed || 0) + " failed"
        : "";

      return status + " / " + itemCount + " sprites" + progress + synced;
    }

    function isActiveBatchStatus(status) {
      return ACTIVE_BATCH_STATUSES.has(String(status || "").toLowerCase());
    }

    function saveLastBatch() {
      if (!state.lastBatch || !state.lastBatch.batchId) {
        localStorage.removeItem(LAST_BATCH_STORAGE_KEY);
        return;
      }

      localStorage.setItem(LAST_BATCH_STORAGE_KEY, JSON.stringify(state.lastBatch));
    }

    function readStoredBatch() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LAST_BATCH_STORAGE_KEY) || "null");
        return parsed && parsed.batchId ? parsed : null;
      } catch {
        return null;
      }
    }

    function renderBatchJobList(jobs) {
      return jobs.map((job) => (
        '<div class="batch-item">' +
          '<strong>' + escapeHtml(job.common_name || job.scientific_name || "Unnamed taxon") + '</strong>' +
          '<span><em>' + escapeHtml(job.scientific_name || "") + '</em></span>' +
          '<span>' + Number(job.obs_count || 0) + ' obs / taxon ' + Number(job.taxon_id || 0) + '</span>' +
        '</div>'
      )).join("");
    }

    function pruneSelectedTaxa() {
      // With a paginated roster only the current page is loaded, so keep
      // selections for taxa on other pages; drop only loaded-but-not-ready ones.
      const loaded = new Map(state.taxa.map((taxon) => [String(taxon.taxonId), taxon]));

      state.selectedTaxa = new Set(Array.from(state.selectedTaxa).filter((taxonId) => {
        const taxon = loaded.get(String(taxonId));
        return !taxon || (taxon.sprite && taxon.sprite.status === "ready");
      }));
    }

    function toggleTeamSelection(taxonId) {
      const normalized = String(taxonId || "");
      const taxon = state.taxa.find((candidate) => String(candidate.taxonId) === normalized);
      if (!taxon || taxon.sprite.status !== "ready") {
        setStatus("Only ready sprites can join the combat team.");
        return;
      }

      if (state.selectedTaxa.has(normalized)) {
        state.selectedTaxa.delete(normalized);
      } else {
        if (state.selectedTaxa.size >= 5) {
          setStatus("Five creatures are already selected.");
          return;
        }
        state.selectedTaxa.add(normalized);
      }

      render();
    }

    function toggleCardFlip(taxonId) {
      if (!taxonId) return;

      if (state.flippedTaxa.has(taxonId)) {
        state.flippedTaxa.delete(taxonId);
      } else {
        state.flippedTaxa.add(taxonId);
      }

      render();
    }

    async function chooseSpriteVariant(taxonId, direction) {
      if (!state.userId || !taxonId || !direction) return;
      const taxon = state.taxa.find((entry) => String(entry.taxonId) === String(taxonId));
      const variants = Array.isArray(taxon?.sprite?.variants) ? taxon.sprite.variants : [];
      if (!taxon || variants.length < 2) return;

      const currentIndex = Math.max(0, variants.findIndex((variant) => variant.assetId === taxon.sprite.assetId));
      const nextIndex = (currentIndex + direction + variants.length) % variants.length;
      const next = variants[nextIndex];
      if (!next?.assetId) return;

      try {
        const res = await apiFetch(
          "/api/users/" + encodeURIComponent(state.userId) +
            "/sprites/" + encodeURIComponent(String(taxonId)) +
            "/preference",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assetId: next.assetId })
          }
        );

        taxon.sprite = {
          ...taxon.sprite,
          ...res.sprite,
          placeholder: taxon.sprite.placeholder
        };
        setStatus("Selected " + (res.sprite?.variantIndex + 1 || nextIndex + 1) + " / " + variants.length + " for " + (taxon.name || taxon.scientificName));
        render();
      } catch (error) {
        setStatus(error.message);
      }
    }

    function renderCard(taxon) {
      const status = taxon.sprite.status;
      const isReady = status === "ready";
      const taxonId = String(taxon.taxonId);
      const isFlipped = state.flippedTaxa.has(taxonId);
      const isSelected = state.selectedTaxa.has(taxonId);
      const imageUrl = isReady ? taxon.sprite.url : taxon.defaultPhotoUrl;
      const image = isReady && imageUrl
        ? renderSheetSprite(imageUrl, "anim-idle")
        : imageUrl
        ? '<img alt="" loading="lazy" src="' + escapeAttr(imageUrl) + '">'
        : '<div class="placeholder-shape placeholder-' + escapeAttr(taxon.sprite.placeholder || "unknown") + '"></div>';
      const badge = isReady ? "ready" : status;
      const types = Array.isArray(taxon.types) ? taxon.types.join(" / ") : (taxon.iconicTaxon || "Life");

      return '<article class="card ' + (isFlipped ? "flipped " : "") + (isSelected ? "selected " : "") + (!isReady ? "unselectable" : "") + '" data-taxon-card data-taxon-id="' + escapeAttr(taxonId) + '" tabindex="0" role="button" aria-pressed="' + String(isSelected) + '" aria-label="' + escapeAttr((taxon.name || taxon.scientificName || "Taxon") + " combat selection") + '">' +
        '<div class="card-inner">' +
          '<div class="select-mark" aria-hidden="true">' + (isSelected ? "OK" : "") + '</div>' +
          '<div class="card-face card-front">' +
            '<div class="sprite ' + (isReady ? "ready" : "") + '">' +
              image +
              '<span class="badge">' + escapeHtml(badge) + '</span>' +
              renderSpritePicker(taxon) +
            '</div>' +
            '<div class="meta">' +
              '<div class="name">' + escapeHtml(taxon.nickname || taxon.name) +
                (Number(taxon.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(taxon.trainingLevel) + '</span>' : '') +
              '</div>' +
              '<div class="sci">' + escapeHtml(taxon.nickname ? taxon.name + " · " + taxon.scientificName : taxon.scientificName) + '</div>' +
              '<div class="chips">' +
                '<span class="chip">' + escapeHtml(types) + '</span>' +
                '<span class="chip">' + escapeHtml(taxon.role || "scout") + '</span>' +
                '<span class="chip">' + Number(taxon.obsCount || 0) + ' obs</span>' +
                '<span class="chip">Affinity ' + Number(affinityLevel(taxon) || 0) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="card-actions">' +
              '<button class="card-action" type="button" data-card-details data-taxon-id="' + escapeAttr(taxonId) + '">Details</button>' +
            '</div>' +
          '</div>' +
          '<div class="card-face card-back">' +
            renderCardBack(taxon, types) +
            '<div class="card-actions">' +
              '<button class="card-action" type="button" data-card-details data-taxon-id="' + escapeAttr(taxonId) + '">Roster</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>';
    }

    function renderSpritePicker(taxon) {
      const variants = Array.isArray(taxon?.sprite?.variants) ? taxon.sprite.variants : [];
      if (taxon?.sprite?.status !== "ready" || variants.length < 2) return "";

      const taxonId = String(taxon.taxonId);
      const index = Math.max(0, Math.min(
        variants.length - 1,
        Number(taxon.sprite.variantIndex ?? variants.findIndex((variant) => variant.assetId === taxon.sprite.assetId) ?? 0)
      ));

      return '<div class="sprite-picker" aria-label="Sprite version">' +
        '<button type="button" data-sprite-shift="-1" data-taxon-id="' + escapeAttr(taxonId) + '" aria-label="Previous sprite version">&lt;</button>' +
        '<span>' + (index + 1) + '/' + variants.length + '</span>' +
        '<button type="button" data-sprite-shift="1" data-taxon-id="' + escapeAttr(taxonId) + '" aria-label="Next sprite version">&gt;</button>' +
      '</div>';
    }

    function renderCardBack(taxon, types) {
      return '<div class="card-back-head">' +
          '<div class="name">' + escapeHtml(taxon.name) + '</div>' +
          '<div class="sci">' + escapeHtml(types + " / " + (taxon.role || "scout")) + '</div>' +
          '<div class="chips">' +
            '<span class="chip">HP ' + Number(taxon.maxHp || 0) + '</span>' +
            '<span class="chip">Affinity ' + Number(affinityLevel(taxon) || 0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="stat-bars">' +
          renderStatRow("Vigor", taxon.stats && taxon.stats.vigor) +
          renderStatRow("Strike", taxon.stats && taxon.stats.strike) +
          renderStatRow("Guard", taxon.stats && taxon.stats.guard) +
          renderStatRow("Tempo", taxon.stats && taxon.stats.tempo) +
          renderStatRow("Sense", taxon.stats && taxon.stats.sense) +
        '</div>' +
        '<div class="abilities">' +
          renderMoveRows(taxon.moves) +
        '</div>';
    }

    function renderStatRow(label, rawValue) {
      const value = Number(rawValue || 0);
      const width = Math.max(4, Math.min(100, value));

      return '<div class="stat-row">' +
        '<span>' + escapeHtml(label) + '</span>' +
        '<div class="stat-track"><span class="stat-fill" style="width:' + width + '%"></span></div>' +
        '<span>' + value + '</span>' +
      '</div>';
    }

    function affinityLevel(taxon) {
      return Number(taxon.affinityLevel ?? taxon.bondLevel ?? 0);
    }

    function renderMoveRows(moves) {
      const safeMoves = Array.isArray(moves) ? moves.slice(0, 4) : [];
      if (safeMoves.length === 0) {
        return '<div class="ability"><div><strong>No moves</strong><span>Missing battle data</span></div></div>';
      }

      return safeMoves.map((move) => {
        const power = Number(move.power || 0);
        const score = power > 0 ? power : "ST";

        return '<div class="ability"' + (move.flavor ? ' title="' + escapeAttr(move.flavor) + '"' : "") + '>' +
          '<div>' +
            '<strong>' + (move.signature ? '<span class="sig-star">★</span> ' : "") + escapeHtml(move.name || move.id || "Move") + '</strong>' +
            '<span>' + escapeHtml((move.type || "Life") + " / " + (move.category || "status")) +
              (move.flavor ? '<br>' + escapeHtml(move.flavor) : "") + '</span>' +
          '</div>' +
          '<div class="ability-power">' + escapeHtml(score) + '</div>' +
        '</div>';
      }).join("");
    }

    async function startNpcBattle() {
      if (!state.userId || state.selectedTaxa.size !== 5) {
        setStatus("Select 5 ready sprites first.");
        return;
      }

      const taxonIds = Array.from(state.selectedTaxa).map(Number);
      setBusy(true, "Starting NPC battle");

      try {
        await apiFetch("/api/users/" + encodeURIComponent(state.userId) + "/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Field Team", taxonIds })
        });

        const battle = await apiFetch("/api/battles/npc/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: state.userId,
            taxonIds,
            npcTemplate: "random_ready",
            difficulty: els.npcDifficultySelect.value || "normal"
          })
        });

        setStatus("NPC battle ready");
        enterBattle(battle);
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function startDemoBattle() {
      setBusy(true, "Starting 5v5 test battle");

      try {
        const battle = await apiFetch("/api/battles/demo/start", { method: "POST" });
        setStatus("5v5 test battle ready");
        enterBattle(battle);
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    function enterBattle(battle, options) {
      state.battle = battle;
      state.battleAnimation = "anim-idle";
      state.battlePhase = battle.status === "active" && !(options && options.skipIntro) ? "intro" : "active";
      switchView("battle");
      renderBattle();

      if (state.battlePhase === "intro") {
        playSfx("start");
        setTimeout(() => {
          if (state.battlePhase === "intro") {
            state.battlePhase = "active";
            renderBattle();
          }
        }, 1150);
      }
    }

    async function submitBattleMove(moveId, switchIndex) {
      const isSwitch = switchIndex !== undefined && switchIndex !== null;
      if (!state.battle || (!moveId && !isSwitch) || state.battleBusy) return;

      const prev = state.battle;
      const active = getActiveCreature(prev.player);
      state.battleBusy = true;
      state.battleAnimation = isSwitch ? "anim-idle" : moveAnimClassFor(active, moveId);
      playSfx("click");
      renderBattle();

      try {
        const next = await apiFetch("/api/battles/" + encodeURIComponent(prev.battleId) + "/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isSwitch ? { switchIndex } : { moveId })
        });
        await playTurnEvents(prev, next);
        state.battle = next;
        state.battleAnimation = "anim-idle";
      } catch (error) {
        setStatus(error.message);
        state.battleAnimation = "anim-idle";
      } finally {
        state.battleBusy = false;
        renderBattle();
        const finished = state.battle && state.battle.status !== "active";
        if (finished && state.lastResultBattle !== state.battle.battleId) {
          state.lastResultBattle = state.battle.battleId;
          playSfx(state.battle.status === "won" ? "win" : state.battle.status === "lost" ? "lose" : "miss");
        }
      }
    }

    // -- Turn sequencing: replay the resolved turn's log as timed effects ----

    function sideForName(name, prev) {
      const playerActive = getActiveCreature(prev.player).name;
      const opponentActive = getActiveCreature(prev.opponent).name;
      if (name === playerActive && name !== opponentActive) return "player";
      if (name === opponentActive && name !== playerActive) return "opponent";
      if (prev.player.creatures.some((creature) => creature.name === name)) return "player";
      return "opponent";
    }

    function moveCategoryFor(prev, side, moveId) {
      if (!moveId) return "physical";
      const creature = getActiveCreature(side === "player" ? prev.player : prev.opponent);
      const move = (creature.moves || []).find((candidate) => candidate.id === moveId);
      return move ? move.category : "physical";
    }

    function moveAnimClassFor(creature, moveId) {
      const move = (creature.moves || []).find((candidate) => candidate.id === moveId);
      if (move && move.animRow === 4) return "anim-special";
      if (move && move.animRow === 3) return "anim-attack";
      return move && move.category === "special" ? "anim-special" : "anim-attack";
    }

    async function playTurnEvents(prev, next) {
      const events = (next.log || []).filter((entry) => entry.turn === prev.turn);
      const hpState = {
        player: { hp: getActiveCreature(prev.player).hp, max: getActiveCreature(prev.player).maxHp },
        opponent: { hp: getActiveCreature(prev.opponent).hp, max: getActiveCreature(prev.opponent).maxHp }
      };
      let lastTargetSide = "opponent";

      for (const entry of events) {
        appendBattleLogLine(entry);
        const text = entry.text || "";

        const damageMatch = text.match(/^(.+) used (.+) and dealt (\d+) damage\.$/);
        if (damageMatch) {
          const actorSide = sideForName(damageMatch[1], prev);
          const targetSide = actorSide === "player" ? "opponent" : "player";
          const damage = Number(damageMatch[3]);
          const actorCreature = getActiveCreature(actorSide === "player" ? prev.player : prev.opponent);
          const moveId = entry.data && entry.data.moveId;
          const isCrit = Boolean(entry.data && entry.data.crit);
          const category = moveCategoryFor(prev, actorSide, moveId);
          lastTargetSide = targetSide;
          triggerAttackVisual(actorSide, moveAnimClassFor(actorCreature, moveId));
          if (category === "special") playSfx("special");
          await delay(280);
          hitEffect(targetSide, damage, hpState);
          if (isCrit) {
            playSfx("crit");
            spawnFloat(targetSide, "CRIT!", "crit");
          }
          await delay(isCrit ? 780 : 640);
          continue;
        }

        if (text === "A critical hit!") {
          // The crit burst already played alongside the damage line.
          await delay(140);
          continue;
        }

        if (/^It's super effective!$/.test(text)) {
          spawnFloat(lastTargetSide, "SUPER EFFECTIVE!", "word eff-strong");
          await delay(340);
          continue;
        }

        if (/not very effective/.test(text)) {
          spawnFloat(lastTargetSide, "RESISTED", "word eff-weak");
          await delay(300);
          continue;
        }

        const rallyMatch = text.match(/^(.+) is cornered and rallies with wild resolve!$/);
        if (rallyMatch) {
          const side = sideForName(rallyMatch[1], prev);
          playSfx("buff");
          spawnFloat(side, "RALLY!", "heal");
          await delay(560);
          continue;
        }

        const vigorHealMatch = text.match(/^(.+)'s vigor restores (\d+) HP\.$/);
        if (vigorHealMatch) {
          const side = sideForName(vigorHealMatch[1], prev);
          const healed = Number(vigorHealMatch[2]);
          playSfx("heal");
          const target = hpState[side];
          target.hp = Math.min(target.max, target.hp + healed);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "+" + healed, "heal");
          await delay(460);
          continue;
        }

        const vigorDrainMatch = text.match(/^(.+)'s sapped vigor drains (\d+) HP\.$/);
        if (vigorDrainMatch) {
          const side = sideForName(vigorDrainMatch[1], prev);
          const damage = Number(vigorDrainMatch[2]);
          playSfx("status");
          const target = hpState[side];
          target.hp = Math.max(0, target.hp - damage);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "-" + damage, "dmg");
          await delay(460);
          continue;
        }

        const multihitMatch = text.match(/^It struck (\d+) times\.$/);
        if (multihitMatch) {
          playSfx("hit", 0.6);
          await delay(260);
          continue;
        }

        const stunMatch = text.match(/^(.+) is stunned and cannot move\.$/);
        if (stunMatch) {
          playSfx("debuff");
          spawnFloat(sideForName(stunMatch[1], prev), "STUNNED!", "word status-fx");
          await delay(520);
          continue;
        }

        const poisonMatch = text.match(/^(.+) is hurt by poison and loses (\d+) HP\.$/);
        if (poisonMatch) {
          const side = sideForName(poisonMatch[1], prev);
          const damage = Number(poisonMatch[2]);
          playSfx("status");
          const target = hpState[side];
          target.hp = Math.max(0, target.hp - damage);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "-" + damage, "dmg");
          await delay(520);
          continue;
        }

        const drainMatch = text.match(/^(.+) drained (\d+) HP\.$/);
        if (drainMatch) {
          const side = sideForName(drainMatch[1], prev);
          const healed = Number(drainMatch[2]);
          playSfx("heal");
          const target = hpState[side];
          target.hp = Math.min(target.max, target.hp + healed);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "+" + healed, "heal");
          await delay(480);
          continue;
        }

        const recoilMatch = text.match(/^(.+) took (\d+) recoil damage\.$/);
        if (recoilMatch) {
          const side = sideForName(recoilMatch[1], prev);
          const damage = Number(recoilMatch[2]);
          playSfx("hit", 0.5);
          const target = hpState[side];
          target.hp = Math.max(0, target.hp - damage);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "-" + damage, "dmg");
          await delay(480);
          continue;
        }

        const blockedMatch = text.match(/^(.+)'s shield softened the blow\.$/);
        if (blockedMatch) {
          playSfx("buff");
          spawnFloat(sideForName(blockedMatch[1], prev), "BLOCKED", "word buff");
          await delay(380);
          continue;
        }

        const appliedMatch =
          text.match(/^(.+) was (poisoned)\.$/) ||
          text.match(/^(.+) is (marked) for the hunt\.$/) ||
          text.match(/^(.+) is (stunned)\.$/) ||
          text.match(/^(.+) (raised a shield)\.$/);
        if (appliedMatch) {
          const side = sideForName(appliedMatch[1], prev);
          const label = appliedMatch[2] === "raised a shield" ? "SHIELDED" : appliedMatch[2].toUpperCase();
          playSfx(appliedMatch[2] === "raised a shield" ? "buff" : "status");
          spawnFloat(side, label, "word status-fx");
          await delay(420);
          continue;
        }

        if (/ shook off the poison\.$/.test(text)) {
          const curedMatch = text.match(/^(.+) shook off the poison\.$/);
          playSfx("heal");
          if (curedMatch) spawnFloat(sideForName(curedMatch[1], prev), "CURED", "word heal");
          await delay(360);
          continue;
        }

        const missMatch = text.match(/^(.+) used (.+), but it missed\.$/);
        if (missMatch) {
          const actorSide = sideForName(missMatch[1], prev);
          triggerAttackVisual(actorSide, "anim-attack");
          await delay(240);
          playSfx("miss");
          spawnFloat(actorSide === "player" ? "opponent" : "player", "MISS", "word miss");
          await delay(420);
          continue;
        }

        const faintMatch = text.match(/^(.+) fainted\.$/);
        if (faintMatch) {
          const side = sideForName(faintMatch[1], prev);
          playSfx("faint");
          faintEffect(side);
          await delay(720);
          continue;
        }

        const healMatch = text.match(/^(.+) recovered (\d+) HP\.$/);
        if (healMatch) {
          const side = sideForName(healMatch[1], prev);
          playSfx("heal");
          const healed = Number(healMatch[2]);
          const target = hpState[side];
          target.hp = Math.min(target.max, target.hp + healed);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "+" + healed, "heal");
          await delay(520);
          continue;
        }

        const roseMatch = text.match(/^(.+)'s (vigor|strike|guard|tempo|sense) rose\.$/);
        if (roseMatch) {
          playSfx("buff");
          spawnFloat(sideForName(roseMatch[1], prev), roseMatch[2].toUpperCase() + " ▲", "word buff");
          await delay(420);
          continue;
        }
        const fellMatch = text.match(/^(.+)'s (vigor|strike|guard|tempo|sense) fell\.$/);
        if (fellMatch) {
          playSfx("debuff");
          spawnFloat(sideForName(fellMatch[1], prev), fellMatch[2].toUpperCase() + " ▼", "word debuff");
          await delay(420);
          continue;
        }
        if (/ rose\.$/.test(text)) {
          playSfx("buff");
          await delay(380);
          continue;
        }
        if (/ fell\.$/.test(text)) {
          playSfx("debuff");
          await delay(380);
          continue;
        }
        if (/ became /.test(text)) {
          playSfx("status");
          await delay(380);
          continue;
        }

        const statusMoveMatch = text.match(/^(.+) used (.+)\.$/);
        if (statusMoveMatch) {
          triggerAttackVisual(sideForName(statusMoveMatch[1], prev), "anim-special", "brace");
          playSfx("status");
          await delay(420);
          continue;
        }

        await delay(300);
      }
    }

    function spriteEl(side) {
      return els.battlePanel.querySelector(
        '[data-sprite-zone="' + side + '"] .sheet-sprite, [data-sprite-zone="' + side + '"] .dummy-sprite'
      );
    }

    function triggerAttackVisual(side, animClass, mode) {
      const el = spriteEl(side);
      if (!el) return;

      // Player sits bottom-left, opponent top-right. Attacks lunge toward
      // the foe; defensive/status moves brace with a small back-step hop.
      // Distance and arc height jitter so no two moves trace the same path.
      const dir = side === "player" ? 1 : -1;
      const jitter = (range) => (Math.random() * 2 - 1) * range;
      if (mode === "brace") {
        el.style.setProperty("--lunge-x", Math.round(-dir * (14 + jitter(6))) + "px");
        el.style.setProperty("--lunge-y", Math.round(-(5 + Math.random() * 7)) + "px");
        el.style.setProperty("--arc-h", Math.round(3 + Math.random() * 7) + "px");
      } else {
        el.style.setProperty("--lunge-x", Math.round(dir * (44 + jitter(14))) + "px");
        el.style.setProperty("--lunge-y", Math.round(-dir * (24 + jitter(10))) + "px");
        el.style.setProperty("--arc-h", Math.round(12 + Math.random() * 24) + "px");
      }

      const isSheet = el.classList.contains("sheet-sprite");
      el.classList.remove("anim-idle", "anim-attack", "anim-special", "lunge");
      void el.offsetWidth;
      el.classList.add("lunge");
      if (isSheet) el.classList.add(animClass);
      setTimeout(() => {
        el.classList.remove("anim-attack", "anim-special", "lunge");
        if (isSheet) el.classList.add("anim-idle");
      }, 620);
    }

    function hitEffect(targetSide, damage, hpState) {
      playSfx("hit", Math.min(1.7, 0.7 + damage / 50));

      const el = spriteEl(targetSide);
      if (el) {
        // Knocked away from the attacker, harder for bigger hits, with a
        // little vertical jitter so each recoil reads differently.
        const dir = targetSide === "player" ? -1 : 1;
        const force = Math.min(1.6, 0.8 + damage / 40);
        el.style.setProperty("--kb-x", Math.round(dir * (10 + Math.random() * 8) * force) + "px");
        el.style.setProperty("--kb-y", Math.round(-dir * (3 + Math.random() * 7) * force) + "px");
        el.classList.remove("hit-flash");
        void el.offsetWidth;
        el.classList.add("hit-flash");
        setTimeout(() => el.classList.remove("hit-flash"), 460);
      }

      const stage = document.getElementById("battleStage");
      if (stage) {
        stage.classList.remove("shake");
        void stage.offsetWidth;
        stage.classList.add("shake");
        setTimeout(() => stage.classList.remove("shake"), 360);

        if (targetSide === "player") {
          const flash = document.createElement("div");
          flash.className = "stage-hurt-flash";
          stage.appendChild(flash);
          setTimeout(() => flash.remove(), 420);
        }
      }

      const target = hpState[targetSide];
      spawnFloat(targetSide, "-" + damage, damage >= target.max * 0.22 ? "big" : "");
      target.hp = Math.max(0, target.hp - damage);
      setHpBar(targetSide, target.hp, target.max);
    }

    function setHpBar(side, hp, max) {
      const bar = els.battlePanel.querySelector('[data-hp-bar="' + side + '"]');
      const label = els.battlePanel.querySelector('[data-hp-text="' + side + '"]');
      const pct = max ? Math.max(0, Math.round((hp / max) * 100)) : 0;
      if (bar) {
        bar.style.setProperty("--hp", pct + "%");
        bar.classList.toggle("hp-low", pct <= 25);
      }
      if (label) label.textContent = Math.round(hp) + " / " + Math.round(max) + " HP";
    }

    function spawnFloat(side, text, kind) {
      const zone = els.battlePanel.querySelector('[data-sprite-zone="' + side + '"]');
      if (!zone) return;
      const el = document.createElement("div");
      el.className = "dmg-float" + (kind ? " " + kind : "");
      el.textContent = text;
      // Stack concurrent floats upward so simultaneous events stay readable.
      const live = zone.querySelectorAll(".dmg-float").length;
      if (live > 0) el.style.top = "calc(26% - " + Math.min(3, live) * 24 + "px)";
      zone.appendChild(el);
      setTimeout(() => el.remove(), kind === "crit" ? 1000 : 950);
    }

    function faintEffect(side) {
      const el = spriteEl(side);
      if (el) el.classList.add("fainted");
    }

    function appendBattleLogLine(entry) {
      const panel = document.getElementById("battleLogPanel");
      if (!panel) return;
      const line = document.createElement("div");
      line.textContent = "Turn " + Number(entry.turn || 0) + ": " + (entry.text || "");
      panel.insertBefore(line, panel.firstChild);
    }

    // -- Bluesky presence buddy list (AIM-style) ----------------------------
    //
    // Presence is inferred behaviorally from the Jetstream firehose filtered to
    // only your mutuals' DIDs, never queried:
    //   online  (green)  -> posted / replied / reposted within the window
    //   idle    (yellow) -> only liked / followed within the window (lurking)
    //   offline (gray)   -> quiet; "last seen" backfilled from getLatestCommit
    //
    // Everything here is client-side against the public, CORS-enabled AppView
    // and Jetstream; no auth and no server round-trips.

    const BSKY_APPVIEW = "https://public.api.bsky.app";
    // Public Jetstream instances are region-scoped; the bare host does not
    // resolve. Rotate across them so one instance being down self-heals.
    const JETSTREAM_HOSTS = [
      "jetstream2.us-east.bsky.network",
      "jetstream1.us-east.bsky.network",
      "jetstream2.us-west.bsky.network",
      "jetstream1.us-west.bsky.network"
    ];
    let jetstreamHostIndex = 0;
    const PRESENCE_ONLINE_MS = 10 * 60 * 1000;
    const PRESENCE_IDLE_MS = 10 * 60 * 1000;
    const PRESENCE_GRAPH_PAGE_CAP = 25; // up to ~2500 follows/followers each
    const PRESENCE_BACKFILL_CAP = 40; // lazy "last seen" lookups per session
    const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

    function presenceFetchJson(url) {
      return fetch(url, { headers: { accept: "application/json" } }).then((res) => {
        if (!res.ok) throw new Error("Bluesky request failed (" + res.status + ")");
        return res.json();
      });
    }

    async function fetchGraphDids(nsid, actor) {
      const dids = new Map();
      let cursor = "";
      for (let page = 0; page < PRESENCE_GRAPH_PAGE_CAP; page += 1) {
        const url = BSKY_APPVIEW + "/xrpc/" + nsid + "?actor=" + encodeURIComponent(actor) +
          "&limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        const data = await presenceFetchJson(url);
        const list = data[nsid.endsWith("getFollows") ? "follows" : "followers"] || [];
        for (const actorObj of list) {
          if (actorObj && actorObj.did) {
            dids.set(actorObj.did, {
              did: actorObj.did,
              handle: actorObj.handle || actorObj.did,
              displayName: actorObj.displayName || "",
              avatar: actorObj.avatar || ""
            });
          }
        }
        cursor = data.cursor || "";
        if (!cursor || list.length === 0) break;
      }
      return dids;
    }

    async function resolveMutuals(did) {
      const [follows, followers] = await Promise.all([
        fetchGraphDids("app.bsky.graph.getFollows", did),
        fetchGraphDids("app.bsky.graph.getFollowers", did)
      ]);
      const mutuals = [];
      for (const [otherDid, profile] of follows) {
        if (followers.has(otherDid)) mutuals.push(profile);
      }
      return mutuals;
    }

    function tidToMs(tid) {
      if (typeof tid !== "string" || tid.length < 10) return 0;
      let n = 0n;
      for (const char of tid) {
        const index = TID_ALPHABET.indexOf(char);
        if (index < 0) return 0;
        n = n * 32n + BigInt(index);
      }
      return Number((n >> 10n) / 1000n);
    }

    function presenceStateFor(buddy, now) {
      if (buddy.lastPostMs && now - buddy.lastPostMs <= PRESENCE_ONLINE_MS) return "online";
      if (buddy.lastLurkMs && now - buddy.lastLurkMs <= PRESENCE_IDLE_MS) return "idle";
      return "offline";
    }

    function presenceRank(stateName) {
      if (stateName === "online") return 0;
      if (stateName === "idle") return 1;
      return 2;
    }

    function relativeTime(ms) {
      if (!ms) return "";
      const diff = Date.now() - ms;
      if (diff < 60 * 1000) return "just now";
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + "m ago";
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + "h ago";
      return Math.floor(diff / 86400000) + "d ago";
    }

    function startPresence(force) {
      const me = state.me;
      if (!me || !me.loggedIn || !me.did) {
        els.buddiesPanel.innerHTML = '<p class="subtle">Sign in with Bluesky to see which of your mutuals are online.</p>';
        els.buddiesMetaLabel.textContent = "";
        return;
      }
      if (state.presence.started && !force) {
        renderBuddies();
        return;
      }
      stopPresence();
      state.presence.started = true;
      state.presence.status = "connecting";
      state.presence.buddies = new Map();
      state.presence.settleAt = 0;
      els.buddiesPanel.innerHTML = '<p class="subtle">Resolving your mutuals from the Bluesky AppView…</p>';
      els.buddiesMetaLabel.textContent = "Connecting";

      resolveMutuals(me.did).then((mutuals) => {
        if (!state.presence.started) return;
        for (const profile of mutuals) {
          state.presence.buddies.set(profile.did, Object.assign({
            lastPostMs: 0,
            lastLurkMs: 0,
            lastSeenMs: 0
          }, profile));
        }
        if (mutuals.length === 0) {
          els.buddiesPanel.innerHTML = '<p class="subtle">No mutuals found yet. Follow some folks back on Bluesky and refresh.</p>';
          els.buddiesMetaLabel.textContent = "0 mutuals";
          return;
        }
        // Suppress the online chime for the first few seconds while the
        // backlog of recent events streams in and seeds initial state.
        state.presence.settleAt = Date.now() + 6000;
        openJetstream(mutuals.map((m) => m.did));
        renderBuddies();
        scheduleBackfill();
      }).catch((error) => {
        state.presence.status = "error";
        els.buddiesPanel.innerHTML = '<p class="subtle">Could not load your mutuals: ' + escapeHtml(error.message) + '</p>';
        els.buddiesMetaLabel.textContent = "Error";
      });
    }

    function stopPresence() {
      const p = state.presence;
      if (p.ws) {
        try { p.ws.onclose = null; p.ws.close(); } catch (error) { /* ignore */ }
        p.ws = null;
      }
      if (p.reconnectTimer) { clearTimeout(p.reconnectTimer); p.reconnectTimer = null; }
      if (p.decayTimer) { clearInterval(p.decayTimer); p.decayTimer = null; }
      p.started = false;
      p.status = "idle";
    }

    function openJetstream(dids) {
      const p = state.presence;
      const host = JETSTREAM_HOSTS[jetstreamHostIndex % JETSTREAM_HOSTS.length];
      // Replay the last window so presence is seeded immediately instead of
      // only filling in as mutuals happen to act while the tab is open.
      const cursorUs = (Date.now() - PRESENCE_ONLINE_MS) * 1000;
      const url = "wss://" + host + "/subscribe?requireHello=true&cursor=" + cursorUs;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        p.status = "error";
        return;
      }
      p.ws = ws;

      ws.onopen = () => {
        p.status = "live";
        // wantedDids MUST be sent as a hello message, not in the URL: hundreds
        // of DIDs as query params blow past the WS handshake URL-length limit
        // and the server refuses the connection.
        ws.send(JSON.stringify({
          type: "options_update",
          payload: {
            wantedCollections: [
              "app.bsky.feed.post",
              "app.bsky.feed.repost",
              "app.bsky.feed.like",
              "app.bsky.graph.follow"
            ],
            wantedDids: dids
          }
        }));
        renderBuddies();
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (error) { return; }
        handleJetstreamEvent(msg);
      };

      ws.onclose = () => {
        if (!p.started || p.ws !== ws) return;
        p.status = "reconnecting";
        jetstreamHostIndex += 1;
        renderBuddies();
        p.reconnectTimer = setTimeout(() => {
          if (p.started) openJetstream(dids);
        }, 4000);
      };

      ws.onerror = () => {
        try { ws.close(); } catch (error) { /* ignore */ }
      };

      if (!p.decayTimer) {
        p.decayTimer = setInterval(() => renderBuddies(), 30000);
      }
    }

    function handleJetstreamEvent(msg) {
      if (!msg || msg.kind !== "commit" || !msg.commit) return;
      const buddy = state.presence.buddies.get(msg.did);
      if (!buddy) return;
      const op = msg.commit.operation;
      if (op !== "create") return;

      const collection = msg.commit.collection;
      const tsMs = msg.time_us ? Math.floor(msg.time_us / 1000) : Date.now();
      const isPost = collection === "app.bsky.feed.post" || collection === "app.bsky.feed.repost";
      const isLurk = collection === "app.bsky.feed.like" || collection === "app.bsky.graph.follow";
      if (!isPost && !isLurk) return;

      const wasOnline = presenceStateFor(buddy, Date.now()) === "online";
      if (isPost && tsMs > buddy.lastPostMs) buddy.lastPostMs = tsMs;
      if (tsMs > buddy.lastLurkMs) buddy.lastLurkMs = tsMs;
      if (tsMs > buddy.lastSeenMs) buddy.lastSeenMs = tsMs;

      const nowOnline = presenceStateFor(buddy, Date.now()) === "online";
      if (isPost && nowOnline && !wasOnline && Date.now() > state.presence.settleAt) {
        playSfx("buddy");
      }
      queueBuddiesRender();
    }

    function queueBuddiesRender() {
      if (state.presence.renderTimer) return;
      state.presence.renderTimer = setTimeout(() => {
        state.presence.renderTimer = null;
        renderBuddies();
      }, 400);
    }

    function scheduleBackfill() {
      const p = state.presence;
      if (p.backfillStarted) return;
      p.backfillStarted = true;
      const offline = [...p.buddies.values()].filter((b) => !b.lastSeenMs).slice(0, PRESENCE_BACKFILL_CAP);
      let index = 0;
      const step = () => {
        if (!p.started || index >= offline.length) return;
        const buddy = offline[index];
        index += 1;
        backfillLastSeen(buddy).finally(() => setTimeout(step, 250));
      };
      step();
    }

    async function backfillLastSeen(buddy) {
      try {
        const doc = await presenceFetchJson("https://plc.directory/" + encodeURIComponent(buddy.did));
        const services = Array.isArray(doc.service) ? doc.service : [];
        const pds = services.find((s) => s && (s.type === "AtprotoPersonalDataServer" || String(s.id || "").endsWith("#atproto_pds")));
        let endpoint = pds && pds.serviceEndpoint;
        if (!endpoint) return;
        if (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
        const data = await presenceFetchJson(endpoint +
          "/xrpc/com.atproto.sync.getLatestCommit?did=" + encodeURIComponent(buddy.did));
        const ms = tidToMs(data.rev);
        if (ms && ms > buddy.lastSeenMs) {
          buddy.lastSeenMs = ms;
          queueBuddiesRender();
        }
      } catch (error) {
        // Best effort; offline buddies just show no "last seen".
      }
    }

    function renderBuddies() {
      if (!state.presence.started) return;
      const now = Date.now();
      const buddies = [...state.presence.buddies.values()].map((buddy) => {
        return { buddy, stateName: presenceStateFor(buddy, now) };
      });
      buddies.sort((a, b) => {
        const rank = presenceRank(a.stateName) - presenceRank(b.stateName);
        if (rank !== 0) return rank;
        const an = (a.buddy.displayName || a.buddy.handle).toLowerCase();
        const bn = (b.buddy.displayName || b.buddy.handle).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });

      const counts = { online: 0, idle: 0, offline: 0 };
      for (const item of buddies) counts[item.stateName] += 1;

      const statusLabel = state.presence.status === "live" ? "live"
        : state.presence.status === "reconnecting" ? "reconnecting…"
        : state.presence.status === "connecting" ? "connecting…"
        : state.presence.status;
      els.buddiesMetaLabel.textContent = counts.online + " online · " + counts.idle + " lurking · " +
        buddies.length + " mutuals · firehose " + statusLabel;

      if (buddies.length === 0) {
        els.buddiesPanel.innerHTML = '<p class="subtle">No mutuals to show.</p>';
        return;
      }

      let html = '<ul class="buddy-list">';
      let lastGroup = "";
      const groupTitles = { online: "Active", idle: "Lurking", offline: "Offline" };
      for (const item of buddies) {
        if (item.stateName !== lastGroup) {
          lastGroup = item.stateName;
          html += '<li class="buddy-group">' + groupTitles[lastGroup] + '</li>';
        }
        html += renderBuddyRow(item.buddy, item.stateName);
      }
      html += '</ul>';
      els.buddiesPanel.innerHTML = html;
    }

    function renderBuddyRow(buddy, stateName) {
      const name = buddy.displayName || buddy.handle;
      const avatar = buddy.avatar
        ? '<img class="buddy-avatar" src="' + escapeAttr(buddy.avatar) + '" alt="" loading="lazy">'
        : '<span class="buddy-avatar buddy-avatar-blank"></span>';
      let sub = "@" + buddy.handle;
      if (stateName === "online") {
        sub = "active · " + relativeTime(buddy.lastPostMs);
      } else if (stateName === "idle") {
        sub = "lurking · " + relativeTime(buddy.lastLurkMs);
      } else if (buddy.lastSeenMs) {
        sub = "last seen " + relativeTime(buddy.lastSeenMs);
      }
      const canChallenge = stateName !== "offline";
      const profileUrl = "https://bsky.app/profile/" + encodeURIComponent(buddy.handle);
      return '<li class="buddy-row ' + stateName + '">' +
        '<span class="buddy-dot ' + stateName + '"></span>' +
        avatar +
        '<span class="buddy-meta">' +
          '<span class="buddy-name">' + escapeHtml(name) + '</span>' +
          '<span class="buddy-sub">' + escapeHtml(sub) + '</span>' +
        '</span>' +
        '<span class="buddy-actions">' +
          (canChallenge
            ? '<button class="secondary buddy-challenge" type="button" data-buddy-challenge="' + escapeAttr(buddy.handle) + '" data-buddy-did="' + escapeAttr(buddy.did) + '">Challenge</button>'
            : '') +
          '<a class="buddy-profile" href="' + escapeAttr(profileUrl) + '" target="_blank" rel="noopener">Profile</a>' +
        '</span>' +
      '</li>';
    }

    function onBuddiesPanelClick(event) {
      const button = event.target.closest("[data-buddy-challenge]");
      if (!button) return;
      const handle = button.getAttribute("data-buddy-challenge");
      if (!handle) return;
      playSfx("click");
      challengeBuddyByHandle(handle);
    }

    async function challengeBuddyByHandle(handle) {
      // Hand off to the existing Battle-tab challenge flow with the opponent
      // handle prefilled, so the rest of the challenge machinery is reused.
      await switchView("battle");
      const handleInput = document.getElementById("challengeHandleInput");
      if (handleInput) {
        handleInput.value = handle;
        handleInput.focus();
        handleInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setStatus("Pick 5 ready sprites, then send your challenge to @" + handle + ".");
    }

    // -- Retro sound effects (WebAudio, fully synthesized, no assets) -------

    let audioCtx = null;
    let audioNoiseBuffer = null;

    function ensureAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    }

    // Mobile browsers (iOS Safari especially) start the AudioContext suspended
    // and only let it resume — and on iOS, only "unlock" — inside a real user
    // gesture, with a buffer actually played during that gesture. Prime it on
    // the first touch/click anywhere so later async-fired SFX can play.
    function unlockAudio() {
      try {
        const ctx = ensureAudio();
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, 22050);
        source.connect(ctx.destination);
        source.start(0);
        const cleanup = () => {
          if (ctx.state === "running") {
            document.removeEventListener("pointerdown", unlockAudio);
            document.removeEventListener("touchend", unlockAudio);
            document.removeEventListener("click", unlockAudio);
          }
        };
        if (ctx.state === "suspended") ctx.resume().then(cleanup, () => {}); else cleanup();
      } catch (error) {
        // Audio is best-effort; never break interaction over it.
      }
    }

    document.addEventListener("pointerdown", unlockAudio, { passive: true });
    document.addEventListener("touchend", unlockAudio, { passive: true });
    document.addEventListener("click", unlockAudio, { passive: true });

    function sfxTone(ctx, out, opts) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = ctx.currentTime + (opts.delay || 0);
      const dur = opts.dur || 0.12;
      osc.type = opts.type || "square";
      osc.frequency.setValueAtTime(Math.max(20, opts.from), t0);
      if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t0 + dur);
      gain.gain.setValueAtTime(opts.gain || 0.18, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    function sfxNoise(ctx, out, opts) {
      if (!audioNoiseBuffer) {
        audioNoiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
        const data = audioNoiseBuffer.getChannelData(0);
        for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
      }
      const source = ctx.createBufferSource();
      source.buffer = audioNoiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = opts.freq || 700;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      const t0 = ctx.currentTime + (opts.delay || 0);
      const dur = opts.dur || 0.1;
      gain.gain.setValueAtTime(opts.gain || 0.25, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      source.start(t0);
      source.stop(t0 + dur + 0.03);
    }

    function playSfx(name, intensity) {
      if (!state.soundOn) return;
      const k = intensity || 1;

      try {
        const ctx = ensureAudio();
        const out = ctx.createGain();
        out.gain.value = 0.5;
        out.connect(ctx.destination);

        if (name === "click") {
          sfxTone(ctx, out, { type: "square", from: 620, to: 740, dur: 0.05, gain: 0.07 });
        } else if (name === "hit") {
          sfxNoise(ctx, out, { freq: 600, dur: 0.09, gain: 0.22 * k });
          sfxTone(ctx, out, { type: "square", from: 190, to: 65, dur: 0.13, gain: 0.2 * k });
        } else if (name === "special") {
          sfxTone(ctx, out, { type: "sawtooth", from: 330, dur: 0.09, gain: 0.1 });
          sfxTone(ctx, out, { type: "sawtooth", from: 440, dur: 0.09, gain: 0.1, delay: 0.07 });
          sfxTone(ctx, out, { type: "sawtooth", from: 587, dur: 0.12, gain: 0.1, delay: 0.14 });
        } else if (name === "crit") {
          sfxNoise(ctx, out, { freq: 950, dur: 0.12, gain: 0.3 });
          sfxTone(ctx, out, { type: "square", from: 260, to: 48, dur: 0.2, gain: 0.24 });
          sfxTone(ctx, out, { type: "square", from: 880, to: 1320, dur: 0.09, gain: 0.12, delay: 0.02 });
        } else if (name === "miss") {
          sfxTone(ctx, out, { type: "triangle", from: 520, to: 170, dur: 0.18, gain: 0.08 });
        } else if (name === "heal") {
          sfxTone(ctx, out, { type: "sine", from: 520, dur: 0.1, gain: 0.12 });
          sfxTone(ctx, out, { type: "sine", from: 780, dur: 0.14, gain: 0.12, delay: 0.09 });
        } else if (name === "buff") {
          sfxTone(ctx, out, { type: "sine", from: 440, to: 660, dur: 0.12, gain: 0.1 });
        } else if (name === "debuff") {
          sfxTone(ctx, out, { type: "sine", from: 440, to: 250, dur: 0.14, gain: 0.1 });
        } else if (name === "status") {
          sfxTone(ctx, out, { type: "triangle", from: 350, dur: 0.1, gain: 0.09 });
        } else if (name === "faint") {
          sfxTone(ctx, out, { type: "square", from: 280, to: 42, dur: 0.45, gain: 0.16 });
        } else if (name === "buddy") {
          // AIM-style "door open" two-note rising chime.
          sfxTone(ctx, out, { type: "sine", from: 660, dur: 0.1, gain: 0.12 });
          sfxTone(ctx, out, { type: "sine", from: 988, dur: 0.16, gain: 0.12, delay: 0.09 });
        } else if (name === "start") {
          sfxTone(ctx, out, { type: "square", from: 392, dur: 0.11, gain: 0.12 });
          sfxTone(ctx, out, { type: "square", from: 523, dur: 0.16, gain: 0.12, delay: 0.11 });
        } else if (name === "win") {
          sfxTone(ctx, out, { type: "square", from: 523, dur: 0.13, gain: 0.12 });
          sfxTone(ctx, out, { type: "square", from: 659, dur: 0.13, gain: 0.12, delay: 0.12 });
          sfxTone(ctx, out, { type: "square", from: 784, dur: 0.13, gain: 0.12, delay: 0.24 });
          sfxTone(ctx, out, { type: "square", from: 1047, dur: 0.3, gain: 0.13, delay: 0.36 });
        } else if (name === "lose") {
          sfxTone(ctx, out, { type: "square", from: 220, to: 180, dur: 0.28, gain: 0.13 });
          sfxTone(ctx, out, { type: "square", from: 165, to: 105, dur: 0.45, gain: 0.13, delay: 0.28 });
        }
      } catch (error) {
        // Audio is best-effort; never break the battle over it.
      }
    }

    // -- Procedural pixel-art battle backdrops ------------------------------

    const BATTLE_BIOMES = {
      meadow: { key: "meadow", sky: ["#9fd4e8", "#b5e0ec", "#cdeaf0"], sun: "#f7d978", cloud: "#f4f9f7", hill: "#6fa06b", ground: "#8fbf6f", groundEdge: "#7aae61", groundDark: "#79a85c", groundLight: "#a3cd82", accent: "#e0788a" },
      wetland: { key: "wetland", sky: ["#a3c8d8", "#b9d8e0", "#cfe6e6"], sun: "#f2e2a0", cloud: "#eef6f4", hill: "#5d8a72", ground: "#6fa384", groundEdge: "#5d927a", groundDark: "#54806a", groundLight: "#8cb89c", accent: "#4f7f9d" },
      forest: { key: "forest", sky: ["#7fae9a", "#92bda4", "#a8ccae"], sun: "#e8e3b0", cloud: "#dcebdf", hill: "#3f6b4c", ground: "#5d8752", groundEdge: "#4d7544", groundDark: "#46663c", groundLight: "#739a64", accent: "#b06a45" },
      urban: { key: "urban", sky: ["#b6c3d4", "#c8d2dd", "#dadfe5"], sun: "#f3e9c5", cloud: "#eff2f4", hill: "#7c8894", ground: "#9aa3a3", groundEdge: "#86908f", groundDark: "#7e8887", groundLight: "#b2baba", accent: "#c2554d" },
      night: { key: "night", sky: ["#23304e", "#2d3c5e", "#3a4a6e"], sun: "#e8e6cf", cloud: "#46557454", hill: "#1d2a40", ground: "#33485a", groundEdge: "#2a3d4e", groundDark: "#243443", groundLight: "#41586c", accent: "#8ea4c8" }
    };

    function seededPixelRng(seedString) {
      let hash = 2166136261;
      for (let index = 0; index < seedString.length; index += 1) {
        hash ^= seedString.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return function rng() {
        hash += 0x6d2b79f5;
        let value = hash;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Maps a battle's terrain (tile biome) to one of the 5 backdrop palettes.
    const TERRAIN_BACKDROP = {
      forest: BATTLE_BIOMES.forest,
      woodland: BATTLE_BIOMES.forest,
      grassland: BATTLE_BIOMES.meadow,
      agricultural: BATTLE_BIOMES.meadow,
      shrubland: BATTLE_BIOMES.meadow,
      desert: BATTLE_BIOMES.meadow,
      urban: BATTLE_BIOMES.urban,
      wetland: BATTLE_BIOMES.wetland,
      freshwater: BATTLE_BIOMES.wetland,
      polar: BATTLE_BIOMES.wetland,
      tundra: BATTLE_BIOMES.wetland
    };

    function pickBiome(battle) {
      // Prefer the battle's actual terrain; fall back to the combatants' types.
      if (battle.terrain && TERRAIN_BACKDROP[battle.terrain]) return TERRAIN_BACKDROP[battle.terrain];
      const types = []
        .concat(getActiveCreature(battle.opponent).types || [])
        .concat(getActiveCreature(battle.player).types || []);
      if (types.includes("Night")) return BATTLE_BIOMES.night;
      if (types.includes("Wetland")) return BATTLE_BIOMES.wetland;
      if (types.includes("Fungus") || types.includes("Decay") || types.includes("Wood")) return BATTLE_BIOMES.forest;
      if (types.includes("Urban")) return BATTLE_BIOMES.urban;
      return BATTLE_BIOMES.meadow;
    }

    function makePixelBackdropSvg(seedString, biome) {
      const rng = seededPixelRng(seedString + ":" + biome.key);
      const W = 64;
      const H = 36;
      let rects = "";
      const px = (x, y, w, h, fill) => {
        rects += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"/>';
      };

      const skyH = Math.floor(H * 0.6);
      for (let band = 0; band < biome.sky.length; band += 1) {
        const bandTop = Math.floor((skyH * band) / biome.sky.length);
        px(0, bandTop, W, Math.ceil(skyH / biome.sky.length) + 1, biome.sky[band]);
      }

      const sunX = 5 + Math.floor(rng() * 22);
      const sunY = 3 + Math.floor(rng() * 5);
      px(sunX, sunY, 4, 4, biome.sun);
      px(sunX + 1, sunY - 1, 2, 1, biome.sun);
      px(sunX + 1, sunY + 4, 2, 1, biome.sun);
      px(sunX - 1, sunY + 1, 1, 2, biome.sun);
      px(sunX + 4, sunY + 1, 1, 2, biome.sun);

      const cloudCount = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < cloudCount; i += 1) {
        const cw = 5 + Math.floor(rng() * 6);
        const cx = Math.floor(rng() * (W - cw));
        const cy = 2 + Math.floor(rng() * (skyH - 8));
        px(cx, cy, cw, 2, biome.cloud);
        px(cx + 1, cy - 1, cw - 2, 1, biome.cloud);
      }

      let hillY = skyH - 4 - Math.floor(rng() * 4);
      for (let x = 0; x < W; x += 2) {
        hillY += Math.floor(rng() * 3) - 1;
        hillY = Math.max(skyH - 9, Math.min(skyH - 2, hillY));
        px(x, hillY, 2, skyH - hillY + 1, biome.hill);
      }

      px(0, skyH, W, H - skyH, biome.ground);
      px(0, skyH, W, 1, biome.groundEdge);

      for (let i = 0; i < 150; i += 1) {
        px(
          Math.floor(rng() * W),
          skyH + 1 + Math.floor(rng() * (H - skyH - 1)),
          1,
          1,
          rng() < 0.5 ? biome.groundDark : biome.groundLight
        );
      }

      for (let i = 0; i < 9; i += 1) {
        const tuftX = 1 + Math.floor(rng() * (W - 3));
        const tuftY = skyH + 2 + Math.floor(rng() * (H - skyH - 5));
        px(tuftX, tuftY, 1, 2, biome.accent);
        px(tuftX - 1, tuftY + 1, 1, 1, biome.groundDark);
        px(tuftX + 1, tuftY + 1, 1, 1, biome.groundDark);
      }

      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36" shape-rendering="crispEdges">' + rects + '</svg>';
    }

    function battleBackdrop(battle) {
      const id = battle.battleId || "default";
      if (state.backdropCache && state.backdropCache.id === id) return state.backdropCache.css;
      const svg = makePixelBackdropSvg(id, pickBiome(battle));
      const css = "url(data:image/svg+xml," + encodeURIComponent(svg) + ")";
      state.backdropCache = { id, css };
      return css;
    }

    // -- Battle rendering ----------------------------------------------------

    function battleTitle(battle) {
      if (battle.mode === "territory_contest") return "Tile Contest";
      if (battle.mode === "pvp_async") return "Challenge Battle";
      if (battle.mode === "demo") return "5v5 Test Battle";
      return "NPC Battle";
    }

    function terrainBannerHtml(battle) {
      const terrain = battle.terrain;
      if (!terrain || terrain === "neutral" || !TERRAIN_MOVE_BONUS[terrain]) return "";
      const name = terrain.charAt(0).toUpperCase() + terrain.slice(1);
      const boosts = TERRAIN_MOVE_BONUS[terrain].join(" · ");
      return '<div class="terrain-banner">🌿 <strong>' + escapeHtml(name) + ' terrain</strong>' +
        ' <span class="subtle">— favors ' + escapeHtml(boosts) + ' moves (+15%)</span></div>';
    }

    function renderResultOverlay(battle) {
      const title = battle.status === "won" ? "Victory!" : battle.status === "lost" ? "Defeat" : "Draw";
      const cls = battle.status === "won" ? "win" : battle.status === "lost" ? "lose" : "";
      const contributions = battle.player.creatures
        .map((creature) => ({
          name: creature.name,
          dealt: Number(creature.damageDealt || 0),
          taken: Number(creature.damageTaken || 0)
        }))
        .filter((row) => row.dealt > 0 || row.taken > 0)
        .sort((a, b) => b.dealt - a.dealt);
      const contribHtml = contributions.length
        ? '<div class="overlay-contrib">' + contributions.map((row) =>
            '<div><strong>' + escapeHtml(row.name) + '</strong> &mdash; ' + row.dealt + ' dmg dealt / ' + row.taken + ' taken</div>'
          ).join("") + '</div>'
        : "";

      const update = battle.ratingUpdate;
      const ratingHtml = update
        ? '<div class="overlay-rating">' +
            '<span class="rating-delta ' + (update.delta >= 0 ? "up" : "down") + '">' +
              (update.delta >= 0 ? "+" : "") + update.delta + '</span>' +
            '<span>' + update.rating + ' Field Score</span>' +
            '<span class="lb-title-chip">' + escapeHtml((update.titleEmoji || "") + " " + (update.title || "")) + '</span>' +
            '<span>Rank #' + update.rank + '</span>' +
            (update.winStreak >= 2 ? '<span class="lb-streak">' + update.winStreak + '-win streak 🔥</span>' : "") +
          '</div>'
        : "";

      const canShare = battle.status === "won" && !battle.demo &&
        state.me && state.me.loggedIn && state.me.inatLogin;
      const actionsHtml = '<div class="overlay-actions">' +
        (canShare ? '<button class="secondary bsky-share-button" type="button" data-share-battle>Brag on Bluesky 🦋</button>' : "") +
        (update ? '<button class="secondary" type="button" data-open-leaderboard>Leaderboard</button>' : "") +
        '<button class="primary" type="button" data-battle-exit>Back to Roster</button>' +
      '</div>';

      return '<div class="battle-overlay">' +
        '<div class="overlay-card">' +
          '<div class="overlay-title ' + cls + '">' + title + '</div>' +
          '<div class="overlay-sub">' + escapeHtml(battle.player.name || "Your Team") + " vs " + escapeHtml(battle.opponent.name || "Opponent") +
            " &middot; " + Math.max(1, Number(battle.turn || 1) - 1) + " turns</div>" +
          ratingHtml +
          contribHtml +
          actionsHtml +
        '</div>' +
      '</div>';
    }

    function renderBattle() {
      const battle = state.battle;
      els.battlePanel.hidden = !battle;
      if (els.battleEmptyState) els.battleEmptyState.hidden = !!battle;
      document.body.classList.toggle("battle-active", !!battle);
      renderViewTabs();
      if (!battle) {
        state.swapOpen = false;
        return;
      }

      const playerActive = getActiveCreature(battle.player);
      const opponentActive = getActiveCreature(battle.opponent);
      let moveButtons;
      if (battle.status === "active") {
        const playerMana = Number(playerActive.mana ?? 0);
        let anyAffordable = false;
        const buttons = playerActive.moves.map((move) => {
            const cost = moveManaCost(move);
            const affordable = playerMana >= cost;
            if (affordable) anyAffordable = true;
            const eff = move.category === "status" ? 1 : typeMultiplierFor(move.type, opponentActive.types);
            const effClass = eff >= 1.2 ? " eff-strong" : eff <= 0.85 ? " eff-weak" : "";
            const terrainBoost = move.category !== "status" && terrainBoostsMove(move.type, battle.terrain);
            const effLabel = "x" + eff.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
            const estimate = estimateMoveDamage(battle, playerActive, opponentActive, move);
            const metaBits = [];
            if (estimate !== null) {
              const multihit = move.effect && move.effect.kind === "multihit";
              metaBits.push(
                '<strong class="meta-dmg">~' + estimate + (multihit ? " x" + (move.effect.min || 2) + "-" + (move.effect.max || 3) : "") + " dmg</strong>" +
                (eff !== 1 ? ' <span class="eff-tag">' + effLabel + "</span>" : "")
              );
            }
            metaBits.push(...describeMoveEffect(move).map(escapeHtml));
            if (Number(move.accuracy) < 100) metaBits.push(Number(move.accuracy) + "% acc");
            return '<button class="move-button' + (move.signature ? " signature" : "") + effClass + (terrainBoost ? " eff-terrain" : "") + (affordable ? "" : " unaffordable") + '" type="button" data-move-id="' + escapeAttr(move.id) + '" ' +
              (move.flavor ? 'title="' + escapeAttr(move.flavor) + '" ' : "") + ((state.battleBusy || !affordable) ? "disabled" : "") + '>' +
              escapeHtml(move.name) + (move.signature ? ' <span class="sig-star">★</span>' : "") +
              (terrainBoost ? ' <span class="terrain-tag" title="Favored by the terrain (+15%)">🌿</span>' : "") +
              ' <span class="move-cost">' + cost + ' MP</span>' +
              '<br><span class="subtle">' + escapeHtml(move.type + " / " + move.category) + '</span>' +
              (metaBits.length ? '<span class="move-meta">' + metaBits.join(" · ") + '</span>' : "") +
            '</button>';
          }).join("");
        const struggle = anyAffordable
          ? ""
          : '<button class="struggle-button" type="button" data-move-id="struggle"' + (state.battleBusy ? " disabled" : "") + '>' +
              'Struggle <span class="subtle">— out of mana: weak hit + recoil</span>' +
            '</button>';
        moveButtons = buttons + struggle;
      } else {
        moveButtons = '<button class="move-button" type="button" disabled>Battle ' + escapeHtml(battle.status) + '</button>';
      }
      const recentLog = battle.log.slice(-8).reverse().map((entry) => (
        '<div>Turn ' + Number(entry.turn || 0) + ': ' + escapeHtml(entry.text) + '</div>'
      )).join("");

      let overlay = "";
      if (battle.status !== "active") {
        overlay = renderResultOverlay(battle);
      } else if (state.battlePhase === "intro") {
        overlay = '<div class="battle-overlay intro"><div class="overlay-title">Battle Start!</div></div>';
      }

      // Swap! lives in an action bar above the moves (not inside the clipped
      // stage) so it's always reachable, especially on mobile.
      const swappableCount = battle.status === "active"
        ? battle.player.creatures.filter((member, index) => index !== battle.player.activeIndex && !member.fainted).length
        : 0;
      const swapBar = swappableCount > 0
        ? '<div class="battle-actions">' +
            '<button type="button" class="swap-button" data-open-swap' + (state.battleBusy ? " disabled" : "") + '>' +
              'Swap! <span class="swap-count">' + swappableCount + '</span>' +
            '</button>' +
          '</div>'
        : "";

      els.battlePanel.innerHTML =
        '<div class="roster-head">' +
          '<h2>' + battleTitle(battle) + '</h2>' +
          '<div class="battle-head-tools">' +
            '<span class="subtle">' + escapeHtml(battle.status) + ' / turn ' + Number(battle.turn || 1) + '</span>' +
            '<button class="secondary" type="button" data-sound-toggle>' + (state.soundOn ? "Sound: on" : "Sound: off") + '</button>' +
            '<button class="secondary" type="button" data-battle-exit>Exit</button>' +
          '</div>' +
        '</div>' +
        terrainBannerHtml(battle) +
        '<div class="battle-stage" id="battleStage" style="background-image:' + battleBackdrop(battle) + '">' +
          renderCombatant(battle.player, playerActive, "player") +
          renderCombatant(battle.opponent, opponentActive, "opponent") +
          overlay +
        '</div>' +
        swapBar +
        '<div class="moves">' + moveButtons + '</div>' +
        '<div class="battle-log" id="battleLogPanel">' + recentLog + '</div>' +
        renderSwapModal(battle, playerActive);
      keyBattleSprites();
    }

    function renderSwapModal(battle, playerActive) {
      if (!state.swapOpen || battle.status !== "active") return "";
      const team = battle.player;
      const rows = team.creatures
        .map((member, index) => ({ member, index }))
        .filter(({ member, index }) => index !== team.activeIndex && !member.fainted);
      if (!rows.length) return "";

      const rowsHtml = rows.map(({ member, index }) => {
        const pct = member.maxHp ? Math.max(0, Math.round((member.hp / member.maxHp) * 100)) : 0;
        const manaPct = member.maxMana ? Math.max(0, Math.round((member.mana / member.maxMana) * 100)) : 0;
        const thumb = member.spriteUrl
          ? '<div class="swap-thumb" data-sprite-url="' + escapeAttr(member.spriteUrl) + '" style="background-image:url(&quot;' + escapeAttr(member.spriteUrl) + '&quot;)"></div>'
          : '<div class="swap-thumb swap-thumb-blank"></div>';
        const types = (member.types || []).join(" / ");
        return '<button type="button" class="swap-row" data-swap-index="' + index + '"' + (state.battleBusy ? " disabled" : "") + '>' +
          thumb +
          '<div class="swap-row-info">' +
            '<span class="swap-row-name">' + escapeHtml(member.name) +
              (Number(member.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(member.trainingLevel) + '</span>' : '') +
            '</span>' +
            (types ? '<span class="subtle swap-row-types">' + escapeHtml(types) + '</span>' : '') +
            '<div class="hp"><span class="' + (pct <= 25 ? "hp-low" : "") + '" style="--hp:' + pct + '%"></span></div>' +
            '<span class="subtle">' + Number(member.hp || 0) + ' / ' + Number(member.maxHp || 0) + ' HP</span>' +
            '<div class="mana"><span style="--mana:' + manaPct + '%"></span></div>' +
            '<span class="subtle mana-text">' + Number(member.mana || 0) + ' / ' + Number(member.maxMana || 0) + ' MP</span>' +
          '</div>' +
        '</button>';
      }).join("");

      return '<div class="swap-modal">' +
        '<div class="swap-sheet" role="dialog" aria-label="Swap species" aria-modal="true">' +
          '<div class="swap-sheet-head">' +
            '<strong>Swap species</strong>' +
            '<button type="button" class="secondary" data-swap-close>Close</button>' +
          '</div>' +
          '<p class="subtle swap-note">Pick a teammate to send in. The opponent still moves this turn.</p>' +
          '<div class="swap-list">' + rowsHtml + '</div>' +
        '</div>' +
      '</div>';
    }

    function renderCombatant(team, creature, side) {
      const hpPct = creature.maxHp ? Math.max(0, Math.round((creature.hp / creature.maxHp) * 100)) : 0;
      const manaPct = creature.maxMana ? Math.max(0, Math.round((creature.mana / creature.maxMana) * 100)) : 0;
      const animation = side === "player" ? state.battleAnimation : "anim-idle";
      const sprite = creature.spriteUrl
        ? renderSheetSprite(creature.spriteUrl, animation + (creature.fainted ? " fainted" : ""))
        : '<div class="dummy-sprite' + (creature.fainted ? " fainted" : "") + '">Dummy</div>';
      // The Swap! button is rendered in the action bar above the moves (see
      // renderBattle) so it stays visible on mobile — the plate sits inside the
      // height-clipped battle-stage where a tall plate would hide it.
      const STATUS_SPRITE_KINDS = ["stunned", "marked", "poisoned", "shielded", "rallied"];
      const activeStatuses = (creature.statuses || []).slice();
      if (creature.rallied) activeStatuses.push("rallied");
      const statusSprites = !creature.fainted
        ? activeStatuses
            .filter((status, index) => STATUS_SPRITE_KINDS.includes(status) && activeStatuses.indexOf(status) === index)
            .map((status) => {
              const url = "/assets/status-" + status + ".png";
              return '<div class="status-sprite" data-sprite-url="' + escapeAttr(url) + '" title="' + escapeAttr(status) + '" ' +
                'style="background-image:url(&quot;' + escapeAttr(url) + '&quot;)"></div>';
            }).join("")
        : "";

      return '<article class="combatant ' + side + '">' +
        '<div class="plate">' +
          '<div class="combatant-head">' +
            '<div class="combatant-name">' + escapeHtml(creature.name) +
              (Number(creature.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(creature.trainingLevel) + '</span>' : '') +
              (Number(creature.trainingBuffPct) > 0 ? ' <span class="lv-chip">+' + Math.round(Number(creature.trainingBuffPct) * 100) + '% mastery</span>' : '') +
              (Number(creature.territoryBuffPct) > 0 ? ' <span class="lv-chip terr-chip">🏞️ +' + Math.round(Number(creature.territoryBuffPct) * 100) + '% home</span>' : '') +
              (Number(creature.localBuffPct) > 0 ? ' <span class="lv-chip local-chip">📍 +' + Math.round(Number(creature.localBuffPct) * 100) + '% local</span>' : '') +
            '</div>' +
            '<div class="combatant-role">' + escapeHtml((creature.types || []).join(" / ")) + '</div>' +
          '</div>' +
          '<div class="hp" aria-label="HP"><span data-hp-bar="' + side + '" class="' + (hpPct <= 25 ? "hp-low" : "") + '" style="--hp:' + hpPct + '%"></span></div>' +
          '<div class="subtle" data-hp-text="' + side + '">' + Number(creature.hp || 0) + ' / ' + Number(creature.maxHp || 0) + ' HP</div>' +
          '<div class="mana" aria-label="Mana"><span style="--mana:' + manaPct + '%"></span></div>' +
          '<div class="subtle mana-text">' + Number(creature.mana || 0) + ' / ' + Number(creature.maxMana || 0) + ' MP</div>' +
          (function () {
            const statusChips = (creature.statuses || []).map((status) => (
              '<span class="status-chip status-' + escapeAttr(status) + '">' + escapeHtml(status) + '</span>'
            )).join("");
            const stageAbbrev = { vigor: "VIG", strike: "STR", guard: "GRD", tempo: "TMP", sense: "SNS" };
            const stageChips = Object.entries(creature.statStages || {})
              .filter(([, value]) => Number(value))
              .map(([stat, value]) => {
                const stage = Number(value);
                return '<span class="stage-chip ' + (stage > 0 ? "up" : "down") + '">' +
                  (stageAbbrev[stat] || stat.slice(0, 3).toUpperCase()) + " " + (stage > 0 ? "+" : "") + stage +
                '</span>';
              }).join("");
            return statusChips || stageChips
              ? '<div class="status-chips">' + statusChips + stageChips + '</div>'
              : "";
          })() +
        '</div>' +
        '<div class="combatant-sprite" data-sprite-zone="' + side + '">' +
          '<div class="platform"></div>' + sprite +
          (statusSprites ? '<div class="status-sprites">' + statusSprites + '</div>' : "") +
        '</div>' +
      '</article>';
    }

    function renderSheetSprite(url, animationClass) {
      return '<div class="sheet-sprite ' + escapeAttr(animationClass || "anim-idle") + '" data-sprite-url="' + escapeAttr(url) + '" style="background-image:url(&quot;' + escapeAttr(url) + '&quot;)"></div>';
    }

    const keyedSpriteCache = new Map();

    function keyBattleSprites() {
      const sprites = els.battlePanel.querySelectorAll(
        ".combatant-sprite .sheet-sprite[data-sprite-url], .combatant-sprite .status-sprite[data-sprite-url], .swap-thumb[data-sprite-url]"
      );
      sprites.forEach((sprite) => {
        const url = sprite.getAttribute("data-sprite-url");
        if (!url) return;

        const cached = keyedSpriteCache.get(url);
        if (typeof cached === "string") {
          setSpriteBackground(sprite, cached);
          return;
        }
        if (cached && typeof cached.then === "function") {
          cached.then((keyedUrl) => {
            if (sprite.isConnected && sprite.getAttribute("data-sprite-url") === url) {
              setSpriteBackground(sprite, keyedUrl);
            }
          });
          return;
        }

        const pending = makeTransparentSpriteUrl(url)
          .then((keyedUrl) => {
            keyedSpriteCache.set(url, keyedUrl);
            return keyedUrl;
          })
          .catch(() => {
            keyedSpriteCache.delete(url);
            return url;
          });
        keyedSpriteCache.set(url, pending);
        pending.then((keyedUrl) => {
          if (sprite.isConnected && sprite.getAttribute("data-sprite-url") === url) {
            setSpriteBackground(sprite, keyedUrl);
          }
        });
      });
    }

    function setSpriteBackground(sprite, url) {
      sprite.style.backgroundImage = 'url("' + url + '")';
      sprite.classList.add("alpha-keyed");
    }

    function makeTransparentSpriteUrl(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) {
              resolve(url);
              return;
            }

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, width, height);
            alphaKeySpriteSheet(imageData.data, width, height);
            context.putImageData(imageData, 0, 0);
            canvas.toBlob((blob) => {
              resolve(blob ? URL.createObjectURL(blob) : url);
            }, "image/png");
          } catch (error) {
            reject(error);
          }
        };
        image.onerror = () => reject(new Error("Sprite image could not be loaded"));
        image.src = url;
      });
    }

    function alphaKeySpriteSheet(data, width, height) {
      const columns = 4;
      const rows = 4;
      const visited = new Uint8Array(width * height);

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x0 = Math.floor((width * column) / columns);
          const x1 = Math.floor((width * (column + 1)) / columns) - 1;
          const y0 = Math.floor((height * row) / rows);
          const y1 = Math.floor((height * (row + 1)) / rows) - 1;
          const queue = [];
          let cursor = 0;

          const push = (x, y) => {
            if (x < x0 || x > x1 || y < y0 || y > y1) return;
            const index = y * width + x;
            if (visited[index]) return;
            if (!isLightCellBackground(data, index * 4)) return;
            visited[index] = 1;
            queue.push(index);
          };

          for (let x = x0; x <= x1; x += 1) {
            push(x, y0);
            push(x, y1);
          }
          for (let y = y0 + 1; y < y1; y += 1) {
            push(x0, y);
            push(x1, y);
          }

          while (cursor < queue.length) {
            const index = queue[cursor];
            cursor += 1;
            data[index * 4 + 3] = 0;

            const x = index % width;
            const y = Math.floor(index / width);
            push(x + 1, y);
            push(x - 1, y);
            push(x, y + 1);
            push(x, y - 1);
          }
        }
      }
    }

    function isLightCellBackground(data, offset) {
      const alpha = data[offset + 3];
      if (alpha === 0) return false;

      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);

      return max >= 190 && max - min <= 70 && red + green + blue >= 590;
    }

    function getActiveCreature(team) {
      return team.creatures[team.activeIndex || 0];
    }

    function schedulePolling() {
      if (state.polling) clearTimeout(state.polling);

      const hasPending = state.taxa.some((taxon) => ["queued", "running", "missing"].includes(taxon.sprite.status));
      if (!hasPending) return;

      state.polling = setTimeout(async () => {
        try {
          await loadRoster();
        } catch (error) {
          setStatus(error.message);
        }
      }, 8000);
    }

    async function apiFetch(path, init) {
      const res = await fetch(path, init);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Request failed");
      }

      return data;
    }

    function setBusy(isBusy, message) {
      els.importButton.disabled = isBusy;
      els.queueMoreButton.disabled = isBusy || !state.userId;
      els.batchPreviewButton.disabled = isBusy || !state.userId;
      els.batchSubmitButton.disabled = isBusy || !state.userId || state.batchJobs.length === 0;
      els.seedImportButton.disabled = isBusy;
      els.seedQueueButton.disabled = isBusy;
      els.seedSubmitButton.disabled = isBusy || state.seedJobs.length === 0;
      els.manualUploadButton.disabled = isBusy;
      els.manualTaxonId.disabled = isBusy;
      els.manualScientificName.disabled = isBusy;
      els.manualCommonName.disabled = isBusy;
      els.manualSpriteFile.disabled = isBusy;
      els.manualAddToRoster.disabled = isBusy;
      els.treeSearchInput.disabled = isBusy;
      els.treeRefreshButton.disabled = isBusy;
      els.recentSearchInput.disabled = isBusy;
      els.recentRefreshButton.disabled = isBusy;
      els.devTaxonIdInput.disabled = isBusy;
      els.devRandomButton.disabled = isBusy;
      els.devInspectButton.disabled = isBusy;
      els.devMovesButton.disabled = isBusy;
      els.devQueueSpriteButton.disabled = isBusy;
      els.devGenerateSpriteButton.disabled = isBusy;
      els.devGenerateSvgButton.disabled = isBusy;
      els.devBatchIdInput.disabled = isBusy;
      els.devSyncBatchButton.disabled = isBusy;
      els.clearTeamButton.disabled = isBusy || state.selectedTaxa.size === 0;
      els.startBattleButton.disabled = isBusy || !state.userId || state.selectedTaxa.size !== 5;
      if (message) setStatus(message);
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function debounce(fn, waitMs) {
      let timeoutId;
      return (...args) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), waitMs);
      };
    }

    function setStatus(message) {
      els.statusLine.textContent = message || "";
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\x60/g, "&#96;");
    }
  </script>
</body>
</html>`;
}
