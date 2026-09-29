// read toolview registrant: the keyed toolview hole for the read tool. A text
// window is the line-numbered read card opened at the line the call named; an
// integrated image read (`imageReadMode: integrated`, the pi preset's `read`)
// settles as [text envelope, image block] and renders the same gallery card
// `read_image` uses, dispatched through the `renderImageSlot` owner currency
// the Tool call tree supplies. Text and image results are mutually exclusive
// shapes of one tool, so the row picks per result and never renders both
// cards.
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { readCallLine, readCardModel } from '../models/read-card-model.ts'
import { imageCardModel } from '../models/image-card-model.ts'
import { readFamilyRow } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type ReadRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/**
 * Lets users expand a completed read result and open its reported path at the
 * line the call started from; an image read expands to the image itself.
 */
export function ReadRow(props: ReadRowProps) {
  const { block, cwd, home, renderImageSlot, loadImage } = props
  const image = imageCardModel(block, cwd, home, 'read')
  if (image !== null) {
    return readFamilyRow(props, { image, renderSlot: renderImageSlot, loadImage })
  }
  return readFamilyRow(props, {
    read: readCardModel(block, cwd, home),
    filePathLine: readCallLine(block),
  })
}

/** Registers the read tool's conversation row. */
export const readToolview = {
  name: 'read-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'read', locale: NS }, ReadRow))
  },
}
