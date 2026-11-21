/** Fixture: record/consume prompts without starting a model run. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export default function (pi) {
  pi.on('input', async (event) => {
    if (event.text === 'HANDLED_TEST') return { action: 'handled' }
    if (event.text === 'IMAGE_TEST') {
      writeFileSync(join(process.cwd(), 'image-seen.json'), JSON.stringify({ images: event.images?.length ?? 0 }))
      return { action: 'handled' }
    }
    if (event.text === 'INJECT_TEST') {
      writeFileSync(join(process.cwd(), 'inject-seen.json'), JSON.stringify({
        text: event.text,
        streaming: event.streamingBehavior ?? null,
      }))
      return { action: 'handled' }
    }
    return undefined
  })
}
