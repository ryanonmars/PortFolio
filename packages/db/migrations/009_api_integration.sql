CREATE TABLE personal_api_tokens (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 access TEXT NOT NULL CHECK(access IN ('read','write')),
 token_hash TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL,
 expires_at INTEGER,
 last_used_at INTEGER,
 revoked_at INTEGER
) STRICT;
CREATE INDEX personal_api_tokens_user ON personal_api_tokens(user_id);
CREATE TABLE integration_proposals (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 token_id TEXT NOT NULL REFERENCES personal_api_tokens(id),
 digest TEXT NOT NULL,
 proposal_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 applied_board_id TEXT,
 idempotency_key TEXT,
 UNIQUE(token_id,idempotency_key)
) STRICT;
CREATE INDEX integration_proposals_expiry ON integration_proposals(expires_at);
