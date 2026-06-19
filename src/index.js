import {
  chooseNpcAction,
  chooseNpcMove,
  createBattleCreature,
  createGenome,
  createNpcTeam,
  createSeededRng,
  reconstructBattleStates,
  resolveTurn,
  terrainForTeam,
  territoryBuffPctForBiomeCount,
  TERRAIN_MOVE_BONUS,
  TYPE_CHART
} from "./game.js";
import { REPLAY_PAGE_HTML } from "./replay-page.js";
import APP_CSS from "./app.css";
import APP_CLIENT_JS from "./app-client.js";

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
import { postBattleHighlight } from "./bsky-bot.js";
import { renderHighlightHeadless } from "./highlight-bot.js";

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
const SPRITE_TREE_CACHE_TTL_MS = 60 * 1000;
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
const spriteTreeCache = new Map();
const spriteTreeAncestorCache = new Map();
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
      return applyCors(await routeRequest(request, env, ctx), env, request);
    } catch (error) {
      console.error(error);
      return applyCors(
        jsonResponse(
          { error: error instanceof Error ? error.message : "Unexpected error" },
          Number.isInteger(error?.status) ? error.status : 500
        ),
        env,
        request
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

    try {
      await runHighlightCurator(env); // self-throttled; no-op unless HIGHLIGHT_BOT_ENABLED
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

// --- Route table -----------------------------------------------------------
//
// Ordered list of routes; the dispatcher returns the FIRST match, so more
// specific patterns must precede general ones — exactly mirroring the original
// sequential if-chain (some pairs are order-sensitive, e.g. /challenges/:id
// /accept before /challenges/:id, and exact /sprite-batches/latest before the
// /sprite-batches/:id regex). A route's `path` may be:
//   - a string   -> exact pathname match
//   - a RegExp   -> matched against pathname; capture groups arrive as params
//   - a function -> custom predicate (url) => paramsArray | null
// `method` is a verb, an array of verbs, or "*" for any method. Handlers receive
// (request, env, ctx, { url, params }); params[n] are the regex captures.
const ROUTES = [
  { method: "GET", path: "/", handler: () => htmlResponse(renderAppHtml()) },

  // Battle highlight video renderer (battle-highlights-bluesky.md): a standalone
  // page that deterministically replays a battle onto a canvas and encodes an
  // MP4 in-browser via WebCodecs. Runs both in a user's browser (Share button)
  // and in headless Chrome (the bot). battleId is read from the path client-side.
  { method: "GET", path: (url) => url.pathname.startsWith("/replay/") ? [] : null,
    handler: () => htmlResponse(REPLAY_PAGE_HTML) },

  { method: "GET", path: "/assets/landing-hero-battle.webp",
    handler: () => bundledImageResponse(landingHeroBattleImage, "image/webp") },
  { method: "GET", path: "/assets/icon-192.png",
    handler: () => bundledImageResponse(iconImage192, "image/png") },
  { method: "GET", path: "/assets/icon-512.png",
    handler: () => bundledImageResponse(iconImage512, "image/png") },
  { method: "GET", path: "/assets/icon-512-maskable.png",
    handler: () => bundledImageResponse(iconImage512Maskable, "image/png") },
  { method: "GET", path: "/assets/apple-touch-icon-180.png",
    handler: () => bundledImageResponse(appleTouchIcon180, "image/png") },
  { method: "GET", path: "/manifest.webmanifest", handler: () => manifestResponse() },
  { method: "GET", path: "/sw.js", handler: () => serviceWorkerResponse() },

  // Status-effect images: only match known statuses, otherwise fall through to 404.
  { method: "GET",
    path: (url) => {
      const m = url.pathname.match(/^\/assets\/status-([a-z]+)\.png$/);
      return m && STATUS_EFFECT_IMAGES[m[1]] ? m : null;
    },
    handler: (request, env, ctx, { params }) =>
      bundledImageResponse(STATUS_EFFECT_IMAGES[params[1]], "image/png") },

  { method: "GET",
    path: (url) => (url.pathname === "/health" || url.pathname === "/api/health") ? [] : null,
    handler: () => jsonResponse({ ok: true, service: "inat-battler" }) },

  { method: "*", path: (url) => url.pathname.startsWith("/api/assets/") ? [] : null,
    handler: (request, env) => serveAsset(request, env) },

  { method: "GET", path: "/oauth/client-metadata.json",
    handler: (request, env, ctx, { url }) => jsonResponse(clientMetadataDocument(env, url.origin)) },

  { method: "GET", path: "/oauth/callback",
    handler: (request, env) => handleOAuthCallback(request, env) },

  { method: "POST", path: "/api/auth/login", handler: async (request, env, ctx, { url }) => {
    await enforceRateLimit(env, request, "auth-login", 12, 60);
    const payload = await readJson(request);
    return jsonResponse(await beginBlueskyLogin(env, url.origin, payload));
  } },

  { method: "POST", path: "/api/auth/logout", handler: (request, env) => handleLogout(request, env) },

  { method: "POST", path: "/api/account/delete", handler: async (request, env) => {
    await enforceRateLimit(env, request, "account-delete", 6, 60);
    return handleAccountDelete(request, env);
  } },

  { method: "GET", path: "/api/me", handler: async (request, env) => jsonResponse(await getMe(request, env)) },

  { method: "GET", path: "/api/bsky/typeahead", handler: async (request, env, ctx, { url }) => {
    const actors = await searchActorsTypeahead(url.searchParams.get("q"), 8);
    return jsonResponse({ actors });
  } },

  { method: "POST", path: "/api/inat/link/start", handler: async (request, env) => {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, request, "inat-link", 15, 60);
    const payload = await readJson(request);
    return jsonResponse(await startInatLink(env, session, payload.inatLogin));
  } },

  { method: "POST", path: "/api/inat/link/confirm", handler: async (request, env, ctx) => {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, request, "inat-link", 15, 60);
    return jsonResponse(await confirmInatLink(env, session, ctx));
  } },

  { method: "POST", path: "/api/inat/unlink", handler: async (request, env) => {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, request, "inat-link", 15, 60);
    return jsonResponse(await handleInatUnlink(env, session));
  } },

  { method: "POST", path: "/api/my-sprites/upload", handler: async (request, env) => {
    const session = await requireSession(request, env);
    return jsonResponse(await uploadUserSprite(request, env, session));
  } },

  { method: "GET", path: "/api/my-sprites", handler: async (request, env) => {
    const session = await requireSession(request, env);
    return jsonResponse(await listUserSprites(env, session));
  } },

  { method: "POST", path: "/api/sprite-submissions/sync", handler: async (request, env) => {
    const session = await requireSession(request, env);
    return jsonResponse(await syncSpriteSubmissions(env, 25, session.did));
  } },

  { method: "POST", path: /^\/api\/sprite-submissions\/([^/]+)\/sync$/, handler: async (request, env, ctx, { params }) => {
    const session = await requireSession(request, env);
    return jsonResponse(await syncSingleSubmission(env, decodeURIComponent(params[1]), session));
  } },

  { method: "GET", path: "/api/training", handler: async (request, env) => {
    const session = await requireSession(request, env);
    return jsonResponse(await getTrainingOverview(env, session));
  } },

  { method: "POST", path: "/api/training/sync", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    const rows = Array.isArray(payload?.speciesCounts) ? payload.speciesCounts.slice(0, 12000) : null;
    return jsonResponse(await syncTrainingData(env, session, rows));
  } },

  { method: "POST", path: "/api/territory/sync", handler: async (request, env) => {
    const session = await requireSession(request, env);
    return jsonResponse(await syncTerritoryObservations(env, session));
  } },

  // Browser-fetch path: the user's own browser pulls their observations from
  // iNaturalist (so the iNat rate limit is per-user, not on the Worker's shared
  // egress) and POSTs the raw rows here just to be persisted. Capped to bound
  // the D1 write budget.
  { method: "POST", path: "/api/territory/ingest", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    const rows = Array.isArray(payload?.observations) ? payload.observations.slice(0, 3000) : [];
    return jsonResponse(await ingestTerritoryObservations(env, session, rows));
  } },

  { method: "GET", path: "/api/territory/tiles", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryTiles(env, session, url));
  } },

  { method: "GET", path: "/api/territory/observations", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryObservations(env, session, url));
  } },

  { method: "GET", path: "/api/avatar", handler: (request, env, ctx, { url }) =>
    proxyAvatar(url.searchParams.get("url") || "") },

  { method: ["GET", "HEAD"], path: "/tiles/biomes.pmtiles", handler: (request, env) => servePmtiles(request, env) },

  { method: "GET", path: "/api/territory/cell", handler: async (request, env, ctx, { url }) => {
    await requireSession(request, env);
    return jsonResponse(await getTerritoryCell(env, url));
  } },

  { method: "GET", path: "/api/territory/claims", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryClaims(env, session, url));
  } },

  { method: "GET", path: "/api/territory/tile", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    return jsonResponse(await getTerritoryTileDetail(env, session, url.searchParams.get("h3")));
  } },

  { method: "POST", path: "/api/territory/claim", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await claimTerritoryTile(env, session, String(payload.h3 ?? "")));
  } },

  { method: "POST", path: "/api/territory/garrison", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await assignTileGarrison(env, session, String(payload.h3 ?? ""), payload.taxonIds));
  } },

  { method: "POST", path: "/api/territory/contest", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await contestTerritoryTile(env, session, String(payload.h3 ?? ""), payload.taxonIds));
  } },

  { method: "POST", path: "/api/training/allocate", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await allocateTrainingPoints(env, session, payload));
  } },

  { method: "POST", path: "/api/training/respec", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await respecTraining(env, session, payload.taxonId));
  } },

  { method: "POST", path: "/api/training/nickname", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await setTrainingNickname(env, session, payload.taxonId, payload.nickname));
  } },

  { method: "POST", path: "/api/challenges", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await createChallenge(env, url.origin, session, payload));
  } },

  { method: "GET", path: "/api/challenges", handler: async (request, env) => {
    const session = await requireSession(request, env);
    return jsonResponse(await listChallengesForSession(env, session));
  } },

  { method: "POST", path: /^\/api\/challenges\/([^/]+)\/accept$/, handler: async (request, env, ctx, { params }) => {
    const session = await requireSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(
      await acceptChallenge(env, session, decodeURIComponent(params[1]), payload.taxonIds ?? [])
    );
  } },

  { method: "POST", path: /^\/api\/challenges\/([^/]+)\/decline$/, handler: async (request, env, ctx, { params }) => {
    const session = await requireSession(request, env);
    return jsonResponse(await declineChallenge(env, session, decodeURIComponent(params[1])));
  } },

  { method: "GET", path: /^\/api\/challenges\/([^/]+)$/, handler: async (request, env, ctx, { params }) =>
    jsonResponse(await getChallengePublic(env, decodeURIComponent(params[1]))) },

  { method: "POST", path: "/api/import", handler: async (request, env) => {
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
  } },

  { method: "POST", path: "/api/manual-sprites/upload", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await uploadManualSprite(request, env));
  } },

  { method: "GET", path: /^\/api\/users\/([^/]+)\/roster$/, handler: async (request, env, ctx, { url, params }) => {
    const userId = decodeURIComponent(params[1]);
    const session = await getSession(request, env);
    return jsonResponse(await getRoster(env, userId, {
      ...rosterOptionsFromUrl(url),
      viewerUserId: session?.inat_login ? inatUserIdFor(session.inat_login) : null
    }));
  } },

  { method: "GET", path: "/api/roster", handler: async (request, env, ctx, { url }) => {
    const userId = url.searchParams.get("userId");
    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);
    const session = await getSession(request, env);
    return jsonResponse(await getRoster(env, userId, {
      ...rosterOptionsFromUrl(url),
      viewerUserId: session?.inat_login ? inatUserIdFor(session.inat_login) : null
    }));
  } },

  { method: "POST", path: /^\/api\/users\/([^/]+)\/sprites\/(\d+)\/preference$/, handler: async (request, env, ctx, { params }) => {
    // Identity comes from the session, never the path — the path :userId is
    // ignored for writes so a caller cannot set another account's preference.
    const session = await requireSession(request, env);
    const userId = requireLinkedUserId(session);
    const taxonId = Number(params[2]);
    const payload = await readJson(request);
    return jsonResponse(await setUserSpritePreference(env, userId, taxonId, String(payload.assetId ?? "")));
  } },

  { method: "POST", path: /^\/api\/users\/([^/]+)\/sprites\/queue-missing$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    const userId = decodeURIComponent(params[1]);
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, maxQueueMoreLimit(env), 12);
    const queued = await queueMissingSpritesForUser(env, userId, limit, 80);
    return jsonResponse({ queued });
  } },

  { method: "POST", path: "/api/sprite-jobs", handler: async (request, env) => {
    await requireAdminSession(request, env);
    const payload = await readJson(request);
    const userId = String(payload.userId ?? "");
    const limit = clampInt(payload.limit, 1, maxQueueMoreLimit(env), 12);
    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);
    const queued = await queueMissingSpritesForUser(env, userId, limit, 80);
    return jsonResponse({ queued });
  } },

  { method: "GET", path: "/api/sprite-jobs", handler: async (request, env, ctx, { url }) => {
    await requireAdminSession(request, env);
    const status = url.searchParams.get("status") ?? "queued";
    const userId = url.searchParams.get("userId") ?? "";
    const limit = clampInt(url.searchParams.get("limit"), 1, maxQueueMoreLimit(env), 100);
    return jsonResponse(await listSpriteJobs(env, status, userId, limit));
  } },

  { method: "GET", path: "/api/global-seed/status", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getGlobalSeedStatus(env));
  } },

  { method: "GET", path: "/api/global-seed/jobs", handler: async (request, env, ctx, { url }) => {
    await requireAdminSession(request, env);
    const limit = clampInt(url.searchParams.get("limit"), 1, GLOBAL_SEED_BATCH_SIZE, GLOBAL_SEED_BATCH_SIZE);
    return jsonResponse({ jobs: await selectQueuedSpriteJobsForBatch(env, limit, "", true) });
  } },

  { method: "POST", path: "/api/global-seed/dev-import", handler: async (request, env) => {
    await requireAdminSession(request, env);
    const payload = await readJson(request);
    const limitPerGroup = clampInt(payload.limitPerGroup, 1, 1000, GLOBAL_SEED_LIMIT_PER_GROUP);
    return jsonResponse(await importGlobalSeedTaxa(env, limitPerGroup));
  } },

  { method: "POST", path: "/api/global-seed/dev-queue", handler: async (request, env) => {
    await requireAdminSession(request, env);
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, GLOBAL_SEED_BATCH_SIZE, GLOBAL_SEED_BATCH_SIZE);
    return jsonResponse(await queueMissingGlobalSeedSprites(env, limit));
  } },

  { method: "POST", path: "/api/global-seed/dev-submit", handler: async (request, env) => {
    await requireAdminSession(request, env);
    const payload = await readJson(request);
    const limit = clampInt(payload.limit, 1, GLOBAL_SEED_BATCH_SIZE, GLOBAL_SEED_BATCH_SIZE);
    return jsonResponse(await submitDevSpriteBatch(env, request.url, {
      limit,
      userId: "",
      queueMissing: false,
      seedOnly: true
    }));
  } },

  { method: "POST", path: "/api/sprite-batches/dev-submit", handler: async (request, env) => {
    await requireAdminSession(request, env);
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
  } },

  { method: "GET", path: "/api/sprite-batches/latest", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getLatestSpriteBatch(env));
  } },

  { method: "POST", path: "/api/sprite-batches/dev-auto-sync", handler: async (request, env, ctx, { url }) => {
    await requireAdminSession(request, env);
    const limit = clampInt(url.searchParams.get("limit"), 1, 10, AUTO_SPRITE_BATCH_SYNC_LIMIT);
    const maxItems = clampInt(url.searchParams.get("maxItems"), 1, 200, AUTO_SPRITE_BATCH_SYNC_ITEMS);
    return jsonResponse(await syncPendingSpriteBatches(env, limit, maxItems));
  } },

  { method: "POST", path: "/api/move-batches/dev-submit", handler: async (request, env) => {
    await requireAdminSession(request, env);
    const payload = await readJson(request);
    return jsonResponse(await submitMoveBatch(env, {
      limit: clampInt(payload.limit, 1, 60, 10),
      userId: payload.userId ? String(payload.userId) : ""
    }));
  } },

  { method: "POST", path: "/api/move-batches/dev-auto-sync", handler: async (request, env, ctx, { url }) => {
    await requireAdminSession(request, env);
    const limit = clampInt(url.searchParams.get("limit"), 1, 20, AUTO_MOVE_BATCH_SYNC_LIMIT);
    return jsonResponse(await syncAutoMoveBatchImageSubmissions(env, limit));
  } },

  { method: "POST", path: /^\/api\/move-batches\/([^/]+)\/sync$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await syncMoveBatch(env, decodeURIComponent(params[1])));
  } },

  { method: "GET", path: /^\/api\/move-batches\/([^/]+)$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getMoveBatch(env, decodeURIComponent(params[1])));
  } },

  { method: "GET", path: "/api/taxa/random-spriteless", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getRandomSpritelessTaxon(env));
  } },

  { method: "POST", path: /^\/api\/taxa\/(\d+)\/moves\/dev-generate$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await generateMovesForTaxon(env, Number(params[1])));
  } },

  { method: "GET", path: /^\/api\/taxa\/(\d+)\/genome$/, handler: async (request, env, ctx, { params }) =>
    jsonResponse(await getTaxonGenome(env, Number(params[1]))) },

  { method: "GET", path: /^\/api\/taxa\/(\d+)\/dev-lab$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getTaxonDevLab(env, Number(params[1])));
  } },

  { method: "POST", path: /^\/api\/taxa\/(\d+)\/sprites\/dev-queue$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await queueSpriteJobForTaxon(env, Number(params[1]), 40));
  } },

  { method: "POST", path: /^\/api\/taxa\/(\d+)\/sprites\/dev-generate$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await devGenerateSpriteForTaxon(env, Number(params[1])));
  } },

  { method: "POST", path: /^\/api\/taxa\/(\d+)\/sprites\/dev-submit-batch$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await submitSpriteBatchForTaxon(env, request.url, Number(params[1])));
  } },

  { method: "POST", path: /^\/api\/sprite-batches\/([^/]+)\/sync$/, handler: async (request, env, ctx, { url, params }) => {
    await requireAdminSession(request, env);
    const maxItems = clampInt(url.searchParams.get("maxItems"), 1, 200, 25);
    return jsonResponse(await syncSpriteBatch(env, decodeURIComponent(params[1]), { maxItems }));
  } },

  { method: "GET", path: /^\/api\/sprite-batches\/([^/]+)$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getSpriteBatch(env, decodeURIComponent(params[1])));
  } },

  { method: "POST", path: "/api/sprite-jobs/dev-generate-next", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await devGenerateNextSpriteJob(env));
  } },

  { method: "POST", path: /^\/api\/sprite-jobs\/([^/]+)\/dev-generate$/, handler: async (request, env, ctx, { params }) => {
    await requireAdminSession(request, env);
    const jobId = decodeURIComponent(params[1]);
    return jsonResponse(await devGenerateSpriteForJob(env, jobId));
  } },

  { method: "GET", path: "/api/sprite-status", handler: async (request, env, ctx, { url }) => {
    const taxonIds = (url.searchParams.get("taxonIds") ?? "")
      .split(",")
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite)
      .slice(0, 100);
    return jsonResponse(await getSpriteStatus(env, taxonIds));
  } },

  { method: "GET", path: "/api/sprite-tree", handler: async (request, env, ctx, { url }) => {
    const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 500);
    const q = String(url.searchParams.get("q") ?? "");
    return jsonResponse(await getSpriteTree(env, { limit, q }));
  } },

  // Phase 0 (sprite taxonomic tree): list ancestor taxon IDs referenced by
  // ready-sprite taxa that are not yet stored as their own taxa rows, so the
  // backfill can fetch exactly the missing internal nodes (orders/families/...).
  { method: "GET", path: "/api/sprite-tree/dev-missing-ancestors", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await getMissingAncestorTaxonIds(env));
  } },

  // Phase 0: bulk-upsert iNat taxon objects (fetched client-side) into taxa.
  { method: "POST", path: "/api/taxa/dev-bulk-upsert", handler: async (request, env) => {
    await requireAdminSession(request, env);
    const payload = await readJson(request);
    const taxa = Array.isArray(payload.taxa) ? payload.taxa : [];
    return jsonResponse(await bulkUpsertTaxa(env, taxa));
  } },

  { method: "GET", path: "/api/recent-sprites", handler: async (request, env, ctx, { url }) => {
    const limit = clampInt(url.searchParams.get("limit"), 1, 200, 80);
    const q = String(url.searchParams.get("q") ?? "");
    return jsonResponse(await getRecentSprites(env, { limit, q }));
  } },

  { method: "GET", path: /^\/api\/users\/([^/]+)\/teams$/, handler: async (request, env, ctx, { params }) => {
    const userId = decodeURIComponent(params[1]);
    return jsonResponse({ teams: await listTeams(env, userId) });
  } },

  { method: "POST", path: /^\/api\/users\/([^/]+)\/teams$/, handler: async (request, env) => {
    // Save to the signed-in account only; the path :userId is not trusted.
    const session = await requireSession(request, env);
    const userId = requireLinkedUserId(session);
    const payload = await readJson(request);
    const name = String(payload.name ?? "Field Team");
    const taxonIds = Array.isArray(payload.taxonIds) ? payload.taxonIds.map(Number) : [];
    return jsonResponse(await saveTeam(env, userId, name, taxonIds));
  } },

  { method: "GET", path: "/api/leaderboard", handler: async (request, env) => {
    const session = await getSession(request, env);
    const viewerUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;
    return jsonResponse(await getLeaderboard(env, viewerUserId));
  } },

  { method: "GET", path: "/api/leaderboard/territory", handler: async (request, env) => {
    const session = await getSession(request, env);
    const viewerUserId = session?.inat_login ? inatUserIdFor(session.inat_login) : null;
    return jsonResponse(await getTerritoryLeaderboard(env, viewerUserId));
  } },

  // Admin: validate the headless render pipeline (Browser Rendering + WebCodecs).
  // ?battleId=__selftest&post=0&fps=24&max=40 — with post=1 it also posts to the
  // brand feed, exercising the full bot path end to end.
  { method: "GET", path: "/api/highlights/render-test", handler: async (request, env, ctx, { url }) => {
    await requireAdminSession(request, env);
    return jsonResponse(await renderHighlightTest(env, {
      battleId: url.searchParams.get("battleId") || "__selftest",
      post: url.searchParams.get("post") === "1",
      fps: Number(url.searchParams.get("fps")) || 24,
      maxSeconds: Number(url.searchParams.get("max")) || 40
    }));
  } },

  // Opt in/out of letting the highlight bot feature your battles on @wildmarch.
  { method: "POST", path: "/api/settings/highlight-opt-in", handler: async (request, env) => {
    const session = await requireSession(request, env);
    const userId = requireLinkedUserId(session);
    const payload = await readJson(request);
    const enabled = payload.enabled ? 1 : 0;
    await env.DB.prepare("UPDATE users SET allow_highlight_bot = ?, updated_at = ? WHERE id = ?")
      .bind(enabled, new Date().toISOString(), userId).run();
    return jsonResponse({ ok: true, allowHighlightBot: enabled === 1 });
  } },

  // Admin: run the curator once now (force bypasses the global flag + interval,
  // still respects opt-in + dedupe). For testing without waiting for cron.
  { method: "POST", path: "/api/highlights/run-curator", handler: async (request, env) => {
    await requireAdminSession(request, env);
    return jsonResponse(await runHighlightCurator(env, { force: true }));
  } },

  { method: "POST", path: "/api/share/battle", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, request, "share", 20, 60);
    const payload = await readJson(request);
    return jsonResponse(await shareBattleToBluesky(env, session, String(payload.battleId ?? ""), url.origin));
  } },

  { method: "POST", path: "/api/share/rank", handler: async (request, env, ctx, { url }) => {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, request, "share", 20, 60);
    return jsonResponse(await shareRankToBluesky(env, session, url.origin));
  } },

  { method: "POST", path: "/api/battles/npc/start", handler: async (request, env) => {
    // Battles are always started for the signed-in account; ranked ratings hang
    // off this id, so it must come from the session, not the request body.
    const session = await requireSession(request, env);
    const userId = requireLinkedUserId(session);
    const payload = await readJson(request);
    const taxonIds = Array.isArray(payload.taxonIds) ? payload.taxonIds.map(Number) : [];
    const npcTemplate = String(payload.npcTemplate ?? "backyard_beginner");
    const difficulty = ["easy", "normal", "hard"].includes(payload.difficulty) ? payload.difficulty : "normal";
    return jsonResponse(await startNpcBattle(env, userId, taxonIds, npcTemplate, difficulty));
  } },

  { method: "POST", path: "/api/battles/demo/start", handler: async (request, env) =>
    jsonResponse(await startDemoBattle(env)) },

  { method: "GET", path: /^\/api\/battles\/([^/]+)$/, handler: async (request, env, ctx, { params }) => {
    const battle = await getBattle(env, decodeURIComponent(params[1]));
    return battle ? jsonResponse(battle) : jsonResponse({ error: "Battle not found" }, 404);
  } },

  { method: "GET", path: /^\/api\/battles\/([^/]+)\/replay$/, handler: async (request, env, ctx, { url, params }) => {
    const wantStates = url.searchParams.get("states") === "1";
    return jsonResponse(
      await getBattleReplay(env, decodeURIComponent(params[1]), { states: wantStates })
    );
  } },

  // Share a rendered highlight MP4 (raw video/mp4 body). Posts to the user's own
  // Bluesky account; with ?brand=1 also cross-posts to the brand feed.
  { method: "POST", path: /^\/api\/battles\/([^/]+)\/share-video$/, handler: async (request, env, ctx, { url, params }) => {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, request, "share-video", 10, 60);
    const bytes = new Uint8Array(await request.arrayBuffer());
    return jsonResponse(await shareBattleVideo(env, session, decodeURIComponent(params[1]), bytes, {
      caption: url.searchParams.get("caption") || "",
      width: Number(url.searchParams.get("w")) || 720,
      height: Number(url.searchParams.get("h")) || 900
    }));
  } },

  { method: "POST", path: /^\/api\/battles\/([^/]+)\/action$/, handler: async (request, env, ctx, { params }) => {
    const battleId = decodeURIComponent(params[1]);
    // Guest demo battles are anonymous; every other battle drives ranked ratings,
    // so the caller must own it. Verify ownership against the session before any
    // move is resolved (battle ids are handed to clients and aren't secret).
    const existing = await getBattle(env, battleId);
    if (!existing) return jsonResponse({ error: "Battle not found" }, 404);
    if (existing.player?.userId !== DEMO_USER_ID) {
      const session = await requireSession(request, env);
      if (existing.player?.userId !== requireLinkedUserId(session)) {
        throw httpError("This is not your battle", 403);
      }
    }
    const payload = await readJson(request);
    return jsonResponse(await submitBattleMove(
      env,
      battleId,
      String(payload.moveId ?? ""),
      payload.switchIndex
    ));
  } }
];

