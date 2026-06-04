-- Sanctum v0 schema
-- All timestamps are Unix milliseconds (INTEGER).
-- tags stored as JSON array string.

CREATE TABLE IF NOT EXISTS tools (
    id           TEXT    PRIMARY KEY,   -- UUID v4
    name         TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    tags         TEXT    NOT NULL DEFAULT '[]',
    icon_data    TEXT,                  -- base64 data URI or null
    current_ver  TEXT,                  -- sha256 hex of the active version
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_versions (
    id           TEXT    PRIMARY KEY,   -- sha256 hex (content-addressed)
    tool_id      TEXT    NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    version_num  INTEGER NOT NULL,      -- monotonically increasing per tool
    file_size    INTEGER NOT NULL,      -- bytes
    checksum     TEXT    NOT NULL,      -- "sha256:{hex}"
    manifest     TEXT    NOT NULL,      -- JSON (ToolManifest)
    quarantined  INTEGER NOT NULL DEFAULT 0,  -- 1 = integrity check failed
    created_at   INTEGER NOT NULL,
    UNIQUE(tool_id, version_num)
);

CREATE INDEX IF NOT EXISTS idx_versions_tool ON tool_versions(tool_id);
