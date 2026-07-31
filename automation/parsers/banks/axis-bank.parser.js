/**
 * Axis Bank Email Parser
 *
 * Deterministic parser for Axis Bank transaction alert emails (alerts@axis.bank.in).
 * Extracts amount, merchant, date, and transaction type from debit alert emails.
 *
 * Relevance strategy: the SUBJECT gate is deliberately permissive (banks reword
 * their templates without notice), and precision is enforced in `parse()`, which
 * requires an amount in an explicit debit context. Rejecting on the subject alone
 * silently loses real transactions; rejecting in `parse()` only loses emails that
 * genuinely contain no debit amount.
 *
 * Adding a new bank: copy this file, update senderEmails, isRelevant, and regex patterns.
 */

const { cleanMerchantName, parseIndianAmount, GENERIC_MERCHANT } = require('../base-parser');

/** Sender email addresses used by Axis Bank for transaction alerts */
const senderEmails = ['alerts@axis.bank.in'];

/** Bank identifier */
const bankId = 'Axis';

/** Subjects that are never a transaction, regardless of any amount they mention. */
const NON_TRANSACTIONAL = /\b(?:otp|password|passcode|e?-?statement|newsletter|offer|offers|reward|rewards|promotion|promotional|survey|feedback|kyc|nominee|due\s+date|minimum\s+due|premium\s+due|policy|unsubscribe)\b/i;

/** Wording that indicates money coming IN rather than going out. */
const CREDIT_INTENT = /\b(?:credited|refund(?:ed)?|reversal|reversed|received\s+from)\b/i;

/** Subject-level debit hints — intentionally broad. */
const SUBJECT_DEBIT_INTENT = /\b(?:debited|debit|spent|withdrawn|withdrawal|paid|payment|purchase|transaction|txn|transferred)\b/i;

/**
 * Body-level debit hints — deliberately narrower than the subject list.
 * Only past-tense/action wording qualifies: the bare noun "debit" would match
 * the phrase "Debit Card" in a promotional footer and authorise a bogus amount.
 */
const BODY_DEBIT_INTENT = /\b(?:debited|spent|withdrawn|withdrawal)\b/i;

/**
 * Amount extraction patterns that carry explicit debit context.
 * Each pattern is tried in order; first successful match wins.
 */
const AMOUNT_PATTERNS = [
  // "Amount Debited: INR 1,234.56" or "Amount Debited: Rs. 1,234.56"
  /Amount\s*Debited\s*[:\-]?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "debited with INR 500.00" / "debited with Rs 500"
  /debited\s+(?:with|for|by)\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "INR 1234.56 has been debited" / "Rs. 1234 was debited"
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:has\s+been|have\s+been|was|is|been)?\s*debited/i,
  // "debited by INR 500 from"
  /debited\s+(?:by\s+)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+from/i,
  // "Transaction of INR 500" / "Transaction of Rs 500"
  /(?:Transaction|Txn)\s+(?:of|for)\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "Rs 500 debited" / "INR 500 withdrawn"
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:debited|withdrawn)/i,
  // "spent Rs. 500" / "spent INR 500"
  /spent\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "Your a/c xxxxxxx debited for Rs 1234.56"
  /a\/c\s*(?:no\.?\s*)?[xX*\d]+\s*(?:is\s+|was\s+)?debited\s+(?:for|with|by)?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
];

/**
 * Last-resort amount pattern. Only applied when the body independently
 * establishes debit context — otherwise it would happily match the amount in a
 * promotional footer or a balance line.
 */
const GENERIC_AMOUNT_PATTERN = /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;

/**
 * Amount patterns for the subject line, most specific first.
 * The bare-currency fallback is safe here because `isRelevant` has already run.
 */
const SUBJECT_AMOUNT_PATTERNS = [
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:was\s+|has\s+been\s+|have\s+been\s+|is\s+|been\s+)?(?:debited|spent|withdrawn)/i,
  /(?:debited|spent|withdrawn)\s+(?:with\s+|for\s+|by\s+|of\s+)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
];

/**
 * Comprehensive merchant/payee extraction patterns.
 * Captures stop at end-of-line; `cleanMerchantName` trims trailing boilerplate
 * for bodies that arrived without line breaks.
 */
const MERCHANT_PATTERNS = [
  /Transaction\s*Info\s*[:\-]\s*([^\n]+)/i,
  /(?:Paid\s+to|Payee|Beneficiary|Merchant)\s*[:\-]\s*([^\n]+)/i,
  /\bTo\s*[:\-]\s*([^\n]+)/i,
  /(?:UPI|IMPS|NEFT)\s*[/\-]\s*([^\n]+)/i,
  /(?:\bat|@)\s+([A-Za-z][\w\s&.-]{2,60})/i,
];

/**
 * Checks whether an email could be an Axis Bank debit alert.
 *
 * Permissive by design — see the file header. The sender is already restricted
 * to the bank's alert address by the Gmail query, so this gate only rejects
 * subjects that are PROVABLY not a debit transaction. Everything else is judged
 * on its body by `parse()`, which has far more signal to work with.
 *
 * Requiring a specific phrase here is what silently lost real transactions
 * whenever the bank reworded its template.
 * @param {string} subject - Email subject line
 * @returns {boolean}
 */
function isRelevant(subject) {
  const s = String(subject || '');

  if (NON_TRANSACTIONAL.test(s)) return false;
  // Credit-only wording with no debit hint anywhere — not our concern.
  if (CREDIT_INTENT.test(s) && !SUBJECT_DEBIT_INTENT.test(s)) return false;

  return true;
}

/**
 * Extracts the amount from the subject line.
 * This is the PRIMARY extraction method — subject is plain text and always reliable.
 * @param {string} subject - Email subject line
 * @returns {number} Amount, or 0 if not found
 */
