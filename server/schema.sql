-- Players: a name, kept in lower case as `key`, and a hash of its token.
CREATE TABLE IF NOT EXISTS players (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  joined INTEGER NOT NULL
);

-- Each player's best run of a day, under one version of the rules, with its
-- moves (JSON) so it can be raced as a ghost.
CREATE TABLE IF NOT EXISTS runs (
  day TEXT NOT NULL,
  rules INTEGER NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  level INTEGER NOT NULL,
  moves TEXT NOT NULL,
  at INTEGER NOT NULL,
  tries INTEGER NOT NULL,
  PRIMARY KEY (day, rules, key)
);

CREATE INDEX IF NOT EXISTS runs_board ON runs (day, rules, score DESC, at);
