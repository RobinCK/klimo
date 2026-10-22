/**
 * Request ids make control actions idempotent for a minute (a double tap or a retried request
 * is applied once). `crypto.randomUUID` exists only in secure contexts, and Home Assistant is
 * often opened over plain http on the LAN, so the id is built from getRandomValues.
 */
export function newReqId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
