import { useCapturesApi } from '~/api/captures'
import { trayItems, TRAY_STATUSES } from '~/features/capture/captureParts'
import { counterLabel } from '~/utils/shellNav'

/**
 * Size of the unsorted tray for the navigation badge. One shared state, so the
 * sidebar and the bottom sheet do not each ask the server. A failed refresh
 * keeps the last number (a badge is a hint, not a source of truth).
 */
export function useUnsortedCount() {
  const count = useState('unsorted-count', () => 0)
  const more = useState('unsorted-count-more', () => false)
  const api = useCapturesApi()
  async function refresh() {
    try {
      const pages = await Promise.all(TRAY_STATUSES.map(status => api.list(status, 0)))
      count.value = trayItems(pages).length
      more.value = pages.some(page => page.captures.length === 50)
    } catch { /* keep the last known count */ }
  }
  const label = computed(() => counterLabel(count.value, more.value))
  return { count, more, label, refresh }
}
