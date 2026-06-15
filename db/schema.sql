-- for dev purposes
DROP TABLE IF EXISTS sandbox_items CASCADE;
DROP TABLE IF EXISTS sandboxes CASCADE;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS notebooks;
DROP TABLE IF EXISTS project_tasks CASCADE;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS daily_tasks CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notebooks (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL DEFAULT 'Untitled Notebook',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_favorite BOOLEAN DEFAULT FALSE,
    color VARCHAR(50),
    tags TEXT
);

CREATE TABLE notes (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    body TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
    is_favorite BOOLEAN DEFAULT FALSE,
    color VARCHAR(50),
    tags TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    is_completed BOOLEAN DEFAULT FALSE,
    priority VARCHAR(10) DEFAULT 'normal',
    due_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    priority VARCHAR(10) DEFAULT 'very_low',
    is_completed BOOLEAN DEFAULT FALSE,
    color VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_tasks (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    is_completed BOOLEAN DEFAULT FALSE,
    priority VARCHAR(10) DEFAULT 'normal',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    is_completed BOOLEAN DEFAULT FALSE,
    priority VARCHAR(10) DEFAULT 'normal',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked BOOLEAN DEFAULT FALSE
);

-- indexes for faster queries
CREATE INDEX idx_user_notes ON notes(user_id, created_at DESC);
CREATE INDEX idx_notes_created_at ON notes(created_at DESC);
CREATE INDEX idx_notebook_notes ON notes(notebook_id);
CREATE INDEX idx_user_notebooks ON notebooks(user_id, created_at DESC);
CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_projects_user_id ON projects(user_id);
CREATE INDEX idx_project_tasks_id ON project_tasks(project_id);
CREATE INDEX idx_daily_tasks_user_id ON daily_tasks(user_id);
CREATE INDEX idx_daily_tasks_expires ON daily_tasks(expires_at);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- Sandbox (infinite canvas) cloud persistence — see references/sandbox-roadmap.md Phase 5.
-- IF NOT EXISTS so these two statements can be applied on their own to an existing DB
-- without re-running the DROP/CREATE block above. user_id is INTEGER to match users.id
-- (SERIAL), while board/item ids are UUID — sandbox_items.id is client-generated
-- (crypto.randomUUID) so optimistic writes have a stable id.
CREATE TABLE IF NOT EXISTS sandboxes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    item_count  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sandbox_items (
    id          UUID PRIMARY KEY,
    sandbox_id  UUID NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('stroke','shape','image','note','task','text','connector')),
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    w           REAL,
    h           REAL,
    rotation    REAL DEFAULT 0,
    z_index     INTEGER DEFAULT 0,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sandboxes_user ON sandboxes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sandbox_items_sandbox ON sandbox_items(sandbox_id);

-- Calendar (planning surface) — see references/calendar-roadmap.md.
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this whole block can be applied on its own
-- to an existing DB without re-running the destructive DROP/CREATE block at the top.
-- A "block" is a first-class calendar item: standalone (sticky/event) when ref_type IS NULL,
-- or linked to an existing entity. ref_id is TEXT (no FK) because it is polymorphic — note/
-- task/project/daily ids are INTEGER (SERIAL) while sandbox ids are UUID; a deleted target
-- simply leaves an orphaned standalone block (degrade gracefully). Times are TIMESTAMPTZ
-- (store UTC, render local). ref_type is validated against an allow-list in routes/events.js.
CREATE TABLE IF NOT EXISTS calendar_events (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(200) NOT NULL,
    description TEXT,
    start_at    TIMESTAMPTZ NOT NULL,
    end_at      TIMESTAMPTZ,
    all_day     BOOLEAN DEFAULT FALSE,
    color       VARCHAR(50),
    ref_type    TEXT,
    ref_id      TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily-task recurrence: extend the existing ephemeral daily_tasks. A row WITH a recurrence
-- is non-expiring (the 24h cleanup in routes/dailyTasks.js skips recurrence IS NOT NULL); the
-- calendar expands it into virtual per-day instances. recurrence is 'every-day'|'weekdays'|
-- 'weekends' or a JSON mask '{"mask":[7 booleans], index 0 = Sunday}'. time is optional 'HH:MM'.
ALTER TABLE daily_tasks ADD COLUMN IF NOT EXISTS recurrence TEXT;
ALTER TABLE daily_tasks ADD COLUMN IF NOT EXISTS time TEXT;

-- Per-day completion for recurring dailies (ephemeral dailies keep using is_completed).
-- A row present = that recurring daily is done on that date.
CREATE TABLE IF NOT EXISTS daily_completions (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    daily_task_id INTEGER REFERENCES daily_tasks(id) ON DELETE CASCADE,
    date          DATE NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (daily_task_id, date)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user_range ON calendar_events(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_daily_completions_user_date ON daily_completions(user_id, date);

-- Schedule Designer: a "schedule" groups the blocks stamped from a designed weekly timetable so a whole
-- term can be renamed / recoloured / bulk-deleted as a unit. Stamped blocks carry schedule_id; deleting
-- a schedule cascades away its blocks. (Standalone blocks have schedule_id NULL — unaffected.)
CREATE TABLE IF NOT EXISTS schedules (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(120) NOT NULL,
    color       VARCHAR(50),
    template    JSONB,   -- the designed weekly pattern, so a schedule can be re-opened/re-stamped
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS template JSONB;  -- for DBs created before the column existed
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_calendar_events_schedule ON calendar_events(schedule_id);
