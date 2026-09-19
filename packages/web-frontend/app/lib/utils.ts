import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Utility to merge Tailwind CSS classes with clsx and tailwind-merge.
 * Handles conditional classes, array notation, and deduplication of conflicting classes.
 *
 * @example
 * cn('text-red-500', isActive && 'bg-blue-500', 'text-blue-500')
 * // → 'bg-blue-500 text-blue-500' (text-red-500 is overridden)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
