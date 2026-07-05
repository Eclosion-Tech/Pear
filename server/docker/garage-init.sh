#!/bin/sh
# One-shot Garage provisioner (runs in an alpine sidecar; busybox wget only —
# no curl/jq). Idempotent: safe on every `docker compose up`.
#
# Steps, all via the Garage admin API (compose-network-internal, port 3903):
#   1. layout: assign the single node full capacity, apply
#   2. bucket: create $S3_BUCKET
#   3. key: import $S3_ACCESS_KEY/$S3_SECRET_KEY (so web/worker S3_* env works
#      unchanged) and grant read+write+owner on the bucket
set -eu

ADMIN="http://garage:3903"
AUTH="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"
BUCKET="${S3_BUCKET:-pear-attachments}"
ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

get() { wget -q -O- --header "$AUTH" "$ADMIN$1"; }
post() { wget -q -O- --header "$AUTH" --header 'Content-Type: application/json' --post-data "$2" "$ADMIN$1"; }
# Like post, but tolerate failures (used where "already exists" is expected).
post_ok() { post "$1" "$2" 2>/dev/null || true; }

echo "garage-init: waiting for the admin API..."
i=0
until get /v2/GetClusterStatus >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && echo "garage-init: admin API not reachable" && exit 1
  sleep 1
done

# Responses are pretty-printed; strip whitespace so sed patterns are stable.
STATUS="$(get /v2/GetClusterStatus | tr -d ' \n\t')"

# 1. Layout — only if the node has no role yet.
NODE_ID="$(printf '%s' "$STATUS" | sed -n 's/.*"id":"\([0-9a-f]\{16,\}\)".*/\1/p' | head -1)"
[ -n "$NODE_ID" ] || { echo "garage-init: could not parse node id"; exit 1; }

if printf '%s' "$STATUS" | grep -q '"role":null'; then
  LAYOUT_VERSION="$(printf '%s' "$STATUS" | sed -n 's/.*"layoutVersion":\([0-9]*\).*/\1/p' | head -1)"
  echo "garage-init: assigning layout to node $NODE_ID"
  post /v2/UpdateClusterLayout "{\"roles\":[{\"id\":\"$NODE_ID\",\"zone\":\"dc1\",\"capacity\":1000000000,\"tags\":[]}]}" >/dev/null
  post /v2/ApplyClusterLayout "{\"version\":$((LAYOUT_VERSION + 1))}" >/dev/null
  echo "garage-init: layout applied"
fi

# 2. Bucket — create if the alias is unknown.
if ! get "/v2/GetBucketInfo?globalAlias=$BUCKET" >/dev/null 2>&1; then
  echo "garage-init: creating bucket $BUCKET"
  post /v2/CreateBucket "{\"globalAlias\":\"$BUCKET\"}" >/dev/null
fi
BUCKET_ID="$(get "/v2/GetBucketInfo?globalAlias=$BUCKET" | tr -d ' \n\t' | sed -n 's/.*"id":"\([0-9a-f]\{16,\}\)".*/\1/p' | head -1)"
[ -n "$BUCKET_ID" ] || { echo "garage-init: could not resolve bucket id"; exit 1; }

# 3. Key — import the compose-provided credentials (already-imported → no-op),
#    then (idempotently) grant full access on the bucket.
if ! get "/v2/GetKeyInfo?id=$ACCESS_KEY" >/dev/null 2>&1; then
  echo "garage-init: importing S3 key $ACCESS_KEY"
  post /v2/ImportKey "{\"accessKeyId\":\"$ACCESS_KEY\",\"secretAccessKey\":\"$SECRET_KEY\",\"name\":\"pear\"}" >/dev/null
fi
post_ok /v2/AllowBucketKey "{\"bucketId\":\"$BUCKET_ID\",\"accessKeyId\":\"$ACCESS_KEY\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null

echo "garage-init: ready (bucket: $BUCKET)"
