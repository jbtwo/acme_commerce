#!/usr/bin/env bash
#
# Acme Commerce — command-line smoke test.
#
# Exercises every Milestone 1 endpoint over a real HTTP socket, plus every documented failure
# case, and asserts the status code and error code of each. This is the "does it actually work
# from outside the process" check that fastify.inject() cannot give you: it goes through the
# kernel, a real TCP connection, and real HTTP parsing.
#
#   Usage:  npm run smoke
#           BASE_URL=http://192.168.1.50:3000 npm run smoke
#
#   Requires: curl, python3 (for JSON extraction). No Postman, no Newman — by design.
#             Backend verification must not depend on the artifacts you are about to build.
#
# Exits 0 when every assertion passes, 1 otherwise.
#
# Note: this script creates catalog records and then archives them. Because DELETE archives
# rather than destroys, repeated runs leave archived "SMOKE TEST" products behind. That is the
# archive semantics working as documented, not a leak. `npm run db:reset` clears them.

set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API="${BASE_URL}/api/v1"
RUN_ID="$(date +%s)"

PASS=0
FAIL=0
FAILURES=()

bold=$(printf '\033[1m'); green=$(printf '\033[32m'); red=$(printf '\033[31m')
dim=$(printf '\033[2m'); reset=$(printf '\033[0m')

section() { printf '\n%s%s%s\n' "$bold" "$1" "$reset"; }

# Extract a dotted path from JSON on stdin. Prints an empty string when absent.
jget() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
for part in sys.argv[1].split("."):
    if part == "":
        continue
    try:
        d = d[int(part)] if part.lstrip("-").isdigit() else d[part]
    except Exception:
        print(""); sys.exit(0)
print(d if not isinstance(d, (dict, list)) else json.dumps(d))
' "$1"
}

LAST_STATUS=""
LAST_BODY=""
LAST_HEADERS=""

# request METHOD PATH [BODY] [EXTRA_CURL_ARGS...]
request() {
  local method="$1" path="$2" body="${3:-}"; shift 3 || shift 2
  local tmp_headers; tmp_headers="$(mktemp)"
  local args=(-sS -X "$method" -o /dev/stdout -w '\n%{http_code}' -D "$tmp_headers")
  # Only supply the default Content-Type when the caller has not passed one. curl sends a
  # repeated -H twice rather than replacing it, so without this check the "wrong Content-Type"
  # assertion would send both application/json and text/plain and test nothing.
  local caller_sets_content_type=0
  for a in "$@"; do
    case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in content-type:*) caller_sets_content_type=1 ;; esac
  done
  if [[ -n "$body" ]]; then
    if [[ $caller_sets_content_type -eq 0 ]]; then args+=(-H 'Content-Type: application/json'); fi
    args+=(--data-binary "$body")
  fi
  args+=("$@")
  local out; out="$(curl "${args[@]}" "${path}" 2>&1)"
  LAST_STATUS="${out##*$'\n'}"
  LAST_BODY="${out%$'\n'*}"
  LAST_HEADERS="$(cat "$tmp_headers")"
  rm -f "$tmp_headers"
}

