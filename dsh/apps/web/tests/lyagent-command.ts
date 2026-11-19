/** Require a registered command to handle an integration-test request. */
export async function handledCommand<T>(pending: Promise<T | undefined>): Promise<T> {
  const result = await pending
  if (result === undefined) throw new Error('Expected the registered command to handle the request')
  return result
}
