// The page table: one route line per page, nothing else; each page's module loads on demand as its own chunk. This file merges with git's union driver
// (.gitattributes), so parallel tasks that each add a page never conflict. Shared routing (redirects, loaders that
// compose several modules) stays in routes.jsx.

// Under /:repo. Code stays the first row: its route id is 0-1-0. Add rows at the end.
export const repoPages = [
  { path: "code/:ref/*", lazy: () => import("./code.jsx").then((m) => ({ element: <m.Code />, loader: m.codeLoader, action: m.codeAction, shouldRevalidate: m.codeRevalidate })) },
  { path: "settings", lazy: () => import("./settings.jsx").then((m) => ({ element: <m.Settings />, loader: m.settingsLoader })) },
  { path: "insights", lazy: () => import("./insights.jsx").then((m) => ({ element: <m.Insights />, loader: m.insightsLoader })) },
  { path: "environments", lazy: () => import("./environments.jsx").then((m) => ({ element: <m.Environments />, hydrateFallbackElement: <m.EnvironmentsLoading />, loader: m.environmentsLoader, action: m.environmentsAction })) },
  { path: "watchtower", lazy: () => import("./watchtower.jsx").then((m) => ({ element: <m.Watchtower />, loader: m.watchtowerLoader, action: m.watchtowerAction, shouldRevalidate: m.watchtowerRevalidate })) },
  { path: "flows", lazy: () => import("./flows.jsx").then((m) => ({ element: <m.Flows />, hydrateFallbackElement: <m.FlowsSkeleton />, loader: m.flowsLoader })) },
  { path: "releases", lazy: () => import("./releases.jsx").then((m) => ({ element: <m.Releases />, hydrateFallbackElement: <m.ReleasesLoading />, loader: m.releasesLoader, action: m.releasesAction })) },
  { path: "changes/collisions", lazy: () => import("./collisions.jsx").then((m) => ({ element: <m.Collisions /> })) },
  { path: "flows/runs/:id", lazy: () => import("./flow-run.jsx").then((m) => ({ element: <m.FlowRun />, loader: m.flowRunLoader })) },
];

// Repo pages reached without a repo (/<page>) follow the viewer's last repo, else ask for one.
export const scoped = [
  "code",
  "changes",
  "changes/new",
  "changes/collisions",
  "settings",
  "environments",
  "insights",
  "flows",
  "releases",
];

// Top level, outside any repo.
export const pages = [
  { path: "/wiki/:repo/:id?", lazy: () => import("./wiki.jsx").then((m) => ({ element: <m.Wiki />, loader: m.wikiLoader, action: m.wikiAction })) },
  { path: "/automation/workers", lazy: () => import("./runners.jsx").then((m) => ({ element: <m.Workers />, hydrateFallbackElement: <m.WorkersLoading />, loader: m.workersLoader, action: m.workersAction })) },
  { path: "/settings/keystore", lazy: () => import("./keystore.jsx").then((m) => ({ element: <m.Keystore />, hydrateFallbackElement: <m.KeystoreLoading />, loader: m.keystoreLoader })) },
  { path: "/settings/access", lazy: () => import("./access.jsx").then((m) => ({ element: <m.Access />, hydrateFallbackElement: <m.AccessLoading />, loader: m.accessLoader })) },
  { path: "/me/models", lazy: () => import("./models.jsx").then((m) => ({ element: <m.Models />, hydrateFallbackElement: <m.ModelsLoading />, loader: m.modelsLoader })) },
  { path: "/automation/judges/:id?", lazy: () => import("./judges.jsx").then((m) => ({ element: <m.Judges />, hydrateFallbackElement: <m.JudgesLoading />, loader: m.judgesLoader })) },
  { path: "/automation/agents", lazy: () => import("./automation-agents.jsx").then((m) => ({ element: <m.Agents />, hydrateFallbackElement: <m.AgentsLoading />, loader: m.agentsLoader })) },
  { path: "/automation/agents/:name/:tab?", lazy: () => import("./automation-agents.jsx").then((m) => ({ element: <m.Agent />, hydrateFallbackElement: <m.AgentLoading />, loader: m.agentLoader })) },
  { path: "/automation/marketplace", lazy: () => import("./marketplace.jsx").then((m) => ({ element: <m.Marketplace />, loader: m.marketplaceLoader })) },
  { path: "/needs", lazy: () => import("./needs.jsx").then((m) => ({ element: <m.Needs />, hydrateFallbackElement: <m.NeedsLoading />, loader: m.needsLoader, action: m.needsAction })) },
];