ok()   { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$1"); printf '  %s✗%s %s\n     %s%s%s\n' "$red" "$reset" "$1" "$dim" "$2" "$reset"; }

# expect_status DESCRIPTION EXPECTED
expect_status() {
  if [[ "$LAST_STATUS" == "$2" ]]; then ok "$1 → $2"
  else bad "$1 → expected $2" "got $LAST_STATUS; body: $(printf '%s' "$LAST_BODY" | head -c 300)"; fi
}

# expect_error_code DESCRIPTION EXPECTED_STATUS EXPECTED_CODE
expect_error_code() {
  local actual_code; actual_code="$(printf '%s' "$LAST_BODY" | jget 'error.code')"
  local rid; rid="$(printf '%s' "$LAST_BODY" | jget 'error.request_id')"
  if [[ "$LAST_STATUS" == "$2" && "$actual_code" == "$3" ]]; then
    if [[ -n "$rid" ]]; then ok "$1 → $2 $3 (request_id present)"
    else bad "$1 → $2 $3" "error.request_id is missing from the error body"; fi
  else
    bad "$1 → expected $2 $3" "got $LAST_STATUS $actual_code; body: $(printf '%s' "$LAST_BODY" | head -c 300)"
  fi
}

# expect_field DESCRIPTION JSON_PATH EXPECTED_VALUE
expect_field() {
  local actual; actual="$(printf '%s' "$LAST_BODY" | jget "$2")"
  if [[ "$actual" == "$3" ]]; then ok "$1 ($2 = $3)"
  else bad "$1 (expected $2 = $3)" "got '$actual'"; fi
}

# expect_header DESCRIPTION HEADER_NAME_LOWER
expect_header_present() {
  if printf '%s' "$LAST_HEADERS" | tr 'A-Z' 'a-z' | grep -q "^$2:"; then ok "$1"
  else bad "$1" "header '$2' absent from: $(printf '%s' "$LAST_HEADERS" | tr '\n' ' ' | head -c 200)"; fi
}

header_value() { printf '%s' "$LAST_HEADERS" | tr -d '\r' | awk -v k="$1" 'BEGIN{IGNORECASE=1} tolower($1)==tolower(k)":" {print $2}'; }

printf '%sAcme Commerce smoke test%s\n' "$bold" "$reset"
printf '%sBase URL: %s   run id: %s%s\n' "$dim" "$BASE_URL" "$RUN_ID" "$reset"

# ===========================================================================
section '1. Platform endpoints'
# ===========================================================================
request GET "${BASE_URL}/health"
expect_status 'GET /health' 200
expect_field 'health reports ok' 'status' 'ok'
expect_header_present 'health response carries X-Request-Id' 'x-request-id'

request GET "${BASE_URL}/ready"
expect_status 'GET /ready' 200
expect_field 'readiness overall' 'status' 'ready'
expect_field 'readiness database check' 'checks.database.status' 'ok'
expect_field 'readiness migration check' 'checks.migrations.status' 'ok'

request GET "${BASE_URL}/openapi.json"
expect_status 'GET /openapi.json' 200
expect_field 'openapi version' 'openapi' '3.1.0'
expect_field 'openapi title' 'info.title' 'Acme Commerce API'

request GET "${BASE_URL}/docs/"
expect_status 'GET /docs/ (Swagger UI)' 200

# ===========================================================================
section '2. Request correlation'
# ===========================================================================
request GET "${BASE_URL}/health" '' -H 'X-Request-Id: smoke-test-correlation-42'
echoed="$(header_value 'x-request-id')"
if [[ "$echoed" == 'smoke-test-correlation-42' ]]; then ok 'caller-supplied X-Request-Id is echoed back'
else bad 'caller-supplied X-Request-Id is echoed back' "got '$echoed'"; fi

request GET "${BASE_URL}/health" '' -H 'X-Request-Id: has spaces and ünicode'
echoed="$(header_value 'x-request-id')"
if [[ "$echoed" =~ ^req_[0-9a-f]{24}$ ]]; then ok 'invalid X-Request-Id is replaced with a generated one'
else bad 'invalid X-Request-Id is replaced' "got '$echoed'"; fi

# ===========================================================================
section '3. Catalog reads: pagination, filtering, search, sorting'
# ===========================================================================
request GET "${API}/products"
expect_status 'GET /products' 200
expect_field 'default page' 'pagination.page' '1'
expect_field 'default limit is 25' 'pagination.limit' '25'
SEEDED_TOTAL="$(printf '%s' "$LAST_BODY" | jget 'pagination.total')"

request GET "${API}/products?limit=5&page=2"
expect_status 'GET /products?limit=5&page=2' 200
expect_field 'page 2 honoured' 'pagination.page' '2'
expect_field 'limit 5 honoured' 'pagination.limit' '5'
returned="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["data"]))')"
if [[ "$returned" == '5' ]]; then ok 'page 2 returns exactly 5 records'
else bad 'page 2 returns exactly 5 records' "got $returned"; fi

request GET "${API}/products?page=9999&limit=25"
expect_status 'GET /products page past the end' 200
returned="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["data"]))')"
if [[ "$returned" == '0' ]]; then ok 'page past the end is 200 with an empty array, not 404'
else bad 'page past the end is empty' "got $returned records"; fi

request GET "${API}/products?status=active"
expect_status 'GET /products?status=active' 200
non_active="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(sum(1 for p in json.load(sys.stdin)["data"] if p["status"]!="active"))')"
if [[ "$non_active" == '0' ]]; then ok 'status filter returns only active products'
else bad 'status filter' "$non_active non-active products leaked through"; fi

request GET "${API}/products?vendor=acme"
expect_status 'GET /products?vendor=acme (case-insensitive)' 200
wrong_vendor="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(sum(1 for p in json.load(sys.stdin)["data"] if (p["vendor"] or "").lower()!="acme"))')"
matched="$(printf '%s' "$LAST_BODY" | jget 'pagination.total')"
if [[ "$wrong_vendor" == '0' && "$matched" -gt 0 ]]; then ok "vendor filter is a case-insensitive exact match ($matched matched)"
else bad 'vendor filter' "wrong_vendor=$wrong_vendor matched=$matched"; fi

request GET "${API}/products?q=backpack"
expect_status 'GET /products?q=backpack' 200
matched="$(printf '%s' "$LAST_BODY" | jget 'pagination.total')"
if [[ "$matched" -gt 0 ]]; then ok "search matched $matched products"
else bad 'search q=backpack' 'matched nothing; seed data may be missing'; fi

request GET "${API}/products?tag=bestseller"
expect_status 'GET /products?tag=bestseller' 200
untagged="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(sum(1 for p in json.load(sys.stdin)["data"] if "bestseller" not in p["tags"]))')"
if [[ "$untagged" == '0' ]]; then ok 'tag filter returns only products carrying the tag'
else bad 'tag filter' "$untagged products lacked the tag"; fi

request GET "${API}/products?q=zzzznotathing"
expect_status 'GET /products with no matches' 200
expect_field 'empty result total is 0' 'pagination.total' '0'
expect_field 'empty result total_pages is 0, not 1' 'pagination.total_pages' '0'

request GET "${API}/products?sort=title&order=asc&limit=100"
expect_status 'GET /products?sort=title&order=asc' 200
sorted_ok="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;t=[p["title"] for p in json.load(sys.stdin)["data"]];print("yes" if t==sorted(t) else "no")')"
if [[ "$sorted_ok" == 'yes' ]]; then ok 'sort=title&order=asc returns titles in ascending order'
else bad 'sort=title&order=asc' 'titles were not ascending'; fi

# Ordering stability: sorting by a heavily-tied column must still page deterministically.
request GET "${API}/products?sort=status&order=asc&limit=7&page=1"
page1="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(",".join(p["id"] for p in json.load(sys.stdin)["data"]))')"
request GET "${API}/products?sort=status&order=asc&limit=7&page=1"
page1_again="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(",".join(p["id"] for p in json.load(sys.stdin)["data"]))')"
request GET "${API}/products?sort=status&order=asc&limit=7&page=2"
page2="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(",".join(p["id"] for p in json.load(sys.stdin)["data"]))')"
overlap="$(python3 -c "
a=set('$page1'.split(',')); b=set('$page2'.split(','))
print(len(a & b))")"
if [[ "$page1" == "$page1_again" && "$overlap" == '0' ]]; then
  ok 'ordering is stable across repeats and pages do not overlap (id tiebreaker works)'
else
  bad 'ordering stability' "repeat-identical=$([[ "$page1" == "$page1_again" ]] && echo yes || echo no) overlap=$overlap"
fi

# ===========================================================================
section '4. Catalog writes'
# ===========================================================================
request POST "${API}/products" "$(cat <<JSON
{
  "title": "SMOKE TEST Riverbend Rain Jacket ${RUN_ID}",
  "description": "Created by scripts/smoke.sh. Safe to archive.",
  "status": "active",
  "vendor": "Acme",
  "product_type": "Apparel",
  "tags": ["waterproof", "smoke-test"]
}
JSON
)"
expect_status 'POST /products' 201
expect_header_present 'POST /products sets a Location header' 'location'
PRODUCT_ID="$(printf '%s' "$LAST_BODY" | jget 'data.id')"
if [[ "$PRODUCT_ID" =~ ^prod_[0-9a-f]{24}$ ]]; then ok "created product id matches the documented format ($PRODUCT_ID)"
else bad 'created product id format' "got '$PRODUCT_ID'"; fi
expect_field 'created product status' 'data.status' 'active'

