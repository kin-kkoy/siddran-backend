# Ember API Specification

Base URL: `/` (e.g. `http://localhost:3000` locally, or your Vercel deployment URL)

All authenticated endpoints require: `Authorization: Bearer <access_token>`

Cursor-based pagination is used on all list endpoints: `?cursor=<ISO_timestamp>&limit=<number>`

---

## Health

### `GET /health`

Check if the API is running. Not rate-limited.

**Response** `200`
```json
{ "status": "ok", "message": "Ember API is running" }
```

---

## Auth (`/auth`)

Rate limit: `authLimiter` (5 req / 15 min)

### `POST /auth/register`

Create a new account. Auto-logs in on success.

**Request Body**
| Field      | Type   | Required | Rules                                                        |
|------------|--------|----------|--------------------------------------------------------------|
| `username` | string | yes      | 3-30 chars, alphanumeric + underscores only                  |
| `password` | string | yes      | Min 6 chars, must contain at least one number or special char |

**Response** `201`
```json
{
  "message": "Registered Successfully",
  "accessToken": "<jwt>"
}
```
Sets `refreshToken` httpOnly cookie (7 days).

**Errors**
| Status | Condition                          |
|--------|------------------------------------|
| 400    | Missing fields or validation fail  |
| 500    | Server / token error               |

---

### `POST /auth/login`

**Request Body**
| Field      | Type   | Required |
|------------|--------|----------|
| `username` | string | yes      |
| `password` | string | yes      |

**Response** `200`
```json
{
  "message": "Signed in",
  "accessToken": "<jwt>"
}
```
Sets `refreshToken` httpOnly cookie (7 days).

**Errors**
| Status | Condition                                          |
|--------|----------------------------------------------------|
| 400    | Missing fields                                     |
| 401    | Incorrect credentials                              |
| 429    | Account locked (5 failed attempts, 15 min lockout) |
| 500    | Server / token error                               |

---

### `POST /auth/refresh`

Rotate tokens. Reads `refreshToken` from cookie (not body).

**Request Body** — none (token comes from cookie)

**Response** `200`
```json
{ "accessToken": "<new_jwt>" }
```
Sets new `refreshToken` httpOnly cookie.

**Errors**
| Status | Condition                          |
|--------|------------------------------------|
| 401    | Missing, invalid, revoked, or expired refresh token |
| 404    | User no longer exists              |
| 500    | Server error                       |

---

### `POST /auth/logout`

Revokes the refresh token and clears the cookie.

**Request Body** — none (token comes from cookie)

**Response** `200`
```json
{ "message": "Logged out" }
```

**Errors**
| Status | Condition        |
|--------|------------------|
| 400    | No refresh token |

---

## Notes (`/notes`)

All endpoints require auth. Rate limits noted per endpoint.

### `GET /notes`

List all notes (cursor-paginated). Rate limit: `generalLimiter`

**Query Params**
| Param    | Type   | Default | Max |
|----------|--------|---------|-----|
| `cursor` | string | null    | —   |
| `limit`  | number | 20      | 50  |

**Response** `200`
```json
{
  "notes": [
    {
      "id": 1,
      "title": "string",
      "body": "string",
      "created_at": "ISO",
      "updated_at": "ISO",
      "notebook_id": null,
      "is_favorite": false,
      "color": null,
      "tags": null
    }
  ],
  "pagination": {
    "hasNextPage": false,
    "nextCursor": null,
    "limit": 20
  }
}
```

---

### `GET /notes/:id`

Get a single note. Rate limit: `generalLimiter`

**Response** `200`
```json
{
  "id": 1,
  "title": "string",
  "body": "string",
  "created_at": "ISO",
  "updated_at": "ISO",
  "notebook_id": null,
  "is_favorite": false,
  "color": null,
  "tags": null
}
```

**Errors**
| Status | Condition  |
|--------|------------|
| 404    | Not found  |

---

### `POST /notes`

Create a note. Rate limit: `strictLimiter` (30 req / 15 min). Max 50 notes per user.

**Request Body**
| Field  | Type   | Required | Rules              |
|--------|--------|----------|--------------------|
| `title`| string | yes      | Non-empty          |
| `body` | string | no       | Max 50,000 chars   |

**Response** `201`
```json
{
  "id": 1,
  "title": "string",
  "body": "string",
  "created_at": "ISO",
  "updated_at": "ISO",
  "notebook_id": null,
  "is_favorite": false,
  "color": null,
  "tags": null
}
```

**Errors**
| Status | Condition                 |
|--------|---------------------------|
| 400    | Missing title, body too long, or max notes reached |

---

### `PUT /notes/:id`

