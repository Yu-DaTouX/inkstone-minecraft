export function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error: /, '')
}
