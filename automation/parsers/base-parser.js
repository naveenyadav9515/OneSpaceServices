/**
 * Base Parser — Shared utilities used by all bank-specific email parsers.
 *
 * Provides common functions for decoding email payloads, extracting body text,
 * cleaning merchant names, and parsing Indian currency amounts.
 */

/** Named HTML entities that show up in bank alert templates. */
const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rupee: '₹',
};

/**
 * Trailing boilerplate that banks append after the merchant/payee value.
 * Used to truncate greedy merchant captures when the body has no line breaks.
 */
const MERCHANT_STOP = /\s+(?:Date\s*(?:&|and)?\s*Time|Amount\s+(?:Debited|Credited)|Available\s+(?:Balance|Bal)|Avl\.?\s*Bal|Total\s+Bal|Account\s+Balance|Ref(?:erence)?\s*(?:No|Number)|If\s+(?:this|you)|Not\s+you|Please\s+call|Call\s+\d|To\s+report|Regards|Thank(?:s|\s+you)|Warm\s+regards|Yours\s+sincerely|This\s+is\s+an?\s+auto)\b[\s\S]*$/i;

/** Placeholder used when no usable merchant name could be extracted. */
const GENERIC_MERCHANT = 'Bank Transaction';

/** Upper bound on a stored merchant name — anything longer is a bad capture. */
const MAX_MERCHANT_LENGTH = 80;

/**
 * Decodes base64url encoded email body parts.
 * @param {string} data - base64url encoded string
 * @returns {string} Decoded UTF-8 string
 */
function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/**
 * Decodes HTML entities (named, decimal, and hex) into plain characters.
 * Bank alerts routinely contain `&amp;` and `&nbsp;`, which break field regexes
 * such as `Date & Time:` if left encoded.
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-z]+);/gi, (match, name) => {
      const decoded = HTML_ENTITIES[name.toLowerCase()];
      return decoded !== undefined ? decoded : match;
    });
}

/**
 * Converts an HTML email body to plain text while PRESERVING line structure.
 *
 * Line breaks matter: parsers capture field values with patterns ending in `(.+)`,
 * which stop at a newline. Collapsing all whitespace would let a single capture
 * swallow the rest of the email.
 *
 * @param {string} html - Raw HTML string
 * @returns {string} Plain text with block boundaries preserved as newlines
 */
function htmlToText(html) {
  const withBreaks = html
    // Drop non-content elements entirely
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Turn block-level boundaries into newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|thead|tbody|section|article)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    // Strip whatever tags remain
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withBreaks)
    // Collapse horizontal whitespace only — never newlines
    .replace(/[ \t\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recursively walks a Gmail MIME tree collecting decoded text parts by type.
 * Handles arbitrarily nested multipart payloads.
 * @param {object} payload - Gmail message payload (or part)
 * @param {{plain: string[], html: string[], other: string[]}} acc
 * @returns {{plain: string[], html: string[], other: string[]}}
 */
function collectTextParts(payload, acc) {
  if (!payload) return acc;

  const mimeType = (payload.mimeType || '').toLowerCase();
  const data = payload.body && payload.body.data;

  if (data) {
    try {
      if (mimeType === 'text/plain') {
        acc.plain.push(decodeBase64(data));
      } else if (mimeType === 'text/html') {
        acc.html.push(decodeBase64(data));
      } else if (!mimeType || mimeType.startsWith('text/')) {
        acc.other.push(decodeBase64(data));
      }
      // Non-text parts (images, PDFs) are intentionally ignored.
    } catch (err) {
      // A single undecodable part must not abort extraction of the rest.
    }
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) collectTextParts(part, acc);
  }

  return acc;
}

/**
 * Extracts the full text body from a Gmail message payload.
 * Prefers text/plain, falls back to text/html (converted to text), then any
 * other text part. Handles single-part and arbitrarily nested multipart messages.
 * @param {object} payload - Gmail message payload
 * @returns {string} Email body text
 */
function extractEmailBody(payload) {
  const parts = collectTextParts(payload, { plain: [], html: [], other: [] });

  if (parts.plain.length) return parts.plain.join('\n').trim();
  if (parts.html.length) return htmlToText(parts.html.join('\n'));

  if (parts.other.length) {
    const raw = parts.other.join('\n');
    // A part with a missing/unknown mime type may still be HTML.
    return /<[a-z][^>]*>/i.test(raw) ? htmlToText(raw) : raw.trim();
  }

  return '';
}

/**
 * Cleans up a raw merchant name extracted from an email.
 * Handles UPI-style paths (UPI/P2M/merchant_name/ref), trailing bank boilerplate,
 * and over-long captures from bodies that lost their line breaks.
 * @param {string} raw - Raw merchant string
 * @returns {string} Cleaned merchant name, or 'Bank Transaction' if unusable
 */
function cleanMerchantName(raw) {
  if (!raw) return GENERIC_MERCHANT;

  // Cut the capture at the first line break, then at any trailing boilerplate.
  let cleaned = String(raw).split('\n')[0].replace(MERCHANT_STOP, '').trim();

  // Clean up UPI-style merchant paths
  if (cleaned.includes('/')) {
    const parts = cleaned.split('/').map(p => p.trim()).filter(Boolean);
    const descriptive = parts.find(p =>
      p.length > 3 &&
      !/^(UPI|P2M|P2P|IMPS|NEFT|RTGS|POS|ATM|ECOM|\d+)$/i.test(p) &&
      /[A-Za-z]/.test(p)
    );
    cleaned = descriptive || parts[parts.length - 1] || cleaned;
    // The chosen segment may itself carry trailing boilerplate.
    cleaned = cleaned.replace(MERCHANT_STOP, '').trim();
  }

  // Clean trailing spaces and punctuation
  cleaned = cleaned.replace(/[.,;:\-\s]+$/, '').trim();

  if (cleaned.length > MAX_MERCHANT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_MERCHANT_LENGTH).trim();
  }

  // Require at least one letter — a bare reference number is not a merchant.
  if (cleaned.length <= 2 || !/[A-Za-z]/.test(cleaned)) return GENERIC_MERCHANT;

  return cleaned;
}

/**
 * Parses an Indian currency amount string to a float.
 * Handles comma-separated amounts like "1,234.56".
 * @param {string} str - Amount string (e.g., "1,234.56")
 * @returns {number} Parsed amount, or 0 if invalid
 */
function parseIndianAmount(str) {
  if (!str) return 0;
  const amount = parseFloat(String(str).replace(/,/g, ''));
  return (!isNaN(amount) && amount > 0) ? amount : 0;
}

module.exports = {
  decodeBase64,
  decodeHtmlEntities,
  htmlToText,
  extractEmailBody,
  cleanMerchantName,
  parseIndianAmount,
  GENERIC_MERCHANT,
};
