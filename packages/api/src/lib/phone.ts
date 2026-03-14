/**
 * Normalize Indonesian mobile numbers to E.164 format (+62...).
 *
 * Handles all real-world formats found in xlsx files:
 *
 *   Input               Normalized
 *   ──────────────────  ──────────────────
 *   08xxxxxxxxx         +628xxxxxxxxx       (standard local format)
 *   8xxxxxxxxx          +628xxxxxxxxx       (Excel stripped leading zero)
 *   628xxxxxxxxx        +628xxxxxxxxx       (already has country code, no +)
 *   +628xxxxxxxxx       +628xxxxxxxxx       (already E.164)
 *   8.2116746411E+10    +628211674641       (Excel scientific notation)
 *   0821 1674 641 1     +62821167464117     (spaces — valid, 11-digit suffix)
 *   0821-1674-6411      +6282116746411      (dashes)
 *
 * Validation: after +62 the remaining digits must be 8–11 digits.
 */

export interface PhoneResult {
  raw: string
  normalized: string
  valid: boolean
  reason?: string
}

export function normalizePhone(raw: string): PhoneResult {
  let input = String(raw).trim()

  if (!input) {
    return { raw, normalized: raw, valid: false, reason: 'empty' }
  }

  // ── Handle scientific notation (e.g. 8.21167464117E+11) ──────────────────
  if (/^[\d.]+[eE][+\-]?\d+$/.test(input)) {
    // Parse as float then convert to integer string
    const num = parseFloat(input)
    if (!isNaN(num) && isFinite(num)) {
      input = Math.round(num).toString()
    }
  }

  // ── Strip non-digit characters except leading + ───────────────────────────
  const hasPlus = input.startsWith('+')
  let digits = input.replace(/\D/g, '')

  if (!digits) {
    return { raw, normalized: raw, valid: false, reason: 'empty after stripping non-digits' }
  }

  // ── Normalise to 62xxxxxxxxx form ─────────────────────────────────────────

  if (hasPlus && digits.startsWith('62')) {
    // +62... → already correct, keep as-is
  } else if (digits.startsWith('62')) {
    // 62... → keep as-is
  } else if (digits.startsWith('0')) {
    // 08... → strip leading 0, prepend 62
    digits = '62' + digits.slice(1)
  } else if (digits.startsWith('8')) {
    // 8... → Excel stripped the leading 0; prepend 62
    digits = '62' + digits
  } else {
    return { raw, normalized: raw, valid: false, reason: 'unrecognised format' }
  }

  const normalized = '+' + digits

  // ── Validate suffix length ─────────────────────────────────────────────────
  // After +62 the subscriber number must be 8–11 digits.
  // Indonesian mobile numbers are at most 12 digits with leading 0 (e.g. 081234567890),
  // which yields an 11-digit suffix. 12-digit suffixes (13 digits with 0) are invalid.
  const suffix = digits.slice(2)
  if (!/^\d{8,11}$/.test(suffix)) {
    return {
      raw,
      normalized,
      valid: false,
      reason: `subscriber number is ${suffix.length} digit(s) — expected 8–11`,
    }
  }

  return { raw, normalized, valid: true }
}
