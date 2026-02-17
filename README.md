# Noyakka Core (Fly.io)

Backend API for Noyakka, deployed to Fly.io.

## Endpoints

- `GET /health`
- `POST /vapi/ping`
- `POST /vapi/create-job`
- `POST /vapi/create-lead`
- `POST /vapi/send-sms`
- `POST /dev/test-profit-estimator` (dev harness)
- `POST /dev/simulate-overrun` (dev harness)
- `GET /auth/servicem8/start`
- `GET /auth/servicem8/callback`

## Required Env Vars

- `VAPI_BEARER_TOKEN`
- `SERVICEM8_APP_ID`
- `SERVICEM8_APP_SECRET`
- `DATABASE_URL` (default: `file:./prisma/dev.db`)

## Optional Env Vars

- `BASE_URL` (default: `https://noyakka-core.fly.dev`)
- `SERVICEM8_QUEUE_UUID`
- `SERVICEM8_CATEGORY_UUID`
- `SERVICEM8_STAFF_UUID`
- `DEBUG_KEY` (required for `/debug/last-vapi-calls`)
- `DEV_TEST_ENDPOINTS` (set `true` to enable `/dev/*` in production-like environments)
- `GIT_SHA`
- `BUILD_TIME`

## Fly Secrets (example)

```
fly secrets set \
VAPI_BEARER_TOKEN="YOUR_VAPI_TOKEN" \
SERVICEM8_APP_ID="YOUR_APP_ID" \
SERVICEM8_APP_SECRET="YOUR_APP_SECRET" \
DATABASE_URL="file:./prisma/prod.db" \
DEBUG_KEY="YOUR_DEBUG_KEY" \
-a noyakka-core
```

## Fly Build Metadata

Pass build args on deploy so `GIT_SHA` + `BUILD_TIME` are set:

```
fly deploy \
  --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -a noyakka-core
```

## OAuth flow

1) Open `GET /auth/servicem8/start`
2) Approve and return to `GET /auth/servicem8/callback`
3) Tokens are stored per `company_uuid`

## Curl checklist

1) Health
```
curl -s https://noyakka-core.fly.dev/health
```

2) OAuth start (redirect)
```
curl -I https://noyakka-core.fly.dev/auth/servicem8/start
```

3) Create job
```
curl -s -X POST https://noyakka-core.fly.dev/vapi/create-job \
  -H "Authorization: Bearer YOUR_VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "company_uuid": "YOUR_SERVICEM8_COMPANY_UUID",
    "first_name": "Test",
    "last_name": "Customer",
    "mobile": "+61400000000",
    "job_address": "13 Example St",
    "job_description": "Power outage - whole house",
    "urgency": "urgent"
  }'
```

4) Create lead (job + contact + note)
```
curl -s -X POST https://noyakka-core.fly.dev/vapi/create-lead \
  -H "Authorization: Bearer YOUR_VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "company_uuid": "YOUR_SERVICEM8_COMPANY_UUID",
    "first_name": "Zak",
    "last_name": "Elliot",
    "mobile": "+61425278961",
    "email": "zak@test.com",
    "job_address": "13 Example Street, Westlake QLD",
    "job_description": "Fix leaking shower head",
    "urgency": "today",
    "call_summary": "Leaking shower head, turned off, wants ASAP."
  }'
```

5) Send SMS (stub)
```
curl -s -X POST https://noyakka-core.fly.dev/vapi/send-sms \
  -H "Authorization: Bearer YOUR_VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "company_uuid": "YOUR_SERVICEM8_COMPANY_UUID",
    "to_mobile": "+61400000000",
    "message": "We’ve received your request and will follow up shortly."
  }'
```

## Phase 2 & 3 Manual Verification (ServiceM8)

1) Prep
```
# local/dev
export OVERRUN_PROTECTION_ENABLED=true
export DEV_TEST_ENDPOINTS=true
export DEBUG_KEY=your_debug_key
```

2) Validate profit estimator harness (Phase 3)
```
curl -s -X POST http://localhost:3000/dev/test-profit-estimator \
  -H "Content-Type: application/json" \
  -H "x-debug-key: your_debug_key" \
  -d '{
    "job_description": "No power in kitchen and switchboard keeps tripping",
    "suburb": "Mount Ommaney",
    "urgency": "this_week"
  }'
```
Expected:
- `jobType`, `estimatedDurationMins`, `estimatedValue`, `flagLevel`, `servicem8NoteText`

3) Verify real AI booking note (Phase 3)
- Create a job via normal booking flow (`/vapi/create-job` path).
- In ServiceM8 open the job and confirm a note exists:
  - Header contains `NOYAKKA PROFIT INSIGHT`
  - Shows type, confidence, revenue range, duration range, margin status.

4) Verify Dispatch Board visibility (Phase 2 scheduling)
- In ServiceM8 Dispatch Board, confirm booked allocations appear immediately under the assigned staff.
- Confirm allocation has date/window and staff assignment (not `Unknown`).

5) Simulate overrun (SOP harness)
```
curl -s -X POST http://localhost:3000/dev/simulate-overrun \
  -H "Content-Type: application/json" \
  -H "x-debug-key: your_debug_key" \
  -d '{
    "job_uuid": "YOUR_JOB_UUID",
    "minutesOverdue": 45
  }'
```
Expected:
- endpoint returns `monitor_result`
- next customer receives delay SMS once
- if overdue > 90 mins and `DISPATCHER_MOBILE` is set, dispatcher receives major delay SMS once

6) Confirm no auto-move safety
- Check the next allocation start/window in ServiceM8 did **not** change automatically.
- Only customer ETA communication and notes should be added.

7) Verify event logs
- Look for these operational events in app logs:
  - `PROFIT_FLAGGED`
  - `OVERRUN_DETECTED`
  - `DELAY_SMS_SENT`
  - `MAJOR_DELAY_ALERT_SENT`
  - `ETA_30MIN_SENT`

8) Verify SMS log behavior
- In ServiceM8 job activity / SMS history, confirm:
  - no duplicate delay SMS for the same next-job overrun chain
  - no duplicate 30-min-away SMS for the same source/next job chain

## Phase 2/3 Harness Script

Run end-to-end checks for:
- create job
- verify profit note fields
- fetch structured availability option codes
- book using returned `selected_code`
- verify allocation is dispatch-board ready

```
BASE_URL=http://localhost:3000 \
VAPI_BEARER_TOKEN=... \
SERVICEM8_VENDOR_UUID=... \
npm run dev:phase23-harness
```
