-- WorkerStandard moved from the standard-1 to the standard-2 instance type; existing full-image pools follow it.
UPDATE worker_pools SET size = 'standard-2' WHERE size = 'standard-1';
