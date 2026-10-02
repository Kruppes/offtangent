import { useCapturesApi } from '~/api/captures'
import { trayCount, trayItems, TRAY_STATUSES } from '~/features/capture/captureParts'
import { counterLabel } from '~/utils/shellNav'

/**
 * Size of the unsorted tray for the navigation badge. One shared state, so the
 * sidebar and the bottom sheet do not each ask the server. A failed refresh
 * keeps the last number (a badge is a hint, not a source of truth). The
 * number is the backend's exact `total` when present, else "50+" style.
 */
export function useUnsortedCount() {
  const count = useState('unsorted-count', () => 0)
  const more = useState('unsorted-count-more', () => false)
  const api = useCapturesApi()
  async function refresh() {
    try {
      const pages = await Promise.all(TRAY_STATUSES.map(status => api.list(status, 0)))
      const counted = trayCount(pages, trayItems(pages).length)
      count.value = counted.count
      more.value = counted.more
    } catch { /* keep the last known count */ }
  }
  const label = computed(() => counterLabel(count.value, more.value))
  return { count, more, label, refresh }
}
