# Runbook

## 1) Start Locally

```
npm install
npm run dev
```

Server listens on `http://0.0.0.0:3000` by default.

Health check:

```
curl http://localhost:3000/health
```

## 2) ServiceM8 OAuth (Local)

**Error -102 (connection refused)?** The callback must reach your server. Ensure:
1. Server is running before you start OAuth
2. Use the same computer and browser for the whole flow (not phone/tablet)
3. Or use ngrok for remote testing (see below)

### Step-by-step OAuth flow

1. **Start the server** (leave it running):
   ```
   npm run dev
   ```

2. **Verify server is reachable** (optional but recommended):
   ```
   npm run oauth:check
   ```
   This fails if the server isn't running, preventing Error -102.

3. **Set `.env`**:
   ```
   BASE_URL=http://localhost:3000
   ```
   Restart the server after changing `.env`.

4. **Start OAuth** — open in the **same browser on this computer**:
   ```
   http://localhost:3000/auth/servicem8/start
   ```
   Do NOT open this link on a phone or another machine — `localhost` won't reach your dev server.

5. **Complete ServiceM8 login** — approve all permissions. You'll be redirected back to the callback.

6. **ServiceM8 Developer add-on**: Add `http://localhost:3000/auth/servicem8/callback` to allowed redirect URIs if required.

### OAuth via ngrok (for phone or remote testing)

Use ngrok when the OAuth flow runs in a browser on a different device than the server:

1. Install ngrok: https://ngrok.com/download

2. In one terminal, start the tunnel:
   ```
   npm run oauth:tunnel
   ```
   (or `ngrok http 3000` if ngrok is installed globally)

3. Copy the HTTPS URL (e.g. `https://abc123.ngrok-free.app`).

4. Set in `.env`:
   ```
   BASE_URL=https://abc123.ngrok-free.app
   ```

5. Restart the server (`npm run dev`).

6. In ServiceM8 add-on settings, add:
   ```
   https://abc123.ngrok-free.app/auth/servicem8/callback
   ```

7. Open `https://abc123.ngrok-free.app/auth/servicem8/start` in any browser (including phone).

### OAuth 402 (Payment Required)

If the vendor lookup returns **402 Payment Required**, ServiceM8 is restricting vendor API access:

- **Trial accounts** often have limited API access
- **Paid ServiceM8 subscription** may be required for the vendor endpoint
- **Actions**: Upgrade the connected ServiceM8 account to a paid plan, use an account with an active subscription, or contact ServiceM8 support (support@servicem8.com)

## 3) Required Env Vars

Required:
- `VAPI_BEARER_TOKEN`
- `SERVICEM8_APP_ID`
- `SERVICEM8_APP_SECRET`
- `DATABASE_URL`

Optional (recommended):
- `SERVICEM8_VENDOR_UUID`
- `SERVICEM8_QUEUE_UUID`
- `SERVICEM8_CATEGORY_UUID`
- `SERVICEM8_STAFF_UUID`
- `DEFAULT_STAFF_UUID`
- `BUSINESS_TZ`
- `CRON_TOKEN`
- `DEBUG_KEY`
- `GIT_SHA`
- `BUILD_TIME`

For local OAuth: `BASE_URL=http://localhost:3000`

### Risk enrichment + tradie decision (optional)

These are all optional and feature-flagged:

- `DISTANCE_ENABLED=false` (set `true` to enable maps distance checks)
- `SMS_ENABLED=false` (set `true` to enable tradie decision SMS)
- `RISK_ENRICH_DRY_RUN=false` (set `true` to log only, no outbound note/SMS side effects)
- `MAPS_PROVIDER=google`
- `GOOGLE_MAPS_API_KEY=...`
- `BUSINESS_BASE_ADDRESS=...`
- `DISTANCE_MEDIUM_KM=10`
- `DISTANCE_FAR_KM=25`
- `SMALL_JOB_KEYWORDS=bulb,light,globe,powerpoint,switch,replace,swap,quick,small job`

Google Maps key steps:

1. In Google Cloud Console, enable:
   - Geocoding API
   - Distance Matrix API
   - Directions API
2. Create an API key and restrict it to those APIs.
3. Put the key in `GOOGLE_MAPS_API_KEY`.

### Scheduling V2 (optional)

Phase 1 feature flag (capacity-based AM/PM staff scheduling):

- `SCHEDULING_V2=false` (set `true` to enable new engine)
- `SCHEDULING_V2_MAX_JOBS_PER_WINDOW=2`
- `SCHEDULING_V2_DEFAULT_DURATION_MINUTES=120`
- `SCHEDULING_V2_BUFFER_RATIO=0.2`

Behavior when enabled:

- booking allocation includes `staff_uuid`, `allocation_date`, `start_time`, `end_time`, `allocation_window_uuid`
- capacity checks run per staff per window
- internal start/end slots are auto-assigned inside AM/PM windows

