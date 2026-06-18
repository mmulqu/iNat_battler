// Live end-to-end test of the brand-account video posting flow.
// Reads the MP4 at ./hl.mp4 (render it via /replay first) and posts it to the
// account named by BSKY_BOT_IDENTIFIER / BSKY_BOT_APP_PASSWORD (env only — never
// hardcode the app password). Verifies by reading the account's feed back.
//
//   BSKY_BOT_IDENTIFIER=wildmarch.bsky.social \
//   BSKY_BOT_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//   node scripts/post-highlight-test.mjs [path-to.mp4]
import { readFileSync } from "node:fs";
import { postBattleHighlight, createBskySession, getVideoUploadLimits } from "../src/bsky-bot.js";

const identifier = process.env.BSKY_BOT_IDENTIFIER;
const password = process.env.BSKY_BOT_APP_PASSWORD;
const file = process.argv[2] || "hl.mp4";

if (!identifier || !password) {
  console.error("Set BSKY_BOT_IDENTIFIER and BSKY_BOT_APP_PASSWORD env vars.");
  process.exit(1);
}

const bytes = readFileSync(file);
console.log(`Loaded ${file}: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

const session = await createBskySession({ identifier, password });
console.log(`Logged in as @${session.handle} (${session.did}) PDS ${session.pdsUrl}`);

const limits = await getVideoUploadLimits(session);
console.log("Upload limits:", JSON.stringify(limits));

const text = "🦋 Test highlight: a wild iNat battle! #iNatBattler";
console.log("Uploading + posting…");
const post = await postBattleHighlight({
  identifier, password,
  bytes, text,
  alt: "An animated iNat Battler creature battle.",
  width: 720, height: 900
});
console.log("Posted:", JSON.stringify(post));

const rkey = post.uri.split("/").pop();
console.log(`Post URL: https://bsky.app/profile/${session.handle}/post/${rkey}`);
