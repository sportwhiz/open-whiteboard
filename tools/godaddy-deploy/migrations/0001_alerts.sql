CREATE TABLE installer_incidents (
  attempt TEXT NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT NOT NULL,
  occurred INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  reported INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (attempt, action)
);
CREATE TABLE installer_alert_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  heartbeat INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_send INTEGER NOT NULL DEFAULT 0,
  delivery_failed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO installer_alert_state (id) VALUES (1);
