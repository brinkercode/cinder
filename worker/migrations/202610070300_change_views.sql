-- Change detail: its view (api/shapes/change-view.js) and whether a person's approval queues the change.
CREATE TABLE IF NOT EXISTS change_views (change_id TEXT PRIMARY KEY, view TEXT, auto_queue INTEGER NOT NULL DEFAULT 1);
