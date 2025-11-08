-- for dev purposes
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notes (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    body TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

-- apparently index for faster queries
CREATE INDEX idx_user_notes ON notes(user_id, created_at DESC);
CREATE INDEX idx_notes_created_at ON notes(created_at DESC);

-- default user maybe for me
INSERT INTO users (username, password_hash) VALUES
    ('testUser', 'testpassword');

INSERT INTO notes (title, body, user_id) VALUES
    ('Welcome Note', 'This is your first note! Start editing/creating new ones', 1),
    ('Meeting Notes', 'Discuss project roadmap and milestones.', 1),
    ('Ideas', 'Brainstorm features for future releases.', 1);