// Match a route's path spec against the URL. Returns the params array (regex
// captures, or [] for matches with none) when it matches, or null otherwise.
function matchRoutePath(path, url) {
  if (typeof path === "string") return url.pathname === path ? [] : null;
  if (path instanceof RegExp) return url.pathname.match(path);
  if (typeof path === "function") return path(url);
  return null;
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  for (const route of ROUTES) {
    const methods = route.method === "*"
      ? null
      : (Array.isArray(route.method) ? route.method : [route.method]);
    if (methods && !methods.includes(request.method)) continue;

    const params = matchRoutePath(route.path, url);
    if (params) {
      return route.handler(request, env, ctx, { url, params });
    }
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

// Wrap fetch with an abort-on-timeout so a hung upstream (OpenAI, iNaturalist,
// Discord, image hosts) can't stall a request. This matters most in the
// cron/queue path, where tasks run sequentially and one hang would block the
// rest (and can blow the whole cron's wall-clock budget). Throws on timeout.
async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...init, signal });
}

async function fetchInatWithRetry(url) {
  const res = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": INAT_USER_AGENT
    }
  }, 15000);

  if (res.status !== 429) return res;

  const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  const waitMs = Number.isFinite(retryAfter)
    ? Math.min(10_000, Math.max(1_000, retryAfter * 1000))
    : 2500;
  await sleep(waitMs);

  return fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": INAT_USER_AGENT
    }
  }, 15000);
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

  const response = await fetchWithTimeout("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: form
  }, 60000);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI batch file upload failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function createOpenAIBatch(env, inputFileId, endpoint, metadata) {
  const response = await fetchWithTimeout("https://api.openai.com/v1/batches", {
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
  }, 30000);

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
  const response = await fetchWithTimeout(`https://api.openai.com/v1/batches/${encodeURIComponent(batchId)}`, {
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    }
  }, 30000);

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
  const response = await fetchWithTimeout(`https://api.openai.com/v1/files/${encodeURIComponent(fileId)}/content`, {
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    }
  }, 120000);

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

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
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
  }, 60000);
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

