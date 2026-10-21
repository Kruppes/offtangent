import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The repository has no DOM test harness, so the rename entry is pinned at
// the source: the title itself opens the edit form with the title field
// focused, instead of the detour over "Edit details".
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const header = read('./StrandDetailHeader.vue')
const en = JSON.parse(read('../../i18n/locales/en.json'))
const de = JSON.parse(read('../../i18n/locales/de.json'))

describe('strand detail header, rename by title click', () => {
  it('renders the title as a button inside the h1 that opens the form on the title field', () => {
    const h1 = header.slice(header.indexOf('<h1'), header.indexOf('</h1>'))
    expect(h1).toMatch(/<button v-if="strand" type="button"[^>]*data-strand-title-rename[^>]*@click="edit\('title'\)"/)
    expect(h1).toContain(':disabled="saving"')
    expect(h1).toContain("t('strandDetail.renameHint')")
  })

  it('focuses and selects the title input after the form opened', () => {
    expect(header).toMatch(/<input ref="titleInput" v-model="title" maxlength="200"/)
    const edit = header.slice(header.indexOf('async function edit('), header.indexOf('async function mutate('))
    expect(edit).toMatch(/editing\.value = true[\s\S]*if \(focus === 'title'\) \{[\s\S]*await nextTick\(\)[\s\S]*titleInput\.value\?\.focus\(\)[\s\S]*titleInput\.value\?\.select\(\)/)
  })

  it('keeps the "Edit details" button opening the form without moving focus', () => {
    expect(header).toMatch(/@click="editing \? editing = false : edit\(\)"/)
  })

  it('has the rename hint in both languages', () => {
    expect(en.strandDetail.renameHint).toBe('Rename strand')
    expect(de.strandDetail.renameHint).toBe('Strand umbenennen')
  })
})

describe('strand detail header, auto-title badge (Paket 8)', () => {
  it('has the badge, hint and undo texts in both languages', () => {
    for (const lang of [en, de]) {
      expect(lang.strandDetail.autoTitleBadge).toBe('auto')
      expect(lang.strandDetail.autoTitleHint).toContain('{previous}')
      expect(lang.strandDetail.autoTitleHintNoPrevious).toBeTruthy()
      expect(lang.strandDetail.autoTitleUndo).toBeTruthy()
    }
  })
})

describe('strand search hint', () => {
  it('says that message content and word beginnings are searched', () => {
    expect(en.strandsW3.searchHint).toMatch(/titles and message content/)
    expect(en.strandsW3.searchHint).toMatch(/word beginnings/)
    expect(de.strandsW3.searchHint).toMatch(/Titel und Nachrichteninhalte/)
    expect(de.strandsW3.searchHint).toMatch(/Wortanfänge/)
  })
})

describe('dead thread components', () => {
  it('stay removed; the strand views replaced them', () => {
    for (const name of ['ThreadList', 'ThreadRow', 'ThreadHeader']) {
      expect(existsSync(new URL(`../../components/${name}.vue`, import.meta.url))).toBe(false)
    }
  })
})
