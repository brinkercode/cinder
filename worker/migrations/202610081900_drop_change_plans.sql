-- Agent versions are resolved from channels when a job is queued; nothing writes or reads change plans.
DROP TABLE IF EXISTS change_plans;