request POST "${API}/products" '{"title":"SMOKE TEST default status '"${RUN_ID}"'"}'
expect_status 'POST /products with only a title' 201
expect_field 'status defaults to draft' 'data.status' 'draft'
expect_field 'tags default to an empty array' 'data.tags' '[]'
DRAFT_PRODUCT_ID="$(printf '%s' "$LAST_BODY" | jget 'data.id')"

request GET "${API}/products/${PRODUCT_ID}"
expect_status 'GET /products/{id}' 200
expect_field 'retrieved the product just created' 'data.id' "$PRODUCT_ID"

request PATCH "${API}/products/${PRODUCT_ID}" '{"product_type":"Outerwear","tags":["waterproof","smoke-test","patched"]}'
expect_status 'PATCH /products/{id}' 200
expect_field 'patched product_type' 'data.product_type' 'Outerwear'

request PATCH "${API}/products/${PRODUCT_ID}" '{"description":null}'
expect_status 'PATCH with explicit null clears a field' 200
expect_field 'description cleared' 'data.description' 'None'

# ===========================================================================
section '5. Variants'
# ===========================================================================
SKU="SMOKE-${RUN_ID}-BLK"
request POST "${API}/products/${PRODUCT_ID}/variants" "{\"sku\":\"${SKU}\",\"title\":\"Black / Medium\",\"price_cents\":18900,\"compare_at_price_cents\":22900}"
expect_status 'POST /products/{id}/variants' 201
VARIANT_ID="$(printf '%s' "$LAST_BODY" | jget 'data.id')"
expect_field 'variant price stored as integer minor units' 'data.price_cents' '18900'
expect_field 'variant currency defaults to CAD' 'data.currency' 'CAD'
expect_field 'variant position defaults to 1' 'data.position' '1'