Update a note (partial update — only send fields to change). Rate limit: `contentUpdateLimiter` (150 req / 15 min)

**Request Body** (all optional, but at least one required)
| Field         | Type     | Notes                    |
|---------------|----------|--------------------------|
| `title`       | string   | Trimmed                  |
| `body`        | string   |                          |
| `is_favorite` | boolean  |                          |
| `color`       | string   |                          |
| `tags`        | string[] |                          |

**Response** `200`
```json
{
  "id": 1,
  "title": "string",
  "body": "string",
  "created_at": "ISO",
  "updated_at": "ISO",
  "is_favorite": false,
  "color": null,
  "tags": null
}
```

**Errors**
| Status | Condition         |
|--------|-------------------|
| 400    | Nothing to update |
| 404    | Not found         |

---

### `DELETE /notes/:id`

Delete a note. Rate limit: `strictLimiter`

**Response** `200`
```json
{ "message": "Note was deleted successfully:", "id": 1 }
```

**Errors**
| Status | Condition |
|--------|-----------|
| 404    | Not found |

---

## Notebooks (`/notebooks`)

All endpoints require auth.

### `GET /notebooks`

List all notebooks (cursor-paginated). Rate limit: `generalLimiter`

**Query Params**
| Param    | Type   | Default | Max |
|----------|--------|---------|-----|
| `cursor` | string | null    | —   |
| `limit`  | number | 20      | 50  |

**Response** `200`
```json
{
  "notebooks": [
    {
      "id": 1,
      "name": "string",
      "created_at": "ISO",
      "updated_at": "ISO",
      "is_favorite": false,
      "color": null,
      "tags": null,
      "note_count": 3
    }
  ],
  "pagination": {
    "hasNextPage": false,
    "nextCursor": null,
    "limit": 20
  }
}
```

---

### `GET /notebooks/:id/notes`

List notes in a specific notebook (cursor-paginated). Rate limit: `generalLimiter`

**Query Params**
| Param    | Type   | Default | Max |
|----------|--------|---------|-----|
| `cursor` | string | null    | —   |
| `limit`  | number | 50      | 100 |

**Response** `200`
```json
{
  "notes": [
    {
      "id": 1,
      "title": "string",
      "body": "string",
      "created_at": "ISO",
      "updated_at": "ISO",
      "notebook_id": 5,
      "is_favorite": false,
      "color": null,
      "tags": null
    }
  ],
  "pagination": {
    "hasNextPage": false,
    "nextCursor": null,
    "limit": 50
  }
}
```

---

### `POST /notebooks`

Create a notebook, optionally moving existing notes into it. Rate limit: `strictLimiter`. Max 20 notebooks per user.

**Request Body**
| Field     | Type     | Required | Rules                          |
|-----------|----------|----------|--------------------------------|
| `name`    | string   | no       | Defaults to "Untitled Notebook"|
| `noteIds` | number[] | no       | Max 50 notes                   |
| `tags`    | string[] | no       | Each tag max 20 chars          |

**Response** `201`
```json
{
  "notebook": {
    "id": 1,
    "name": "string",
    "created_at": "ISO",
    "updated_at": "ISO",
    "is_favorite": false,
    "color": null,
    "tags": null
  },
  "updatedNotes": []
}
```

**Errors**
| Status | Condition                                    |
|--------|----------------------------------------------|
| 400    | Too many notes, tag too long, or max reached |

---

### `PUT /notebooks/:id`

Update notebook metadata. Rate limit: `strictLimiter`

**Request Body** (all optional, at least one required)
| Field         | Type     | Notes                    |
|---------------|----------|--------------------------|
| `name`        | string   | Trimmed, max 100 chars   |
| `is_favorite` | boolean  |                          |
| `color`       | string   |                          |
| `tags`        | string[] | Each tag max 20 chars    |

**Response** `200`
```json
{
  "id": 1,
  "name": "string",
  "created_at": "ISO",
  "updated_at": "ISO",
  "is_favorite": false,
  "color": null,
  "tags": null
}
```

**Errors**
| Status | Condition                      |
|--------|--------------------------------|
| 400    | No valid fields / tag too long |
| 404    | Not found                      |

---

### `POST /notebooks/:id/notes`

Add existing notes to a notebook. Only moves notes that don't already belong to a notebook. Rate limit: `strictLimiter`

**Request Body**
| Field     | Type     | Required |
|-----------|----------|----------|
| `noteIds` | number[] | yes      |

**Response** `200`
```json
{ "updatedNotes": [ { ...note } ] }
```

**Errors**
| Status | Condition                  |
|--------|----------------------------|
| 400    | Missing or empty noteIds   |
| 404    | Notebook not found         |

