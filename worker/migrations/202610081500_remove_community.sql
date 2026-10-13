-- Community and Explore are removed: drop their tables and the topic judge, and every repo is private.
DROP TABLE IF EXISTS topic_pins;
DROP TABLE IF EXISTS topic_descriptions;
DROP TABLE IF EXISTS topic_follows;
DROP TABLE IF EXISTS repo_topics;
DROP TABLE IF EXISTS stars;
DELETE FROM judge_config WHERE kind = 'topic';
UPDATE repo_visibility SET visibility = 'private' WHERE visibility = 'instance';
