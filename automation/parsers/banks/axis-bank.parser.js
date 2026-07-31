/**
 * Axis Bank Email Parser
 *
 * Deterministic parser for Axis Bank transaction alert emails (alerts@axis.bank.in).
 * Extracts amount, merchant, date, and transaction type from debit alert emails.
 *
 * Adding a new bank: copy this file, update senderEmails, isRelevant, and regex patterns.
 */

const { cleanMerchantName, parseIndianAmount } = require('../base-parser');

/** Sender email addresses used by Axis Bank for transaction alerts */
const senderEmails = ['alerts@axis.bank.in'];

/** Bank identifier */
const bankId = 'Axis';

/**
 * Amount extraction patterns for Axis Bank alert emails.
 * Each pattern is tried in order; first successful match wins.
 */
const AMOUNT_PATTERNS = [
  // "Amount Debited: INR 1,234.56" or "Amount Debited: Rs. 1,234.56"
  /Amount\s*Debited\s*[:\-]?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "debited with INR 500.00" / "debited with Rs 500"
  /debited\s+(?:with|for|by)\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "INR 1234.56 has been debited" / "Rs. 1234 was debited"
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:has been|was|is)\s+debited/i,
  // "debited by INR 500 from"
  /debited\s+(?:by\s+)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+from/i,
  // "Transaction of INR 500" / "Transaction of Rs 500"
  /(?:Transaction|Txn)\s+(?:of|for)\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "Rs 500 debited" / "INR 500 debited" (simpler pattern)
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:debited|withdrawn)/i,
  // "spent Rs. 500" / "spent INR 500"
  /spent\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "Your a/c xxxxxxx debited for Rs 1234.56"
  /a\/c\s*[xX*\d]+\s*(?:is\s+)?debited\s+(?:for|with)\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  // Generic: "INR 500.00" or "Rs.500" or "₹500" anywhere in email (last resort)
  /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
];

/**
 * Comprehensive merchant/payee extraction patterns.
 */
const MERCHANT_PATTERNS = [
  /Transaction\s*Info\s*[:\-]\s*(.+)/i,
  /(?:Paid\s+to|Payee|Beneficiary|Merchant|To)\s*[:\-]\s*(.+)/i,
  /(?:UPI|IMPS|NEFT)\s*[/\-]\s*(.+)/i,
  /(?:at|@)\s+([A-Za-z][\w\s&.-]+)/i,
];

/**
 * Checks if an email subject matches the specific Axis Bank debit alert pattern.
 * Expected format: "INR 1.00 was debited from your A/c no. XX5482."
 * Only the amount varies — the rest of the structure is fixed.
 * @param {string} subject - Email subject line
 * @returns {boolean}
 */
function isRelevant(subject) {
  return /INR\s+[\d,]+(?:\.\d{1,2})?\s+was\s+debited\s+from\s+your\s+A\/c/i.test(subject);
}

/**
 * Extracts the amount from the Axis Bank subject line.
 * Subject format: "INR 1.00 was debited from your A/c no. XX5482."
 * This is the PRIMARY extraction method — subject is plain text and always reliable.
 * @param {string} subject - Email subject line
 * @returns {number} Amount, or 0 if not found
 */
function extractAmountFromSubject(subject) {
  const match = subject.match(/INR\s+([\d,]+(?:\.\d{1,2})?)\s+was\s+debited/i);
  if (match && match[1]) {
    return parseIndianAmount(match[1]);
  }
  return 0;
}

/**
 * Extracts the amount from the email body (fallback).
 * @param {string} body - Email body text
 * @returns {number} Amount, or 0 if not found
 */
function extractAmount(body) {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = body.match(pattern);
    if (match && match[1]) {
      const amount = parseIndianAmount(match[1]);
      if (amount > 0) return amount;
    }
  }
  return 0;
}

/**
 * Extracts the merchant name from the email body.
 * @param {string} body - Email body text
 * @returns {string} Merchant name
 */
function extractMerchant(body) {
  for (const pattern of MERCHANT_PATTERNS) {
    const match = body.match(pattern);
    if (match && match[1]) {
      const cleaned = cleanMerchantName(match[1]);
      if (cleaned !== 'Bank Transaction') return cleaned;
    }
  }
  return 'Bank Transaction';
}

/**
 * Extracts the transaction date from the email body.
 * Falls back to Gmail's internalDate if no date is found in the body.
 * @param {string} body - Email body text
 * @param {object} messageMetadata - { internalDate: string }
 * @returns {Date} Transaction date
 */
function extractDate(body, messageMetadata) {
  // Pattern 1: "Date & Time: DD-MM-YY, HH:MM:SS"
  const p1 = body.match(/Date\s*(?:&|and)?\s*Time\s*[:\-]\s*(\d{2})-(\d{2})-(\d{2,4}),?\s*(\d{2}):(\d{2}):?(\d{2})?/i);
  if (p1) {
    const [_, day, month, year, hours, minutes, seconds] = p1;
    const fullYear = year.length === 2 ? `20${year}` : year;
    const sec = seconds || '00';
    return new Date(`${fullYear}-${month}-${day}T${hours}:${minutes}:${sec}+05:30`);
  }

  // Pattern 2: "on DD/MM/YYYY at HH:MM"
  const p2 = body.match(/on\s+(\d{2})[/\-](\d{2})[/\-](\d{2,4})\s+(?:at\s+)?(\d{2}):(\d{2})/i);
  if (p2) {
    const [_, day, month, year, hours, minutes] = p2;
    const fullYear = year.length === 2 ? `20${year}` : year;
    return new Date(`${fullYear}-${month}-${day}T${hours}:${minutes}:00+05:30`);
  }

  // Fallback: use Gmail's internal date
  if (messageMetadata && messageMetadata.internalDate) {
    return new Date(parseInt(messageMetadata.internalDate));
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
  // Primary: extract amount from subject (most reliable — always plain text)
  let amount = extractAmountFromSubject(subject);
  // Fallback: extract from body if subject extraction fails
  if (amount <= 0) {
    amount = extractAmount(body);
  }
  if (amount <= 0) return null;

  const merchant = extractMerchant(body);
  const date = extractDate(body, messageMetadata);

  return {
    amount,
    merchant,
    date,
    bank: bankId,
    transactionType: 'Debit',
    paymentMethod: 'UPI',
    gmailMessageId: messageMetadata.id,
    rawSubject: subject.substring(0, 200),
    parsedSuccessfully: true,
  };
}

module.exports = {
  bankId,
  senderEmails,
  isRelevant,
  parse,
};
