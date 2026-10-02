// M7A-CUSTOMERS-P9 — which customer a draft (an invoice being created) names: none, a customer of this browser's own
// customer list, or a customer saved on the tenant server. One tagged field, so a draft can never hold an active local
// AND an active server reference, and every reader has to say which source it accepts.
//
//   - A local id (`c1`…, `c<ts>`, `c-<ts>`) and a server id (a canonical lowercase UUID) are different things that may
//     never be mistaken for each other: a server reference is never looked up in the local list, never matched to a
//     local customer by name, and its id is a branded type only `serverCustomerReference` makes.
//   - A server reference is what the picker saw under ONE checked session: the server's id and name (the name for
//     display only — never identity), the signed-in user it was chosen by, and an opaque context naming that session.
//     It carries no contact field, no token and nothing of the tenant: a context is compared by identity, never read.
//   - Every reference is frozen: nothing downstream can turn a local reference into a server one or re-point either.

import { isCustomerId, type CustomerEntry } from './customersClient';

declare const serverId: unique symbol;
/** A customer id the tenant server answered; only `serverCustomerReference` makes one. */
export type ServerCustomerId = string & { readonly [serverId]: true };
declare const contextBrand: unique symbol;
/** Which checked tenant session a server customer was chosen under: opaque, compared by identity, no token inside. */
export interface SessionContext { readonly [contextBrand]: true }

export interface NoCustomer { readonly source: 'none' }
/** A customer of this browser's own list, by its local id. */
export interface LocalCustomerReference { readonly source: 'local'; readonly id: string }
export interface ServerCustomerReference {
  readonly source: 'server';
  readonly id: ServerCustomerId;
  readonly name: string; // presentation only — never identity, never matched against local customers
  readonly uid: string; // the signed-in shop user it was chosen under
  readonly context: SessionContext; // the checked tenant session it was chosen under
}
export type DraftCustomerReference = NoCustomer | LocalCustomerReference | ServerCustomerReference;

export const NO_CUSTOMER: NoCustomer = Object.freeze({ source: 'none' });

/** A local customer by id; '' (the select's "Select Customer…") is no customer. */
export function localCustomerReference(id: string): DraftCustomerReference {
  return id === '' ? NO_CUSTOMER : Object.freeze({ source: 'local', id });
}

/**
 * A server customer as one list answer named it, under `uid` and `context`; null unless the id is a server id and the
 * name a non-empty string. Only the id and the name are copied, whatever else the entry carries.
 */
export function serverCustomerReference(entry: CustomerEntry, uid: string, context: SessionContext): ServerCustomerReference | null {
  if (!isCustomerId(entry.id) || typeof entry.name !== 'string' || entry.name === '') return null;
  return Object.freeze({ source: 'server', id: entry.id as ServerCustomerId, name: entry.name, uid, context });
}

/** The local id a draft names, '' for none or for a server customer (never a server id). */
export const localCustomerIdOf = (ref: DraftCustomerReference): string => (ref.source === 'local' ? ref.id : '');
