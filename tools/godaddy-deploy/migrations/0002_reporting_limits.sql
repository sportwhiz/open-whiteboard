CREATE TABLE installer_attempts (
  attempt TEXT PRIMARY KEY,
  updated INTEGER NOT NULL
);
CREATE TABLE installer_rejections (
  category TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  reported INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);
