/** Sidebar toggle icon: one silhouette, the open state fills the side area. */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SidebarStateIcon from './SidebarStateIcon.vue'

const render = (open: boolean) => renderToString(createSSRApp({ render: () => h(SidebarStateIcon, { open }) }))

describe('SidebarStateIcon', () => {
  it('fills the side area with currentColor while open', async () => {
    const html = await render(true)
    expect(html).toContain('data-state="open"')
    expect(html).toMatch(/data-part="side"[^>]*fill="currentColor"/)
  })
  it('keeps only the outline while closed, with the same frame and stroke', async () => {
    const open = await render(true)
    const closed = await render(false)
    expect(closed).toContain('data-state="closed"')
    expect(closed).not.toContain('data-part="side"')
    const frame = (html: string) => html.match(/<rect[^>]*data-part="frame"[^>]*>/)?.[0]
    expect(frame(closed)).toBeTruthy()
    expect(frame(closed)).toBe(frame(open))
    for (const html of [open, closed]) expect(html).toContain('stroke-width="1.8"')
  })
  it('is hidden from assistive technology, the button carries the state', async () => {
    expect(await render(false)).toContain('aria-hidden="true"')
  })
})
