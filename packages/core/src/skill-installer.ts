import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { parseSkillMd, type ParsedSkill } from './skill-parser.js'

/**
 * Represents a parsed source for skill installation
 */
export interface SkillSource {
  type: 'openclaw' | 'github'
  owner: string
  name: string
  apiUrl: string
  sourceUrl: string
}

/**
 * Result of a skill installation
 */
export interface SkillInstallResult {
  source: SkillSource
  installPath: string
  parsed: ParsedSkill
  filesDownloaded: number
}

/**
 * A file entry from the GitHub Contents API response
 */
interface GitHubContentEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  download_url: string | null
  url: string
}

/**
 * Parse an input string into a SkillSource.
 * Supports:
 * - OpenClaw shorthand: "owner/name"
 * - GitHub URLs: https://github.com/owner/repo/tree/branch/path/to/skill
 */
export function parseSkillSource(input: string): SkillSource {
  input = input.trim()

  // Normalize /blob/ to /tree/ — skills are always directories
  input = input.replace(
    /^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//,
    '$1/tree/'
  )

  // Check if it's a GitHub URL
  const githubMatch = input.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/(.+))?$/
  )

  if (githubMatch) {
    const [, repoOwner, repoName, branch, dirPath] = githubMatch

    if (!branch || !dirPath) {
      throw new Error(
        `Invalid GitHub URL: must include branch and directory path (e.g. https://github.com/owner/repo/tree/main/path/to/skill)`
      )
    }

    // Derive skill name from the last segment of the path
    const pathParts = dirPath.replace(/\/+$/, '').split('/')
    const skillName = pathParts[pathParts.length - 1]

    return {
      type: 'github',
      owner: repoOwner,
      name: skillName,
      apiUrl: `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${dirPath}?ref=${branch}`,
      sourceUrl: `https://github.com/${repoOwner}/${repoName}/tree/${branch}/${dirPath}`,
    }
  }

  // Check for OpenClaw shorthand: owner/name (no slashes beyond one)
  const shorthandMatch = input.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/)
  if (shorthandMatch) {
    const [, owner, name] = shorthandMatch
    return {
      type: 'openclaw',
      owner,
      name,
      apiUrl: `https://api.github.com/repos/openclaw/skills/contents/skills/${owner}/${name}`,
      sourceUrl: `https://github.com/openclaw/skills/tree/main/skills/${owner}/${name}`,
    }
  }

  throw new Error(
    `Invalid skill source "${input}": use "owner/name" for OpenClaw or a full GitHub URL`
  )
}

/**
 * Get the base directory for skill installations
 */
function getSkillsDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'skills')
}

/**
 * Fetch function type — allows injection for testing
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Download a skill directory recursively from GitHub Contents API.
 */
export async function downloadSkillDirectory(
  apiUrl: string,
  destDir: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<number> {
  const response = await fetchFn(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Axiom-Skill-Installer',
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API error (${response.status}): ${body}`)
  }

  const entries = (await response.json()) as GitHubContentEntry[]

  if (!Array.isArray(entries)) {
    throw new Error('GitHub API did not return a directory listing. Is the path correct?')
  }

  fs.mkdirSync(destDir, { recursive: true })

  let filesDownloaded = 0

  for (const entry of entries) {
    if (entry.type === 'file' && entry.download_url) {
      // Download the file
      const fileResponse = await fetchFn(entry.download_url)
      if (!fileResponse.ok) {
        throw new Error(`Failed to download ${entry.name}: ${fileResponse.status}`)
      }

      const content = Buffer.from(await fileResponse.arrayBuffer())
      const filePath = path.join(destDir, entry.name)
      fs.writeFileSync(filePath, content)
      filesDownloaded++
    } else if (entry.type === 'dir') {
      // Recursively download subdirectory
      const subDir = path.join(destDir, entry.name)
      const subCount = await downloadSkillDirectory(entry.url, subDir, fetchFn)
      filesDownloaded += subCount
    }
  }

  return filesDownloaded
}

/**
 * Install a skill from an OpenClaw shorthand or GitHub URL.
 *
 * Downloads the skill directory, parses SKILL.md, and returns metadata.
 */
export async function installSkill(
  input: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SkillInstallResult> {
  const source = parseSkillSource(input)

  // Determine install path
  const installPath = path.join(getSkillsDir(), source.owner, source.name)

  // Clean existing installation if present
  if (fs.existsSync(installPath)) {
    fs.rmSync(installPath, { recursive: true, force: true })
  }

  // Download the skill directory
  const filesDownloaded = await downloadSkillDirectory(source.apiUrl, installPath, fetchFn)

  // Parse SKILL.md
  const skillMdPath = path.join(installPath, 'SKILL.md')
  if (!fs.existsSync(skillMdPath)) {
    // Clean up on failure
    fs.rmSync(installPath, { recursive: true, force: true })
    throw new Error('Downloaded directory does not contain a SKILL.md file')
  }

  const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')
  const parsed = parseSkillMd(skillMdContent)

  return {
    source,
    installPath,
    parsed,
    filesDownloaded,
  }
}

/**
 * Result of a skill upload (zip/skill file)
 */
export interface SkillUploadResult {
  installPath: string
  parsed: ParsedSkill
  filesExtracted: number
  owner: string
  name: string
}

/**
 * Count files recursively in a directory
 */
function countFiles(dir: string): number {
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) count++
    else if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name))
  }
  return count
}

/**
 * Install a skill from a .zip or .skill file buffer.
 *
 * The zip may contain SKILL.md at the root or inside a single subdirectory.
 * The skill is installed under DATA_DIR/skills/uploaded/<skill-name>.
 */
export function installSkillFromZip(
  fileBuffer: Buffer,
  originalFilename?: string,
): SkillUploadResult {
  const zip = new AdmZip(fileBuffer)
  const zipEntries = zip.getEntries()

  if (zipEntries.length === 0) {
    throw new Error('The uploaded archive is empty')
  }

  // Extract to a temp directory first
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-upload-'))

  try {
    zip.extractAllTo(tmpDir, true)

    // Find SKILL.md — either at root or one level deep
    let skillRoot = tmpDir
    const rootSkillMd = path.join(tmpDir, 'SKILL.md')

    if (!fs.existsSync(rootSkillMd)) {
      // Check if there's a single subdirectory containing SKILL.md
      const entries = fs.readdirSync(tmpDir, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('__MACOSX'))
      const files = entries.filter(e => e.isFile())

      if (dirs.length === 1 && files.length === 0) {
        const subDir = path.join(tmpDir, dirs[0].name)
        if (fs.existsSync(path.join(subDir, 'SKILL.md'))) {
          skillRoot = subDir
        }
      }

      if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) {
        throw new Error('Archive does not contain a SKILL.md file (checked root and single subdirectory)')
      }
    }

    // Parse SKILL.md
    const skillMdContent = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf-8')
    const parsed = parseSkillMd(skillMdContent)

    // Determine owner and name
    const owner = 'uploaded'
    const name = parsed.name || (originalFilename
      ? path.basename(originalFilename, path.extname(originalFilename)).toLowerCase().replace(/[^a-z0-9-]/g, '-')
      : 'unknown-skill')

    // Move to final install path
    const installPath = path.join(getSkillsDir(), owner, name)

    // Clean existing installation if present
    if (fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true })
    }

    fs.mkdirSync(path.dirname(installPath), { recursive: true })
    fs.cpSync(skillRoot, installPath, { recursive: true })

    const filesExtracted = countFiles(installPath)

    return {
      installPath,
      parsed,
      filesExtracted,
      owner,
      name,
    }
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
