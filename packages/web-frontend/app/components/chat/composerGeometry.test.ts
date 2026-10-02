import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Composer geometry contract (W6c). The browser measurement found the
// controls off the input line by up to 4.5 px: the strand page lifts every
// button and textarea to min 44 px (pages/strands/[id].vue), while the
// composer still placed 28 px buttons with a 7 px bottom margin and 42 px
// side buttons next to a bordered (44 + 2 px) box. The fix gives every part
// one height, so all centres share one line. These tests keep that geometry
// in the markup; the pixel check itself is the Playwright measurement.
const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const template = (path: string) => {
  const text = src(path)
  return text.slice(text.indexOf('<template>'), text.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '')
}
const classOf = (tag: string) => tag.match(/\sclass="([^"]*)"/)?.[1] ?? ''
const openTag = (html: string, marker: RegExp) => {
  const at = html.search(marker)
  expect(at, String(marker)).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf('<', at)
  return html.slice(start, html.indexOf('>', at) + 1)
}
const PX: Record<string, number> = { '3': 12, '5': 20, '11': 44 }
const tw = (cls: string, prefix: string) => {
  const m = cls.split(/\s+/).find(c => c.startsWith(prefix))
  return m ? PX[m.slice(prefix.length)] : undefined
}

const composer = template('./ChatComposer.vue')
const picker = template('./ChatThinkingLevelPicker.vue')

describe('composer geometry (W6c)', () => {
  const box = classOf(openTag(composer, /data-composer-box/))
  const textarea = classOf(openTag(composer, /<textarea/))
  const controls = {
    thinking: classOf(openTag(picker, /data-composer-control="thinking"/)),
    attach: classOf(openTag(composer, /data-composer-control="attach"/)),
    mic: classOf(openTag(composer, /data-testid="dictation-mic"/)),
    send: classOf(openTag(composer, /type="submit"/)),
  }

  it('the single-line textarea is exactly as high as its padding plus one line', () => {
    const pad = tw(textarea, 'py-')!
    const line = tw(textarea, 'leading-')!
    const min = tw(textarea, 'min-h-')!
    expect(pad * 2 + line).toBe(min)
    expect(min).toBe(44)
  })

  it('the box outline adds no height (ring, not border), so the box is as high as the textarea', () => {
    expect(box).toMatch(/(^|\s)ring-1(\s|$)/)
    expect(box).not.toMatch(/(^|\s)border(\s|-input|$)/)
    expect(box).toMatch(/(^|\s)items-end(\s|$)/)
  })

  it('every control has the same 44 px height on every width and no offset margin', () => {
    for (const [name, cls] of Object.entries(controls)) {
      expect(tw(cls, 'h-'), `${name} height`).toBe(tw(textarea, 'min-h-'))
      expect(cls, name).not.toMatch(/(^|\s)(max-|sm:|md:)*(mb|mt|my)-/)
      expect(cls, name).not.toMatch(/(^|\s)(max-sm|max-md|sm|md|lg):h-/)
    }
    for (const name of ['thinking', 'attach', 'mic'] as const) {
      expect(controls[name], name).toMatch(/(^|\s)w-11(\s|$)/)
      expect(controls[name], name).toMatch(/items-center/)
      expect(controls[name], name).toMatch(/justify-center/)
    }
  })

  it('the row bottom-aligns the controls, so with several lines they sit on the last one', () => {
    const row = classOf(openTag(composer, /<div class="flex items-end gap-2">/))
    expect(row).toMatch(/items-end/)
  })
})
