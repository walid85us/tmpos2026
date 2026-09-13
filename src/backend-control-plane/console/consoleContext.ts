// Phase 4.0 M4 — the console's services (session client, identity provider, Command Center
// client) and the hook that subscribes a component to the published session state.

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AdminIdentityProvider } from './adminIdentity';
import type { AdminSessionClient, SessionState } from './adminSessionClient';
import type { CommandCenterClient } from './commandCenterClient';

export interface ConsoleServices {
  readonly client: AdminSessionClient;
  readonly identity: AdminIdentityProvider;
  readonly commandCenter: CommandCenterClient;
}

/** What a console screen gets: the services, and whether another screen came before it in this page. */
export interface ConsoleValue extends ConsoleServices {
  readonly screens: { shown: boolean };
}

export const ConsoleContext = createContext<ConsoleValue | null>(null);

export function useConsole(): ConsoleValue {
  const services = useContext(ConsoleContext);
  if (services === null) throw new Error('useConsole outside ConsoleProvider');
  return services;
}

export function useSessionState(): SessionState {
  const { client } = useConsole();
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}