request POST "${API}/products/${PRODUCT_ID}/variants" "{\"sku\":\"SMOKE-${RUN_ID}-BLU\",\"title\":\"Blue / Medium\",\"price_cents\":18900}"
expect_status 'POST a second variant' 201
expect_field 'second variant position auto-increments' 'data.position' '2'

request GET "${API}/products/${PRODUCT_ID}/variants"
expect_status 'GET /products/{id}/variants' 200
count="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["data"]))')"
if [[ "$count" == '2' ]]; then ok 'variant sub-collection returns both variants'
else bad 'variant sub-collection' "expected 2, got $count"; fi

request GET "${API}/variants/${VARIANT_ID}"
expect_status 'GET /variants/{id}' 200
expect_field 'variant links back to its product' 'data.product_id' "$PRODUCT_ID"
expect_field 'inventory_item_id is null in Milestone 1' 'data.inventory_item_id' 'None'

request PATCH "${API}/variants/${VARIANT_ID}" '{"price_cents":15900,"compare_at_price_cents":null}'
expect_status 'PATCH /variants/{id}' 200
expect_field 'variant price updated' 'data.price_cents' '15900'
expect_field 'compare_at price cleared with null' 'data.compare_at_price_cents' 'None'

# ===========================================================================
section '6. Archive semantics (DELETE)'
# ===========================================================================
request DELETE "${API}/variants/${VARIANT_ID}"
expect_status 'DELETE /variants/{id}' 200
expect_field 'variant is archived, not destroyed' 'data.status' 'archived'

