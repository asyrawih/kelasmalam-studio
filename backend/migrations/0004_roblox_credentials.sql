CREATE TABLE IF NOT EXISTS roblox_credential (
  user_id        TEXT PRIMARY KEY REFERENCES user(id),
  creator_kind   TEXT NOT NULL,
  creator_id     TEXT NOT NULL,
  api_key_cipher TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);
