-- Phase 4.0 M5 — the trusted principal-resolution and transaction-revalidation boundary
-- Migration: 007_m5_trusted_principal_resolution (DOWN)
--
-- Removes exactly what the up file created: the two entry routines, with the grants that ride on
-- them, the version helper, and the schema tmpos_identity that held them. Nothing else is touched —
-- not migration 006's schema tmpos_internal or any of its eleven routines, not a table, not a role,
-- not a grant issued by 001-006.
--
-- NOTHING IS REFUSED, BECAUSE NOTHING IS LOST. Unlike 006's rollback, this file destroys no durable
-- state: these routines hold no row, and dropping them only returns the runtime to the posture it had
-- before 007 — unable to resolve a principal, which is a refusal, not a loss. A command already
-- committed keeps its audit record and its events; a command in flight is refused by its own
-- transaction when the routine it calls is gone.
--
-- ORDER. The two entry routines go first and the version helper last, because both of them call it:
-- dropping the helper first would fail on the dependency, and dropping it with CASCADE would silently
-- take the callers with it. Revoking before dropping is redundant — a dropped function keeps no ACL —
-- but it is written out so the rollback states the privilege change it makes rather than implying it.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL
-- pins resolution to pg_catalog until this transaction ends.

set local search_path = pg_catalog, pg_temp;

revoke execute on function tmpos_identity.m5_resolve_principal(text, text) from tmpos_app;
revoke execute on function tmpos_identity.m5_revalidate_principal_context(uuid, text, text, uuid, uuid) from tmpos_app;

drop function tmpos_identity.m5_resolve_principal(text, text);
drop function tmpos_identity.m5_revalidate_principal_context(uuid, text, text, uuid, uuid);
drop function tmpos_identity.m5_security_version(uuid);

-- The schema last, and WITHOUT CASCADE: if anything this file did not create lives in it, the drop
-- fails and the whole rollback with it, rather than taking an unknown object down silently.
drop schema tmpos_identity;
