/**
 * Google API error classification.
 *
 * Every Gmail/OAuth failure used to collapse into one of two useless outcomes:
 * a generic 500 ("An unexpected internal server error occurred!") during connect,
 * or `authExpired` during sync — which immediately wiped `gmailConnected`.
 *
 * That second behaviour is what made a *transient* problem look permanent: the
 * Gmail API answers 403 for rate limits and for "this API is not enabled in your
 * project" just as readily as it does for a revoked grant. Treating all of them
 * as revoked consent disconnects a perfectly healthy account on the first hiccup,
 * and the user is told only "Gmail is not connected".
 *
 * This module answers two questions the callers actually need:
 *   1. Is the stored credential dead? (`fatal` — only then may we disconnect)
 *   2. What do we tell the user? (`message` — actionable, never "try again")
 */

/** Scope required for any of the expense automation to work. */
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * Pulls the machine-readable reason out of a Gaxios/googleapis error.
 * The shape varies by endpoint, so check every place Google puts it.
 * @param {any} err
 * @returns {string} lowercased reason, or '' when absent
 */
function extractReason(err) {
  const data = err?.response?.data;
  const candidates = [
    data?.error?.errors?.[0]?.reason,
    data?.error?.status,
    data?.error_description,
    typeof data?.error === 'string' ? data.error : null,
    err?.errors?.[0]?.reason,
  ];
  return String(candidates.find(Boolean) || '').toLowerCase();
}

/**
 * Numeric HTTP status of a Google error, if there is one.
 *
 * `err.code` is NOT reliably a status: Gaxios sets it to strings like 'ENOTFOUND'
 * for network failures, so a naive `err.code === 403` check both misses real 403s
 * and mis-reads socket errors.
 * @param {any} err
 * @returns {number|null}
 */
function extractStatus(err) {
  const raw = err?.response?.status ?? err?.status ?? err?.code;
  const asNumber = Number(raw);
  return Number.isInteger(asNumber) && asNumber >= 100 && asNumber < 600 ? asNumber : null;
}

/**
 * Classifies a Google failure.
 *
 * @param {any} err
 * @returns {{code: string, fatal: boolean, retryable: boolean, status: number|null, message: string, raw: string}}
 *   `fatal`     — the stored refresh token can never work again; the user must reconnect.
 *   `retryable` — transient; keep the connection and try later.
 */
function classifyGoogleError(err) {
  const status = extractStatus(err);
  const reason = extractReason(err);
  const raw = `${err?.message || ''} ${reason}`.trim();
  const text = raw.toLowerCase();

  const build = (code, fatal, retryable, message) => ({ code, fatal, retryable, status, message, raw });

  // ── Network / transport: never a credential problem ──
  if (!status && /econnreset|enotfound|etimedout|econnrefused|socket hang up|network/i.test(text)) {
    return build('network_error', false, true,
      'Could not reach Google. Check the server\'s network connection and try again.');
  }

  // ── OAuth token-exchange failures (the /connect path) ──
  if (/redirect_uri_mismatch/.test(text)) {
    return build('redirect_uri_mismatch', false, false,
      'Google rejected the redirect URL. Add this exact URL to "Authorized redirect URIs" for your OAuth client in Google Cloud Console, then try again.');
  }
  if (/invalid_client|unauthorized_client/.test(text)) {
    return build('invalid_client', false, false,
      'Google rejected the app credentials. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.');
  }
  if (/invalid_grant/.test(text)) {
    return build('invalid_grant', true, false,
      'Google rejected the authorization. This usually means the sign-in link was already used or expired — start the connection again from the Automation Settings panel.');
  }

  // ── Scope problems: the grant exists but does not cover Gmail ──
  if (/insufficient.?(permission|scope)|access_token_scope_insufficient|insufficientpermissions/.test(text)) {
    return build('insufficient_scope', true, false,
      'OneSpace was connected without permission to read Gmail. Reconnect and make sure the "Read your email messages and settings" checkbox stays ticked on Google\'s consent screen.');
  }

  // ── Project configuration: NOT the user's credentials ──
  if (/accessnotconfigured|has not been used in project|is disabled/.test(text)) {
    return build('api_disabled', false, false,
      'The Gmail API is not enabled for this Google Cloud project. Enable it under APIs & Services → Library → Gmail API.');
  }

  // ── Quota / rate limiting: transient, must NOT disconnect ──
  if (/ratelimitexceeded|userratelimitexceeded|dailylimitexceeded|quotaexceeded|resource_exhausted|too many requests/.test(text) || status === 429) {
    return build('rate_limited', false, true,
      'Google is rate-limiting requests right now. Your connection is fine — try syncing again in a few minutes.');
  }

  // ── Status-based fallbacks ──
  if (status === 401) {
    return build('auth_expired', true, false,
      'Google access has expired or was revoked. Please reconnect your Gmail account.');
  }
  if (status === 403) {
    // A 403 that matched none of the specific reasons above is ambiguous.
    // Refuse to disconnect on a guess — that is the bug this module exists to fix.
    return build('forbidden', false, true,
      'Google refused the request. Your connection is still stored; if this keeps happening, reconnect Gmail.');
  }
  if (status && status >= 500) {
    return build('google_unavailable', false, true,
      'Google returned a server error. This is temporary — try again shortly.');
  }

  return build('gmail_error', false, true, err?.message || 'Gmail request failed.');
}

/**
 * Does a granted-scope string actually include Gmail read access?
 *
 * Google's consent screen shows a *separate checkbox* for Gmail access. A user who
 * unticks it still completes the flow and still receives a refresh token — the
 * connection looks successful and then fails on every single Gmail call. Checking
 * the granted scope at connect time is the only way to catch that immediately.
 *
 * @param {string|undefined|null} grantedScope space-delimited scope string from the token response
 * @returns {boolean}
 */
function hasGmailReadScope(grantedScope) {
  if (!grantedScope) return false;
  return String(grantedScope).split(/\s+/).includes(GMAIL_READONLY_SCOPE);
}

module.exports = {
  GMAIL_READONLY_SCOPE,
  classifyGoogleError,
  hasGmailReadScope,
};
