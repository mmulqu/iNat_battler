// Minimal AT Protocol OAuth client for Cloudflare Workers.
//
// Implements the atproto OAuth profile with WebCrypto only:
// handle -> DID -> PDS resolution, authorization server discovery,
// PAR + PKCE, DPoP-bound tokens (ES256), token refresh, and
// authenticated XRPC calls against the user's PDS.

const PLC_DIRECTORY_URL = "https://plc.directory";
const PUBLIC_APPVIEW_URL = "https://public.api.bsky.app";

export const DEFAULT_OAUTH_SCOPE = "atproto repo:app.bsky.feed.post?action=create";

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function b64urlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlJson(value) {
  return b64urlFromBytes(textEncoder.encode(JSON.stringify(value)));
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return b64urlFromBytes(bytes);
}

async function sha256B64url(input) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return b64urlFromBytes(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// ES256 / DPoP
// ---------------------------------------------------------------------------

export async function generateDpopKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicJwk = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y
  };
  return { privateJwk, publicJwk };
}

async function signEs256(header, payload, privateJwk) {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(signingInput)
  );
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
}

export async function createDpopProof({ privateJwk, publicJwk, method, url, nonce, accessToken }) {
  const target = new URL(url);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk };
  const payload = {
    jti: randomToken(16),
    htm: method.toUpperCase(),
    htu: `${target.origin}${target.pathname}`,
    iat: Math.floor(Date.now() / 1000)
  };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = await sha256B64url(accessToken);
  return signEs256(header, payload, privateJwk);
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export function normalizeHandle(rawHandle) {
  const handle = String(rawHandle ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{1,250}\.[a-z]{2,}$/.test(handle)) {
    throw new Error(`"${rawHandle}" does not look like a Bluesky handle (try name.bsky.social)`);
  }
  return handle;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Request to ${new URL(url).host} failed (${res.status})`);
  return res.json();
}

export async function resolveHandleToDid(handle) {
  const url = `${PUBLIC_APPVIEW_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not resolve Bluesky handle @${handle}`);
  const data = await res.json();
  if (!data?.did) throw new Error(`Could not resolve Bluesky handle @${handle}`);
  return data.did;
}

export async function resolveDidDocument(did) {
  if (did.startsWith("did:plc:")) {
    return fetchJson(`${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`);
  }
  if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error(`Unsupported did:web value ${did}`);
    return fetchJson(`https://${host}/.well-known/did.json`);
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

export function pdsEndpointFromDidDocument(doc) {
  const services = Array.isArray(doc?.service) ? doc.service : [];
  const pds = services.find(
    (service) =>
      service?.type === "AtprotoPersonalDataServer" ||
      String(service?.id ?? "").endsWith("#atproto_pds")
  );
  const endpoint = pds?.serviceEndpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    throw new Error("Could not find a PDS endpoint in the DID document");
  }
  return endpoint.replace(/\/$/, "");
}

export async function resolveIdentity(rawHandle) {
  const handle = normalizeHandle(rawHandle);
  const did = await resolveHandleToDid(handle);
  const doc = await resolveDidDocument(did);
  return { did, handle, pdsUrl: pdsEndpointFromDidDocument(doc) };
}

export async function fetchPublicProfile(did) {
  try {
    const data = await fetchJson(
      `${PUBLIC_APPVIEW_URL}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    return {
      handle: data?.handle ?? null,
      displayName: data?.displayName ?? null,
      avatarUrl: data?.avatar ?? null
    };
  } catch {
    return { handle: null, displayName: null, avatarUrl: null };
  }
}

export async function searchActorsTypeahead(query, limit = 8) {
  const q = String(query ?? "").trim().replace(/^@/, "");
  if (q.length < 2) return [];

  try {
    const data = await fetchJson(
      `${PUBLIC_APPVIEW_URL}/xrpc/app.bsky.actor.searchActorsTypeahead?q=${encodeURIComponent(q)}&limit=${limit}`
    );
    return (data.actors ?? []).map((actor) => ({
      did: actor.did,
      handle: actor.handle,
      displayName: actor.displayName ?? null,
      avatar: actor.avatar ?? null
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Authorization server discovery
// ---------------------------------------------------------------------------

export async function getAuthServerMeta(pdsUrl) {
  const resourceMeta = await fetchJson(new URL("/.well-known/oauth-protected-resource", pdsUrl));
  const issuer = resourceMeta?.authorization_servers?.[0];
  if (!issuer) throw new Error("PDS did not advertise an authorization server");

  const meta = await fetchJson(new URL("/.well-known/oauth-authorization-server", issuer));
  if (meta?.issuer?.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new Error("Authorization server issuer mismatch");
  }
  for (const field of ["pushed_authorization_request_endpoint", "authorization_endpoint", "token_endpoint"]) {
    if (typeof meta[field] !== "string") throw new Error(`Authorization server metadata missing ${field}`);
  }
  return meta;
}

// ---------------------------------------------------------------------------
// OAuth requests (PAR, token exchange, refresh) with DPoP nonce retries
// ---------------------------------------------------------------------------

async function dpopFormRequest(endpoint, params, dpopKey, initialNonce) {
  let nonce = initialNonce ?? null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const proof = await createDpopProof({
      privateJwk: dpopKey.privateJwk,
      publicJwk: dpopKey.publicJwk,
      method: "POST",
      url: endpoint,
      nonce
    });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: proof
      },
      body: new URLSearchParams(params)
    });
    const data = await res.json().catch(() => ({}));
    const serverNonce = res.headers.get("dpop-nonce");
    if (serverNonce) nonce = serverNonce;

    if (!res.ok && data?.error === "use_dpop_nonce" && serverNonce && attempt === 0) {
      continue;
    }
    return { ok: res.ok, status: res.status, data, nonce };
  }
}

export async function pushedAuthorizationRequest({ authMeta, clientId, redirectUri, scope, state, handle, codeChallenge, dpopKey }) {
  const { ok, data, nonce } = await dpopFormRequest(
    authMeta.pushed_authorization_request_endpoint,
    {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      login_hint: handle,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    },
    dpopKey
  );

  if (!ok) {
    const detail = data?.error_description || data?.error || "request rejected";
    if (data?.error === "invalid_scope") {
      throw new Error(
        `Authorization server rejected scope "${scope}". ` +
        "If this PDS predates granular auth scopes, set OAUTH_SCOPE=\"atproto transition:generic\"."
      );
    }
    throw new Error(`Pushed authorization request failed: ${detail}`);
  }
  if (!data?.request_uri) throw new Error("Pushed authorization request returned no request_uri");
  return { requestUri: data.request_uri, nonce };
}

export async function exchangeAuthorizationCode({ authMeta, clientId, redirectUri, code, pkceVerifier, dpopKey, nonce }) {
  const result = await dpopFormRequest(
    authMeta.token_endpoint,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkceVerifier
    },
    dpopKey,
    nonce
  );

  if (!result.ok) {
    const detail = result.data?.error_description || result.data?.error || `status ${result.status}`;
    throw new Error(`Token exchange failed: ${detail}`);
  }
  return { tokens: result.data, nonce: result.nonce };
}

export async function refreshAccessToken({ authMeta, clientId, refreshToken, dpopKey, nonce }) {
  const result = await dpopFormRequest(
    authMeta.token_endpoint,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId
    },
    dpopKey,
    nonce
  );

  if (!result.ok) {
    const detail = result.data?.error_description || result.data?.error || `status ${result.status}`;
    const error = new Error(`Token refresh failed: ${detail}`);
    error.code = "ATPROTO_REFRESH_FAILED";
    throw error;
  }
  return { tokens: result.data, nonce: result.nonce };
}

export function pkceChallengeFromVerifier(verifier) {
  return sha256B64url(verifier);
}

// ---------------------------------------------------------------------------
// Authenticated PDS XRPC calls
// ---------------------------------------------------------------------------

export async function pdsXrpcCall({ pdsUrl, accessToken, dpopKey, nonce }, nsid, body) {
  const url = `${pdsUrl}/xrpc/${nsid}`;
  let currentNonce = nonce ?? null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const proof = await createDpopProof({
      privateJwk: dpopKey.privateJwk,
      publicJwk: dpopKey.publicJwk,
      method: "POST",
      url,
      nonce: currentNonce,
      accessToken
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        dpop: proof
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    const serverNonce = res.headers.get("dpop-nonce");
    if (serverNonce) currentNonce = serverNonce;

    const needsNonce =
      res.status === 401 &&
      serverNonce &&
      (data?.error === "use_dpop_nonce" ||
        String(res.headers.get("www-authenticate") ?? "").includes("use_dpop_nonce"));
    if (needsNonce && attempt === 0) continue;

    return { ok: res.ok, status: res.status, data, nonce: currentNonce };
  }
}

// ---------------------------------------------------------------------------
// Bluesky post construction (challenge announcement with mention + link facets)
// ---------------------------------------------------------------------------

export function buildChallengePostRecord({ opponentHandle, opponentDid, challengeUrl, message }) {
  const mentionText = `@${opponentHandle}`;
  const body = message ? ` ${message} ` : " I challenge you to an iNat Battle! ";
  const text = `${mentionText}${body}${challengeUrl}`;

  const mentionEnd = textEncoder.encode(mentionText).length;
  const linkStart = textEncoder.encode(`${mentionText}${body}`).length;
  const linkEnd = textEncoder.encode(text).length;

  return {
    $type: "app.bsky.feed.post",
    text,
    facets: [
      {
        index: { byteStart: 0, byteEnd: mentionEnd },
        features: [{ $type: "app.bsky.richtext.facet#mention", did: opponentDid }]
      },
      {
        index: { byteStart: linkStart, byteEnd: linkEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: challengeUrl }]
      }
    ],
    createdAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Client metadata
// ---------------------------------------------------------------------------

export function oauthClientConfig(env, origin) {
  const url = new URL(origin);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const scope = env.OAUTH_SCOPE || DEFAULT_OAUTH_SCOPE;
  const redirectUri = `${origin}/oauth/callback`;
  const clientId = isLoopback
    ? `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`
    : `${origin}/oauth/client-metadata.json`;
  return { clientId, redirectUri, scope, isLoopback };
}

export function clientMetadataDocument(env, origin) {
  const { clientId, redirectUri, scope } = oauthClientConfig(env, origin);
  return {
    client_id: clientId,
    client_name: "iNat Battler",
    client_uri: origin,
    application_type: "web",
    dpop_bound_access_tokens: true,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [redirectUri],
    response_types: ["code"],
    scope,
    token_endpoint_auth_method: "none"
  };
}
