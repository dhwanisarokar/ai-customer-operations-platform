#!/usr/bin/env bash
# Production smoke test of an ALREADY BUILT application (run `npm run build` first). It starts the real server twice:
#   1. with an incomplete production configuration: it must EXIT (never listen) and name only variable names;
#   2. with a complete (placeholder) configuration: it must serve, with the security headers the application promises.
# It uses only the values given in the environment below and never prints them. It talks to NO external service: the
# keys are non-functional placeholders and the database / Redis are whatever DATABASE_URL / REDIS_URL point at (in CI: the
# disposable service containers). Usage: DATABASE_URL=... REDIS_URL=... [PORT=3100] bash scripts/smoke-production.sh
set -euo pipefail

PORT="${PORT:-3100}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp)"
SERVER_PID=""
fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }
# `npx` starts the real server as a child process: stop the child too, or it keeps the port.
cleanup() { [ -n "$SERVER_PID" ] && { pkill -P "$SERVER_PID" 2>/dev/null || true; kill "$SERVER_PID" 2>/dev/null || true; }; rm -f "$LOG"; }
trap cleanup EXIT

: "${DATABASE_URL:?DATABASE_URL must point at a disposable database}"
: "${REDIS_URL:?REDIS_URL must point at a disposable Redis}"

# The application is started for real against these services, so refuse anything that is not clearly local: this script is
# for disposable databases (CI service containers, a scratch container), never a shared or production one. Set
# SMOKE_ALLOW_NONLOCAL=1 only for a remote service that is also disposable.
host_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/]+).*#\2#'; }
for url in "$DATABASE_URL" "$REDIS_URL"; do
  case "$(host_of "$url")" in
    localhost|127.0.0.1) ;;
    *) [ "${SMOKE_ALLOW_NONLOCAL:-}" = "1" ] || fail "a service URL points at a non-local host (set SMOKE_ALLOW_NONLOCAL=1 only for a disposable remote service)";;
  esac
done

# A publishable-key-shaped placeholder (the Frontend API host is encoded in the key); not a credential.
PK="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-pk_live_$(printf 'clerk.example.test$' | base64 | tr -d '\n=')}"

echo "== 1. incomplete production configuration must stop the web process"
set +e
env -u REDIS_URL -u CLERK_SECRET_KEY -u NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY -u GEMINI_API_KEY NODE_ENV=production DATABASE_URL="$DATABASE_URL" timeout 60 npx next start -p "$PORT" >"$LOG" 2>&1
STATUS=$?
set -e
[ "$STATUS" -ne 0 ] || fail "the server kept running with an incomplete configuration"
[ "$STATUS" -ne 124 ] || fail "the server did not exit (timeout) with an incomplete configuration"
grep -q "missing required variables" "$LOG" || fail "the error does not say which variables are missing"
for name in REDIS_URL CLERK_SECRET_KEY NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY GEMINI_API_KEY; do
  grep -q "$name" "$LOG" || fail "the error does not name $name"
done
if grep -qF "$DATABASE_URL" "$LOG"; then fail "an error leaked a configuration value"; fi
echo "   ok (exit $STATUS, names only)"

echo "== 2. complete configuration serves, with the promised headers"
env NODE_ENV=production DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
  CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-sk_live_placeholder_not_a_real_key}" NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$PK" \
  GEMINI_API_KEY="placeholder-not-a-real-key" npx next start -p "$PORT" >"$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$BASE/api/health" && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$LOG" >&2; fail "the server exited"; }
  sleep 1
done
curl -sf -o /dev/null "$BASE/api/health" || fail "/api/health did not become healthy"

headers() { curl -s -o /dev/null -D - "$BASE$1" | tr -d '\r'; }
header() { headers "$1" | grep -i "^$2:" | head -1 || true; }

# Safe everywhere.
for path in /api/health /widget/wk_smoke_0123456789 /widget.js; do
  header "$path" "x-content-type-options" | grep -qi nosniff || fail "$path: missing X-Content-Type-Options"
  header "$path" "referrer-policy" | grep -qi "strict-origin-when-cross-origin" || fail "$path: missing Referrer-Policy"
  header "$path" "strict-transport-security" | grep -qi "max-age=" || fail "$path: missing HSTS"
done

# The app can never be framed; the widget page can (it exists to be embedded).
header /api/health "x-frame-options" | grep -qi deny || fail "/api/health: not frame-protected"
header /api/health "content-security-policy" | grep -q "frame-ancestors 'none'" || fail "/api/health: CSP lacks frame-ancestors 'none'"
[ -z "$(header /widget/wk_smoke_0123456789 x-frame-options)" ] || fail "the widget page must not send X-Frame-Options (it is embedded)"
WIDGET_CSP="$(header /widget/wk_smoke_0123456789 content-security-policy)"
[ -n "$WIDGET_CSP" ] || fail "the widget page has no Content-Security-Policy"
echo "$WIDGET_CSP" | grep -q "frame-ancestors" && fail "the widget CSP must not restrict framing"
echo "$WIDGET_CSP" | grep -q "'nonce-" || fail "the widget CSP has no nonce"
echo "$WIDGET_CSP" | grep -Eq "script-src[^;]*('unsafe-inline'|\*|https?:)" && fail "the widget script-src is too permissive"

# A nonce is per request.
N1="$(header /widget/wk_smoke_0123456789 content-security-policy | grep -o "nonce-[A-Za-z0-9+/=]*" | head -1)"
N2="$(header /widget/wk_smoke_0123456789 content-security-policy | grep -o "nonce-[A-Za-z0-9+/=]*" | head -1)"
[ -n "$N1" ] && [ "$N1" != "$N2" ] || fail "the CSP nonce is not unique per request"

# Health: the web tier is healthy; the background tier is reported separately (no worker runs here: it must say so).
BG="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health/background")"
[ "$BG" = "503" ] || fail "/api/health/background should report 503 while no worker runs (got $BG)"

echo "SMOKE OK"
