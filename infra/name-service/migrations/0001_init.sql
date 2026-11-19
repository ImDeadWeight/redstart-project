-- Redstart name service (TLS plan C12). One row per install.
--
-- What is stored, and nothing else: the install's random id, a SHA-256 of
-- its credential (the credential itself is returned once and never kept),
-- when it registered and was last heard from, the LAN addresses it
-- published, and the newest two ACME TXT values (kept, not deleted, the way
-- acme-dns does: Caddy's acmedns plugin never deletes).
CREATE TABLE installs (
  id              TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  ipv4            TEXT,
  ipv6            TEXT,
  txt1            TEXT,
  txt2            TEXT
);

-- Registration rate limit. `bucket` is a truncated SHA-256 of the caller's
-- public IP, never the IP itself; rows older than the window are deleted on
-- every registration.
CREATE TABLE register_attempts (
  bucket TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX register_attempts_bucket_at ON register_attempts (bucket, at);
