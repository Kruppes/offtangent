export type CronjobLastRunVariant = 'default' | 'success' | 'destructive' | 'warning' | 'muted'

export function cronjobLastRunVariant(status: string | null): CronjobLastRunVariant {
  switch (status) {
    case 'running': return 'default'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
    default: return 'muted'
  }
}
