import {
  chooseNpcMove,
  createBattleCreature,
  createGenome,
  createSeededRng,
  resolveTurn
} from "./game.js";

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
const GLOBAL_SEED_KEY = "na_europe_plants_animals_v1";
const GLOBAL_SEED_LIMIT_PER_GROUP = 1000;
const GLOBAL_SEED_BATCH_SIZE = 200;
const GLOBAL_SEED_PRIORITY = 120;
const GLOBAL_SEED_REGIONS = [
  { key: "north_america", label: "North America", placeId: 97394 },
  { key: "europe", label: "Europe", placeId: 67952 }
];
const GLOBAL_SEED_GROUPS = [
  { key: "plants", label: "Plants", iconicTaxon: "Plantae" },
  { key: "animals", label: "Animals", iconicTaxon: "Animalia" }
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
    return jsonResponse(await syncTrainingData(env, session));
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
    const payload = await readJson(request);
    const result = await importUserByLogin(env, String(payload.inatLogin ?? payload.login ?? ""));
    return jsonResponse(result);
  }

  if (request.method === "POST" && url.pathname === "/api/manual-sprites/upload") {
    return jsonResponse(await uploadManualSprite(request, env));
  }

  const rosterMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/roster$/);
  if (request.method === "GET" && rosterMatch) {
    const userId = decodeURIComponent(rosterMatch[1]);
    const limit = clampInt(url.searchParams.get("limit"), 1, 250, 100);
    const q = String(url.searchParams.get("q") ?? "");
    return jsonResponse(await getRoster(env, userId, limit, q));
  }

  if (request.method === "GET" && url.pathname === "/api/roster") {
    const userId = url.searchParams.get("userId");
    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);

    const limit = clampInt(url.searchParams.get("limit"), 1, 250, 100);
    const q = String(url.searchParams.get("q") ?? "");
    return jsonResponse(await getRoster(env, userId, limit, q));
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

  if (request.method === "POST" && url.pathname === "/api/battles/npc/start") {
    const payload = await readJson(request);
    const userId = String(payload.userId ?? "");
    const taxonIds = Array.isArray(payload.taxonIds) ? payload.taxonIds.map(Number) : [];
    const npcTemplate = String(payload.npcTemplate ?? "backyard_beginner");

    if (!userId) return jsonResponse({ error: "Missing userId" }, 400);
    return jsonResponse(await startNpcBattle(env, userId, taxonIds, npcTemplate));
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
      String(payload.moveId ?? "")
    ));
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function importUserByLogin(env, rawLogin) {
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

  for (const row of speciesRows) {
    const taxon = row.taxon;
    if (!taxon?.id || !taxon.name) continue;

    await upsertTaxonFromInat(env, taxon, now);

    const obsCount = Number(row.count ?? 0);
    const bondLevel = Math.floor(10 * Math.log10(1 + obsCount));

    await env.DB.prepare(`
      INSERT INTO user_taxa (
        user_id, taxon_id, obs_count, weighted_obs, bond_level, imported_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, taxon_id) DO UPDATE SET
        obs_count = excluded.obs_count,
        weighted_obs = excluded.weighted_obs,
        bond_level = excluded.bond_level,
        imported_at = excluded.imported_at
    `).bind(userId, taxon.id, obsCount, obsCount, bondLevel, now).run();
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
  const cacheKey = `inat:species_counts:${inatLogin.toLowerCase()}:v2:fields:v1`;
  const cooldownKey = `inat:species_counts:${inatLogin.toLowerCase()}:verifiable:cooldown`;
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
    url.searchParams.set("verifiable", "true");
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
  const cacheKey = `inat:global_seed:${GLOBAL_SEED_KEY}:${group.key}:${limitPerGroup}:v2:fields:v1`;
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
      url.searchParams.set("iconic_taxa", group.iconicTaxon);
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
    addedToRoster
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

  if (remote.status !== "completed") {
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
    WHERE b.status IN ('submitted', 'validating', 'in_progress', 'finalizing', 'completed')
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

async function generateMovesForTaxon(env, taxonId) {
  if (!env.OPENAI_API_KEY) throw httpError("OPENAI_API_KEY is not configured", 400);

  const taxonRow = await ensureTaxonInDb(env, taxonId);
  const summaries = await fetchWikipediaSummaries(env, [taxonId]);
  const messages = dossierMessages(taxonSummaryFromRow(taxonRow), summaries.get(taxonId) ?? null);

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

async function getRoster(env, userId, limit, q = "") {
  const rows = await env.DB.prepare(`
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
    ORDER BY ut.obs_count DESC
    LIMIT ?
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    userId,
    q,
    q,
    q,
    limit
  ).all();

  const buffMap = await loadUserBuffMap(env, userId);
  const rosterRows = rows.results ?? [];
  const rosterTaxonIds = rosterRows.map((row) => Number(row.taxon_id));
  const movesMap = await loadSpeciesMovesMap(env, rosterTaxonIds);
  const variantMap = await loadReadySpriteVariantMap(env, rosterTaxonIds);
  const preferenceMap = await loadUserSpritePreferenceMap(env, userId, rosterTaxonIds);

  return {
    userId,
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

  const tree = buildSpriteTree(leaves);

  return {
    totalSprites: leaves.length,
    limit: options.limit ?? 500,
    q,
    roots: tree
  };
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

async function loadUserBattleCreatures(env, userId, taxonIds, idPrefix, personalView = "owner") {
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
    return createBattleCreature(
      taxonSummaryFromRow(row, spriteUrl),
      `${idPrefix}-${index}`,
      trainingFromRow(row, buffMap),
      movesMap.get(taxonId)?.moves ?? null
    );
  });
}

async function startNpcBattle(env, userId, taxonIds, npcTemplate) {
  const creatures = await loadUserBattleCreatures(env, userId, taxonIds, "p");
  const cleanTaxonIds = creatures.map((creature) => Number(creature.taxonId)).filter(Number.isFinite);
  const opponent = await createRandomReadyNpcTeam(env, cleanTaxonIds, 5);

  const now = new Date().toISOString();
  const battleId = randomId("battle");
  const seed = randomId("seed");
  const state = {
    battleId,
    mode: "npc",
    seed,
    turn: 1,
    player: { userId, name: "Your Team", activeIndex: 0, creatures },
    opponent,
    log: [{ turn: 0, text: `${opponent.name} challenges your field team.` }],
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

async function submitBattleMove(env, battleId, moveId) {
  if (!moveId) throw new Error("Missing moveId");

  const state = await getBattle(env, battleId);
  if (!state) throw new Error("Battle not found");
  if (state.status !== "active") return state;

  const active = state.player.creatures[state.player.activeIndex];
  if (!active.moves.some((move) => move.id === moveId)) {
    throw new Error("Move is not available to the active creature");
  }

  const rng = createSeededRng(`${state.seed}:${state.turn}`);
  const npcMoveId = chooseNpcMove(state, "normal", rng);
  const next = resolveTurn(
    state,
    { kind: "move", moveId },
    { kind: "move", moveId: npcMoveId },
    rng
  );
  const now = new Date().toISOString();

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

async function syncTrainingData(env, session) {
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
    const rgRows = await fetchRgSpeciesCounts(env, session.inat_login);
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
      st.nickname, st.allocated_json, st.points_spent, st.last_respec_at
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
    LEFT JOIN species_training st ON st.user_id = ut.user_id AND st.taxon_id = ut.taxon_id
    WHERE ut.user_id = ?
    ORDER BY ut.rg_obs_count DESC, ut.obs_count DESC
  `).bind(userId).all();
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

  return {
    submissionId,
    taxonId,
    name: owned.common_name || owned.scientific_name,
    status: "pending",
    url: `/api/assets/${encodeR2Key(r2Key)}`,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    discordMessageId,
    discordError
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>iNat Battler</title>
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

    body {
      margin: 0;
      min-height: 100vh;
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

    .sprite-tree {
      display: grid;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.84);
    }

    .tree-menu-row {
      --tree-indent: 0px;
      width: 100%;
      min-width: 0;
      border: 0;
      border-bottom: 1px solid #e5e9e2;
      padding-left: calc(10px + var(--tree-indent));
      padding-right: 10px;
      font: inherit;
      color: var(--ink);
    }

    .tree-menu-row:last-child {
      border-bottom: 0;
    }

    .tree-menu-branch {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      min-height: 42px;
      background: #fbfcf9;
      cursor: pointer;
      text-align: left;
    }

    .tree-menu-branch:hover,
    .tree-menu-branch:focus-visible {
      background: #eef4f0;
    }

    .tree-menu-branch[aria-expanded="true"] {
      background: #edf6f1;
    }

    .tree-disclosure {
      color: var(--teal);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-weight: 900;
      text-align: center;
    }

    .tree-branch-name,
    .tree-leaf-name {
      min-width: 0;
      font-weight: 900;
      overflow-wrap: anywhere;
    }

    .tree-rank,
    .tree-count,
    .tree-leaf-meta {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 900;
      white-space: nowrap;
    }

    .tree-menu-leaf {
      display: grid;
      grid-template-columns: var(--leaf-size, 58px) minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-height: 72px;
      padding-top: 7px;
      padding-bottom: 7px;
      background: #ffffff;
    }

    .tree-menu-leaf:nth-child(even) {
      background: #fbfcf9;
    }

    .tree-leaf-sprite {
      display: grid;
      place-items: center;
      width: var(--leaf-size, 58px);
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      background: #eef2eb;
      overflow: hidden;
    }

    .tree-leaf-sprite .sheet-sprite {
      width: 94%;
    }

    .tree-leaf-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .tree-notice {
      color: var(--muted);
      font-size: 0.84rem;
      font-weight: 800;
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

    .sheet-sprite.hit-flash {
      animation:
        spriteFrames 900ms steps(1, end) infinite,
        hitFlash 380ms steps(2, end) 1;
    }

    @keyframes hitFlash {
      0%, 100% { filter: drop-shadow(0 10px 12px rgba(23, 32, 27, 0.18)); }
      20%, 70% { filter: sepia(1) saturate(9) hue-rotate(-46deg) brightness(1.3); }
      45% { filter: brightness(2.4) saturate(0.3); }
    }

    .dummy-sprite.hit-flash {
      animation: hitFlash 380ms steps(2, end) 1;
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
      grid-template-columns: minmax(160px, 1fr) repeat(5, auto);
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

    .bench {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
    }

    .bench-slot {
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #eef2eb;
      padding: 6px;
      font-size: 0.72rem;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.72;
    }

    .bench-slot.active {
      border-color: var(--teal);
      opacity: 1;
      background: #e4f2ef;
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

    @media (max-width: 880px) {
      .topbar,
      .layout {
        grid-template-columns: 1fr;
      }

      .panel {
        position: static;
      }

      .login {
        grid-template-columns: 1fr auto;
      }
    }

    @media (max-width: 520px) {
      .shell {
        padding: 14px;
      }

      .login,
      .roster-head {
        grid-template-columns: 1fr;
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

      .tree-menu-branch {
        grid-template-columns: 18px minmax(0, 1fr) auto;
      }

      .tree-rank {
        display: none;
      }

      .tree-menu-leaf {
        grid-template-columns: 52px minmax(0, 1fr);
      }

      .tree-menu-leaf .manual-result-link {
        grid-column: 2;
        justify-self: start;
      }

      .tree-leaf-sprite {
        width: 52px;
      }

      .meta {
        padding: 10px;
        padding-bottom: 40px;
      }

      .name {
        font-size: 0.9rem;
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
        <input id="inatLogin" name="inatLogin" autocomplete="username" placeholder="iNaturalist username" maxlength="64" required>
        <button class="primary" id="importButton" type="submit">Import</button>
      </form>
    </header>

    <section class="layout">
      <aside class="panel">
        <details class="dev-batch bsky-panel" id="bskyPanelDetails" open>
          <summary class="dev-batch-head">
            <h2>Bluesky Battles</h2>
            <span class="subtle" id="bskyStateLabel">signed out</span>
          </summary>
          <div id="bskyBody" class="bsky-body">Loading Bluesky session…</div>
        </details>
        <h2>Account</h2>
        <div class="stats">
          <div class="stat">
            <span class="subtle">Taxa</span>
            <strong id="taxaCount">0</strong>
          </div>
          <div class="stat">
            <span class="subtle">Sprites</span>
            <strong id="spriteCount">0</strong>
          </div>
          <div class="stat">
            <span class="subtle">Queued</span>
            <strong id="queuedCount">0</strong>
          </div>
          <div class="stat">
            <span class="subtle">Affinity</span>
            <strong id="bondCount">0</strong>
          </div>
        </div>
        <div class="team-picker">
          <div class="team-picker-row">
            <div>
              <span class="subtle">Combat Team</span>
              <div class="team-count" id="teamCount">0 / 5 selected</div>
            </div>
            <button class="secondary" id="clearTeamButton" type="button" disabled>Clear</button>
          </div>
          <button class="primary" id="startBattleButton" type="button" disabled>Battle NPC</button>
        </div>
        <button class="secondary" id="queueMoreButton" type="button" disabled>Queue More</button>
        <details class="dev-batch">
          <summary class="dev-batch-head">
            <h2>Dev Batch</h2>
            <span class="subtle" id="batchQueueCount">0 queued</span>
          </summary>
          <button class="secondary" id="batchPreviewButton" type="button" disabled>Show Batch Queue</button>
          <button class="secondary" id="batchSubmitButton" type="button" disabled>Submit Batch</button>
          <div class="batch-list" id="batchQueueList">Load a roster, then click Queue More.</div>
        </details>
        <details class="dev-batch">
          <summary class="dev-batch-head">
            <h2>Global Seed</h2>
            <span class="subtle" id="seedQueueCount">0 queued</span>
          </summary>
          <button class="secondary" id="seedImportButton" type="button">Import Plants + Animals</button>
          <button class="secondary" id="seedQueueButton" type="button">Queue 200</button>
          <button class="secondary" id="seedSubmitButton" type="button" disabled>Submit 200</button>
          <div class="batch-list" id="seedQueueList">Load seed status to start.</div>
        </details>
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
        <p class="status" id="statusLine"></p>
      </aside>

      <section>
        <nav class="view-tabs" aria-label="Main views">
          <button class="view-tab active" id="rosterTabButton" type="button" data-view-tab="roster">Roster</button>
          <button class="view-tab" id="battleTabButton" type="button" data-view-tab="battle">Battle</button>
          <button class="view-tab" id="trainingTabButton" type="button" data-view-tab="training">Training</button>
          <button class="view-tab" id="treeTabButton" type="button" data-view-tab="tree">Sprite Tree</button>
          <button class="view-tab" id="recentTabButton" type="button" data-view-tab="recent">Recently Added</button>
          <button class="view-tab" id="devTabButton" type="button" data-view-tab="dev">Dev Lab</button>
        </nav>
        <section class="view-panel" id="rosterView">
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
          <div class="empty" id="emptyState">Import a public iNaturalist roster.</div>
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
        <section class="view-panel" id="trainingView" hidden>
          <div class="roster-head">
            <h2>Training</h2>
            <span class="subtle" id="trainingTotalsLabel"></span>
          </div>
          <div class="tree-tools">
            <input id="trainingFilterInput" placeholder="Filter species">
            <button class="secondary" id="trainingSyncButton" type="button">Sync iNat Data</button>
          </div>
          <div class="empty" id="trainingEmptyState">
            Sign in with Bluesky and link your iNaturalist account, then sync to earn
            training points from iNaturalist observations.
          </div>
          <div id="trainingMasteries" hidden></div>
          <div id="trainingList" class="training-list" hidden></div>
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
        </section>
      </section>
    </section>
  </main>

  <script>
    const LAST_BATCH_STORAGE_KEY = "inatBattler:lastBatch";
    const BATCH_POLL_MS = 60000;
    const DEV_QUEUE_MORE_LIMIT = 100;
    const DEV_BATCH_SUBMIT_LIMIT = 100;
    const GLOBAL_SEED_BATCH_LIMIT = 200;
    const TREE_RENDER_ROW_LIMIT = 420;
    const BATCH_SYNC_ITEM_LIMIT = 25;
    const ACTIVE_BATCH_STATUSES = new Set(["submitted", "validating", "in_progress", "finalizing", "cancelling"]);

    const state = {
      userId: localStorage.getItem("inatBattler:userId") || "",
      inatLogin: localStorage.getItem("inatBattler:inatLogin") || "",
      activeView: "roster",
      taxa: [],
      rosterSearch: "",
      rosterSort: "default",
      rosterStatus: "all",
      rosterTypes: new Set(),
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
      challenges: [],
      challengeInfo: null,
      inatLinkPending: null,
      mySprites: [],
      training: null,
      trainingFilter: "",
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
      statusLine: document.getElementById("statusLine"),
      accountLabel: document.getElementById("accountLabel"),
      taxaCount: document.getElementById("taxaCount"),
      spriteCount: document.getElementById("spriteCount"),
      queuedCount: document.getElementById("queuedCount"),
      bondCount: document.getElementById("bondCount"),
      refreshLabel: document.getElementById("refreshLabel"),
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
      battlePanel: document.getElementById("battlePanel"),
      battleTabButton: document.getElementById("battleTabButton"),
      battleView: document.getElementById("battleView"),
      battleEmptyState: document.getElementById("battleEmptyState"),
      demoBattleButton: document.getElementById("demoBattleButton"),
      trainingTabButton: document.getElementById("trainingTabButton"),
      trainingView: document.getElementById("trainingView"),
      trainingTotalsLabel: document.getElementById("trainingTotalsLabel"),
      trainingFilterInput: document.getElementById("trainingFilterInput"),
      trainingSyncButton: document.getElementById("trainingSyncButton"),
      trainingEmptyState: document.getElementById("trainingEmptyState"),
      trainingMasteries: document.getElementById("trainingMasteries"),
      trainingList: document.getElementById("trainingList"),
      devTabButton: document.getElementById("devTabButton"),
      devView: document.getElementById("devView"),
      devLabState: document.getElementById("devLabState"),
      devTaxonIdInput: document.getElementById("devTaxonIdInput"),
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

    els.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await importRoster(els.input.value);
    });

    els.rosterTabButton.addEventListener("click", () => switchView("roster"));
    els.battleTabButton.addEventListener("click", () => switchView("battle"));
    els.trainingTabButton.addEventListener("click", () => switchView("training"));
    els.treeTabButton.addEventListener("click", () => switchView("tree"));
    els.recentTabButton.addEventListener("click", () => switchView("recent"));
    els.devTabButton.addEventListener("click", () => switchView("dev"));

    els.trainingSyncButton.addEventListener("click", syncTraining);

    els.trainingFilterInput.addEventListener("input", debounce(() => {
      state.trainingFilter = els.trainingFilterInput.value.trim().toLowerCase();
      renderTraining();
    }, 200));

    els.trainingList.addEventListener("click", async (event) => {
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

    els.trainingList.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || !event.target.hasAttribute("data-train-nick-input")) return;
      event.preventDefault();
      await saveNickname(event.target.getAttribute("data-train-nick-input"));
    });

    els.devInspectButton.addEventListener("click", () => inspectDevLab(true));
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

    els.spriteTreePanel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tree-toggle]");
      if (!button) return;

      const key = button.getAttribute("data-tree-key");
      if (!key) return;

      if (state.expandedTreeNodes.has(key)) {
        state.expandedTreeNodes.delete(key);
      } else {
        state.expandedTreeNodes.add(key);
      }

      renderSpriteTree();
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

      const exitButton = event.target.closest("[data-battle-exit]");
      if (exitButton) {
        state.battle = null;
        state.battlePhase = "idle";
        renderBattle();
        switchView("roster");
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
      state.rosterSearch = els.rosterSearchInput.value.trim().toLowerCase();
      render();
    }, 150));

    els.rosterSortSelect.addEventListener("change", () => {
      state.rosterSort = els.rosterSortSelect.value;
      render();
    });

    els.rosterStatusFilter.addEventListener("change", () => {
      state.rosterStatus = els.rosterStatusFilter.value;
      render();
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
      if (state.rosterTypes.has(type)) state.rosterTypes.delete(type);
      else state.rosterTypes.add(type);
      render();
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

    els.rosterZoomInput.value = String(state.rosterZoom);
    els.rosterGrid.style.setProperty("--card-min", state.rosterZoom + "px");
    els.treeZoomInput.value = String(state.treeZoom);
    els.spriteTreePanel.style.setProperty("--leaf-size", state.treeZoom + "px");
    els.recentZoomInput.value = String(state.recentZoom);
    els.recentSpritesPanel.style.setProperty("--tile-min", state.recentZoom + "px");

    els.bskyBody.addEventListener("click", (event) => {
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
    });

    els.bskyBody.addEventListener("input", (event) => {
      if (event.target.getAttribute && event.target.getAttribute("data-bsky-typeahead")) {
        handleTypeaheadInput(event.target);
      }
    });

    els.bskyBody.addEventListener("keydown", (event) => {
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
    });

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

    async function importRoster(inatLogin) {
      setBusy(true, "Importing roster");

      try {
        state.selectedTaxa.clear();
        state.flippedTaxa.clear();
        const res = await apiFetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inatLogin })
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
      const input = document.getElementById("bskyHandleInput");
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
      setStatus("Signed out of Bluesky.");
    }

    async function inatLinkStart() {
      const input = document.getElementById("inatLinkInput");
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
      const message = res.discordError
        ? "Sprite saved and live for you, but the Discord QA post failed: " + res.discordError + " (it will retry automatically)"
        : "Custom sprite for " + res.name + " submitted for QA. It's live for you now; opponents see it once approved on Discord.";
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
        const res = await apiFetch("/api/training/sync", { method: "POST" });
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
      els.trainingList.hidden = !training;

      if (!training) {
        els.trainingTotalsLabel.textContent = "";
        els.trainingEmptyState.textContent = linked
          ? "Press Sync iNat Data to pull your iNaturalist observations and start earning points."
          : "Sign in with Bluesky and link your iNaturalist account, then sync to earn training points from iNaturalist observations.";
        return;
      }

      els.trainingTotalsLabel.textContent =
        training.totals.available + " pts available · " +
        training.totals.spent + " spent · " +
        training.totals.earned + " earned";

      els.trainingMasteries.innerHTML = training.masteries.length
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

      els.trainingList.innerHTML = visible.length
        ? visible.map(renderTrainRow).join("")
        : '<div class="subtle">No species match the filter.</div>';
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
      return '<div class="typeahead">' +
        '<input id="' + escapeAttr(inputId) + '" data-bsky-enter="' + escapeAttr(enterAction) + '" data-bsky-typeahead="1"' +
          ' placeholder="' + escapeAttr(placeholder) + '" autocomplete="off" spellcheck="false">' +
        '<div class="typeahead-list" hidden></div>' +
      '</div>';
    }

    function typeaheadListFor(input) {
      return input && input.parentElement ? input.parentElement.querySelector(".typeahead-list") : null;
    }

    function closeTypeaheadLists() {
      els.bskyBody.querySelectorAll(".typeahead-list").forEach((list) => {
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
          '<input id="inatLinkInput" data-bsky-enter="inat-start" placeholder="iNaturalist username" value="' + escapeAttr(me.inatPendingLogin || "") + '">' +
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

      const res = await apiFetch("/api/roster?userId=" + encodeURIComponent(state.userId) + "&limit=100");
      state.taxa = res.taxa || [];
      pruneSelectedTaxa();
      render();
      schedulePolling();
    }

    async function switchView(view) {
      state.activeView = ["tree", "recent", "battle", "training", "dev"].includes(view) ? view : "roster";
      renderViewTabs();

      if (state.activeView === "tree" && !state.spriteTree) {
        await loadSpriteTree(false);
      }
      if (state.activeView === "recent" && !state.recentSprites) {
        await loadRecentSprites(false);
      }
      if (state.activeView === "training" && !state.training) {
        await loadTraining();
      }
      if (state.activeView === "roster" && state.rosterStale && state.userId) {
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
      els.rosterTabButton.classList.toggle("active", view === "roster");
      els.battleTabButton.classList.toggle("active", view === "battle");
      els.trainingTabButton.classList.toggle("active", view === "training");
      els.treeTabButton.classList.toggle("active", view === "tree");
      els.recentTabButton.classList.toggle("active", view === "recent");
      els.devTabButton.classList.toggle("active", view === "dev");
      els.rosterView.hidden = view !== "roster";
      els.battleView.hidden = view !== "battle";
      els.trainingView.hidden = view !== "training";
      els.treeView.hidden = view !== "tree";
      els.recentView.hidden = view !== "recent";
      els.devView.hidden = view !== "dev";
      els.battleTabButton.textContent = state.battle && state.battle.status === "active" ? "Battle ⚔" : "Battle";
    }

    async function loadSpriteTree(showStatus) {
      const q = state.treeSearch || "";
      if (showStatus) setStatus("Loading sprite tree");

      try {
        const previousQuery = state.spriteTree?.q || "";
        const res = await apiFetch("/api/sprite-tree?limit=1000&q=" + encodeURIComponent(q));
        state.spriteTree = res;
        syncTreeExpansion(res, q, previousQuery);
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

    function render() {
      els.accountLabel.textContent = state.inatLogin ? "@" + state.inatLogin : "No roster loaded";

      const visibleTaxa = visibleRosterTaxa();
      els.emptyState.style.display = visibleTaxa.length ? "none" : "grid";
      els.emptyState.textContent = state.taxa.length
        ? "No roster creatures match these filters."
        : "Import a public iNaturalist roster.";
      els.rosterGrid.classList.toggle("sprite-mode", state.rosterMode === "sprites");
      els.rosterModeButton.textContent = state.rosterMode === "sprites" ? "Card View" : "Sprite Grid";
      els.rosterGrid.innerHTML = visibleTaxa
        .map(state.rosterMode === "sprites" ? renderSpriteTile : renderCard)
        .join("");
      renderTypeChips();

      const spriteCount = state.taxa.filter((taxon) => taxon.sprite.status === "ready").length;
      const queuedCount = state.taxa.filter((taxon) => ["queued", "running"].includes(taxon.sprite.status)).length;
      const bondCount = state.taxa.reduce((sum, taxon) => sum + Number(affinityLevel(taxon) || 0), 0);
      const selectedCount = state.selectedTaxa.size;

      els.taxaCount.textContent = String(state.taxa.length);
      els.spriteCount.textContent = String(spriteCount);
      els.queuedCount.textContent = String(queuedCount);
      els.bondCount.textContent = String(bondCount);
      els.teamCount.textContent = selectedCount + " / 5 selected";
      els.clearTeamButton.disabled = selectedCount === 0;
      els.startBattleButton.disabled = !state.userId || selectedCount !== 5;
      els.queueMoreButton.disabled = !state.userId;
      els.batchPreviewButton.disabled = !state.userId;
      els.batchSubmitButton.disabled = !state.userId || state.batchJobs.length === 0;
      els.refreshLabel.textContent = state.taxa.length
        ? (visibleTaxa.length === state.taxa.length
          ? "Top " + state.taxa.length
          : visibleTaxa.length + " of " + state.taxa.length + " shown")
        : "";
      renderBatchQueue();
      renderGlobalSeedQueue();
      renderViewTabs();
      renderSpriteTree();
      renderRecentSprites();
      renderDevLab();
      renderBattle();
    }

    function visibleRosterTaxa() {
      let taxa = state.taxa.slice();

      if (state.rosterSearch) {
        const q = state.rosterSearch;
        taxa = taxa.filter((taxon) =>
          String(taxon.name || "").toLowerCase().includes(q) ||
          String(taxon.scientificName || "").toLowerCase().includes(q) ||
          String(taxon.nickname || "").toLowerCase().includes(q)
        );
      }

      if (state.rosterStatus !== "all") {
        taxa = taxa.filter((taxon) => {
          const status = taxon.sprite?.status || "missing";
          if (state.rosterStatus === "ready") return status === "ready";
          if (state.rosterStatus === "pending") return status === "queued" || status === "running";
          return status !== "ready" && status !== "queued" && status !== "running";
        });
      }

      if (state.rosterTypes.size > 0) {
        taxa = taxa.filter((taxon) => state.rosterTypes.has(taxon.iconicTaxonName || "Life"));
      }

      const byName = (a, b) => String(a.nickname || a.name || a.scientificName || "")
        .localeCompare(String(b.nickname || b.name || b.scientificName || ""));

      if (state.rosterSort === "name") taxa.sort(byName);
      else if (state.rosterSort === "obs") taxa.sort((a, b) => Number(b.obsCount || 0) - Number(a.obsCount || 0));
      else if (state.rosterSort === "affinity") taxa.sort((a, b) => Number(affinityLevel(b)) - Number(affinityLevel(a)));
      else if (state.rosterSort === "level") taxa.sort((a, b) => Number(b.trainingLevel || 0) - Number(a.trainingLevel || 0));
      else if (state.rosterSort === "status") {
        const rank = (taxon) => {
          const status = taxon.sprite?.status || "missing";
          if (status === "ready") return 0;
          if (status === "running") return 1;
          if (status === "queued") return 2;
          return 3;
        };
        taxa.sort((a, b) => rank(a) - rank(b) || byName(a, b));
      }

      return taxa;
    }

    function renderTypeChips() {
      const counts = new Map();
      for (const taxon of state.taxa) {
        const type = taxon.iconicTaxonName || "Life";
        counts.set(type, (counts.get(type) || 0) + 1);
      }

      for (const type of [...state.rosterTypes]) {
        if (!counts.has(type)) state.rosterTypes.delete(type);
      }

      if (counts.size < 2) {
        els.rosterTypeChips.innerHTML = "";
        return;
      }

      els.rosterTypeChips.innerHTML = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([type, count]) =>
          '<button type="button" class="type-chip' + (state.rosterTypes.has(type) ? " active" : "") +
            '" data-type-chip="' + escapeAttr(type) + '">' +
            escapeHtml(type) + ' <span class="subtle">' + count + '</span>' +
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

      els.spriteTreePanel.innerHTML =
        '<div class="tree-summary">' + treeSummaryText(tree) + '</div>' +
        renderTreeMenu(tree.roots);
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

    function syncTreeExpansion(tree, query, previousQuery) {
      const roots = Array.isArray(tree?.roots) ? tree.roots : [];
      const branchKeys = collectTreeBranchKeys(roots);
      const rootKeys = roots
        .filter((node) => !node.leaf && node.key)
        .map((node) => String(node.key));

      if (String(query || "").trim()) {
        state.expandedTreeNodes = branchKeys;
        return;
      }

      if (previousQuery !== query || state.expandedTreeNodes.size === 0) {
        state.expandedTreeNodes = new Set(rootKeys);
        return;
      }

      const retained = new Set(rootKeys);
      for (const key of state.expandedTreeNodes) {
        if (branchKeys.has(key)) retained.add(key);
      }
      state.expandedTreeNodes = retained;
    }

    function collectTreeBranchKeys(nodes, keys = new Set()) {
      for (const node of nodes || []) {
        if (!node || node.leaf) continue;
        if (node.key) keys.add(String(node.key));
        collectTreeBranchKeys(node.children || [], keys);
      }
      return keys;
    }

    function treeSummaryText(tree) {
      const q = String(tree.q || "").trim();
      const total = Number(tree.totalSprites || 0);
      if (q) return total + ' ready sprites matching "' + escapeHtml(q) + '"';
      return total + " ready sprites by taxonomic branch";
    }

    function renderTreeMenu(roots) {
      const renderState = { rows: [], truncated: false };
      collectVisibleTreeRows(roots || [], 0, renderState);

      const notice = renderState.truncated
        ? '<div class="tree-notice">Showing first ' + TREE_RENDER_ROW_LIMIT + ' visible rows.</div>'
        : '';

      return notice +
        '<div class="sprite-tree" role="tree">' +
          renderState.rows.map((row) => row.node.leaf
            ? renderTreeLeaf(row.node, row.depth)
            : renderTreeBranch(row.node, row.depth)
          ).join("") +
        '</div>';
    }

    function collectVisibleTreeRows(nodes, depth, renderState) {
      for (const node of nodes || []) {
        if (renderState.rows.length >= TREE_RENDER_ROW_LIMIT) {
          renderState.truncated = true;
          return;
        }

        renderState.rows.push({ node, depth });

        if (!node.leaf && state.expandedTreeNodes.has(String(node.key))) {
          collectVisibleTreeRows(node.children || [], depth + 1, renderState);
          if (renderState.truncated) return;
        }
      }
    }

    function renderTreeBranch(node, depth) {
      const key = String(node.key || "");
      const expanded = state.expandedTreeNodes.has(key);
      const childCount = Array.isArray(node.children) ? node.children.length : 0;
      const rank = node.rank || "branch";

      return '<button class="tree-menu-row tree-menu-branch" type="button" role="treeitem" ' +
          treeRowStyle(depth) +
          ' data-tree-toggle data-tree-key="' + escapeAttr(key) + '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
        '<span class="tree-disclosure" aria-hidden="true">' + (expanded ? "v" : "&gt;") + '</span>' +
        '<span class="tree-branch-name">' + escapeHtml(node.name || "Taxon") + '</span>' +
        '<span class="tree-rank">' + escapeHtml(rank) + '</span>' +
        '<span class="tree-count">' + Number(node.spriteCount || 0) + ' sprites / ' + childCount + ' items</span>' +
      '</button>';
    }

    function renderTreeLeaf(node, depth) {
      const sprite = node.sprite?.url
        ? renderSheetSprite(node.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(node.iconicTaxonName)) + '"></div>';

      return '<div class="tree-menu-row tree-menu-leaf" role="treeitem" ' + treeRowStyle(depth) + '>' +
        '<div class="tree-leaf-sprite">' + sprite + '</div>' +
        '<div class="tree-leaf-copy">' +
          '<div class="tree-leaf-name">' + escapeHtml(node.name || node.scientificName || "Unnamed taxon") + '</div>' +
          '<div class="tree-leaf-meta"><em>' + escapeHtml(node.scientificName || "") + '</em></div>' +
          '<div class="tree-leaf-meta">' + escapeHtml((node.rank || "taxon") + " / " + (node.iconicTaxonName || "Life")) + ' / taxon ' + Number(node.taxonId || 0) + '</div>' +
        '</div>' +
        '<a class="manual-result-link" href="' + escapeAttr(node.sprite?.url || "#") + '" target="_blank" rel="noreferrer">Open</a>' +
      '</div>';
    }

    function treeRowStyle(depth) {
      const indent = Math.max(0, Math.min(10, Number(depth) || 0)) * 18;
      return 'style="--tree-indent:' + indent + 'px"';
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
        '<a class="manual-result-link" href="' + escapeAttr(result.url || "#") + '" target="_blank" rel="noreferrer">Open asset</a>' +
      '</div>';
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
      const readyIds = new Set(state.taxa
        .filter((taxon) => taxon.sprite && taxon.sprite.status === "ready")
        .map((taxon) => String(taxon.taxonId)));

      state.selectedTaxa = new Set(Array.from(state.selectedTaxa).filter((taxonId) => readyIds.has(String(taxonId))));
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
          body: JSON.stringify({ userId: state.userId, taxonIds, npcTemplate: "random_ready" })
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

    async function submitBattleMove(moveId) {
      if (!state.battle || !moveId || state.battleBusy) return;

      const prev = state.battle;
      const active = getActiveCreature(prev.player);
      const move = active.moves.find((candidate) => candidate.id === moveId);
      state.battleBusy = true;
      state.battleAnimation = moveAnimClassFor(active, moveId);
      playSfx("click");
      renderBattle();

      try {
        const next = await apiFetch("/api/battles/" + encodeURIComponent(prev.battleId) + "/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ moveId })
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
          const category = moveCategoryFor(prev, actorSide, moveId);
          triggerAttackVisual(actorSide, moveAnimClassFor(actorCreature, moveId));
          if (category === "special") playSfx("special");
          await delay(280);
          hitEffect(targetSide, damage, hpState);
          await delay(640);
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
          spawnFloat(sideForName(stunMatch[1], prev), "stunned", "dmg");
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

        if (/shield softened the blow\.$/.test(text) || / raised a shield\.$/.test(text)) {
          playSfx("buff");
          await delay(380);
          continue;
        }
        if (/ was poisoned\.$/.test(text) || / is marked for the hunt\.$/.test(text) || / is stunned\.$/.test(text)) {
          playSfx("status");
          await delay(380);
          continue;
        }
        if (/ shook off the poison\.$/.test(text)) {
          playSfx("heal");
          await delay(320);
          continue;
        }

        const missMatch = text.match(/^(.+) used (.+), but it missed\.$/);
        if (missMatch) {
          triggerAttackVisual(sideForName(missMatch[1], prev), "anim-attack");
          await delay(240);
          playSfx("miss");
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
          triggerAttackVisual(sideForName(statusMoveMatch[1], prev), "anim-special");
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

    function triggerAttackVisual(side, animClass) {
      const el = spriteEl(side);
      if (!el || !el.classList.contains("sheet-sprite")) return;
      el.classList.remove("anim-idle", "anim-attack", "anim-special");
      el.classList.add(animClass);
      setTimeout(() => {
        el.classList.remove("anim-attack", "anim-special");
        el.classList.add("anim-idle");
      }, 620);
    }

    function hitEffect(targetSide, damage, hpState) {
      playSfx("hit", Math.min(1.7, 0.7 + damage / 50));

      const el = spriteEl(targetSide);
      if (el) {
        el.classList.remove("hit-flash");
        void el.offsetWidth;
        el.classList.add("hit-flash");
        setTimeout(() => el.classList.remove("hit-flash"), 420);
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

      spawnFloat(targetSide, "-" + damage, "dmg");
      const target = hpState[targetSide];
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
      el.className = "dmg-float" + (kind === "heal" ? " heal" : "");
      el.textContent = text;
      zone.appendChild(el);
      setTimeout(() => el.remove(), 900);
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

    // -- Retro sound effects (WebAudio, fully synthesized, no assets) -------

    let audioCtx = null;
    let audioNoiseBuffer = null;

    function ensureAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    }

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

    function pickBiome(battle) {
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
      if (battle.mode === "pvp_async") return "Challenge Battle";
      if (battle.mode === "demo") return "5v5 Test Battle";
      return "NPC Battle";
    }

    function renderResultOverlay(battle) {
      const title = battle.status === "won" ? "Victory!" : battle.status === "lost" ? "Defeat" : "Draw";
      const cls = battle.status === "won" ? "win" : battle.status === "lost" ? "lose" : "";
      return '<div class="battle-overlay">' +
        '<div class="overlay-card">' +
          '<div class="overlay-title ' + cls + '">' + title + '</div>' +
          '<div class="overlay-sub">' + escapeHtml(battle.player.name || "Your Team") + " vs " + escapeHtml(battle.opponent.name || "Opponent") +
            " &middot; " + Math.max(1, Number(battle.turn || 1) - 1) + " turns</div>" +
          '<button class="primary" type="button" data-battle-exit>Back to Roster</button>' +
        '</div>' +
      '</div>';
    }

    function renderBattle() {
      const battle = state.battle;
      els.battlePanel.hidden = !battle;
      if (els.battleEmptyState) els.battleEmptyState.hidden = !!battle;
      renderViewTabs();
      if (!battle) return;

      const playerActive = getActiveCreature(battle.player);
      const opponentActive = getActiveCreature(battle.opponent);
      const moveButtons = battle.status === "active"
        ? playerActive.moves.map((move) => (
            '<button class="move-button' + (move.signature ? " signature" : "") + '" type="button" data-move-id="' + escapeAttr(move.id) + '" ' +
              (move.flavor ? 'title="' + escapeAttr(move.flavor) + '" ' : "") + (state.battleBusy ? "disabled" : "") + '>' +
              escapeHtml(move.name) + (move.signature ? ' <span class="sig-star">★</span>' : "") +
              '<br><span class="subtle">' + escapeHtml(move.type + " / " + move.category) + '</span>' +
            '</button>'
          )).join("")
        : '<button class="move-button" type="button" disabled>Battle ' + escapeHtml(battle.status) + '</button>';
      const recentLog = battle.log.slice(-8).reverse().map((entry) => (
        '<div>Turn ' + Number(entry.turn || 0) + ': ' + escapeHtml(entry.text) + '</div>'
      )).join("");

      let overlay = "";
      if (battle.status !== "active") {
        overlay = renderResultOverlay(battle);
      } else if (state.battlePhase === "intro") {
        overlay = '<div class="battle-overlay intro"><div class="overlay-title">Battle Start!</div></div>';
      }

      els.battlePanel.innerHTML =
        '<div class="roster-head">' +
          '<h2>' + battleTitle(battle) + '</h2>' +
          '<div class="battle-head-tools">' +
            '<span class="subtle">' + escapeHtml(battle.status) + ' / turn ' + Number(battle.turn || 1) + '</span>' +
            '<button class="secondary" type="button" data-sound-toggle>' + (state.soundOn ? "Sound: on" : "Sound: off") + '</button>' +
            '<button class="secondary" type="button" data-battle-exit>Exit</button>' +
          '</div>' +
        '</div>' +
        '<div class="battle-stage" id="battleStage" style="background-image:' + battleBackdrop(battle) + '">' +
          renderCombatant(battle.player, playerActive, "player") +
          renderCombatant(battle.opponent, opponentActive, "opponent") +
          overlay +
        '</div>' +
        '<div class="moves">' + moveButtons + '</div>' +
        '<div class="battle-log" id="battleLogPanel">' + recentLog + '</div>';
      keyBattleSprites();
    }

    function renderCombatant(team, creature, side) {
      const hpPct = creature.maxHp ? Math.max(0, Math.round((creature.hp / creature.maxHp) * 100)) : 0;
      const animation = side === "player" ? state.battleAnimation : "anim-idle";
      const sprite = creature.spriteUrl
        ? renderSheetSprite(creature.spriteUrl, animation + (creature.fainted ? " fainted" : ""))
        : '<div class="dummy-sprite' + (creature.fainted ? " fainted" : "") + '">Dummy</div>';
      const bench = team.creatures.map((member, index) => (
        '<div class="bench-slot ' + (index === team.activeIndex ? "active" : "") + (member.fainted ? '" style="opacity:0.35' : "") + '">' + escapeHtml(member.name) + '</div>'
      )).join("");

      return '<article class="combatant ' + side + '">' +
        '<div class="plate">' +
          '<div class="combatant-head">' +
            '<div class="combatant-name">' + escapeHtml(creature.name) +
              (Number(creature.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(creature.trainingLevel) + '</span>' : '') +
            '</div>' +
            '<div class="combatant-role">' + escapeHtml((creature.types || []).join(" / ")) + '</div>' +
          '</div>' +
          '<div class="hp" aria-label="HP"><span data-hp-bar="' + side + '" class="' + (hpPct <= 25 ? "hp-low" : "") + '" style="--hp:' + hpPct + '%"></span></div>' +
          '<div class="subtle" data-hp-text="' + side + '">' + Number(creature.hp || 0) + ' / ' + Number(creature.maxHp || 0) + ' HP</div>' +
          ((creature.statuses || []).length
            ? '<div class="status-chips">' + creature.statuses.map((status) => (
                '<span class="status-chip status-' + escapeAttr(status) + '">' + escapeHtml(status) + '</span>'
              )).join("") + '</div>'
            : "") +
          '<div class="bench">' + bench + '</div>' +
        '</div>' +
        '<div class="combatant-sprite" data-sprite-zone="' + side + '">' +
          '<div class="platform"></div>' + sprite +
        '</div>' +
      '</article>';
    }

    function renderSheetSprite(url, animationClass) {
      return '<div class="sheet-sprite ' + escapeAttr(animationClass || "anim-idle") + '" data-sprite-url="' + escapeAttr(url) + '" style="background-image:url(&quot;' + escapeAttr(url) + '&quot;)"></div>';
    }

    const keyedSpriteCache = new Map();

    function keyBattleSprites() {
      const sprites = els.battlePanel.querySelectorAll(".combatant-sprite .sheet-sprite[data-sprite-url]");
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