request DELETE "${API}/variants/${VARIANT_ID}"
expect_status 'DELETE /variants/{id} again is idempotent' 200
expect_field 'repeat archive still reports archived' 'data.status' 'archived'

request GET "${API}/variants/${VARIANT_ID}"
expect_status 'archived variant is still retrievable' 200

request DELETE "${API}/products/${PRODUCT_ID}"
expect_status 'DELETE /products/{id}' 200
expect_field 'product is archived' 'data.status' 'archived'
archived_at="$(printf '%s' "$LAST_BODY" | jget 'data.archived_at')"
if [[ -n "$archived_at" && "$archived_at" != 'None' ]]; then ok 'archived_at is set'
else bad 'archived_at is set' "got '$archived_at'"; fi

request GET "${API}/products/${PRODUCT_ID}/variants"
cascaded="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print(sum(1 for v in d if v["status"]!="archived"))')"
if [[ "$cascaded" == '0' ]]; then ok 'archiving a product cascades to its variants'
else bad 'archive cascade' "$cascaded variants remained active"; fi

request DELETE "${API}/products/${PRODUCT_ID}"
expect_status 'DELETE /products/{id} again is idempotent' 200

request DELETE "${API}/products/${DRAFT_PRODUCT_ID}"
expect_status 'archive the second smoke-test product' 200

# ===========================================================================
section '7. Failure cases — identifiers'
# ===========================================================================
request GET "${API}/products/prod_00000000000000000000dead"
expect_error_code 'unknown product' 404 'PRODUCT_NOT_FOUND'

request GET "${API}/variants/var_00000000000000000000dead"
expect_error_code 'unknown variant' 404 'VARIANT_NOT_FOUND'

request GET "${API}/products/prod_zzz"
expect_error_code 'malformed product identifier' 400 'MALFORMED_ID'

request GET "${API}/products/prod_undefined"
expect_error_code 'malformed identifier (the classic prod_undefined)' 400 'MALFORMED_ID'

request GET "${API}/variants/12345"
expect_error_code 'malformed variant identifier' 400 'MALFORMED_ID'

request GET "${BASE_URL}/api/v1/nonexistent"
expect_error_code 'unknown route' 404 'ROUTE_NOT_FOUND'

# ===========================================================================
section '8. Failure cases — validation'
# ===========================================================================
request POST "${API}/products" '{"vendor":"Acme"}'
expect_error_code 'missing required product field (title)' 400 'VALIDATION_ERROR'
field="$(printf '%s' "$LAST_BODY" | jget 'error.details.fields.0.field')"
if [[ "$field" == 'body.title' ]]; then ok 'validation error names the missing field (body.title)'
else bad 'validation error names the field' "got '$field'"; fi

request POST "${API}/products" '{"title":"X","status":"pending"}'
expect_error_code 'invalid product status' 400 'VALIDATION_ERROR'
allowed="$(printf '%s' "$LAST_BODY" | jget 'error.details.fields.0.allowed')"
if [[ "$allowed" == '["draft", "active", "archived"]' ]]; then ok 'enum error lists the permitted values'
else bad 'enum error lists permitted values' "got '$allowed'"; fi

request POST "${API}/products" '{"title":"X","titel":"typo"}'
expect_error_code 'unknown body property is rejected, not ignored' 400 'VALIDATION_ERROR'

request POST "${API}/products" '{"title":'
expect_error_code 'malformed JSON' 400 'INVALID_JSON'

request PATCH "${API}/products/${PRODUCT_ID}" '{}'
expect_error_code 'empty PATCH body' 400 'VALIDATION_ERROR'

request POST "${API}/products" 'title=X' -H 'Content-Type: text/plain'
expect_error_code 'wrong Content-Type' 415 'UNSUPPORTED_MEDIA_TYPE'

# Variant validation needs a live product to attach to.
request POST "${API}/products" "{\"title\":\"SMOKE TEST variant host ${RUN_ID}\",\"status\":\"active\"}"
HOST_PRODUCT_ID="$(printf '%s' "$LAST_BODY" | jget 'data.id')"

