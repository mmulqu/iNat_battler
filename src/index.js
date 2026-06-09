import {
  chooseNpcMove,
  createBattleCreature,
  createGenome,
  createSeededRng,
  resolveTurn
} from "./game.js";

const ASSET_VERSION = 1;
const DEFAULT_ASSET_KIND = "sprite_sheet";
const INAT_SPECIES_CACHE_TTL_SECONDS = 6 * 60 * 60;
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
        500
      );
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
    const userId = payload.userId ? String(payload.userId) : "";
    const queueMissing = payload.queueMissing !== false;
    return jsonResponse(await submitDevSpriteBatch(env, request.url, { limit, userId, queueMissing }));
  }

  if (request.method === "GET" && url.pathname === "/api/sprite-batches/latest") {
    return jsonResponse(await getLatestSpriteBatch(env));
  }

  const spriteBatchSyncMatch = url.pathname.match(/^\/api\/sprite-batches\/([^/]+)\/sync$/);
  if (request.method === "POST" && spriteBatchSyncMatch) {
    return jsonResponse(await syncSpriteBatch(env, decodeURIComponent(spriteBatchSyncMatch[1])));
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
  const cacheKey = `inat:species_counts:${inatLogin.toLowerCase()}:v1`;
  const cached = await readSpeciesCountsCache(env, cacheKey);
  if (cached?.fresh) return cached.rows;

  const maxPages = intEnv(env, "MAX_IMPORT_PAGES", 1);
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL("https://api.inaturalist.org/v1/observations/species_counts");
    url.searchParams.set("user_login", inatLogin);
    url.searchParams.set("verifiable", "true");
    url.searchParams.set("per_page", "500");
    url.searchParams.set("page", String(page));

    const res = await fetchInatWithRetry(url.toString());

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429 && cached?.rows?.length) {
        return cached.rows;
      }

      if (res.status === 429) {
        const error = new Error("iNaturalist rate limit reached");
        error.code = "INAT_RATE_LIMITED";
        throw error;
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
      "User-Agent": "inat-battler/0.1 (Cloudflare Worker; public species_counts import)"
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
      "User-Agent": "inat-battler/0.1 (Cloudflare Worker; public species_counts import)"
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
    { expirationTtl: INAT_SPECIES_CACHE_TTL_SECONDS }
  );
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
  const cacheKey = `inat:global_seed:${GLOBAL_SEED_KEY}:${group.key}:${limitPerGroup}:v1`;
  const cached = await readSpeciesCountsCache(env, cacheKey);
  if (cached?.fresh) return cached.rows;

  const merged = new Map();
  const pages = Math.ceil(limitPerGroup / 500);

  for (const region of GLOBAL_SEED_REGIONS) {
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL("https://api.inaturalist.org/v1/observations/species_counts");
      url.searchParams.set("place_id", String(region.placeId));
      url.searchParams.set("rank", "species");
      url.searchParams.set("verifiable", "true");
      url.searchParams.set("photos", "true");
      url.searchParams.set("per_page", "500");
      url.searchParams.set("page", String(page));
      url.searchParams.append("iconic_taxa[]", group.iconicTaxon);

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
    SELECT
      gst.group_key,
      COUNT(*) AS seed_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM sprite_assets sa
        WHERE sa.taxon_id = gst.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
      ) THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM sprite_jobs sj
        WHERE sj.taxon_id = gst.taxon_id
          AND sj.asset_kind = ?
          AND sj.asset_version = ?
          AND sj.status = 'queued'
      ) THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM sprite_jobs sj
        WHERE sj.taxon_id = gst.taxon_id
          AND sj.asset_kind = ?
          AND sj.asset_version = ?
          AND sj.status = 'batch_submitted'
      ) THEN 1 ELSE 0 END) AS batch_submitted_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM sprite_jobs sj
        WHERE sj.taxon_id = gst.taxon_id
          AND sj.asset_kind = ?
          AND sj.asset_version = ?
          AND sj.status = 'failed'
      ) THEN 1 ELSE 0 END) AS failed_count
    FROM global_seed_taxa gst
    WHERE gst.seed_key = ?
    GROUP BY gst.group_key
    ORDER BY gst.group_key
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
      missingCount: Math.max(0, seedCount - readyCount - activeCount)
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

    const url = `https://api.inaturalist.org/v1/taxa/${encodeURIComponent(String(id))}`;
    const res = await fetchInatWithRetry(url);
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

  const url = new URL("https://api.inaturalist.org/v1/taxa/autocomplete");
  url.searchParams.set("q", query);
  url.searchParams.set("is_active", "true");
  url.searchParams.set("per_page", "10");

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
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

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

  const endpoint = "/v1/images/edits";
  const jsonlLines = [];
  const items = [];

  for (const job of jobs) {
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

async function syncSpriteBatch(env, batchId) {
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

  let ready = 0;
  let failed = 0;

  if (remote.output_file_id) {
    const outputText = await fetchOpenAIFileContent(env, remote.output_file_id);
    for (const line of parseJsonl(outputText)) {
      const result = await syncSpriteBatchOutputLine(env, batchId, line);
      if (result === "ready") ready += 1;
      if (result === "failed") failed += 1;
    }
  }

  if (remote.error_file_id) {
    const errorText = await fetchOpenAIFileContent(env, remote.error_file_id);
    for (const line of parseJsonl(errorText)) {
      const result = await markSpriteBatchItemFailed(
        env,
        batchId,
        line.custom_id,
        line.error?.message ?? JSON.stringify(line.error ?? line)
      );
      if (result) failed += 1;
    }
  }

  return {
    synced: true,
    batchId,
    status: remote.status,
    ready,
    failed,
    requestCounts: remote.request_counts ?? null
  };
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

async function fetchOpenAIFileContent(env, fileId) {
  const response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(fileId)}/content`, {
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI file content fetch failed: ${response.status} ${text}`);
  }

  return response.text();
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

