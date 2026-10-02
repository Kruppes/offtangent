/**
 * Overview <-> strand transition (W4d) with the View Transitions API
 * (same-document).
 *
 * Why a plugin of our own and not Nuxt's `experimental.viewTransition`: that
 * option wraps EVERY page change of the app in a transition (opt-out per page
 * meta) and knows neither the direction nor which row should morph. Here only
 * `/strands` <-> `/strands/:id` animates (see `utils/strandTransition.ts`),
 * from 768 px up, never with `prefers-reduced-motion: reduce`, and browsers
 * without `document.startViewTransition` simply switch at once.
 *
 * Flow: `router.beforeResolve` names the one row that morphs, starts the
 * transition and lets the navigation continue inside its update callback;
 * the callback resolves once Vue has rendered the new route (after the next
 * ticks, or `page:finish`, with a safety timeout so a stuck render can never
 * freeze the page). CSS for the animation lives in `assets/css/tailwind.css`
 * under `html[data-strand-transition]`.
 */
import { nextTick } from 'vue'
import { STRAND_ROW_TRANSITION_NAME, morphingStrandId, strandTransition } from '~/utils/strandTransition'

type ViewTransitionLike = { finished: Promise<void>; skipTransition: () => void }
type StartViewTransition = (update: () => Promise<void>) => ViewTransitionLike

/** Upper bound for the DOM update inside the transition (the browser itself gives up after a few seconds). */
const UPDATE_TIMEOUT_MS = 400

export default defineNuxtPlugin((nuxtApp) => {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition
  let uaTransition = false
  let current: ViewTransitionLike | null = null
  let finishUpdate: (() => void) | null = null
  // Safari/Chrome back-swipe already animate the page; never stack ours on it.
  window.addEventListener('popstate', (event) => {
    uaTransition = Boolean((event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition)
    if (uaTransition) current?.skipTransition()
  })

  const router = useRouter()
  router.beforeResolve((to, from) => {
    const direction = strandTransition({
      supported: typeof start === 'function',
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      viewport: window.innerWidth,
      fromPath: from.path,
      toPath: to.path,
    })
    const skipUa = uaTransition
    uaTransition = false
    if (!direction || skipUa) return

    // The morphing row: exactly one element may carry the name.
    const id = morphingStrandId(from.path, to.path)
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="strand-row"]')) {
      el.style.viewTransitionName = el.dataset.strandId === id ? STRAND_ROW_TRANSITION_NAME : ''
    }
    const root = document.documentElement
    root.dataset.strandTransition = direction

    let continueNavigation!: () => void
    const navigationMayContinue = new Promise<void>((resolve) => { continueNavigation = resolve })
    const updated = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, UPDATE_TIMEOUT_MS)
      finishUpdate = () => { clearTimeout(timer); finishUpdate = null; resolve() }
    })
    try {
      current = start!.call(document, () => { continueNavigation(); return updated })
    } catch {
      delete root.dataset.strandTransition
      finishUpdate?.()
      return
    }
    current.finished.catch(() => {}).finally(() => {
      current = null
      delete root.dataset.strandTransition
    })
    return navigationMayContinue
  })

  // The new route is in the DOM after the navigation's render flush.
  router.afterEach(async () => {
    if (!finishUpdate) return
    await nextTick()
    await nextTick()
    finishUpdate?.()
  })
  router.onError(() => { finishUpdate?.(); current?.skipTransition() })
  nuxtApp.hook('page:finish', () => { finishUpdate?.() })
  nuxtApp.hook('vue:error', () => { finishUpdate?.(); current?.skipTransition() })
})
