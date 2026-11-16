# Clinic booking API

Koya Cohort 4 Task 1 — an appointment booking API plus a small web page that uses it.

| | |
| --- | --- |
| Spec | [koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api) |
| Stack | TypeScript, Hono, Postgres |
| Levels | 1–5 |

## What it does

| Level | Behaviour |
| --- | --- |
| 1 | `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/:id` |
| 2 | `X-API-Key` auth; validation for missing/invalid fields, unknown slots, past slots |
| 3 | No double booking under concurrent requests; `DELETE /bookings/:id` cancels and frees the slot |
| 4 | `Idempotency-Key` replay / 422; cursor pagination on `GET /bookings?email=` |
| 5 | 5 booking attempts per email per minute → `429` + `Retry-After` |

## Design decisions

1. **Postgres enforces the hard guarantees.** A partial unique index allows only one `confirmed` booking per slot. Inserts use `ON CONFLICT DO NOTHING`, so simultaneous requests serialize in the database: one gets `201`, the rest get `409`. Cancelling flips status to `cancelled`, which drops the row out of the index and frees the slot.
2. **Idempotency and rate limits also live in Postgres.** That keeps them correct across multiple serverless instances. Retries with the same key take an advisory lock, replay the stored response, or return `422` when the body changed. Rate limiting is a sliding 60-second window of attempts per email (failed attempts count; pure replays do not).

## Local run

```bash
# Postgres (example with Docker)
docker run -d --name clinic-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=clinic \
  -p 5433:5432 postgres:16-alpine

cp .env.example .env   # set DATABASE_URL and API_KEY
npm install
npm run db:migrate
npm run dev
```

- API base: `http://localhost:3000`
- Web page: `http://localhost:3000/`
- Health: `http://localhost:3000/health`

The page talks to `/web/*` helpers so the browser never sees the API key. API clients should call `/slots` and `/bookings` with `X-API-Key`.

## Tests

```bash
npm test
```

Covers auth, validation, concurrent double-booking (25 parallel requests), cancel/rebook, idempotency, pagination, rate limiting, and the web helpers.
