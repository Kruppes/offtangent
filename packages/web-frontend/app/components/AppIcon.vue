<template>
  <component
    :is="iconComponent"
    :size="iconSize"
    :stroke-width="1.8"
    class="block shrink-0"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import {
  Activity,
  Archive,
  ArchiveRestore,
  Bot,
  Brain,
  CalendarDays,
  ChartColumnIncreasing,
  ChevronsUpDown,
  EllipsisVertical,
  Globe,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  CircleCheck,
  CircleX,
  Compass,
  FileText,
  FolderOpen,
  Info,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Logs,
  Menu,
  MessageSquare,
  Moon,
  Pencil,
  PlugZap,
  Plus,
  Puzzle,
  RefreshCw,
  Send,
  Settings,
  Shield,
  Sparkles,
  Square,
  SquareCheck,
  Sun,
  Trash2,
  Upload,
  User,
  Users,
  Wrench,
  X,
  ListTodo,
  OctagonX,
  Paperclip,
  Download,
  ExternalLink,
  Funnel,
  Image,
  Zap,
  Volume2,
  Loader,
  Mail,
  Mic,
  Inbox,
  Pin,
  PinOff,
} from 'lucide-vue-next'

const iconMap = {
  activity: Activity,
  add: Plus,
  arrowLeft: ChevronLeft,
  arrowRight: ChevronRight,
  bot: Bot,
  brain: Brain,
  calendar: CalendarDays,
  chat: MessageSquare,
  check: Check,
  chevronsUpDown: ChevronsUpDown,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  clock: Clock,
  close: X,
  compass: Compass,
  dashboard: LayoutDashboard,
  edit: Pencil,
  file: FileText,
  folder: FolderOpen,
  globe: Globe,
  info: Info,
  key: KeyRound,
  lock: LockKeyhole,
  logs: Logs,
  mail: Mail,
  menu: Menu,
  moreVertical: EllipsisVertical,
  moon: Moon,
  plug: PlugZap,
  puzzle: Puzzle,
  refresh: RefreshCw,
  send: Send,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  square: Square,
  squareCheck: SquareCheck,
  success: CircleCheck,
  sun: Sun,
  trendDown: ChartColumnIncreasing,
  users: Users,
  user: User,
  warning: CircleX,
  wrench: Wrench,
  trash: Trash2,
  upload: Upload,
  tasks: ListTodo,
  kill: OctagonX,
  paperclip: Paperclip,
  download: Download,
  externalLink: ExternalLink,
  filter: Funnel,
  image: Image,
  zap: Zap,
  volume: Volume2,
  loader: Loader,
  mic: Mic,
  archive: Archive,
  unarchive: ArchiveRestore,
  inbox: Inbox,
  pin: Pin,
  pinOff: PinOff,
} as const

const props = withDefaults(defineProps<{
  name: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | number
}>(), {
  size: 'md',
})

const iconComponent = computed(() => iconMap[props.name as keyof typeof iconMap] ?? Wrench)
const iconSize = computed(() => {
  if (typeof props.size === 'number') return props.size

  switch (props.size) {
    case 'sm': return 14
    case 'lg': return 20
    case 'xl': return 24
    default: return 16
  }
})
</script>
