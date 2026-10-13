-- Per-push sandbox checks are gone (verification runs on the runners), so nothing writes or reads their results.
DROP TABLE IF EXISTS pipeline_checks;