async function getRoster(env, userId, limit, q = "") {
  const rows = await env.DB.prepare(`
    SELECT
      t.taxon_id,
      t.scientific_name,
      t.common_name,
      t.iconic_taxon_name,
      t.ancestry,
      t.default_photo_url,
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
      ) AS sprite_job_status
    FROM user_taxa ut
    JOIN taxa t ON t.taxon_id = ut.taxon_id
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

  return {
    userId,
    taxa: (rows.results ?? []).map((row) => {
      const spriteReady = Boolean(row.r2_key);
      const spriteUrl = spriteReady ? `/api/assets/${encodeR2Key(row.r2_key)}` : null;
      const taxon = taxonSummaryFromRow(row, spriteUrl);
      const genome = createGenome(taxon);
      const battleCreature = createBattleCreature(taxon, "roster");

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
          ? { status: "ready", url: spriteUrl }
          : {
              status: row.sprite_job_status || "missing",
              url: null,
              placeholder: placeholderFor(row.iconic_taxon_name)
            },
        bodyPlan: genome.bodyPlan,
        types: genome.types,
        role: genome.role,
        baseStats: genome.baseStats,
        stats: battleCreature.stats,
        maxHp: battleCreature.maxHp,
        moves: battleCreature.moves
      };
    })
  };
}

async function getSpriteStatus(env, taxonIds) {
  if (taxonIds.length === 0) return { sprites: [] };

  const placeholders = taxonIds.map(() => "?").join(",");
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
  `).bind(DEFAULT_ASSET_KIND, ASSET_VERSION, ...taxonIds).all();

  return {
    sprites: (rows.results ?? []).map((row) => ({
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

function buildSpriteTree(leaves) {
  const rootMap = new Map();

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

  return Array.from(rootMap.values()).map(finalize).sort(compareTreeNodes);
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

async function startNpcBattle(env, userId, taxonIds, npcTemplate) {
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
      AND EXISTS (
        SELECT 1
        FROM sprite_assets sa
        WHERE sa.taxon_id = t.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
      )
  `).bind(
    DEFAULT_ASSET_KIND,
    ASSET_VERSION,
    userId,
    ...cleanTaxonIds,
    DEFAULT_ASSET_KIND,
    ASSET_VERSION
  ).all();

  const byId = new Map((rows.results ?? []).map((row) => [Number(row.taxon_id), row]));
  const creatures = cleanTaxonIds.map((taxonId, index) => {
    const row = byId.get(taxonId);
    if (!row) throw new Error(`Taxon ${taxonId} is not a ready sprite in this user's roster`);

    const spriteUrl = row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null;
    return createBattleCreature(taxonSummaryFromRow(row, spriteUrl), `p-${index}`);
  });
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

  const creatures = (rows.results ?? []).map((row, index) => {
    const spriteUrl = row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null;
    return createBattleCreature(taxonSummaryFromRow(row, spriteUrl), `npc-${index}`);
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
  const creatures = DEMO_PLAYER_TAXON_IDS.map((taxonId, index) => {
    const row = byId.get(taxonId);
    if (!row) throw new Error("Demo sprite seed data is missing. Run D1 migrations.");

    const spriteUrl = row.r2_key ? `/api/assets/${encodeR2Key(row.r2_key)}` : null;
    return createBattleCreature(taxonSummaryFromRow(row, spriteUrl), `demo-${index}`);
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
      next.status === "won" ? next.player.userId ?? null : null,
      next.status === "lost" ? next.player.userId ?? null : null,
      JSON.stringify({ status: next.status, turns: next.turn - 1 }),
      now
    ).run();
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
      AND EXISTS (
        SELECT 1
        FROM sprite_assets sa
        WHERE sa.taxon_id = ut.taxon_id
          AND sa.asset_kind = ?
          AND sa.asset_version = ?
          AND sa.status = 'ready'
      )
  `).bind(userId, ...taxonIds, DEFAULT_ASSET_KIND, ASSET_VERSION).all();

  if ((rows.results ?? []).length !== taxonIds.length) {
    throw new Error("Team must use 5 ready sprites from this user's roster");
  }
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
      AND genome_version = ?
  `).bind(taxonId, ASSET_VERSION).first();

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

    .dev-batch-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      margin-bottom: 12px;
    }

    .tree-tools input {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      background: #fbfcf9;
      color: var(--ink);
      font: inherit;
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
      gap: 8px;
    }

    .tree-node {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.78);
      overflow: hidden;
    }

    .tree-node summary {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-height: 42px;
      padding: 9px 12px;
      cursor: pointer;
      font-weight: 900;
    }

    .tree-node-list {
      display: grid;
      gap: 8px;
      padding: 0 10px 10px 18px;
    }

    .tree-leaf {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-height: 88px;
      border: 1px solid #e5e9e2;
      border-radius: 8px;
      padding: 8px;
      background: #fbfcf9;
    }

    .tree-leaf-sprite {
      display: grid;
      place-items: center;
      width: 72px;
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      background: #eef2eb;
      overflow: hidden;
    }

    .tree-leaf-sprite .sheet-sprite {
      width: 94%;
    }

    .tree-leaf-name {
      min-width: 0;
      font-weight: 900;
      overflow-wrap: anywhere;
    }

    .tree-leaf-meta {
      color: var(--muted);
      font-size: 0.82rem;
      overflow-wrap: anywhere;
    }

    .tree-count {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 900;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
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
      min-height: 398px;
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
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 10px;
      padding: 12px;
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
      min-height: 132px;
    }

    .name {
      min-height: 42px;
      font-weight: 800;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .sci {
      min-height: 18px;
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
      margin-top: 20px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.88);
      box-shadow: var(--shadow);
    }

    .battle[hidden] {
      display: none;
    }

    .battle-stage {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      align-items: stretch;
    }

    .combatant {
      display: grid;
      grid-template-rows: auto minmax(180px, 1fr) auto;
      gap: 10px;
      min-width: 0;
      min-height: 310px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcf9;
      padding: 12px;
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
      display: grid;
      place-items: center;
      min-height: 180px;
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(69, 109, 168, 0.1), rgba(47, 125, 66, 0.1)),
        #f6f8f4;
      overflow: hidden;
    }

    .combatant-sprite .sheet-sprite {
      width: min(82%, 240px);
    }

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

      .tree-tools,
      .tree-leaf {
        grid-template-columns: 1fr;
      }

      .tree-leaf-sprite {
        width: min(100%, 160px);
      }

      .meta {
        padding: 10px;
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
        <div class="dev-batch">
          <div class="dev-batch-head">
            <h2>Dev Batch</h2>
            <span class="subtle" id="batchQueueCount">0 queued</span>
          </div>
          <button class="secondary" id="batchPreviewButton" type="button" disabled>Show Batch Queue</button>
          <button class="secondary" id="batchSubmitButton" type="button" disabled>Submit Batch</button>
          <div class="batch-list" id="batchQueueList">Load a roster, then click Queue More.</div>
        </div>
        <div class="dev-batch">
          <div class="dev-batch-head">
            <h2>Global Seed</h2>
            <span class="subtle" id="seedQueueCount">0 queued</span>
          </div>
          <button class="secondary" id="seedImportButton" type="button">Import Plants + Animals</button>
          <button class="secondary" id="seedQueueButton" type="button">Queue 200</button>
          <button class="secondary" id="seedSubmitButton" type="button" disabled>Submit 200</button>
          <div class="batch-list" id="seedQueueList">Load seed status to start.</div>
        </div>
        <div class="dev-batch">
          <div class="dev-batch-head">
            <h2>Manual Sprite</h2>
            <span class="subtle" id="manualUploadState">idle</span>
          </div>
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
        </div>
        <p class="status" id="statusLine"></p>
      </aside>

      <section>
        <nav class="view-tabs" aria-label="Main views">
          <button class="view-tab active" id="rosterTabButton" type="button" data-view-tab="roster">Roster</button>
          <button class="view-tab" id="treeTabButton" type="button" data-view-tab="tree">Sprite Tree</button>
        </nav>
        <section class="view-panel" id="rosterView">
          <div class="roster-head">
            <h2>Roster</h2>
            <span class="subtle" id="refreshLabel"></span>
          </div>
          <div class="grid" id="rosterGrid"></div>
          <div class="empty" id="emptyState">Import a public iNaturalist roster.</div>
          <section class="battle" id="battlePanel" hidden></section>
        </section>
        <section class="view-panel" id="treeView" hidden>
          <div class="roster-head">
            <h2>Sprite Tree</h2>
            <span class="subtle" id="treeRefreshLabel"></span>
          </div>
          <div class="tree-tools">
            <input id="treeSearchInput" placeholder="Search sprites, taxa, or groups">
            <button class="secondary" id="treeRefreshButton" type="button">Refresh</button>
          </div>
          <div class="tree-browser" id="spriteTreePanel">
            <div class="empty">Load the sprite tree to browse ready assets.</div>
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
    const ACTIVE_BATCH_STATUSES = new Set(["submitted", "validating", "in_progress", "finalizing", "cancelling"]);

    const state = {
      userId: localStorage.getItem("inatBattler:userId") || "",
      inatLogin: localStorage.getItem("inatBattler:inatLogin") || "",
      activeView: "roster",
      taxa: [],
      spriteTree: null,
      treeSearch: "",
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
      polling: null
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
      rosterView: document.getElementById("rosterView"),
      treeView: document.getElementById("treeView"),
      treeSearchInput: document.getElementById("treeSearchInput"),
      treeRefreshButton: document.getElementById("treeRefreshButton"),
      treeRefreshLabel: document.getElementById("treeRefreshLabel"),
      spriteTreePanel: document.getElementById("spriteTreePanel"),
      rosterGrid: document.getElementById("rosterGrid"),
      emptyState: document.getElementById("emptyState"),
      battlePanel: document.getElementById("battlePanel")
    };

    els.input.value = state.inatLogin;

    els.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await importRoster(els.input.value);
    });

    els.rosterTabButton.addEventListener("click", () => switchView("roster"));
    els.treeTabButton.addEventListener("click", () => switchView("tree"));

    els.treeRefreshButton.addEventListener("click", async () => {
      state.treeSearch = els.treeSearchInput.value.trim();
      await loadSpriteTree(true);
    });

    els.treeSearchInput.addEventListener("input", debounce(async () => {
      if (state.activeView !== "tree") return;
      state.treeSearch = els.treeSearchInput.value.trim();
      await loadSpriteTree(false);
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

    els.battlePanel.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-move-id]");
      if (!button || state.battleBusy) return;
      await submitBattleMove(button.getAttribute("data-move-id"));
    });

    els.rosterGrid.addEventListener("click", (event) => {
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

    if (state.userId) {
      loadRoster();
    }

    renderBatchQueue();
    hydrateBatchTracker();
    hydrateGlobalSeedStatus();

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

    async function loadRoster() {
      if (!state.userId) return;

      const res = await apiFetch("/api/roster?userId=" + encodeURIComponent(state.userId) + "&limit=100");
      state.taxa = res.taxa || [];
      pruneSelectedTaxa();
      render();
      schedulePolling();
    }

    async function switchView(view) {
      state.activeView = view === "tree" ? "tree" : "roster";
      renderViewTabs();

      if (state.activeView === "tree" && !state.spriteTree) {
        await loadSpriteTree(false);
      }
    }

    function renderViewTabs() {
      const isTree = state.activeView === "tree";
      els.rosterTabButton.classList.toggle("active", !isTree);
      els.treeTabButton.classList.toggle("active", isTree);
      els.rosterView.hidden = isTree;
      els.treeView.hidden = !isTree;
    }

    async function loadSpriteTree(showStatus) {
      const q = state.treeSearch || "";
      if (showStatus) setStatus("Loading sprite tree");

      try {
        const res = await apiFetch("/api/sprite-tree?limit=1000&q=" + encodeURIComponent(q));
        state.spriteTree = res;
        renderSpriteTree();
        if (showStatus) setStatus("Loaded " + Number(res.totalSprites || 0) + " ready sprites in the tree");
      } catch (error) {
        setStatus(error.message);
      }
    }

    function render() {
      els.accountLabel.textContent = state.inatLogin ? "@" + state.inatLogin : "No roster loaded";
      els.emptyState.style.display = state.taxa.length ? "none" : "grid";
      els.rosterGrid.innerHTML = state.taxa.map(renderCard).join("");

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
      els.refreshLabel.textContent = state.taxa.length ? "Top " + state.taxa.length : "";
      renderBatchQueue();
      renderGlobalSeedQueue();
      renderViewTabs();
      renderSpriteTree();
      renderBattle();
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
        '<div class="tree-summary">Grouped by iNaturalist iconic taxon and genus from the current D1/R2 sprite assets.</div>' +
        '<div class="sprite-tree">' + tree.roots.map((node) => renderTreeNode(node, 0)).join("") + '</div>';
    }

    function renderTreeNode(node, depth) {
      if (node.leaf) return renderTreeLeaf(node);

      const open = depth < 1 ? " open" : "";
      return '<details class="tree-node"' + open + '>' +
        '<summary>' +
          '<span>' + escapeHtml(node.name || "Taxon") + '</span>' +
          '<span class="tree-count">' + Number(node.spriteCount || 0) + ' sprites</span>' +
        '</summary>' +
        '<div class="tree-node-list">' +
          (Array.isArray(node.children) ? node.children.map((child) => renderTreeNode(child, depth + 1)).join("") : "") +
        '</div>' +
      '</details>';
    }

    function renderTreeLeaf(node) {
      const sprite = node.sprite?.url
        ? renderSheetSprite(node.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(node.iconicTaxonName)) + '"></div>';

      return '<div class="tree-leaf">' +
        '<div class="tree-leaf-sprite">' + sprite + '</div>' +
        '<div>' +
          '<div class="tree-leaf-name">' + escapeHtml(node.name || node.scientificName || "Unnamed taxon") + '</div>' +
          '<div class="tree-leaf-meta"><em>' + escapeHtml(node.scientificName || "") + '</em></div>' +
          '<div class="tree-leaf-meta">' + escapeHtml((node.rank || "taxon") + " / " + (node.iconicTaxonName || "Life")) + ' / taxon ' + Number(node.taxonId || 0) + '</div>' +
        '</div>' +
        '<a class="manual-result-link" href="' + escapeAttr(node.sprite?.url || "#") + '" target="_blank" rel="noreferrer">Open</a>' +
      '</div>';
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
        const res = await apiFetch("/api/sprite-batches/" + encodeURIComponent(state.lastBatch.batchId) + "/sync", {
          method: "POST"
        });

        if (res.synced) {
          state.lastBatch = {
            ...state.lastBatch,
            status: res.status || state.lastBatch.status,
            synced: true,
            ready: Number(res.ready || 0),
            failed: Number(res.failed || 0),
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
            requestCounts: res.requestCounts || state.lastBatch.requestCounts || null
          };
          saveLastBatch();
          if (showStatus) setStatus(batchStatusText(state.lastBatch));
          if (isActiveBatchStatus(state.lastBatch.status)) scheduleBatchPolling(BATCH_POLL_MS);
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
      if (!state.lastBatch || !isActiveBatchStatus(state.lastBatch.status)) return;

      state.batchPolling = setTimeout(() => {
        refreshBatchStatus(false);
      }, delayMs || BATCH_POLL_MS);
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
            '</div>' +
            '<div class="meta">' +
              '<div class="name">' + escapeHtml(taxon.name) + '</div>' +
              '<div class="sci">' + escapeHtml(taxon.scientificName) + '</div>' +
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

        return '<div class="ability">' +
          '<div>' +
            '<strong>' + escapeHtml(move.name || move.id || "Move") + '</strong>' +
            '<span>' + escapeHtml((move.type || "Life") + " / " + (move.category || "status")) + '</span>' +
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

        state.battle = battle;
        state.battleAnimation = "anim-idle";
        setStatus("NPC battle ready");
        renderBattle();
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
        state.battle = battle;
        state.battleAnimation = "anim-idle";
        setStatus("5v5 test battle ready");
        renderBattle();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function submitBattleMove(moveId) {
      if (!state.battle || !moveId) return;

      const active = getActiveCreature(state.battle.player);
      const move = active.moves.find((candidate) => candidate.id === moveId);
      state.battleBusy = true;
      state.battleAnimation = move && move.category === "special" ? "anim-special" : "anim-attack";
      renderBattle();

      try {
        await delay(450);
        state.battle = await apiFetch("/api/battles/" + encodeURIComponent(state.battle.battleId) + "/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ moveId })
        });
        state.battleAnimation = "anim-idle";
        renderBattle();
      } catch (error) {
        setStatus(error.message);
        state.battleAnimation = "anim-idle";
        renderBattle();
      } finally {
        state.battleBusy = false;
        renderBattle();
      }
    }

    function renderBattle() {
      const battle = state.battle;
      els.battlePanel.hidden = !battle;
      if (!battle) return;

      const playerActive = getActiveCreature(battle.player);
      const opponentActive = getActiveCreature(battle.opponent);
      const moveButtons = battle.status === "active"
        ? playerActive.moves.map((move) => (
            '<button class="move-button" type="button" data-move-id="' + escapeAttr(move.id) + '" ' + (state.battleBusy ? "disabled" : "") + '>' +
              escapeHtml(move.name) + '<br><span class="subtle">' + escapeHtml(move.type + " / " + move.category) + '</span>' +
            '</button>'
          )).join("")
        : '<button class="move-button" type="button" disabled>Battle ' + escapeHtml(battle.status) + '</button>';
      const recentLog = battle.log.slice(-6).reverse().map((entry) => (
        '<div>Turn ' + Number(entry.turn || 0) + ': ' + escapeHtml(entry.text) + '</div>'
      )).join("");

      els.battlePanel.innerHTML =
        '<div class="roster-head">' +
          '<h2>NPC Battle</h2>' +
          '<span class="subtle">' + escapeHtml(battle.status) + ' / turn ' + Number(battle.turn || 1) + '</span>' +
        '</div>' +
        '<div class="battle-stage">' +
          renderCombatant(battle.player, playerActive, "player") +
          renderCombatant(battle.opponent, opponentActive, "opponent") +
        '</div>' +
        '<div class="moves">' + moveButtons + '</div>' +
        '<div class="battle-log">' + recentLog + '</div>';
    }

    function renderCombatant(team, creature, side) {
      const hpPct = creature.maxHp ? Math.max(0, Math.round((creature.hp / creature.maxHp) * 100)) : 0;
      const animation = side === "player" ? state.battleAnimation : "anim-idle";
      const sprite = creature.spriteUrl
        ? renderSheetSprite(creature.spriteUrl, animation)
        : '<div class="dummy-sprite">Dummy</div>';
      const bench = team.creatures.map((member, index) => (
        '<div class="bench-slot ' + (index === team.activeIndex ? "active" : "") + '">' + escapeHtml(member.name) + '</div>'
      )).join("");

      return '<article class="combatant">' +
        '<div class="combatant-head">' +
          '<div class="combatant-name">' + escapeHtml(creature.name) + '</div>' +
          '<div class="combatant-role">' + escapeHtml((creature.types || []).join(" / ")) + '</div>' +
        '</div>' +
        '<div class="combatant-sprite">' + sprite + '</div>' +
        '<div>' +
          '<div class="hp" aria-label="HP"><span style="--hp:' + hpPct + '%"></span></div>' +
          '<div class="subtle">' + Number(creature.hp || 0) + ' / ' + Number(creature.maxHp || 0) + ' HP</div>' +
          '<div class="bench">' + bench + '</div>' +
        '</div>' +
      '</article>';
    }

    function renderSheetSprite(url, animationClass) {
      return '<div class="sheet-sprite ' + escapeAttr(animationClass || "anim-idle") + '" style="background-image:url(&quot;' + escapeAttr(url) + '&quot;)"></div>';
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
