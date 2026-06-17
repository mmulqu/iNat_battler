#!/usr/bin/env python3
"""Report Cloudflare usage (month-to-date, UTC) vs free-tier limits for this
account: R2 storage + operations, Workers requests, D1 queries.

Auth: Cloudflare's GraphQL Analytics API needs an API token with
"Account Analytics: Read" (the wrangler OAuth token does NOT work — it has no
analytics scope). Create one at:
  Cloudflare dashboard -> My Profile -> API Tokens -> Create Token
  -> "Read analytics and logs" template (or custom: Account > Account Analytics: Read)

Provide the token via either:
  - env var CLOUDFLARE_API_TOKEN, or
  - a file ~/.cf_analytics_token containing only the token (kept out of git/chat).

Usage:  python scripts/cf_usage.py
"""
import json, os, sys, urllib.request, urllib.error, datetime

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "b092f621d0a33973ebb97c64ef0d1c86")
GIB = 1024 ** 3

# R2 operation classes (Cloudflare billing). Anything unmapped -> "other".
CLASS_A = {
    "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
    "UploadPart", "UploadPartCopy", "ListObjects", "ListBuckets",
    "ListMultipartUploads", "ListParts", "PutBucketEncryption", "PutBucket",
    "PutBucketCors", "PutBucketLifecycleConfiguration", "LifecycleStorageTierTransition",
}
CLASS_B = {
    "GetObject", "HeadObject", "HeadBucket", "UsageSummary", "GetBucketEncryption",
    "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration",
}


def get_token():
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if tok:
        return tok.strip()
    path = os.path.expanduser("~/.cf_analytics_token")
    if os.path.exists(path):
        return open(path, encoding="utf-8").read().strip()
    sys.exit("No token. Set CLOUDFLARE_API_TOKEN or write it to ~/.cf_analytics_token "
             "(needs Account Analytics: Read).")


def query(token, gql, variables):
    body = json.dumps({"query": gql, "variables": variables}).encode()
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql", data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:800]}")
    if resp.get("errors"):
        sys.exit("GraphQL errors: " + json.dumps(resp["errors"], indent=2))
    return resp["data"]["viewer"]["accounts"][0]


def pct(used, limit):
    return f"{(used / limit * 100):.2f}%" if limit else "n/a"


def main():
    token = get_token()
    now = datetime.datetime.utcnow()
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    v = {
        "a": ACCOUNT_ID,
        "sDT": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "eDT": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sD": start.strftime("%Y-%m-%d"),
        "eD": now.strftime("%Y-%m-%d"),
    }
    gql = """
    query($a:String!,$sDT:Time!,$eDT:Time!,$sD:Date!,$eD:Date!){
     viewer{ accounts(filter:{accountTag:$a}){
      r2storage: r2StorageAdaptiveGroups(limit:10000, filter:{datetime_geq:$sDT,datetime_leq:$eDT}){
        max{ objectCount payloadSize metadataSize } dimensions{ datetime } }
      r2ops: r2OperationsAdaptiveGroups(limit:100, filter:{datetime_geq:$sDT,datetime_leq:$eDT}){
        sum{ requests } dimensions{ actionType } }
      workers: workersInvocationsAdaptive(limit:100, filter:{datetime_geq:$sDT,datetime_leq:$eDT}){
        sum{ requests errors subrequests } dimensions{ scriptName } }
      d1: d1AnalyticsAdaptiveGroups(limit:100, filter:{date_geq:$sD,date_leq:$eD}){
        sum{ readQueries writeQueries } dimensions{ databaseId } }
     }}}
    """
    acct = query(token, gql, v)

    print(f"Cloudflare usage  account={ACCOUNT_ID}")
    print(f"Period (month-to-date, UTC): {v['sDT']} -> {v['eDT']}\n")

    # R2 storage: take the peak across the period's time buckets (storage is a
    # point-in-time gauge; the latest bucket can be empty/incomplete).
    st = acct.get("r2storage") or []
    max_objs = max((r["max"].get("objectCount", 0) for r in st), default=0)
    max_bytes = max((r["max"].get("payloadSize", 0) + r["max"].get("metadataSize", 0) for r in st), default=0)
    stored = max_bytes / GIB
    print("R2 STORAGE (peak this period)")
    print(f"  objects: {max_objs:,}")
    print(f"  size:    {stored:.2f} GB / 10 GB free   ({pct(stored, 10)})")
    print(f"  overage: ${max(0, stored - 10) * 0.015:.3f}/mo (over 10 GB @ $0.015/GB-mo)\n")

    # R2 operations -> class A/B
    a = b = other = 0
    breakdown = {}
    for row in acct.get("r2ops") or []:
        n = row["sum"]["requests"]; at = row["dimensions"]["actionType"]
        breakdown[at] = breakdown.get(at, 0) + n
        if at in CLASS_A: a += n
        elif at in CLASS_B: b += n
        else: other += n
    print("R2 OPERATIONS (month-to-date)")
    print(f"  Class A (writes/lists): {a:,} / 1,000,000 free   ({pct(a, 1_000_000)})")
    print(f"  Class B (reads):        {b:,} / 10,000,000 free  ({pct(b, 10_000_000)})")
    if other:
        print(f"  unclassified:           {other:,}")
    for at, n in sorted(breakdown.items(), key=lambda kv: -kv[1])[:8]:
        print(f"      {at}: {n:,}")
    print()

    # Workers
    print("WORKERS REQUESTS (month-to-date)")
    treq = 0
    for row in acct.get("workers") or []:
        s = row["sum"]
        treq += s.get("requests", 0)
        print(f"  {row['dimensions']['scriptName']}: {s.get('requests',0):,} requests, "
              f"{s.get('subrequests',0):,} subrequests, {s.get('errors',0):,} errors")
    print(f"  total: {treq:,} / 10,000,000 included   ({pct(treq, 10_000_000)})\n")

    # D1
    print("D1 QUERIES (month-to-date)")
    rq = wq = 0
    for row in acct.get("d1") or []:
        s = row["sum"]; rq += s.get("readQueries", 0); wq += s.get("writeQueries", 0)
    print(f"  rows read:    {rq:,} / 25,000,000,000 free  ({pct(rq, 25_000_000_000)})")
    print(f"  rows written: {wq:,} / 50,000,000 free      ({pct(wq, 50_000_000)})")


if __name__ == "__main__":
    main()
