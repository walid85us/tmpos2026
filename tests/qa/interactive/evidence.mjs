// QA-INTERACTIVE-P1 — bounded, read-only backend evidence from the QA run's own database. Every query runs in a READ ONLY
// transaction as the fixture owner, names its columns from migrations 001–035, and returns only the rows of the
// fixtures or ids asked for (plus per-tenant counts). Session material, keys and idempotency digests are never returned.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function auditsOf(sql, column, id) {
  return sql.unsafe(`select action_id, count(*)::int as n from public.audit_event where ${column} = $1 group by action_id order by action_id`, [id]);
}

async function customerOf(sql, id) {
  const [row] = await sql`select customer_id as id, tenant_id, name, phone, email, row_version,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
    from tmpos_customer.customer where customer_id = ${id}`;
  if (!row) return null;
  const [created] = await sql`select count(*)::int as n from public.audit_event
    where action_id = 'tenant.customer.create' and tenant_id = ${row.tenant_id}`;
  return { kind: 'customer', ...row, audits: await auditsOf(sql, 'subject_customer_id', id), tenantCreateAudits: created.n };
}

async function draftOf(sql, id) {
  const [row] = await sql`select draft_id as id, tenant_id, store_id, customer_id, status, version, line_count, subtotal_cents,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
    from tmpos_invoice_draft.invoice_draft where draft_id = ${id}`;
  if (!row) return null;
  const outbox = await sql`select event_type, count(*)::int as n from tmpos_internal.outbox_event
    where aggregate_id::text = ${id} group by event_type order by event_type`;
  return { kind: 'draft', ...row, audits: await auditsOf(sql, 'subject_invoice_draft_id', id), outbox };
}

async function invoiceOf(sql, id) {
  const [row] = await sql`select invoice_id as id, tenant_id, store_id, number::text as number, source_draft_id, customer_name,
      total_cents, to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at
    from tmpos_invoice_issue.issued_invoice where invoice_id = ${id}`;
  if (!row) return null;
  const [voided] = await sql`select reason_code, to_char(voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as voided_at
    from tmpos_invoice_void.issued_invoice_void where invoice_id = ${id}`;
  return { kind: 'issued invoice', ...row, state: voided ? 'voided' : 'issued', void: voided ?? null, audits: await auditsOf(sql, 'subject_issued_invoice_id', id) };
}

async function tenantSummary(sql, tenantId) {
  const [c] = await sql`select
      (select count(*)::int from tmpos_customer.customer where tenant_id = ${tenantId}) as customers,
      (select count(*)::int from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenantId} and status = 'draft') as drafts_open,
      (select count(*)::int from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenantId} and status = 'discarded') as drafts_discarded,
      (select count(*)::int from tmpos_invoice_draft.invoice_draft where tenant_id = ${tenantId} and status = 'issued') as drafts_issued,
      (select count(*)::int from tmpos_invoice_issue.issued_invoice where tenant_id = ${tenantId}) as invoices_issued,
      (select count(*)::int from tmpos_invoice_void.issued_invoice_void where tenant_id = ${tenantId}) as invoices_voided`;
  const audits = await sql`select action_id, count(*)::int as n from public.audit_event where tenant_id = ${tenantId} group by action_id order by action_id`;
  const levels = await sql`select l.role_id, l.domain, coalesce(l.level, '(default)') as level, v.version
    from tmpos_role.tenant_role_level l
    left join tmpos_role_edit.role_level_version v on v.tenant_id = l.tenant_id and v.role_id = l.role_id and v.domain = l.domain
    where l.tenant_id = ${tenantId} order by l.role_id, l.domain`;
  return { counts: c, audits, roleLevels: levels };
}

/** `targets`: fixture labels or ids; empty → the run summary. `recent` → the newest five records per kind. */
export async function collectEvidence(owner, reg, { targets = [], recent = false } = {}) {
  return owner.begin('read only', async (sql) => {
    if (recent) {
      const tenants = Object.values(reg.tenants);
      return {
        customers: await sql`select customer_id as id, name, row_version, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
          from tmpos_customer.customer where tenant_id = any(${tenants}) order by created_at desc nulls last limit 5`,
        drafts: await sql`select draft_id as id, status, version, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
          from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}) order by created_at desc limit 5`,
        invoices: await sql`select invoice_id as id, number::text as number, to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as issued_at
          from tmpos_invoice_issue.issued_invoice where tenant_id = any(${tenants}) order by issued_at desc limit 5`,
      };
    }
    if (targets.length === 0) {
      const [idem] = await sql`select count(*)::int as total, count(*) filter (where response is not null)::int as completed,
          count(*) filter (where response is null)::int as pending from tmpos_internal.idempotency_record`;
      const out = { generation: reg.generation, idempotency: idem, tenants: {} };
      for (const [label, id] of Object.entries(reg.tenants)) out.tenants[label] = { id, ...(await tenantSummary(sql, id)) };
      return out;
    }
    const found = [];
    for (const target of targets) {
      const fixture = reg.customers[target] ?? reg.drafts[target] ?? reg.invoices[target] ?? null;
      const id = fixture ? fixture.id : target;
      if (!UUID.test(id)) {
        found.push({ target, error: 'not a fixture label or a record id' });
        continue;
      }
      const row = (await customerOf(sql, id)) ?? (await draftOf(sql, id)) ?? (await invoiceOf(sql, id));
      found.push(row ? { target, ...row } : { target, error: 'no such customer, draft or issued invoice in this QA database' });
    }
    return found;
  });
}