function extractAmountFromSubject(subject) {
  if (!subject) return 0;
  for (const pattern of SUBJECT_AMOUNT_PATTERNS) {
    const match = subject.match(pattern);
    if (match && match[1]) {
      const amount = parseIndianAmount(match[1]);
      if (amount > 0) return amount;
    }
  }
  return 0;
}

/**
 * Extracts the amount from the email body (fallback).
 * @param {string} body - Email body text
 * @returns {number} Amount, or 0 if not found
 */
function extractAmount(body) {
  if (!body) return 0;

  for (const pattern of AMOUNT_PATTERNS) {
    const match = body.match(pattern);
    if (match && match[1]) {
      const amount = parseIndianAmount(match[1]);
      if (amount > 0) return amount;
    }
  }

  // Only fall back to a context-free currency match if the body is clearly a debit.
  if (BODY_DEBIT_INTENT.test(body)) {
    const match = body.match(GENERIC_AMOUNT_PATTERN);
    if (match && match[1]) return parseIndianAmount(match[1]);
  }

  return 0;
}

/**
 * Extracts the merchant name from the email body.
 * @param {string} body - Email body text
 * @returns {string} Merchant name
 */
function extractMerchant(body) {
  if (!body) return GENERIC_MERCHANT;
  for (const pattern of MERCHANT_PATTERNS) {
    const match = body.match(pattern);
    if (match && match[1]) {
      const cleaned = cleanMerchantName(match[1]);
      if (cleaned !== GENERIC_MERCHANT) return cleaned;
    }
  }
  return GENERIC_MERCHANT;
}

/**
 * Builds a Date from Indian-format date components (DD-MM-YY[YY]) in IST.
 * @returns {Date|null} Valid Date, or null if the components don't form one
 */
function buildIstDate(day, month, year, hours, minutes, seconds) {
  const fullYear = String(year).length === 2 ? `20${year}` : String(year);
  const hh = hours || '00';
  const mm = minutes || '00';
  const ss = seconds || '00';
  const date = new Date(`${fullYear}-${month}-${day}T${hh}:${mm}:${ss}+05:30`);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Rejects dates that cannot plausibly belong to a transaction alert
 * (far future, or older than two years) so a misread pattern can't poison the record.
 * @param {Date|null} date
 * @returns {boolean}
 */
function isPlausibleTransactionDate(date) {
  if (!date) return false;
  const now = Date.now();
  const oneDayAhead = now + 24 * 60 * 60 * 1000;
  const twoYearsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
  return date.getTime() <= oneDayAhead && date.getTime() >= twoYearsAgo;
}

/**
 * Extracts the transaction date from the email body.
 * Falls back to Gmail's internalDate if no plausible date is found in the body.
 * @param {string} body - Email body text
 * @param {object} messageMetadata - { internalDate: string }
 * @returns {Date} Transaction date
 */
function extractDate(body, messageMetadata) {
  const text = body || '';

  const candidates = [
    // "Date & Time: DD-MM-YY, HH:MM:SS"  (entities are decoded before we get here)
    /Date\s*(?:&|and)?\s*Time\s*[:\-]\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i,
    // "on DD-MM-YY at HH:MM:SS" / "on DD/MM/YYYY HH:MM"
    /\bon\s+(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\s*(?:,|\s)?\s*(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?/i,
    // "DD-MM-YYYY HH:MM:SS" anywhere
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    // Date only: "on DD-MM-YY"
    /\bon\s+(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/i,
  ];

  for (const pattern of candidates) {
    const match = text.match(pattern);
    if (!match) continue;
    const [, day, month, year, hours, minutes, seconds] = match;
    const parsed = buildIstDate(
      String(day).padStart(2, '0'),
      String(month).padStart(2, '0'),
      year,
      hours ? String(hours).padStart(2, '0') : null,
      minutes,
      seconds
    );
    if (isPlausibleTransactionDate(parsed)) return parsed;
  }

  // Fallback: use Gmail's internal date (when the email was received)
  if (messageMetadata && messageMetadata.internalDate) {
    const received = new Date(parseInt(messageMetadata.internalDate, 10));
    if (!isNaN(received.getTime())) return received;
  }

  return new Date();
}

/**
 * Parses a full email into a structured transaction object.
 * @param {string} subject - Email subject line
 * @param {string} body - Email body text (already extracted)
 * @param {object} messageMetadata - { id: string, internalDate: string }
 * @returns {object|null} Parsed transaction or null if parsing fails
 */
function parse(subject, body, messageMetadata) {
  const text = body || '';

  // Guard: an unambiguous credit alert that slipped past the subject gate.
  if (CREDIT_INTENT.test(text) && !BODY_DEBIT_INTENT.test(text) && !SUBJECT_DEBIT_INTENT.test(subject || '')) {
    return null;
  }

  // Primary: extract amount from subject (most reliable — always plain text)
  let amount = extractAmountFromSubject(subject);
  // Fallback: extract from body if subject extraction fails
  if (amount <= 0) {
    amount = extractAmount(text);
  }
  if (amount <= 0) return null;

  const merchant = extractMerchant(text);
  const date = extractDate(text, messageMetadata);

  return {
    amount,
    merchant,
    date,
    bank: bankId,
    transactionType: 'Debit',
    paymentMethod: 'UPI',
    gmailMessageId: messageMetadata && messageMetadata.id,
    rawSubject: String(subject || '').substring(0, 200),
    parsedSuccessfully: merchant !== GENERIC_MERCHANT,
  };
}

module.exports = {
  bankId,
  senderEmails,
  isRelevant,
  parse,
};
