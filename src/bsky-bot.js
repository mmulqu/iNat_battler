// Brand-account Bluesky posting for battle highlights (see
// docs/battle-highlights-bluesky.md). This is the bot path: a dedicated account
// (wildmarch.bsky.social) authenticated with an app password — plain Bearer JWT,
// no DPoP, completely separate from the per-user OAuth flow in atproto.js.
//
// Portable ESM: uses only global fetch + standard APIs, so it runs in the
// Worker and in Node (the test script). Pass video bytes in; R2 is never used.
//
// Video flow (https://docs.bsky.app/docs/tutorials/video):
//   1. createSession (app password) -> accessJwt, did, PDS host
//   2. getServiceAuth on the PDS (lxm com.atproto.repo.uploadBlob) -> token
//   3. POST video bytes to video.bsky.app/xrpc/app.bsky.video.uploadVideo -> jobId
//   4. poll app.bsky.video.getJobStatus until a blob ref is returned
//   5. createRecord app.bsky.feed.post with an app.bsky.embed.video embed

const DEFAULT_SERVICE = "https://bsky.social";
const VIDEO_SERVICE = "https://video.bsky.app";
const textEncoder = new TextEncoder();

async function xrpc(baseUrl, method, { token, query, body, contentType, raw } = {}) {
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw) {
    headers["content-type"] = contentType || "application/octet-stream";
    payload = raw;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}/xrpc/${method}${qs}`, {
    method: body !== undefined || raw ? "POST" : "GET",
    headers,
    body: payload
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function pdsHostFromDidDoc(didDoc, fallback) {
  const services = didDoc?.service || [];
  const pds = services.find((s) => String(s?.id || "").endsWith("#atproto_pds"));
  if (pds?.serviceEndpoint) {
    try {
      return new URL(pds.serviceEndpoint).host;
    } catch (_) {}
  }
  return fallback;
}

export async function createBskySession({ identifier, password, service = DEFAULT_SERVICE }) {
  if (!identifier || !password) throw new Error("Bluesky identifier and app password are required");
  const { ok, status, data } = await xrpc(service, "com.atproto.server.createSession", {
    body: { identifier, password }
  });
  if (!ok) {
    throw new Error(`Bluesky login failed (${status}): ${data?.message || data?.error || "unknown"}`);
  }
  const pdsHost = pdsHostFromDidDoc(data.didDoc, new URL(service).host);
  return {
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    did: data.did,
    handle: data.handle,
    pdsUrl: `https://${pdsHost}`,
    pdsHost
  };
}

async function getServiceAuth(session, { lxm, aud, expSeconds = 1800 }) {
  const { ok, status, data } = await xrpc(session.pdsUrl, "com.atproto.server.getServiceAuth", {
    token: session.accessJwt,
    query: {
      aud: aud || `did:web:${session.pdsHost}`,
      lxm,
      exp: String(Math.floor(Date.now() / 1000) + expSeconds)
    }
  });
  if (!ok) throw new Error(`getServiceAuth failed (${status}): ${data?.message || data?.error}`);
  return data.token;
}

// Returns the upload limits for the account; useful to verify email/upload
// eligibility before attempting an upload. Non-fatal — returns null on error.
export async function getVideoUploadLimits(session) {
  try {
    const token = await getServiceAuth(session, { lxm: "app.bsky.video.getUploadLimits", aud: "did:web:video.bsky.app" });
    const { ok, data } = await xrpc(VIDEO_SERVICE, "app.bsky.video.getUploadLimits", { token });
    return ok ? data : null;
  } catch (_) {
    return null;
  }
}