---

### `DELETE /notebooks/:notebookId/notes/:noteId`

Remove a note from a notebook (note is NOT deleted, just unlinked). Rate limit: `strictLimiter`

**Response** `200`
```json
{ "message": "Note has been removed from notebook" }
```

---

### `DELETE /notebooks/:id`

Delete a notebook. All notes inside are unlinked first (not deleted). Rate limit: `strictLimiter`

**Response** `200`
```json
{ "message": "Notebook has been deleted" }
```

**Errors**
| Status | Condition |
|--------|-----------|
| 404    | Not found |

---

## Tasks (`/tasks`)

All endpoints require auth.

### `GET /tasks`

List all tasks with their checklist items (cursor-paginated). Sorted: incomplete first, then by date. Rate limit: `generalLimiter`

**Query Params**
| Param    | Type   | Default | Max |
|----------|--------|---------|-----|
| `cursor` | string | null    | —   |
| `limit`  | number | 20      | 50  |

**Response** `200`
```json
{
  "tasks": [
    {
      "id": 1,
      "title": "string",
      "description": "string",
      "priority": "normal",
      "due_date": "ISO | null",
      "is_completed": false,
      "created_at": "ISO",
      "updated_at": "ISO",
      "checklist": [
        {
          "id": 1,
          "task_id": 1,
          "title": "string",
          "priority": "normal",
          "is_completed": false,
          "created_at": "ISO",
          "updated_at": "ISO"
        }
      ]
    }
  ],
  "pagination": {
    "hasNextPage": false,
    "nextCursor": null,
    "limit": 20
  }
}
```

---

### `POST /tasks`

Create a task with optional checklist items. Rate limit: `strictLimiter`. Max 100 tasks per user.

**Request Body**
| Field         | Type     | Required | Rules                       |
|---------------|----------|----------|-----------------------------|
| `title`       | string   | yes      | Non-empty, max 200 chars    |
| `description` | string   | no       | Max 500 chars               |
| `priority`    | string   | no       | Default: `"normal"`         |
| `due_date`    | string   | no       | ISO date string             |
| `checklist`   | array    | no       | Max 20 items, each `{ title, priority? }` (title max 100 chars) |

**Response** `201`
```json
{
  "id": 1,
  "title": "string",
  "description": null,
  "priority": "normal",
  "due_date": null,
  "is_completed": false,
  "created_at": "ISO",
  "updated_at": "ISO",
  "checklist": []
}
```

**Errors**
| Status | Condition                                      |
|--------|------------------------------------------------|
| 400    | Missing title, too long, or max tasks reached  |

---

### `PUT /tasks/:id`

Update a task (partial update). Rate limit: `contentUpdateLimiter`

**Request Body** (all optional)
| Field          | Type    | Rules                |
|----------------|---------|----------------------|
| `title`        | string  | Max 200 chars        |
| `description`  | string  | Max 500 chars        |
| `is_completed` | boolean |                      |
| `priority`     | string  |                      |
| `due_date`     | string  | ISO date             |

**Response** `200` — updated task with `checklist` array included.

**Errors**
| Status | Condition |
|--------|-----------|
| 404    | Not found |

---

### `DELETE /tasks/:id`

Delete a task (checklist items cascade-deleted). Rate limit: `strictLimiter`

**Response** `200`
```json
{ "message": "Task deleted successfully" }
```

**Errors**
| Status | Condition |
|--------|-----------|
| 404    | Not found |

---

### `POST /tasks/:taskId/checklist`

Add a checklist item to an existing task. Rate limit: `strictLimiter`

**Request Body**
| Field      | Type   | Required | Rules                    |
|------------|--------|----------|--------------------------|
| `title`    | string | yes      | Non-empty, max 100 chars |
| `priority` | string | no       | Default: `"normal"`      |

**Response** `201`
```json
{
  "id": 1,
  "task_id": 1,
  "title": "string",
  "priority": "normal",
  "is_completed": false,
  "created_at": "ISO",
  "updated_at": "ISO"
}
```

**Errors**
| Status | Condition                    |
|--------|------------------------------|
| 400    | Missing or too-long title    |
| 404    | Parent task not found        |

---

### `PUT /tasks/:taskId/checklist/:checklistId`

Update/toggle a checklist item. Rate limit: `contentUpdateLimiter`

**Request Body** (all optional)
| Field          | Type    | Rules          |
|----------------|---------|----------------|
| `title`        | string  | Max 100 chars  |
| `priority`     | string  |                |
| `is_completed` | boolean |                |

