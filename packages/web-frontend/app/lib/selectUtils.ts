/**
 * Sentinel value used internally by Select / SelectItem wrappers.
 *
 * reka-ui (v2) throws when a SelectItem has value="".
 * Our wrapper components transparently map "" ↔ EMPTY_SENTINEL
 * so that consumer code can keep using empty strings for
 * "all / default / none selected" options.
 */
export const EMPTY_SENTINEL = '__empty__'
