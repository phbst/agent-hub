#!/bin/sh
set -eu
: "${SUPABASE_URL:?}"
: "${SUPABASE_ANON_KEY:?}"
: "${AGENT_EMAIL:?}"
: "${AGENT_PASSWORD:?}"
TOKEN=$(curl -fsS "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H 'content-type: application/json' \
  --data "{\"email\":\"$AGENT_EMAIL\",\"password\":\"$AGENT_PASSWORD\"}" | jq -r .access_token)
curl -fsS "$SUPABASE_URL/rest/v1/rpc/agent_heartbeat" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "authorization: Bearer $TOKEN" -X POST -H 'content-type: application/json' -d '{}'
