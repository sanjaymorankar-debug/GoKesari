-- split: core
-- Searches made while signed out were saved with user_id NULL until 24 Oct 2026. Nothing reads
-- them any more: trending counts distinct signed-in accounts, and a guest's recent searches stay
-- in the browser. This removes the rows already stored; new guest searches are not saved
-- (recordSearch). Deletes only; no schema change. The privacy policy says these are not kept.
DELETE FROM "search_queries" WHERE "user_id" IS NULL;
