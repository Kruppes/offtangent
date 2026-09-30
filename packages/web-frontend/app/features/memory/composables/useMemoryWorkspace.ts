import type { MemoryTreeNode } from '~/api/memory'
import { useMemoryApi } from '~/api/memory'

type MemoryTab = 'files' | 'facts' | 'stats'

export function useMemoryWorkspace() {
  const memoryApi = useMemoryApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  const activeTab = ref<MemoryTab>('files')
  const tree = ref<MemoryTreeNode[]>([])
  const selectedPath = ref<string | null>(null)
  const fileContent = ref('')
  const searchQuery = ref('')
  const creatingNewFile = ref(false)
  const newFilePath = ref('')
  const newFileInput = ref<HTMLInputElement | null>(null)
  const deleteDialogOpen = ref(false)

  const filteredTree = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return tree.value
    return filterTree(tree.value, query)
  })

  const fileCount = computed(() => countFiles(tree.value))

  const fileTitle = computed(() => {
    const frontmatter = fileContent.value.match(/^---\s*\n([\s\S]*?)\n---/)?.[1]
    const frontmatterTitle = frontmatter?.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
    const heading = fileContent.value.match(/^#\s+(.+)$/m)?.[1]?.trim()
    return frontmatterTitle || heading || selectedPath.value?.split('/').pop() || ''
  })

  function clearMessages() {
    error.value = null
    successMessage.value = null
  }

  async function refreshTree() {
    loading.value = true
    try {
      tree.value = (await memoryApi.listFiles()).files
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function openFile(path: string) {
    clearMessages()
    creatingNewFile.value = false
    selectedPath.value = path
    loading.value = true
    try {
      fileContent.value = (await memoryApi.getFile(path)).content
    } catch (err) {
      error.value = (err as Error).message
      fileContent.value = ''
    } finally {
      loading.value = false
    }
  }

  function closeFile() {
    selectedPath.value = null
    fileContent.value = ''
    clearMessages()
  }

  async function handleSaveFile() {
    if (!selectedPath.value) return

    saving.value = true
    clearMessages()
    try {
      await memoryApi.updateFile(selectedPath.value, fileContent.value)
      successMessage.value = 'saved'
      await refreshTree()
      autoHideSuccess()
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      saving.value = false
    }
  }

  function startNewFile() {
    clearMessages()
    creatingNewFile.value = true
    newFilePath.value = ''
    selectedPath.value = null
    fileContent.value = ''

    nextTick(() => {
      newFileInput.value?.focus()
    })
  }

  function cancelNewFile() {
    creatingNewFile.value = false
    newFilePath.value = ''
  }

  async function confirmNewFile() {
    let path = newFilePath.value.trim().replace(/^\/+/, '').replace(/\s+/g, '-')
    if (!path) return
    if (!path.endsWith('.md')) path += '.md'

    const segments = path.split('/').filter((segment) => segment.length > 0)
    if (!segments.every((segment) => /^[\w][\w.-]*$/.test(segment))) {
      error.value = 'Path may only contain letters, digits, hyphens, underscores, and dots (no leading dots).'
      return
    }

    path = segments.join('/')
    creatingNewFile.value = false
    newFilePath.value = ''
    selectedPath.value = path
    fileContent.value = `# ${(segments.at(-1) ?? '').replace(/\.md$/, '')}\n\n`

    await handleSaveFile()
  }

  function confirmDelete() {
    deleteDialogOpen.value = true
  }

  async function handleDeleteFile() {
    deleteDialogOpen.value = false
    if (!selectedPath.value) return

    try {
      await memoryApi.deleteFile(selectedPath.value)
      closeFile()
      await refreshTree()
    } catch (err) {
      error.value = (err as Error).message
    }
  }

  function autoHideSuccess() {
    setTimeout(() => {
      successMessage.value = null
    }, 3000)
  }

  onMounted(refreshTree)

  return {
    loading,
    saving,
    error,
    successMessage,
    clearMessages,
    activeTab,
    tree,
    filteredTree,
    fileCount,
    selectedPath,
    fileContent,
    fileTitle,
    searchQuery,
    creatingNewFile,
    newFilePath,
    newFileInput,
    deleteDialogOpen,
    openFile,
    closeFile,
    handleSaveFile,
    startNewFile,
    cancelNewFile,
    confirmNewFile,
    confirmDelete,
    handleDeleteFile,
  }
}

function filterTree(nodes: MemoryTreeNode[], query: string): MemoryTreeNode[] {
  const result: MemoryTreeNode[] = []

  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.path.toLowerCase().includes(query)) result.push(node)
      continue
    }

    const children = filterTree(node.children ?? [], query)
    if (children.length > 0) result.push({ ...node, children })
  }

  return result
}

function countFiles(nodes: MemoryTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.type === 'file' ? 1 : countFiles(node.children ?? [])), 0)
}
