import type { ToolCallData } from '~/composables/useChat'
import { useSkillDetection } from '~/composables/useSkillDetection'
import {
  detectMemoryFile,
  extractEditsFromArgs,
  extractMemoryFileName,
  extractMemoryRelativePath,
  extractMemoryWriteContent,
} from '~/utils/memoryFileDetection'
import { formatToolName, getToolCallSummary } from '~/utils/toolNameFormat'

/**
 * How one tool call is labelled in the transcript: skill loads and memory
 * file edits get their own name, icon and view; everything else shows the
 * formatted tool name and a one-line argument summary.
 */
export function useToolPresentation() {
  const { isSkillLoad, getSkillName } = useSkillDetection()

  function isToolSkillLoad(toolData: ToolCallData): boolean { return isSkillLoad(toolData.toolName, toolData.toolArgs) }
  function getToolMemoryInfo(toolData: ToolCallData) { return detectMemoryFile(toolData.toolName, toolData.toolArgs) }
  function getToolEdits(toolData: ToolCallData) { return extractEditsFromArgs(toolData.toolArgs) }
  function getToolMemoryFileName(toolData: ToolCallData) { return extractMemoryFileName(toolData.toolArgs) ?? undefined }
  function isEditFileTool(toolData: ToolCallData) { return toolData.toolName === 'edit_file' || toolData.toolName === 'Edit' }
  function getToolMemoryWriteContent(toolData: ToolCallData) { return extractMemoryWriteContent(toolData.toolName, toolData.toolArgs) }
  function hasMemoryView(toolData: ToolCallData) {
    return (isEditFileTool(toolData) && getToolEdits(toolData) && getToolMemoryInfo(toolData).isMemoryFile)
      || getToolMemoryWriteContent(toolData) !== null
  }
  function toolDisplayName(toolData: ToolCallData): string {
    if (isToolSkillLoad(toolData)) return `Load Skill: ${getSkillName(toolData.toolArgs)}`
    const memInfo = getToolMemoryInfo(toolData)
    if (memInfo.isMemoryFile) return memInfo.label
    return formatToolName(toolData.toolName)
  }
  function toolSummary(toolData: ToolCallData): string | null {
    if (isToolSkillLoad(toolData)) return null
    const memInfo = getToolMemoryInfo(toolData)
    if (memInfo.isMemoryFile) return memInfo.displayPath
    return extractMemoryRelativePath(toolData.toolArgs) ?? getToolCallSummary(toolData.toolName, toolData.toolArgs)
  }
  function toolIconName(toolData: ToolCallData): string {
    if (isToolSkillLoad(toolData)) return 'puzzle'
    const memInfo = getToolMemoryInfo(toolData)
    if (memInfo.isMemoryFile) return memInfo.icon
    return 'settings'
  }

  return {
    isToolSkillLoad, getToolMemoryInfo, getToolEdits, getToolMemoryFileName, isEditFileTool,
    getToolMemoryWriteContent, hasMemoryView, toolDisplayName, toolSummary, toolIconName,
  }
}