### Profit flagging (optional, non-blocking)

Phase 2 feature flag:

- `FEATURE_PROFIT_FLAGGING=false` (set `true` to enable)
- `DISPATCHER_MOBILE=...` (optional; receives low-margin alerts)

Optional financial overrides:

- `FIN_MINIMUM_CALLOUT=180`
- `FIN_INCLUDED_MINUTES=30`
- `FIN_HOURLY_RATE=100`
- `FIN_INTERNAL_COST_RATE=55`
- `FIN_OVERHEAD_PER_JOB=30`
- `FIN_REGRET_MARGIN_THRESHOLD=15`
- `FIN_HEALTHY_MARGIN_THRESHOLD=20`

Behavior:

- adds a structured "NOYAKKA PROFIT INSIGHT" note on AI-booked jobs
- can send dispatcher alert for low-margin estimates
- never blocks booking, never declines job, never changes approval flow

### Vapi system prompt booking rules (required)

Add this to your assistant system prompt:

- Always use `getAvailability` first and read `options[]`.
- Always present `option.label` values to the customer (full day names, no abbreviations).
- When customer chooses a slot, map that choice to `options[]` and pass `selected_code` exactly from `getAvailability.options[].code`.
- Never invent codes from day/window text.
- If booking fails with `INVALID_SELECTED_CODE`, call `getAvailability` again and re-offer returned options.
- Do not send booked confirmation wording until `bookWindow` returns `ok: true`.

### Smart overrun protection (optional, non-blocking)

Feature flags:

- `OVERRUN_PROTECTION_ENABLED=false` (set `true` to enable SOP monitor)
- `OVERRUN_GRACE_MINUTES=15` (overrun threshold buffer)
- `OVERRUN_MAJOR_DELAY_MINUTES=90` (dispatcher escalation threshold)
- `DISPATCHER_MOBILE=...` (optional; receives major delay alerts)

Behavior when enabled:

- every 15 minutes, monitor checks active allocations against estimated end time
- if overrun is detected, calculates delay impact and notifies the next customer with updated ETA
- sends one delay SMS max per target allocation and one 30-minute-away SMS max per target allocation
- escalates delays above threshold to dispatcher via SMS
- never edits/moves ServiceM8 allocations; ETA communication only

Manual trigger endpoint:

- `POST /internal/cron/overrun-monitor` with header `x-cron-token: $CRON_TOKEN`

### API key mode (skip OAuth, no 402)

If OAuth returns 402, use an API key instead (single-tenant):

1. In ServiceM8: **Settings → API Keys** → Create key.
2. Add to `.env`:
   ```
   SERVICEM8_API_KEY=smk-xxx-xxx
   ```
3. `SERVICEM8_VENDOR_UUID` is optional — it will be fetched from vendor.json at startup if omitted.
4. Restart the server. OAuth is not needed.

## 4) Smoke Tests

Local smoke (starts server if needed, hits `/health` and `/vapi/ping`):

```
VAPI_BEARER_TOKEN=... npm run local:smoke
```

Contract tests (parsing/validation only):

```
VAPI_BEARER_TOKEN=... npm run vapi:contract-tests
```

Booking smoke (ServiceM8 calls, opt-in):

```
ENABLE_SERVICEM8_SMOKE=true \
VAPI_BEARER_TOKEN=... \
SERVICEM8_VENDOR_UUID=... \
TEST_JOB_UUID=... \
npm run vapi:booking-smoke
```

Dry-run booking validation (no ServiceM8 calls):

```
VAPI_BEARER_TOKEN=... npm run vapi:booking-smoke
```

Expected output:
- `PASS dry-run booking validation`
- or `PASS booked allocation_uuid=... job_uuid=... sms_sent=false`

## 5) Debug Allocation Failures

Check last Vapi tool calls:

```
curl -H "X-DEBUG-KEY: <DEBUG_KEY>" http://localhost:3000/debug/last-vapi-calls
```

Check last booking allocation failures:

```
curl -H "X-DEBUG-KEY: <DEBUG_KEY>" http://localhost:3000/debug/last-booking-errors
```

Check last availability failures (why no windows):

```
curl -H "X-DEBUG-KEY: <DEBUG_KEY>" http://localhost:3000/debug/last-availability-errors
```

## 6) Allocation Failure Clues

Common error codes:
- `INSUFFICIENT_SCOPE` → ServiceM8 token missing permission
- `ENDPOINT_NOT_FOUND` → wrong API base or path
- `VALIDATION_ERROR` → missing/invalid allocation fields
- `INVALID_ALLOCATION_WINDOW` → allocation_window_uuid invalid (refresh mapping)
- `NO_CAPACITY` → capacity exceeded for selected window
- `ALLOCATION_VERIFY_FAILED` → allocation created but cannot be read back
