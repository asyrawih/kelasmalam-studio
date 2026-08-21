CREATE TABLE IF NOT EXISTS roblox_asset (
  user_id          TEXT NOT NULL REFERENCES user(id),
  asset_id         TEXT NOT NULL,
  creator_kind     TEXT NOT NULL,
  creator_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  moderation_state TEXT,
  source           TEXT NOT NULL,
  created_at       INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, asset_id)
);
CREATE INDEX IF NOT EXISTS roblox_asset_owner
  ON roblox_asset(user_id, creator_kind, creator_id, name);

CREATE TABLE IF NOT EXISTS roblox_grant (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id),
  asset_id     TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roblox_grant_user
  ON roblox_grant(user_id, created_at DESC);
