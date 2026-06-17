---
name: cloudflare-usage
description: Check this project's Cloudflare account usage vs free-tier limits (R2 storage/operations, Workers requests, D1 queries) and inspect/query Cloudflare resources. Use when asked about Cloudflare billing, usage, limits, "are we exceeding the $5 plan", R2 storage, D1 size, or to run queries against the production D1 database.
---

# Cloudflare usage & resource checks

This project (`inat-battler`) runs on Cloudflare Workers **Paid ($5/mo)** — confirmed because it uses **Queues**, which require the Paid plan. R2/D1 usage is billed on top but each has a generous monthly free tier.

Key IDs:
- **Account ID:** `b092f621d0a33973ebb97c64ef0d1c86` (email intrinsic3141@gmail.com)
- **D1 database:** name `inat_battler`, id `68f56b1f-bec1-46a2-93bd-829b00aa6756`
- **R2 bucket:** `inat-battler-assets`
- **Worker:** `inat-battler` (cron `*/2 * * * *`)

There are **two** tools, for two different jobs. Pick by what's being asked.

## 1. Exact usage vs limits → `scripts/cf_usage.py` (GraphQL Analytics API)

For real numbers (storage GB, operation counts, request counts) use the script. The MCP below CANNOT do this — it has no analytics dataset.

**Auth:** needs a Cloudflare **API token** with **Account → Account Analytics → Read** (template: "Read analytics and logs"). The **wrangler OAuth token does NOT work** for GraphQL (`not authorized for that account`). Store the token at `~/.cf_analytics_token` (one line). It is in HOME, **outside the repo — never commit a token**; the script only reads the file path. If `~/.cf_analytics_token` is missing, ask the user to create the token (My Profile → API Tokens → Create Token) and save it there, or set `CLOUDFLARE_API_TOKEN`.

**Run:**
```
python scripts/cf_usage.py
```
Reports month-to-date (UTC) vs free tiers:
- R2 storage (peak objects + GB) — free 10 GB-month, then $0.015/GB-mo
- R2 Class A ops (writes/lists) — free 1,000,000/mo; Class B (reads) — free 10,000,000/mo
- Workers requests (per worker + total) — 10,000,000/mo included
- D1 rows read (free 25B) / written (free 50M)

Note: R2 storage is a point-in-time gauge — the script takes the **peak** across the period's buckets (the latest bucket is often empty). Free-tier op/request meters reset on the **calendar month (UTC)**; the $5 subscription bills on the signup anniversary.

Baseline seen 2026-06 (whole account, many workers share it): R2 ~1.5 GB / 1,555 objects (~15%), R2 ops <0.3%, Workers ~185k/10M (~1.9%), D1 written ~1.1%. **Nowhere near limits.** The only meter that scales with sprite generation is R2 storage at **~0.9 MB/sprite** (so ~11k sprites ≈ 10 GB). Real cost driver is OpenAI image gen, not Cloudflare.

## 2. Resource config + D1 queries → Cloudflare MCP

The "claude.ai Cloudflare Developer Platform" MCP gives resource CRUD + a D1 query tool, but **no billing/analytics**. Tools are deferred — load schemas with ToolSearch (e.g. `select:mcp__claude_ai_Cloudflare_Developer_Platform__d1_database_query`).

**Auth reminder:** if MCP tools return "unauthorized", ask the user to run **`/mcp`** and select **"claude.ai Cloudflare Developer Platform"** to sign in via browser, then retry. (The tool names appear in `<system-reminder>` deferred-tools lists once connected.)

Useful tools:
- `d1_database_query` — run SQL against prod D1 (pass `database_id` = the id above). Good for exact counts that aren't in analytics, e.g. R2 object count: `SELECT COUNT(*) FROM sprite_assets WHERE r2_key IS NOT NULL AND status='ready'`. sprite_assets has no byte-size column; estimate storage as count × ~0.9 MB, or use the script for real GB.
- `r2_bucket_get` / `r2_buckets_list` — bucket config only (no size/usage — returns 0; use the script for real storage).
- `d1_database_get` — returns `file_size` (D1 storage in bytes) and `num_tables` — this IS real (~90 MB seen).
- `workers_list` / `workers_get_worker[_code]` — worker config/code.

## Quick sanity checks without either tool
- `npx wrangler whoami` — account id + token scopes.
- `npx wrangler r2 bucket info inat-battler-assets` — note: object_count/size often report **0** (metrics lag); don't trust it, use the script.
- Asset cache: `/api/assets/*` already serves `Cache-Control: public, max-age=31536000, immutable`, so repeat sprite views hit Cloudflare's CDN, keeping R2 Class B reads low.