async function getRosterSummary(env, userId, includePendingCustomSprites = false) {
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
            AND (uss.status = 'approved' OR (? = 1 AND uss.status = 'pending'))
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
    includePendingCustomSprites ? 1 : 0,
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
  const includePendingCustomSprites = options.viewerUserId === userId;

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
          AND (uss.status = 'approved' OR (? = 1 AND uss.status = 'pending'))
        ORDER BY uss.created_at DESC
        LIMIT 1
      ) AS custom_r2_key,
      (
        SELECT uss.status
        FROM user_sprite_submissions uss
        WHERE uss.user_id = ut.user_id
          AND uss.taxon_id = t.taxon_id
          AND ? = 1
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
    includePendingCustomSprites ? 1 : 0,
    includePendingCustomSprites ? 1 : 0,
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
    summary: await getRosterSummary(env, userId, includePendingCustomSprites),
    limit,
    offset,
    iconicCounts: (iconicRows.results ?? []).map((row) => ({
      iconic: row.iconic,
      count: Number(row.count)
    })),
    taxa: rosterRows.map((row) => {
      // Pending custom sprites are owner-only until Discord QA approves them.
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
  const limit = Math.max(1, Math.min(1000, Number(options.limit ?? 500)));
  const cacheKey = `${limit}:${q.toLowerCase()}`;
  const cached = spriteTreeCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SPRITE_TREE_CACHE_TTL_MS) {
    return cached.result;
  }

  const rows = await env.DB.prepare(`
    WITH ranked_assets AS (
      SELECT
        sa.taxon_id,
        sa.r2_key,
        sa.model,
        ROW_NUMBER() OVER (
          PARTITION BY sa.taxon_id
          ORDER BY
            CASE
              WHEN sa.model = 'manual-upload' OR sa.model = 'manual-upload-web' OR sa.prompt_hash LIKE 'manual-upload:%' THEN 1
              WHEN sa.prompt_hash LIKE 'manual-%' THEN 2
              ELSE 3
            END,
            sa.created_at DESC,
            sa.asset_id DESC
        ) AS asset_rank
      FROM sprite_assets sa
      WHERE sa.asset_kind = ?
        AND sa.asset_version = ?
        AND sa.status = 'ready'
    )
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.rank,
      t.iconic_taxon_name,
      t.ancestry,
      t.parent_id,
      ra.r2_key,
      ra.model AS sprite_model
    FROM ranked_assets ra
    JOIN taxa t ON t.taxon_id = ra.taxon_id
    WHERE ra.asset_rank = 1
      AND ra.r2_key IS NOT NULL
      AND (
        ? = ''
        OR lower(t.scientific_name) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.common_name, '')) LIKE '%' || lower(?) || '%'
        OR lower(COALESCE(t.iconic_taxon_name, '')) LIKE '%' || lower(?) || '%'
        OR CAST(t.taxon_id AS TEXT) = ?
      )
    ORDER BY COALESCE(t.iconic_taxon_name, 'Life') ASC, t.scientific_name ASC
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

  const result = {
    totalSprites: leaves.length,
    limit,
    q,
    roots: tree
  };

  spriteTreeCache.set(cacheKey, { createdAt: Date.now(), result });
  if (spriteTreeCache.size > 16) {
    const oldestKey = spriteTreeCache.keys().next().value;
    if (oldestKey) spriteTreeCache.delete(oldestKey);
  }

  return result;
}

async function loadAncestorTaxa(env, leaves) {
  const ids = new Set();
  for (const leaf of leaves) {
    for (const id of leaf.ancestorIds || []) ids.add(id);
  }
  const map = new Map();
  const missing = [];
  for (const id of ids) {
    const cached = spriteTreeAncestorCache.get(id);
    if (cached) map.set(id, cached);
    else missing.push(id);
  }
  for (const chunk of chunkArray(missing, D1_ID_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT taxon_id, scientific_name, common_name, rank, iconic_taxon_name
       FROM taxa WHERE taxon_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const r of rows.results ?? []) {
      const entry = {
        taxonId: Number(r.taxon_id),
        scientificName: r.scientific_name,
        commonName: r.common_name ?? null,
        rank: String(r.rank || "").toLowerCase(),
        iconicTaxonName: r.iconic_taxon_name || null
      };
      map.set(entry.taxonId, entry);
      spriteTreeAncestorCache.set(entry.taxonId, entry);
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
  const terrain = terrainForTeam(opponent);
  const state = {
    battleId,
    mode: "npc",
    difficulty,
    seed,
    turn: 1,
    terrain,
    player: { userId, name: "Your Team", activeIndex: 0, creatures },
    opponent,
    log: [{ turn: 0, text: `${opponent.name} challenges your field team. (${difficulty})` }],
    status: "active",
    // Deterministic-replay foundation (battle-highlights-bluesky.md): the
    // pristine starting teams + seed snapshotted once, never mutated, plus the
    // per-turn player actions appended in submitBattleMove. Together they let
    // reconstructBattleStates() reproduce the battle bit-for-bit for rendering.
    replay: {
      v: 1,
      mode: "npc",
      seed,
      difficulty,
      terrain,
      player: { name: "Your Team", creatures: structuredClone(creatures) },
      opponent: structuredClone(opponent)
    },
    actions: []
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

// Returns the compact replay artifact for a battle: the pristine starting teams
// + seed/difficulty and the recorded per-turn player actions. The video
// renderer feeds this to reconstructBattleStates() to redraw the battle. Only
// battles created after the replay foundation landed carry `replay`/`actions`;
// older battles return `available: false`.
async function getBattleReplay(env, battleId, { states = false } = {}) {
  // `__selftest` synthesizes a battle on the fly (no DB/auth) so the renderer
  // can be exercised standalone — used by the Playwright check and as a demo.
  if (battleId === "__selftest") {
    const replay = await buildSelftestReplay(env);
    const built = reconstructBattleStates(replay.replay, replay.actions);
    return {
      available: true,
      battleId,
      status: built.at(-1).status,
      turns: replay.actions.length,
      replay: replay.replay,
      actions: replay.actions,
      states: built
    };
  }

  const state = await getBattle(env, battleId);
  if (!state) return { error: "Battle not found", available: false };
  if (!state.replay || !Array.isArray(state.actions)) {
    return { available: false, reason: "no_replay", battleId, status: state.status ?? null };
  }
  return {
    available: true,
    battleId,
    status: state.status ?? null,
    turns: state.actions.length,
    replay: state.replay,
    actions: state.actions,
    states: states ? reconstructBattleStates(state.replay, state.actions) : undefined
  };
}

// Deterministically simulate a short battle and return its replay artifact
// (pristine teams + seed + recorded player actions). Mirrors the live loop in
// submitBattleMove so reconstructBattleStates reproduces it exactly. Teams are
// drawn from real ready-sprite taxa in the DB so the rendered video shows actual
// sprites (falls back to the static NPC roster if the DB has no ready sprites).
async function buildSelftestReplay(env, seed = "selftest-1") {
  let playerTeam, opponent;
  try {
    playerTeam = await createRandomReadyNpcTeam(env, [], 3);
    const exclude = playerTeam.creatures.map((c) => Number(c.taxonId)).filter(Number.isFinite);
    opponent = await createRandomReadyNpcTeam(env, exclude, 3);
    playerTeam = { ...playerTeam, name: "Wild Sprite Team A" };
    opponent = { ...opponent, name: "Wild Sprite Team B" };
  } catch (_) {
    playerTeam = createNpcTeam("wetland_watcher");
    opponent = createNpcTeam("backyard_beginner");
  }
  const terrain = terrainForTeam(opponent);
  const pristinePlayer = structuredClone(playerTeam.creatures);
  const pristineOpponent = structuredClone(opponent);

  let current = {
    mode: "npc",
    difficulty: "normal",
    seed,
    turn: 1,
    terrain,
    player: { name: playerTeam.name, activeIndex: 0, creatures: structuredClone(pristinePlayer) },
    opponent: structuredClone(pristineOpponent),
    log: [],
    status: "active"
  };

  const actions = [];
  const pick = createSeededRng(`picker:${seed}`);
  while (current.status === "active" && current.turn < 60) {
    const rng = createSeededRng(`${current.seed}:${current.turn}`);
    const npcAction = chooseNpcAction(current, "normal", rng);
    const active = current.player.creatures[current.player.activeIndex];
    const move = active.moves[Math.floor(pick() * active.moves.length)];
    const playerAction = { kind: "move", moveId: move.id };
    actions.push({ turn: current.turn, ...playerAction });
    current = resolveTurn(current, playerAction, npcAction, rng);
  }

  return {
    replay: {
      v: 1,
      mode: "npc",
      seed,
      difficulty: "normal",
      terrain,
      player: { name: playerTeam.name, creatures: pristinePlayer },
      opponent: pristineOpponent
    },
    actions
  };
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

  // Append this turn's player action to the replay log (NPC actions + RNG are
  // re-derived deterministically, so only the player's choice needs storing).
  // `state.turn` is the turn that was just resolved and matches the rng seed.
  if (!Array.isArray(next.actions)) next.actions = [];
  next.actions.push({ turn: state.turn, ...playerAction });

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

// Posts a rendered highlight MP4 to the @wildmarch brand feed (app password),
// crediting the battle's owner via an @mention. Video bytes stream straight
// through to Bluesky — R2 is never used. (Per-user own-account posting is
// deferred: it needs a broader OAuth scope; see docs/battle-highlights-bluesky.md.)
async function shareBattleVideo(env, session, battleId, bytes, { caption, width, height }) {
  const userId = requireLinkedUserId(session);
  const battle = await getBattle(env, battleId);
  if (!battle) throw httpError("Battle not found", 404);
  if (battle.player?.userId !== userId) throw httpError("This is not your battle", 403);
  if (!bytes || bytes.byteLength < 1000) throw httpError("Missing or empty video", 400);
  if (bytes.byteLength > 100 * 1024 * 1024) throw httpError("Video exceeds Bluesky's 100MB limit", 400);
  if (!env.BSKY_BOT_APP_PASSWORD || !env.BSKY_BOT_IDENTIFIER) {
    throw httpError("Highlight posting is not configured", 503);
  }

  const base = (caption && caption.trim()) || defaultHighlightCaption(battle);
  const handle = session.handle ? `@${session.handle}` : null;
  const text = handle ? `${base} — by ${handle}` : base;
  const mentions = session.handle && session.did ? [{ handle: session.handle, did: session.did }] : [];
  const alt = `An iNat Battler highlight: ${battle.player?.name || "a team"} vs ${battle.opponent?.name || "the opponent"}.`;

  const post = await postBattleHighlight({
    identifier: env.BSKY_BOT_IDENTIFIER,
    password: env.BSKY_BOT_APP_PASSWORD,
    bytes, text, alt, width, height, mentions,
    name: `battle-${battleId}.mp4`
  });
  const rkey = post?.uri ? String(post.uri).split("/").pop() : null;
  return {
    ok: true,
    brand: { uri: post?.uri ?? null, webUrl: rkey ? `https://bsky.app/profile/${post.handle}/post/${rkey}` : null }
  };
}

// Admin validation of the headless render pipeline. Returns timing + size so we
// can confirm Browser Rendering's Chrome supports the WebCodecs H.264 encoder
// before building the autonomous curator on top of it.
async function renderHighlightTest(env, { battleId, post, fps, maxSeconds }) {
  const startedAt = Date.now();
  const render = await renderHighlightHeadless(env, battleId, { fps, maxSeconds });
  const out = {
    ok: true,
    battleId,
    bytes: render.bytes.byteLength,
    mb: Number((render.bytes.byteLength / 1024 / 1024).toFixed(2)),
    width: render.width,
    height: render.height,
    durationMs: render.durationMs,
    inPageEncodeMs: render.encodeMs,
    totalRenderMs: Date.now() - startedAt
  };

  if (post) {
    if (!env.BSKY_BOT_APP_PASSWORD || !env.BSKY_BOT_IDENTIFIER) {
      out.posted = { error: "Brand posting not configured" };
    } else {
      const result = await postBattleHighlight({
        identifier: env.BSKY_BOT_IDENTIFIER,
        password: env.BSKY_BOT_APP_PASSWORD,
        bytes: render.bytes,
        text: "🌿 iNat Battler highlight (render-test) #iNatBattler",
        alt: "An automated iNat Battler highlight render test.",
        width: render.width,
        height: render.height,
        name: `rendertest-${battleId}.mp4`
      });
      const rkey = result?.uri ? String(result.uri).split("/").pop() : null;
      out.posted = { uri: result?.uri ?? null, webUrl: rkey ? `https://bsky.app/profile/${result.handle}/post/${rkey}` : null };
    }
  }
  return out;
}

// --- Autonomous highlight curator ------------------------------------------
const HIGHLIGHT_MAX_PER_DAY = 2;
const HIGHLIGHT_RUN_INTERVAL_MS = 30 * 60 * 1000; // don't scan more than this often
const HIGHLIGHT_CANDIDATE_WINDOW_HOURS = 72;      // only feature fresh battles
const HIGHLIGHT_MIN_SCORE = 4;

// Scores a finished battle for "highlight-worthiness" (player victories only).
// Rewards clean sweeps, comebacks (won despite losing creatures), fast wins,
// and crit drama. Returns 0 for anything not worth posting.
function scoreBattleForHighlight(state) {
  if (!state || state.status !== "won") return 0;
  const turns = Math.max(1, Number(state.turn ?? 1) - 1);
  const playerCreatures = state.player?.creatures ?? [];
  const oppCreatures = state.opponent?.creatures ?? [];
  const playerFaints = playerCreatures.filter((c) => c.fainted).length;
  const oppFaints = oppCreatures.filter((c) => c.fainted).length;
  const crits = (state.log ?? []).filter((e) => e?.data?.crit).length;
  const survivor = playerCreatures.find((c) => !c.fainted);
  const survivorLowHp = survivor && survivor.maxHp && survivor.hp / survivor.maxHp <= 0.25;

  let score = oppFaints * 1.5 + crits * 1.5;
  if (playerFaints === 0 && oppFaints >= 3) score += 4;        // flawless sweep
  if (playerFaints >= 2) score += 3;                            // comeback
  if (survivorLowHp) score += 3;                               // clutch finish
  if (turns <= 8) score += 3; else if (turns <= 14) score += 1; // fast win
  return score;
}

// Runs in the cron. Picks the single best un-posted, opted-in, recent victory,
// renders it headlessly, and posts to the brand feed — capped per day and
// throttled. `force` (admin) bypasses the global flag + interval.
async function runHighlightCurator(env, { force = false } = {}) {
  const enabled = String(env.HIGHLIGHT_BOT_ENABLED ?? "").toLowerCase() === "true";
  if (!enabled && !force) return { ran: false, reason: "disabled" };
  if (!env.BSKY_BOT_APP_PASSWORD || !env.BSKY_BOT_IDENTIFIER) return { ran: false, reason: "not_configured" };

  // Throttle scans (skip the KV check when forced).
  const now = Date.now();
  if (!force) {
    const last = Number((await env.CACHE.get("highlight:last_run")) ?? 0);
    if (now - last < HIGHLIGHT_RUN_INTERVAL_MS) return { ran: false, reason: "throttled" };
    await env.CACHE.put("highlight:last_run", String(now));
  }

  // Daily cap.
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const postedToday = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM battle_highlights WHERE status = 'posted' AND created_at >= ?"
  ).bind(dayAgo).first();
  if (Number(postedToday?.n ?? 0) >= HIGHLIGHT_MAX_PER_DAY) return { ran: false, reason: "daily_cap" };

  // Eligible: opted-in owners, recent victories, not already acted on.
  const windowStart = new Date(now - HIGHLIGHT_CANDIDATE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(`
    SELECT bi.battle_id, bi.attacker_user_id, bi.state_json
    FROM battle_instances bi
    JOIN users u ON u.id = bi.attacker_user_id AND u.allow_highlight_bot = 1
    LEFT JOIN battle_highlights bh ON bh.battle_id = bi.battle_id
    WHERE bi.status = 'won' AND bi.created_at >= ? AND bh.battle_id IS NULL
    ORDER BY bi.created_at DESC
    LIMIT 40
  `).bind(windowStart).all();

  let best = null;
  for (const row of rows.results ?? []) {
    let state;
    try { state = JSON.parse(row.state_json); } catch { continue; }
    const score = scoreBattleForHighlight(state);
    if (score >= HIGHLIGHT_MIN_SCORE && (!best || score > best.score)) {
      best = { battleId: row.battle_id, userId: row.attacker_user_id, score, state };
    }
  }
  if (!best) return { ran: true, posted: false, reason: "no_candidate", scanned: (rows.results ?? []).length };

  // Resolve the player's Bluesky handle/DID to credit them.
  const acct = await env.DB.prepare(`
    SELECT a.handle, a.did FROM users u
    JOIN accounts a ON a.inat_login = u.inat_login
    WHERE u.id = ? ORDER BY a.updated_at DESC LIMIT 1
  `).bind(best.userId).first();

  const nowIso = new Date().toISOString();
  try {
    const render = await renderHighlightHeadless(env, best.battleId, { fps: 24, maxSeconds: 60 });
    const handle = acct?.handle ? `@${acct.handle}` : null;
    const text = handle
      ? `${defaultHighlightCaption(best.state)} — by ${handle}`
      : defaultHighlightCaption(best.state);
    const mentions = acct?.handle && acct?.did ? [{ handle: acct.handle, did: acct.did }] : [];
    const post = await postBattleHighlight({
      identifier: env.BSKY_BOT_IDENTIFIER,
      password: env.BSKY_BOT_APP_PASSWORD,
      bytes: render.bytes,
      text,
      alt: `An iNat Battler highlight: ${best.state.player?.name || "a team"} vs ${best.state.opponent?.name || "the opponent"}.`,
      width: render.width, height: render.height,
      mentions, name: `battle-${best.battleId}.mp4`
    });
    await env.DB.prepare(
      "INSERT INTO battle_highlights (battle_id, user_id, status, score, post_uri, created_at) VALUES (?, ?, 'posted', ?, ?, ?)"
    ).bind(best.battleId, best.userId, best.score, post?.uri ?? null, nowIso).run();
    return { ran: true, posted: true, battleId: best.battleId, score: best.score, uri: post?.uri ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Record the failure so we don't retry the same battle forever.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO battle_highlights (battle_id, user_id, status, score, error, created_at) VALUES (?, ?, 'failed', ?, ?, ?)"
    ).bind(best.battleId, best.userId, best.score, message, nowIso).run();
    return { ran: true, posted: false, battleId: best.battleId, error: message };
  }
}

function defaultHighlightCaption(battle) {
  const turns = Math.max(1, Number(battle.turn ?? 1) - 1);
  const outcome =
    battle.status === "won" ? `My ${battle.player?.name || "team"} won` :
    battle.status === "lost" ? `${battle.opponent?.name || "The wild team"} won` :
    "A clash";
  return `${outcome} in ${turns} turns! ⚔️🦋 #iNatBattler`;
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

function csvEnvValues(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHandle(value) {
  return String(value ?? "").trim().replace(/^@+/, "").toLowerCase();
}

function isAdminSession(env, session) {
  if (!session) return false;

  const dids = new Set(csvEnvValues(env.ADMIN_DIDS));
  if (dids.has(String(session.did))) return true;

  const handles = new Set(csvEnvValues(env.ADMIN_BSKY_HANDLES).map(normalizeHandle));
  if (handles.has(normalizeHandle(session.handle))) return true;

  const inatLogins = new Set(csvEnvValues(env.ADMIN_INAT_LOGINS).map((value) => value.toLowerCase()));
  if (session.inat_login && inatLogins.has(String(session.inat_login).toLowerCase())) return true;

  return false;
}

async function requireAdminSession(request, env) {
  const session = await getSession(request, env);
  if (!isAdminSession(env, session)) {
    // Deliberately return 404 for private ops endpoints so they are not
    // advertised as protected admin surfaces to unauthenticated probes.
    throw httpError("Not found", 404);
  }
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

// Permanently delete the signed-in player's account and all their data. Shared/
// global data (taxa, the sprite_assets library, biome geography) is preserved;
// owned tiles are released to neutral. `deleteSharedSprites` also removes sprites
// the player contributed to the shared library (others lose that art).
async function handleAccountDelete(request, env) {
  const session = await requireSession(request, env);
  const did = session.did;
  const inatLogin = session.inat_login || null;
  const userId = inatLogin ? inatUserIdFor(inatLogin) : null;
  const payload = await readJson(request);
  const deleteSharedSprites = payload.deleteSharedSprites === true;

  // Collect R2 blobs to remove (before the rows that reference them are gone).
  const r2Keys = [];
  if (userId) {
    if (deleteSharedSprites) {
      const subs = await env.DB.prepare(
        "SELECT r2_key FROM user_sprite_submissions WHERE user_id = ?"
      ).bind(userId).all();
      for (const r of subs.results ?? []) if (r.r2_key) r2Keys.push(r.r2_key);
      // Remove the shared sprite_assets promoted from this user's approved uploads.
      await env.DB.prepare(
        "DELETE FROM sprite_assets WHERE prompt_hash IN " +
        "(SELECT 'user-approved:' || submission_id FROM user_sprite_submissions WHERE user_id = ?)"
      ).bind(userId).run();
    } else {
      // Keep promoted shared sprites: only delete uploads no sprite_asset references.
      const subs = await env.DB.prepare(
        "SELECT r2_key FROM user_sprite_submissions WHERE user_id = ? " +
        "AND r2_key NOT IN (SELECT r2_key FROM sprite_assets WHERE r2_key IS NOT NULL)"
      ).bind(userId).all();
      for (const r of subs.results ?? []) if (r.r2_key) r2Keys.push(r.r2_key);
    }
    // Release any tiles this player owns back to neutral (geography is shared).
    await env.DB.prepare(
      "UPDATE tiles SET owner_id = NULL, owner_faction_id = NULL, state = 'neutral', " +
      "defender_team_json = NULL, garrison_deadline = NULL, claimed_at = NULL WHERE owner_id = ?"
    ).bind(userId).run();
  }

  const statements = [];
  if (userId) {
    for (const table of [
      "user_taxa", "teams", "species_training", "user_masteries", "user_sprite_preferences",
      "player_ratings", "user_generation_budget_daily", "territory_players",
      "tile_observations", "territory_actions", "user_sprite_submissions"
    ]) {
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId));
    }
    statements.push(env.DB.prepare("DELETE FROM tile_garrison WHERE owner_id = ?").bind(userId));
    statements.push(env.DB.prepare(
      "DELETE FROM battle_instances WHERE attacker_user_id = ? OR defender_user_id = ?"
    ).bind(userId, userId));
    statements.push(env.DB.prepare(
      "DELETE FROM battle_results WHERE winner_user_id = ? OR loser_user_id = ?"
    ).bind(userId, userId));
    statements.push(env.DB.prepare("DELETE FROM battle_highlights WHERE user_id = ?").bind(userId));
    statements.push(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId));
  }
  statements.push(env.DB.prepare(
    "DELETE FROM challenges WHERE challenger_did = ? OR opponent_did = ?"
  ).bind(did, did));
  statements.push(env.DB.prepare("DELETE FROM oauth_requests WHERE did = ?").bind(did));
  statements.push(env.DB.prepare("DELETE FROM oauth_sessions WHERE did = ?").bind(did));
  statements.push(env.DB.prepare("DELETE FROM accounts WHERE did = ?").bind(did));
  await env.DB.batch(statements);

  // Best-effort R2 cleanup (the DB rows are already gone regardless).
  for (const key of r2Keys) {
    try { await env.ASSETS.delete(key); } catch (e) { /* ignore */ }
  }

  return new Response(JSON.stringify({ ok: true, deleted: true, deletedSharedSprites: deleteSharedSprites }), {
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

  const userId = session.inat_login ? inatUserIdFor(session.inat_login) : null;
  let allowHighlightBot = false;
  if (userId) {
    const row = await env.DB.prepare("SELECT allow_highlight_bot FROM users WHERE id = ?").bind(userId).first();
    allowHighlightBot = Number(row?.allow_highlight_bot ?? 0) === 1;
  }

  return {
    loggedIn: true,
    did: session.did,
    handle: session.handle,
    displayName: session.display_name,
    avatarUrl: session.avatar_url,
    inatLogin: session.inat_login,
    inatUserId: session.inat_user_id,
    userId,
    inatPendingLogin: session.inat_pending_login,
    inatVerificationCode: session.inat_verification_code,
    admin: isAdminSession(env, session),
    allowHighlightBot,
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

// Detach the iNaturalist link from this Bluesky identity WITHOUT deleting any
// imported data. Roster, training, teams, ratings, and territory rows are keyed
// by the iNat user id (inat:<login>), so re-linking the same profile restores
// everything, and linking a different profile starts a separate roster. To
// erase data, use /api/account/delete instead.
async function handleInatUnlink(env, session) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE accounts
    SET inat_login = NULL, inat_user_id = NULL, inat_verified_at = NULL,
        inat_pending_login = NULL, inat_verification_code = NULL, updated_at = ?
    WHERE did = ?
  `).bind(now, session.did).run();
  return { ok: true, unlinked: true };
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
  const upstream = await fetchWithTimeout(target.toString(), {
    headers: { accept: "image/*" },
    cf: { cacheTtl: 86400, cacheEverything: true }
  }, 15000);
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

  const res = await fetchWithTimeout(`${DISCORD_API_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}` },
    body: form
  }, 15000);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Discord post failed (${res.status}): ${detail.slice(0, 180)}`);
  }
  const message = await res.json();
  return { messageId: message.id, channelId };
}

async function fetchDiscordDecision(env, row) {
  const { token } = discordConfig(env);
  const res = await fetchWithTimeout(
    `${DISCORD_API_URL}/channels/${row.discord_channel_id}/messages/${row.discord_message_id}`,
    { headers: { authorization: `Bot ${token}` } },
    15000
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

async function syncSpriteSubmissions(env, limit = 25, did = null) {
  const didFilter = did ? "AND did = ?" : "";
  const query = `
    SELECT *
    FROM user_sprite_submissions
    WHERE status = 'pending'
      ${didFilter}
    ORDER BY created_at ASC
    LIMIT ?
  `;
  const statement = env.DB.prepare(query);
  const rows = did
    ? await statement.bind(did, limit).all()
    : await statement.bind(limit).all();

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

async function syncSingleSubmission(env, submissionId, session = null) {
  const row = await env.DB.prepare(
    "SELECT * FROM user_sprite_submissions WHERE submission_id = ?"
  ).bind(submissionId).first();
  if (!row) throw httpError("Submission not found", 404);
  if (session && row.did !== session.did && !isAdminSession(env, session)) {
    throw httpError("Submission not found", 404);
  }
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

  const res = await fetchWithTimeout(endpoint, request, 120000);

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
    const response = await fetchWithTimeout(sourceUrl, {
      headers: { "User-Agent": "taxa-battler/0.1" }
    }, 20000);

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

// Best-effort fixed-window rate limiter backed by KV, keyed by client IP. Used
// to shield the expensive unauthenticated / external-call endpoints (Bluesky
// login PAR + PDS resolution, account delete, share-to-Bluesky) from abuse and
// runaway cost. Eventually consistent, so it may slightly under-count under a
// burst — that is an acceptable trade for a free, low-latency guard. Limiter
// infra failures never block the request.
async function enforceRateLimit(env, request, bucket, limit, windowSeconds) {
  if (!env.CACHE) return;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${ip}:${window}`;
  try {
    const current = Number(await env.CACHE.get(key)) || 0;
    if (current >= limit) {
      throw httpError("Too many requests — please slow down and try again shortly.", 429);
    }
    await env.CACHE.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
  } catch (err) {
    if (err?.status === 429) throw err;
    console.error("rate limit error", err);
  }
}

function corsHeaders() {
  // Origin is decided centrally in applyCors() (the fetch wrapper) against an
  // allowlist; these are the method/header parts that are origin-independent.
  return {
    "access-control-allow-methods": "GET,POST,HEAD,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

// The app is same-origin (this Worker serves both the HTML and the API), so we
// only ever echo CORS for an allowlisted origin instead of reflecting "*".
function allowedCorsOrigin(env, request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allow = new Set();
  try { allow.add(new URL(request.url).origin); } catch {}
  if (env.PUBLIC_BASE_URL) {
    try { allow.add(new URL(env.PUBLIC_BASE_URL).origin); } catch {}
  }
  return allow.has(origin) ? origin : null;
}

// Re-emit a response with the correct, allowlisted CORS origin. Disallowed
// cross-origin browsers get no access-control-allow-origin header at all.
function applyCors(response, env, request) {
  const origin = allowedCorsOrigin(env, request);
  const headers = new Headers(response.headers);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "Origin");
  } else {
    headers.delete("access-control-allow-origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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
    // Apply the saved theme before first paint to avoid a flash of the wrong theme.
    (function () {
      try {
        var pref = localStorage.getItem("inatBattler:theme") || "system";
        var dark = pref === "dark" || (pref === "system" && window.matchMedia
          && window.matchMedia("(prefers-color-scheme: dark)").matches);
        if (dark) document.documentElement.setAttribute("data-theme", "dark");
      } catch (e) {}
    })();
  </script>
  <script>
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      });
    }
  </script>
  <style>
${APP_CSS}
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

      <section class="landing-section landing-gallery" id="landingGallery" hidden>
        <div class="landing-section-head">
          <h3>Real species, real sprites</h3>
          <p>Every battler is generated from an actual iNaturalist taxon. Here are some recently added to the shared library.</p>
        </div>
        <div class="landing-sprites" id="landingSprites" aria-hidden="true"></div>
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
        <details class="foldout-panel bsky-panel" id="bskyPanelDetails" open>
          <summary class="foldout-head">
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
            <div><strong>Loading the arena…</strong></div>
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
            <div class="settings-field">
              <span>Theme</span>
              <div class="map-mode-toggle" id="themeToggle" role="group" aria-label="Theme">
                <button class="map-mode-btn" type="button" data-theme-pref="system">System</button>
                <button class="map-mode-btn" type="button" data-theme-pref="light">Light</button>
                <button class="map-mode-btn" type="button" data-theme-pref="dark">Dark</button>
              </div>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" id="settingsSoundToggle">
              <span>Sound effects</span>
            </label>
          </div>
          <div class="settings-section">
            <h3>Sprites</h3>
            <details class="foldout-panel">
              <summary class="foldout-head">
                <h2>Custom Sprite</h2>
                <span class="subtle" id="manualUploadState">idle</span>
              </summary>
              <form class="manual-upload" id="manualSpriteForm">
                <input id="manualTaxonId" name="taxonId" inputmode="numeric" placeholder="iNaturalist taxon ID">
                <input id="manualSpriteFile" name="sprite" type="file" accept="image/png,image/jpeg,image/webp" required>
                <button class="secondary" id="manualUploadButton" type="submit">Submit for QA</button>
              </form>
              <div class="batch-list" id="manualUploadResult">No custom sprite submitted yet.</div>
            </details>
          </div>
          <div class="settings-section">
            <h3>Highlight videos</h3>
            <p class="subtle">When enabled, the iNat Battler bot may turn your best victories into short videos and post them to the <strong>@wildmarch.bsky.social</strong> feed, credited to you. You can always share a battle yourself with the “Share as video” button on the results screen.</p>
            <label class="settings-toggle">
              <input type="checkbox" id="settingsHighlightOptIn">
              <span>Let the bot feature my best battles</span>
            </label>
          </div>
          <div class="settings-section">
            <h3>Privacy &amp; data</h3>
            <p class="subtle settings-disclosure">We store: your Bluesky handle &amp; DID and login session; your linked iNaturalist username; your imported <strong>research-grade</strong> species roster and observation summaries (public iNaturalist data only — never your iNat password); your team, training, and territory choices; any sprites you upload; and battle/challenge records. Per-user iNaturalist fetches happen in your own browser.</p>
            <div class="settings-actions">
              <button class="secondary settings-danger" id="settingsDeleteButton" type="button">Delete account &amp; data</button>
            </div>
            <div class="confirm-modal" id="settingsDeletePanel" hidden>
              <div class="confirm-sheet delete-panel" role="dialog" aria-modal="true" aria-labelledby="settingsDeleteHeading">
                <h3 class="confirm-title" id="settingsDeleteHeading">Delete your account &amp; data?</h3>
                <p><strong>Are you sure? This permanently deletes your account and all your data, and can't be undone.</strong> Your owned territory tiles are released to neutral.</p>
                <label class="settings-toggle">
                  <input type="checkbox" id="deleteSharedSpritesCheck">
                  <span>Also remove sprites I contributed to the shared library</span>
                </label>
                <p class="subtle">If left unchecked, sprites you contributed stay in the shared library for other players (de-identified). If checked, any species using your art falls back to AI-generated sprites for everyone.</p>
                <div class="settings-actions confirm-actions">
                  <button class="secondary" id="settingsDeleteCancel" type="button">Cancel</button>
                  <button class="secondary settings-danger" id="settingsDeleteConfirm" type="button">Yes, delete permanently</button>
                </div>
              </div>
            </div>
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
      <button class="mobile-sheet-item" type="button" data-mobile-nav="settings" role="menuitem">⚙️ Settings</button>
    </div>
  </div>

  <script>
    const ROSTER_PAGE_SIZE = 100;
    ${placeholderFor.toString()}
    const TYPE_CHART = ${JSON.stringify(TYPE_CHART)};
    const TERRAIN_MOVE_BONUS = ${JSON.stringify(TERRAIN_MOVE_BONUS)};
${APP_CLIENT_JS}
  </script>
</body>
</html>`;
}
