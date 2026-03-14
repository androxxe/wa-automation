/**
 * Normalize Indonesian mobile numbers to E.164 format (+62...).
 *
 * Rules:
 *   0821...     → +62821...
 *   62821...    → +62821...
 *   +62821...   → +62821... (unchanged)
 *
 * Validation: after +62 the remaining digits must be 8–12 digits.
 */

export interface PhoneResult {
  raw: string
  normalized: string
  valid: boolean
  reason?: string
}

export function normalizePhone(raw: string): PhoneResult {
  // Strip whitespace, dashes, parentheses, dots
  let digits = raw.replace(/[\s\-().+]/g, '')

  if (!digits) {
    return { raw, normalized: raw, valid: false, reason: 'empty' }
  }

  // Convert to +62 form
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1)
  }

  if (!digits.startsWith('62')) {
    return { raw, normalized: raw, valid: false, reason: 'not an Indonesian number' }
  }

  const normalized = '+' + digits

  // After +62, remaining digits must be 8–12 digits
  const suffix = digits.slice(2)
  if (!/^\d{8,12}$/.test(suffix)) {
    return {
      raw,
      normalized,
      valid: false,
      reason: `suffix length ${suffix.length} out of range 8–12`,
    }
  }

  return { raw, normalized, valid: true }
}
