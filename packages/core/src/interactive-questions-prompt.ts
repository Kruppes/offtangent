import {
  INTERACTION_BLOCK_MAX_MULTI_OPTIONS,
  INTERACTION_BLOCK_MAX_OPTIONS,
  INTERACTION_BLOCKS_PER_MESSAGE,
} from './contracts/interaction-blocks.js'

const FENCE = '```'

/**
 * The example the prompt teaches. Kept as data so the test can feed it to the
 * real parser: if the wire format ever moves, the prompt fails the test
 * instead of teaching a shape no surface renders.
 */
export const INTERACTIVE_QUESTION_EXAMPLE = {
  block: 'choice',
  id: 'q1',
  question: 'Which branch should I deploy?',
  options: [
    { id: 'main', label: 'main (current release)' },
    { id: 'feature', label: 'feature/new-header' },
  ],
} as const

export function buildInteractiveQuestionsPrompt(): string {
  const example = JSON.stringify(INTERACTIVE_QUESTION_EXAMPLE, null, 2)
  return `<interactive_questions>
When you need a decision from the user and the sensible answers form a small closed set — which of several alternatives, yes/no before an irreversible step, which items out of a list — do not guess and do not bury the question in prose. Ask it as an interactive block: the web app and the Android app render it as tappable cards, Telegram shows it as a numbered list. Put the block at the END of your message and then stop; the turn ends there and continues when the answer arrives. Never carry on as if an answer had already been given.

Format: a fenced code block with the language \`offtangent\` and a JSON body.

${FENCE}offtangent
${example}
${FENCE}

Kinds:
- \`choice\` — exactly one of 2–${INTERACTION_BLOCK_MAX_OPTIONS} options.
- \`confirm\` — yes/no. No options needed; optional \`"confirmLabel"\`, \`"cancelLabel"\`, and \`"destructive": true\` for anything that deletes or cannot be undone.
- \`multi\` — several of 2–${INTERACTION_BLOCK_MAX_MULTI_OPTIONS} options.

Rules: at most ${INTERACTION_BLOCKS_PER_MESSAGE} block per message; a short unique \`id\`; labels are concrete and self-explanatory (≤120 characters); no free-text fields inside the block — the user can always type an own answer instead of tapping, so when a custom answer is plausible, say so in one short sentence before the block. Lead with a sentence of context if the question needs it, then the block. A block is for a real fork in the road, not for acknowledgements, rhetorical questions or things the user has already told you: when you have enough to decide, decide and act.

The answer arrives as an ordinary user message carrying the chosen label(s), exactly as if the user had typed it.
</interactive_questions>`
}
