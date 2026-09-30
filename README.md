# Siddran Backend

The REST API behind [Siddran](https://github.com/kin-kkoy/siddran-web), a notes, tasks and
planning app. It stores each user's notes, notebooks, tasks, calendar blocks and canvas
boards in PostgreSQL, and issues presigned URLs so the client can upload images straight to
object storage.

- Deployed at https://siddran-backend.vercel.app (health check: `GET /health`)
- Web client: [siddran-web](https://github.com/kin-kkoy/siddran-web), live at https://cinder-ebon.vercel.app
- Desktop build: [siddran-desktop](https://github.com/kin-kkoy/siddran-desktop) is local-first and does not use this API

## Stack

Node 18+, Express 5, PostgreSQL (`pg` locally, `@neondatabase/serverless` when
`NODE_ENV=production`), `jsonwebtoken` + `bcryptjs`, Cloudflare R2 through the AWS S3 SDK,
plus `helmet`, `cors`, `express-rate-limit` and `morgan`.

## Endpoints

Every group except `/auth` and `/health` requires `Authorization: Bearer <access_token>`.
List endpoints use cursor pagination (`?cursor=<timestamp>&limit=<n>`).

| Group | Covers |
| --- | --- |
| `/auth` | Register, login, refresh, logout |
| `/notes` | Note CRUD (title, Markdown body, tags, color, favorite) |
| `/notebooks` | Notebook CRUD, add/remove notes, fetch notes for many notebooks in one call |
| `/tasks` | Standalone tasks, including dated/undated filtering for the calendar |
| `/projects` | Task bundles (grouped task lists) and their tasks |
| `/daily-tasks` | One-off and recurring dailies, per-day completions, batch complete/delete |
| `/events` | Calendar blocks, standalone or linked to a note, task, daily, bundle or sandbox |
| `/schedules` | Weekly timetables stamped onto the calendar, with restamp |
| `/sandboxes` | Canvas boards and batched item writes (5 MB body limit; other routes use 100 KB) |
| `/uploads` | `POST /uploads/presign` returns a presigned R2 PUT URL (PNG/JPEG/GIF/WebP, 5 MB max) |
| `/settings` | Per-user settings |

Request and response shapes for auth, notes, notebooks, tasks, projects, daily tasks,
uploads and settings are in [API-Specification.md](API-Specification.md).

## Auth

- Passwords are hashed with bcrypt.
- Login and register return a 15-minute JWT access token in the response body and set a
  7-day refresh token as an `HttpOnly` cookie (`Secure` and `SameSite=None` in production).
- Refresh tokens are random values stored in a `refresh_tokens` table. `POST /auth/refresh`
  rotates them, logout revokes them, and each user keeps at most 5 active (one per device).
- CORS allows only `FRONTEND_URL`, with credentials enabled so the cookie is sent.
- Rate limits: 5 auth attempts per 15 min, 30 create/delete per 15 min, 400 general requests per 15 min, 30 upload presigns per minute.

## Data layer

`db/connection.js` exports a single connection pool. `db/schema.sql` holds the full schema:
users, notebooks, notes, tasks, projects, project_tasks, daily_tasks, daily_completions,
calendar_events, schedules, sandboxes, sandbox_items and refresh_tokens. Batch writes build
one multi-row `INSERT`/`UPDATE` (`utils/sqlBulk.js`) instead of one query per row.

Note: the top of `schema.sql` drops and recreates the core tables, so use it only on a
fresh development database.

## Environment variables

| Name | Used for |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Signing access tokens |
| `FRONTEND_URL` | CORS allowed origin |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | Image uploads to Cloudflare R2 |
| `NODE_ENV` | `production` switches the DB driver and cookie flags |
| `PORT` | Local port (default 3000) |

## Run locally

```bash
npm install
# create .env with the variables above
psql "$DATABASE_URL" -f db/schema.sql   # fresh database only
npm run dev     # nodemon
npm start       # plain node
```

## Deployment

Deployed to Vercel as a serverless function (`vercel.json` routes every path to
`server.js`). When the `VERCEL` variable is set, the app is exported as a handler and does
not call `listen()`. The startup cleanup of expired refresh tokens also runs only outside Vercel.
