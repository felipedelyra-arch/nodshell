import type { ZodType } from 'zod'

/** Generic on purpose: never echoes the payload or schema details. */
export class IpcError extends Error {
  constructor(message = 'Invalid request') {
    super(message)
  }
}

export async function runValidated<I, O>(
  schemas: { in: ZodType<I>; out: ZodType<O> },
  handler: (input: I) => O | Promise<O>,
  raw: unknown,
): Promise<O> {
  const input = schemas.in.safeParse(raw)
  if (!input.success) throw new IpcError('Invalid request')
  const output = schemas.out.safeParse(await handler(input.data))
  if (!output.success) throw new IpcError('Internal error')
  return output.data
}
