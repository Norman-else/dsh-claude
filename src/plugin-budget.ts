/**
 * The plugin's connection budget, in one table.
 *
 * A browser opens a small fixed number of connections to one origin — six for
 * HTTP/1.1 in Chromium — and shares them with the Host's own traffic. Every
 * response this plugin holds open costs one of them for its lifetime, and a
 * request that cannot get one waits in the browser's queue where no server-side
 * deadline can reach it. When the pool is exhausted the panels that would
 * *diagnose* the problem are the first thing to stop answering, which is how
 * this failure has always presented: four settings cards timing out at once
 * against a Host that is demonstrably healthy.
 *
 * So the budget is a fixed constant rather than a function of how much work is
 * in flight. Steady state is one connection (the multiplexed projection
 * carrier); the peak is `PLUGIN_GLOBAL_PERMITS`, whatever the session count.
 *
 * Both halves read this file, which is the point: a route declares a budget
 * class and the client derives its wait from the same entry, so a server
 * deadline can never be quietly longer than the client's patience.
 */

/** Server-side budget classes. A route declares a class, never a number. */
export const ROUTE_BUDGET_MS = {
  /** Answers from memory or a single bounded probe. */
  fast: 5_000,
  /** Chains local Git work. */
  git: 45_000,
  /** Reaches the network: remote Git, `gh`, the npm registry. */
  remote: 150_000,
} as const

export type RouteBudget = keyof typeof ROUTE_BUDGET_MS

/** The client waits one round trip longer, so the route's own 504 wins the
 *  race and the caller learns which budget elapsed instead of guessing. */
export const CLIENT_GRACE_MS = 3_000

export function clientBudgetMs(budget: RouteBudget): number {
  return ROUTE_BUDGET_MS[budget] + CLIENT_GRACE_MS
}

/** A request that never got a permit fails fast and says so, rather than
 *  spending its whole budget queued behind work it cannot see. */
export const QUEUE_WAIT_BUDGET_MS = 4_000

/** Connections this plugin may hold at once, across every lane. */
export const PLUGIN_GLOBAL_PERMITS = 4

/** Per-lane ceilings inside the global budget.
 *
 *  The projection carrier holds a permanently reserved permit outside these,
 *  so three remain. `write + stream <= 2` leaves one permit that only a read
 *  can take: a diagnostic read always has somewhere to go, however many slow
 *  actions are in flight. That invariant is what stops a 150s repository
 *  action from reproducing the original symptom through a new mechanism. */
export const PLUGIN_LANE_CAPS = { read: 2, write: 1, stream: 1 } as const

export type PluginLane = keyof typeof PLUGIN_LANE_CAPS

/** Both halves cap the multiplex at the same number. */
export const MAX_MULTIPLEX_SESSIONS = 16
