/**
 * Favorite agent kinds (`settings.agentFavorites`): the creation dialogs' picker lists them right
 * after Shell. Favoriting never selects anything; the picker's own choice stays where it was.
 */

import type { AgentKind } from "../../shared/protocol.ts";

/** The agents with the favorites first; each group keeps the order the server lists them in. */
export function favoritesFirst(agents: readonly AgentKind[], favorites: readonly string[]): AgentKind[] {
  return [...agents.filter((agent) => favorites.includes(agent.kind)), ...agents.filter((agent) => !favorites.includes(agent.kind))];
}

/** The favorites with `kind` added, or taken out when it is one; Shell ("") is never a favorite. */
export function toggleFavorite(favorites: readonly string[], kind: string): string[] {
  if (!kind) return [...favorites];
  return favorites.includes(kind) ? favorites.filter((favorite) => favorite !== kind) : [...favorites, kind];
}
