-- Phase 4.0 M3 S2 — two-tenant / two-store isolation fixture.
--
-- Loaded by tests/db/rlsIsolation.integration.test.mjs into a DISPOSABLE PostgreSQL database
-- and nowhere else. Every identifier below is a fixed synthetic UUID chosen so an assertion can
-- name it; none corresponds to any real tenant, store or person.
--
-- NO CREDENTIAL, NO CONNECTION STRING, NO SECRET appears in this file. The disposable cluster
-- uses trust authentication over a task-owned socket (or the CI loopback service), so the
-- non-owner probe roles the test creates need nothing to authenticate with at all.
--
-- Inserted as the table OWNER: the tenant-runtime principal deliberately cannot create tenants,
-- stores, users or memberships, so it could not build its own fixture — which is itself part of
-- what the suite proves.
--
-- SHAPE (adversarial by construction):
--   tenant A  -- store A1, store A2      <- cross-STORE isolation inside ONE tenant
--   tenant B  -- store B1, store B2      <- cross-TENANT isolation
--   a PLATFORM-scope membership with tenant_id NULL  <- must be invisible to any tenant context

insert into platform_identity (internal_user_id, auth_provider, auth_provider_uid) values
  ('11111111-1111-4111-8111-111111111111', 'firebase', 'rls-fixture-subject-a'),
  ('22222222-2222-4222-8222-222222222222', 'firebase', 'rls-fixture-subject-b'),
  ('33333333-3333-4333-8333-333333333333', 'firebase', 'rls-fixture-subject-platform');

insert into app_user (internal_user_id, status) values
  ('11111111-1111-4111-8111-111111111111', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'active'),
  ('33333333-3333-4333-8333-333333333333', 'active');

insert into tenant (tenant_id, display_name, legal_name, plan_key, status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fixture Tenant A', 'Fixture Tenant A Ltd', 'growth', 'active'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Fixture Tenant B', 'Fixture Tenant B Ltd', 'starter', 'active');

insert into store (store_id, tenant_id, store_name, status) values
  ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Tenant A / Store 1', 'active'),
  ('a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Tenant A / Store 2', 'active'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Tenant B / Store 1', 'active'),
  ('b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Tenant B / Store 2', 'active');

insert into user_membership
  (membership_id, internal_user_id, tenant_id, store_id, scope_type, role_id, status) values
  -- tenant-scope grants
  ('cccccccc-0001-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 'tenant', 'store_owner', 'active'),
  ('cccccccc-0002-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, 'tenant', 'store_owner', 'active'),
  -- store-scope grants, both inside tenant A so cross-store isolation is testable
  ('cccccccc-0003-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'store', 'manager', 'active'),
  ('cccccccc-0004-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', 'store', 'technician', 'active'),
  -- a PLATFORM grant: tenant_id and store_id are both NULL, so no tenant context can ever
  -- match it. A policy that leaked this row would expose the platform administration graph.
  ('cccccccc-0005-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333',
   null, null, 'platform', 'system_owner', 'active');

insert into tenant_feature_entitlement (entitlement_id, tenant_id, feature_key, enabled, source) values
  ('dddddddd-0001-4ddd-8ddd-dddddddddddd', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fixture.capability', true, 'plan'),
  ('dddddddd-0002-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'fixture.capability', false, 'plan');
