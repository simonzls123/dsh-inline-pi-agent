/**
 * Two small adapters between DSH's tool vocabulary and MCP's.
 *
 * The parameter conversion is DSH's own (`parameterSchemaSpecToJsonSchema`), so
 * this file must not invent one: a divergent copy would drift as tools start
 * using newer spec fields.
 */

export { parameterSchemaSpecToJsonSchema as toJsonSchema } from '@deepseek-ai/dsh-tools'

/** Flatten DSH content blocks into MCP content items. */
export function toMcpContent(blocks) {
  const content = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
      continue
    }
    // Images and unknown blocks are refused by most clients as-is; hand over the
    // JSON so the model at least sees the structure instead of nothing.
    if (block.type === 'image') continue
    content.push({ type: 'text', text: JSON.stringify(block) })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return content
}
