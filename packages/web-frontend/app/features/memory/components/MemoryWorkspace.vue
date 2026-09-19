<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('memory.title')" :subtitle="$t('memory.subtitle')" />

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6">
      <!-- Error / success banners -->
      <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('memory.saveSuccess') }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList class="mb-4 shrink-0 self-start">
          <TabsTrigger value="files">{{ $t('memory.filesTab') }}</TabsTrigger>
          <TabsTrigger value="facts">{{ $t('memory.factsTab') }}</TabsTrigger>
          <TabsTrigger value="stats">{{ $t('memory.statsTab') }}</TabsTrigger>
        </TabsList>

        <!-- Files tab -->
        <TabsContent value="files" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div class="flex min-h-0 flex-1 gap-4 overflow-hidden">
            <!-- Sidebar: file tree -->
            <aside class="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border">
              <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
                <input
                  v-model="searchQuery"
                  type="text"
                  :placeholder="$t('memory.searchPlaceholder')"
                  class="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                >
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 shrink-0"
                  :aria-label="$t('memory.newFile')"
                  :title="$t('memory.newFile')"
                  @click="startNewFile"
                >
                  <AppIcon name="add" class="h-4 w-4" />
                </Button>
              </div>

              <div class="flex-1 overflow-y-auto py-1">
                <div v-if="loading && tree.length === 0" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  {{ $t('memory.loading') }}
                </div>
                <div v-else-if="filteredTree.length === 0" class="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground">
                  <AppIcon name="file" size="xl" class="h-8 w-8 opacity-40" />
                  <p class="text-xs">{{ searchQuery ? $t('memory.noResults') : $t('memory.empty') }}</p>
                </div>
                <MemoryFileTreeItem
                  v-for="node in filteredTree"
                  :key="node.path"
                  :node="node"
                  :selected-path="selectedPath"
                  :force-open="Boolean(searchQuery.trim())"
                  @select="openFile"
                />
              </div>

              <div class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                {{ $t('memory.fileCount', { count: fileCount }) }}
              </div>
            </aside>

            <!-- Content area -->
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
              <!-- New file creation form -->
              <div v-if="creatingNewFile" class="mb-3 flex shrink-0 items-center gap-2">
                <Button variant="outline" size="icon" class="h-8 w-8 shrink-0" :aria-label="$t('common.cancel')" @click="cancelNewFile">
                  <AppIcon name="arrowLeft" class="h-4 w-4" />
                </Button>
                <input
                  ref="newFileInput"
                  v-model="newFilePath"
                  type="text"
                  :placeholder="$t('memory.newFilePlaceholder')"
                  class="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                  @keydown.enter="confirmNewFile"
                  @keydown.escape="cancelNewFile"
                >
                <Button size="sm" :disabled="!newFilePath.trim()" @click="confirmNewFile">
                  {{ $t('memory.createFile') }}
                </Button>
              </div>

              <!-- Editor header when file is selected -->
              <div v-else-if="selectedPath" class="mb-3 flex shrink-0 flex-wrap items-center gap-2">
                <Button variant="outline" size="icon" class="h-8 w-8" :aria-label="$t('memory.closeFile')" @click="closeFile">
                  <AppIcon name="arrowLeft" class="h-4 w-4" />
                </Button>
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-base font-bold text-foreground">{{ fileTitle }}</span>
                  <p class="text-xs text-muted-foreground">{{ $t('memory.editorDescription') }}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8 text-destructive hover:text-destructive"
                  :aria-label="$t('memory.deleteFile')"
                  :title="$t('memory.deleteFile')"
                  @click="confirmDelete"
                >
                  <AppIcon name="trash" class="h-4 w-4" />
                </Button>
              </div>

              <!-- Empty state -->
              <div v-if="!selectedPath && !creatingNewFile" class="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <AppIcon name="file" size="xl" class="h-12 w-12 opacity-30" />
                <div>
                  <p class="font-medium text-foreground/70">{{ $t('memory.selectFileTitle') }}</p>
                  <p class="mt-1 text-sm">{{ $t('memory.selectFileDescription') }}</p>
                </div>
                <Button variant="outline" size="sm" @click="startNewFile">
                  <AppIcon name="add" class="mr-2 h-4 w-4" />
                  {{ $t('memory.newFile') }}
                </Button>
              </div>

              <!-- Loading content -->
              <div v-else-if="loading && selectedPath" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
                {{ $t('memory.loading') }}
              </div>

              <!-- Editor -->
              <div v-else-if="selectedPath" class="flex min-h-0 flex-1 flex-col overflow-hidden">
                <MarkdownEditor
                  v-model="fileContent"
                  :saving="saving"
                  :file-path="`/data/memory/${selectedPath}`"
                  @save="handleSaveFile"
                />
              </div>
            </div>
          </div>
        </TabsContent>

        <!-- Facts tab -->
        <TabsContent value="facts" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <MemoryFactsTab />
        </TabsContent>

        <!-- Stats tab -->
        <TabsContent value="stats" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <MemoryStatsTab />
        </TabsContent>
      </Tabs>
    </div>

    <!-- Delete confirmation dialog -->
    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="$t('memory.deleteConfirmTitle')"
      :description="$t('memory.deleteConfirmDescription', { name: selectedPath ?? '' })"
      :confirm-label="$t('common.delete')"
      variant="destructive"
      @confirm="handleDeleteFile"
    />
  </div>
</template>

<script setup lang="ts">
import MemoryFileTreeItem from '~/features/memory/components/MemoryFileTreeItem.vue'
import { useMemoryWorkspace } from '~/features/memory/composables/useMemoryWorkspace'

const {
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
} = useMemoryWorkspace()
</script>
