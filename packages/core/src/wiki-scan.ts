/**
 * Wiki file scan shared by the memory view and the page embedding index.
 * Pure filesystem reading: directories, file names, the first `# ` heading,
 * frontmatter aliases and links between pages. No taxonomy is invented here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { getMemoryDir, parseProjectAliases } from './memory.js'

/** Directory recursion limit for the wiki scan. */
export const WIKI_MAX_DEPTH = 4
/** Hard limit on scanned wiki files. */
export const WIKI_MAX_PAGES = 500

export interface WikiPageEntry {
  id: string
  relPath: string
  name: string
  title: string
  aliases: string[]
  dir: string | null
  modifiedAt: string
  linksOut: string[]
}

export function wikiDirFor(memoryDir?: string): string {
  return path.join(memoryDir ?? getMemoryDir(), 'wiki')
}

export function listWikiFiles(wikiDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > WIKI_MAX_DEPTH || found.length >= WIKI_MAX_PAGES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sorted) {
      if (found.length >= WIKI_MAX_PAGES) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full)
    }
  }
  walk(wikiDir, 0)
  return found
}

export function pageIdFor(relPath: string): string {
  return `wiki:${relPath.replace(/\.md$/, '')}`
}

export function folderIdFor(dir: string): string {
  return `folder:${dir}`
}

export function humanize(name: string): string {
  return name.replace(/[-_]+/g, ' ').trim()
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : fallback
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?\n---/)
  return match ? content.slice(match[0].length) : content
}

function extractLinkTargets(content: string): string[] {
  const targets: string[] = []
  const body = stripFrontmatter(content)
  const markdownLink = /\[[^\]]*\]\(([^)\s]+)\)/g
  let match: RegExpExecArray | null
  while ((match = markdownLink.exec(body)) !== null) {
    targets.push(match[1])
  }
  const wikiLink = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
  while ((match = wikiLink.exec(body)) !== null) {
    targets.push(match[1])
  }
  return targets
}

export function scanWikiPages(memoryDir?: string): WikiPageEntry[] {
  const wikiDir = wikiDirFor(memoryDir)
  if (!fs.existsSync(wikiDir)) return []

  const files = listWikiFiles(wikiDir)
  const byRelPath = new Map<string, { entry: WikiPageEntry; rawTargets: string[] }>()

  for (const file of files) {
    const relPath = path.relative(wikiDir, file).split(path.sep).join('/')
    let content = ''
    let modifiedAt = new Date(0).toISOString()
    try {
      content = fs.readFileSync(file, 'utf-8')
      modifiedAt = fs.statSync(file).mtime.toISOString()
    } catch {
      continue
    }
    const name = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.md$/, '')
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : null
    byRelPath.set(relPath, {
      entry: {
        id: pageIdFor(relPath),
        relPath,
        name,
        title: extractTitle(content, humanize(name)),
        aliases: parseProjectAliases(content),
        dir,
        modifiedAt,
        linksOut: [],
      },
      rawTargets: extractLinkTargets(content),
    })
  }

  for (const { entry, rawTargets } of byRelPath.values()) {
    const resolved = new Set<string>()
    for (const raw of rawTargets) {
      if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith('#')) continue
      const cleaned = raw.split('#')[0].trim()
      if (!cleaned) continue
      const withExt = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`
      const candidates = entry.dir
        ? [`${entry.dir}/${withExt}`, withExt]
        : [withExt]
      for (const candidate of candidates) {
        const normalized = path.posix.normalize(candidate).replace(/^\.\//, '')
        if (normalized !== entry.relPath && byRelPath.has(normalized)) {
          resolved.add(normalized)
          break
        }
      }
    }
    entry.linksOut = [...resolved].sort()
  }

  return [...byRelPath.values()].map(v => v.entry).sort((a, b) => a.relPath.localeCompare(b.relPath))
}
