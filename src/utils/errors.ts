/**
 * Error serialization helper.
 *
 * WHY THIS EXISTS
 * --------------
 * `String(err)` on a plain object returns `"[object Object]"`, which
 * makes error logs useless. Fyers API (and many other libraries) throw
 * plain objects like `{ s: 'error', code: -8, message: '...' }` rather
 * than Error instances. This helper extracts the useful bits.
 */

export function errToString(err: unknown): string {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (err instanceof Error) {
    return err.message || err.name || 'Error (no message)';
  }
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // Prefer explicit message fields (Fyers uses `message`, some libs use `msg`)
    const msg = e['message'] ?? e['msg'] ?? e['error'] ?? e['description'];
    if (typeof msg === 'string' && msg.length > 0) {
      const code = e['code'];
      return code !== undefined ? `${msg} (code: ${code})` : msg;
    }
    // Fall back to JSON serialization (truncated to keep logs readable)
    try {
      const json = JSON.stringify(err);
      return json.length > 500 ? json.slice(0, 500) + '...' : json;
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * Check whether an error/response indicates an expired Fyers access token.
 *
 * Fyers returns objects like:
 *   { s: 'error', code: -8, message: 'Your token has expired. Please generate a token' }
 *
 * We check both the code and message text for robustness.
 */
export function isFyersTokenExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const code = Number(e['code']);
  const message = String(e['message'] ?? '').toLowerCase();
  if (code === -8 || code === -12) return true;
  return message.includes('token has expired') || message.includes('invalid token');
}