// Uploads MP4 bytes through the video service and returns the processed blob ref.
export async function uploadVideo(session, bytes, { name = "highlight.mp4" } = {}) {
  const token = await getServiceAuth(session, { lxm: "com.atproto.repo.uploadBlob" });

  const uploadRes = await fetch(
    `${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(session.did)}&name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "video/mp4",
        "content-length": String(bytes.byteLength ?? bytes.length)
      },
      body: bytes
    }
  );
  const uploadData = await uploadRes.json().catch(() => ({}));

  // The video service nests its result/error under `jobStatus`.
  const jobStatus = uploadData?.jobStatus || uploadData;
  const err = jobStatus?.error || uploadData?.error || uploadData?.message;

  // Already-processed videos short-circuit with the blob (sometimes as an error).
  if (jobStatus?.blob) return jobStatus.blob;

  if (err === "unconfirmed_email") {
    throw new Error(
      "Bluesky requires a verified email on the posting account before its first video upload. " +
      "Verify the email for this account in Bluesky settings, then retry."
    );
  }
  if (err && err !== "already_exists" && !jobStatus?.jobId) {
    throw new Error(`uploadVideo failed (${uploadRes.status}): ${err}`);
  }
  if (!uploadRes.ok && !jobStatus?.jobId && !jobStatus?.blob) {
    throw new Error(`uploadVideo failed (${uploadRes.status}): ${err || "unknown"}`);
  }

  const jobId = jobStatus?.jobId;
  if (!jobId) throw new Error("uploadVideo returned no jobId and no blob");
  return await pollJobUntilBlob(token, jobId);
}

async function pollJobUntilBlob(token, jobId, { tries = 60, intervalMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const { ok, data } = await xrpc(VIDEO_SERVICE, "app.bsky.video.getJobStatus", { token, query: { jobId } });
    const js = data?.jobStatus || data;
    if (js?.blob) return js.blob;
    if (js?.state === "JOB_STATE_FAILED" || js?.error) {
      // already_exists still carries a blob in some cases — handled above.
      if (!js?.blob) throw new Error(`Video processing failed: ${js?.error || js?.message || js?.state}`);
    }
    if (!ok && i > 3) throw new Error(`getJobStatus failed: ${data?.message || data?.error}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for video processing");
}

// Build richtext facets for @mentions. `mentions` is [{ handle, did }]; only
// mentions whose handle text appears in `text` get a facet.
export function buildMentionFacets(text, mentions = []) {
  const facets = [];
  for (const { handle, did } of mentions) {
    if (!handle || !did) continue;
    const needle = `@${handle}`;
    const idx = text.indexOf(needle);
    if (idx < 0) continue;
    const byteStart = textEncoder.encode(text.slice(0, idx)).length;
    const byteEnd = byteStart + textEncoder.encode(needle).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#mention", did }]
    });
  }
  return facets;
}

export async function createVideoPost(session, { text, blob, width, height, alt, facets, langs = ["en"] }) {
  const record = {
    $type: "app.bsky.feed.post",
    text: text || "",
    createdAt: new Date().toISOString(),
    langs,
    embed: {
      $type: "app.bsky.embed.video",
      video: blob,
      ...(alt ? { alt } : {}),
      ...(width && height ? { aspectRatio: { width, height } } : {})
    }
  };
  if (facets && facets.length) record.facets = facets;

  const { ok, status, data } = await xrpc(session.pdsUrl, "com.atproto.repo.createRecord", {
    token: session.accessJwt,
    body: { repo: session.did, collection: "app.bsky.feed.post", record }
  });
  if (!ok) throw new Error(`createRecord failed (${status}): ${data?.message || data?.error}`);
  return data; // { uri, cid }
}

// High-level: log in with the brand app password, upload the MP4, and post it.
// `bytes` is a Uint8Array/ArrayBuffer of the MP4. `mentions` is [{handle,did}].
export async function postBattleHighlight({
  identifier, password, service,
  bytes, text, alt, width = 720, height = 900, mentions = [], name = "highlight.mp4"
}) {
  const session = await createBskySession({ identifier, password, service });
  const blob = await uploadVideo(session, bytes, { name });
  const facets = buildMentionFacets(text || "", mentions);
  const post = await createVideoPost(session, { text, blob, width, height, alt, facets });
  return { ...post, handle: session.handle, did: session.did };
}
