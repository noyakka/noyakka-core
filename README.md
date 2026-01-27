# Noyakka Core (Fly.io)

Backend API for Noyakka, deployed to Fly.io.

## Endpoints

- `GET /health`
- `POST /vapi/ping`
- `POST /vapi/create-job`
- `POST /vapi/create-lead`
- `POST /vapi/send-sms`
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

## Fly Secrets (example)

```
fly secrets set \
VAPI_BEARER_TOKEN="YOUR_VAPI_TOKEN" \
SERVICEM8_APP_ID="YOUR_APP_ID" \
SERVICEM8_APP_SECRET="YOUR_APP_SECRET" \
DATABASE_URL="file:./prisma/prod.db" \
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
