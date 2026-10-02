/**
 * Navigation entries of the shell (W1 structure), shared by the sidebar and
 * the command palette so both offer exactly the same pages with the same rights.
 */
/** The four main areas: the same as the app's tabs. */
export const PRIMARY_NAV_ITEMS = [
  { path: '/', label: 'home', icon: 'inbox' },
  { path: '/strands', label: 'strands', icon: 'chat' },
  { path: '/feed', label: 'feed', icon: 'activity' },
  { path: '/boards', label: 'boards', icon: 'compass' },
] as const
/**
 * Everything else lives in the collapsible System block. `access` keeps the
 * rights exactly as before: projects and memory for everyone, email for
 * admins or when an email account is configured, the rest admin only.
 */
export const SYSTEM_NAV_ITEMS = [
  { path: '/projects', label: 'projects', icon: 'folder', access: 'all' },
  { path: '/memory', label: 'memory', icon: 'brain', access: 'all' },
  { path: '/dashboard', label: 'dashboard', icon: 'dashboard', access: 'admin' },
  { path: '/tasks', label: 'tasks', icon: 'tasks', access: 'admin' },
  { path: '/cronjobs', label: 'cronjobs', icon: 'calendar', access: 'admin' },
  { path: '/logs', label: 'logs', icon: 'logs', access: 'admin' },
  { path: '/usage', label: 'usage', icon: 'trendDown', access: 'admin' },
  { path: '/email', label: 'email', icon: 'mail', access: 'email' },
  { path: '/users', label: 'users', icon: 'users', access: 'admin' },
  { path: '/providers', label: 'providers', icon: 'plug', access: 'admin' },
  { path: '/connectors', label: 'connectors', icon: 'link', access: 'admin' },
  { path: '/skills', label: 'skills', icon: 'puzzle', access: 'admin' },
  { path: '/personas', label: 'personas', icon: 'bot', access: 'admin' },
  { path: '/instructions', label: 'instructions', icon: 'file', access: 'admin' },
  { path: '/settings', label: 'settings', icon: 'settings', access: 'admin' },
] as const
export type SystemNavItem = typeof SYSTEM_NAV_ITEMS[number]
export function navItemAllowed(item: SystemNavItem, rights: { isAdmin: boolean; emailConfigured: boolean }): boolean {
  if (item.access === 'all') return true
  if (item.access === 'email') return rights.isAdmin || rights.emailConfigured
  return rights.isAdmin
}
/**
 * Capture follow-ups (the app reaches them from Home): directly below the main
 * areas on desktop, at the top of the "More" sheet on mobile. `labelKey` is a
 * full i18n key; Unsorted carries the tray counter.
 */
export const CAPTURE_NAV_ITEMS = [
  { path: '/unsorted', labelKey: 'unsorted.navLabel', icon: 'filter', counter: 'unsorted' },
  { path: '/week', labelKey: 'week.navLabel', icon: 'calendar', counter: null },
] as const
export type CaptureNavItem = typeof CAPTURE_NAV_ITEMS[number]
/** Badge text of a counter: nothing at zero, "50+" when the first page was full. */
export function counterLabel(count: number, more: boolean): string {
  if (count <= 0) return ''
  return more ? `${count}+` : String(count)
}