request POST "${API}/products/${HOST_PRODUCT_ID}/variants" '{"title":"No SKU here"}'
expect_error_code 'missing required variant fields (sku, price_cents)' 400 'VALIDATION_ERROR'

request POST "${API}/products/${HOST_PRODUCT_ID}/variants" "{\"sku\":\"SMOKE-NEG-${RUN_ID}\",\"title\":\"Negative\",\"price_cents\":-100}"
expect_error_code 'invalid price (negative)' 400 'VALIDATION_ERROR'

request POST "${API}/products/${HOST_PRODUCT_ID}/variants" "{\"sku\":\"SMOKE-FLOAT-${RUN_ID}\",\"title\":\"Float\",\"price_cents\":19.99}"
expect_error_code 'invalid price (non-integer)' 400 'VALIDATION_ERROR'

request POST "${API}/products/${HOST_PRODUCT_ID}/variants" "{\"sku\":\"SMOKE-STR-${RUN_ID}\",\"title\":\"String price\",\"price_cents\":\"1999\"}"
expect_error_code 'invalid price (string, not coerced in a body)' 400 'VALIDATION_ERROR'

# Duplicate SKU: ACME-BAG-BLK is seeded, so this collides with real data.
request POST "${API}/products/${HOST_PRODUCT_ID}/variants" '{"sku":"ACME-BAG-BLK","title":"Duplicate","price_cents":1000}'
expect_error_code 'duplicate SKU' 409 'SKU_ALREADY_EXISTS'
conflicting="$(printf '%s' "$LAST_BODY" | jget 'error.details.conflicting_variant_id')"
if [[ "$conflicting" =~ ^var_[0-9a-f]{24}$ ]]; then ok 'conflict error names the conflicting variant'
else bad 'conflict names the conflicting variant' "got '$conflicting'"; fi

request POST "${API}/products/prod_00000000000000000000dead/variants" '{"sku":"SMOKE-ORPHAN","title":"Orphan","price_cents":100}'
expect_error_code 'variant on an unknown product' 404 'PRODUCT_NOT_FOUND'

request DELETE "${API}/products/${HOST_PRODUCT_ID}" >/dev/null 2>&1

# ===========================================================================
section '9. Failure cases — query parameters'
# ===========================================================================
request GET "${API}/products?page=0"
expect_error_code 'invalid pagination (page=0)' 400 'VALIDATION_ERROR'

request GET "${API}/products?limit=500"
expect_error_code 'invalid pagination (limit above maximum)' 400 'VALIDATION_ERROR'

request GET "${API}/products?limit=abc"
expect_error_code 'invalid pagination (non-numeric limit)' 400 'VALIDATION_ERROR'

request GET "${API}/products?sort=password"
expect_error_code 'invalid sort field' 400 'VALIDATION_ERROR'
allowed="$(printf '%s' "$LAST_BODY" | jget 'error.details.fields.0.allowed')"
if [[ "$allowed" == *'created_at'* ]]; then ok 'sort error lists the allowlisted fields'
else bad 'sort error lists allowed fields' "got '$allowed'"; fi

request GET "${API}/products?order=sideways"
expect_error_code 'invalid sort order' 400 'VALIDATION_ERROR'

request GET "${API}/products?status=nonsense"
expect_error_code 'invalid status filter' 400 'VALIDATION_ERROR'

request GET "${API}/products?statuss=active"
expect_error_code 'unknown query parameter is rejected, not ignored' 400 'VALIDATION_ERROR'

# ===========================================================================
section 'Summary'
# ===========================================================================
printf '\n  %s%d passed%s, %s%d failed%s   (seeded catalog reported %s products)\n' \
  "$green" "$PASS" "$reset" "$([[ $FAIL -eq 0 ]] && printf '%s' "$dim" || printf '%s' "$red")" "$FAIL" "$reset" "${SEEDED_TOTAL:-?}"

if [[ $FAIL -gt 0 ]]; then
  printf '\n%sFailed assertions:%s\n' "$red" "$reset"
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
printf '\n%sAll smoke assertions passed.%s\n' "$green" "$reset"
