-- A provider row exists only for a person's stored key or login; usage reports used to add credits and org rows,
-- which hid Connect for providers the person never saved a key for.
DELETE FROM model_providers WHERE source <> 'mine';
