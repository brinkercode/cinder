-- Release promotions are no longer recorded: deploy_syncs keeps each environment's deploy history.
DROP TABLE IF EXISTS release_promotions;