**Response** `200`
```json
{
  "id": 1,
  "task_id": 1,
  "title": "string",
  "priority": "normal",
  "is_completed": true,
  "created_at": "ISO",
  "updated_at": "ISO"
}
```

**Errors**
| Status | Condition              |
|--------|------------------------|
| 404    | Task or item not found |

---

### `DELETE /tasks/:taskId/checklist/:checklistId`

Delete a checklist item. Rate limit: `strictLimiter`

**Response** `200`
```json
{ "message": "Checklist item deleted successfully" }
```

**Errors**
| Status | Condition              |
|--------|------------------------|
| 404    | Task or item not found |

---

## Daily Tasks (`/daily-tasks`)

All endpoints require auth. Daily tasks auto-expire 24 hours after creation. Expired tasks are cleaned up on each GET.

### `GET /daily-tasks`

List active (non-expired) daily tasks (cursor-paginated). Sorted: incomplete first, then by date. Rate limit: `generalLimiter`

**Query Params**
| Param    | Type   | Default | Max |
|----------|--------|---------|-----|
| `cursor` | string | null    | —   |
| `limit`  | number | 20      | 50  |

**Response** `200`
```json
{
  "dailyTasks": [
    {
      "id": 1,
      "title": "string",
      "priority": "normal",
      "is_completed": false,
      "created_at": "ISO",
      "updated_at": "ISO",
      "expires_at": "ISO"
    }
  ],
  "pagination": {
    "hasNextPage": false,
    "nextCursor": null,
    "limit": 20
  }
}
```

---

### `POST /daily-tasks`

Create daily tasks in batch. Rate limit: `strictLimiter`. Max 50 active daily tasks per user.

**Request Body**
| Field   | Type   | Required | Rules                                         |
|---------|--------|----------|-----------------------------------------------|
| `tasks` | array  | yes      | Array of `{ title, priority? }`. Max 20 per request. |

Each item in `tasks`:
| Field      | Type   | Required | Rules               |
|------------|--------|----------|---------------------|
| `title`    | string | yes      | Non-empty           |
| `priority` | string | no       | Default: `"normal"` |

**Response** `201`
```json
[
  {
    "id": 1,
    "title": "string",
    "priority": "normal",
    "is_completed": false,
    "created_at": "ISO",
    "updated_at": "ISO",
    "expires_at": "ISO"
  }
]
```

**Errors**
| Status | Condition                                                |
|--------|----------------------------------------------------------|
| 400    | Missing/empty tasks array, too many per request, or max active reached |

---

### `PUT /daily-tasks/:id`

Toggle completion of a daily task. Only works if not expired. Rate limit: `contentUpdateLimiter`

**Request Body**
| Field          | Type    | Required |
|----------------|---------|----------|
| `is_completed` | boolean | no       |

**Response** `200`
```json
{
  "id": 1,
  "title": "string",
  "priority": "normal",
  "is_completed": true,
  "created_at": "ISO",
  "updated_at": "ISO",
  "expires_at": "ISO"
}
```

**Errors**
| Status | Condition              |
|--------|------------------------|
| 404    | Not found or expired   |

---

### `DELETE /daily-tasks/:id`

Delete a daily task. Rate limit: `strictLimiter`

**Response** `200`
```json
{ "message": "Successfully deleted daily task" }
```

**Errors**
| Status | Condition |
|--------|-----------|
| 404    | Not found |

---

## Settings (`/settings`)

All endpoints require auth. Rate limit: `generalLimiter`

### `GET /settings`

Get user settings.

**Response** `200`
```json
{ "settings": {} }
```

---

### `PUT /settings`

Replace user settings (full overwrite).

**Request Body**
| Field      | Type   | Required | Notes              |
|------------|--------|----------|--------------------|
| `settings` | object | yes      | Any JSON object    |

**Response** `200`
```json
{ "settings": { ... } }
```

**Errors**
| Status | Condition                |
|--------|--------------------------|
| 400    | Missing settings object  |
| 404    | User not found           |

---

## Common Error Responses

All endpoints may return:

| Status | Condition                         |
|--------|-----------------------------------|
| 401    | Missing or invalid access token   |
| 404    | Route not found                   |
| 429    | Rate limit exceeded               |
| 500    | Internal server error             |

## Rate Limit Summary

| Limiter                | Limit            | Applied to                       |
|------------------------|------------------|----------------------------------|
| `generalLimiter`       | 100 req / 15 min | All routes (global)              |
| `contentUpdateLimiter` | 150 req / 15 min | PUT (frequent edits)             |
| `strictLimiter`        | 30 req / 15 min  | POST create, DELETE              |
| `authLimiter`          | 5 req / 15 min   | Login, register                  |
