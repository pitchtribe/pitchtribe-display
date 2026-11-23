'use strict';
/* Password strength requirements and validation for admin accounts.
   Enforces: minimum length, complexity, common password blocklist. */

const MIN_LENGTH = 12;
const MIN_UPPERCASE = 1;
const MIN_LOWERCASE = 1;
const MIN_DIGITS = 1;
const MIN_SPECIAL = 1;

/** Common weak passwords that must be rejected regardless of length. */
const BLOCKLIST = new Set([
  'password', 'password123', '123456', '12345678', 'qwerty', 'abc123',
  'monkey', '1234567', 'letmein', 'trustno1', 'dragon', 'baseball',
  'iloveyou', 'master', 'sunshine', 'ashley', 'bailey', 'passw0rd',
  'shadow', '123123', '654321', 'superman', 'qazwsx', 'michael',
  'football', 'admin', 'administrator', 'pitchtribe', 'raspberry',
]);

/**
 * Validates password strength against policy requirements.
 * @param {string} password - The password to validate
 * @returns {{ valid: boolean, errors: string[] }} - Validation result with specific error messages
 */
function validatePassword(password) {
  const errors = [];

  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password is required'] };
  }

  // Length check
  if (password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters long`);
  }

  // Complexity checks
  const uppercase = (password.match(/[A-Z]/g) || []).length;
  const lowercase = (password.match(/[a-z]/g) || []).length;
  const digits = (password.match(/[0-9]/g) || []).length;
  const special = (password.match(/[^A-Za-z0-9]/g) || []).length;

  if (uppercase < MIN_UPPERCASE) {
    errors.push(`Password must contain at least ${MIN_UPPERCASE} uppercase letter(s)`);
  }
  if (lowercase < MIN_LOWERCASE) {
    errors.push(`Password must contain at least ${MIN_LOWERCASE} lowercase letter(s)`);
  }
  if (digits < MIN_DIGITS) {
    errors.push(`Password must contain at least ${MIN_DIGITS} digit(s)`);
  }
  if (special < MIN_SPECIAL) {
    errors.push(`Password must contain at least ${MIN_SPECIAL} special character(s)`);
  }

  // Blocklist check (case-insensitive)
  if (BLOCKLIST.has(password.toLowerCase())) {
    errors.push('Password is too common and easily guessable');
  }

  // Check for common patterns
  if (/^(.)\1+$/.test(password)) {
    errors.push('Password cannot be all the same character');
  }
  if (/^(012|123|234|345|456|567|678|789|890)+$/.test(password)) {
    errors.push('Password cannot be sequential numbers');
  }
  if (/^(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)+$/i.test(password)) {
    errors.push('Password cannot be sequential letters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generates a secure random password that meets policy requirements.
 * Useful for temporary passwords or password reset flows.
 * @returns {string} - A cryptographically secure random password
 */
function generateSecurePassword() {
  const crypto = require('node:crypto');
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  // Ensure minimum requirements are met
  let password = '';
  password += uppercase[crypto.randomInt(uppercase.length)];
  password += lowercase[crypto.randomInt(lowercase.length)];
  password += digits[crypto.randomInt(digits.length)];
  password += special[crypto.randomInt(special.length)];

  // Fill remaining characters randomly
  const allChars = uppercase + lowercase + digits + special;
  const remainingLength = MIN_LENGTH - password.length;
  for (let i = 0; i < remainingLength; i++) {
    password += allChars[crypto.randomInt(allChars.length)];
  }

  // Shuffle the password to avoid predictable patterns
  const chars = password.split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Checks if a password needs to be rotated based on age.
 * @param {Date|number} lastChanged - When the password was last changed
 * @param {number} maxAgeDays - Maximum age in days (default: 90)
 * @returns {boolean} - True if password should be rotated
 */
function needsRotation(lastChanged, maxAgeDays = 90) {
  if (!lastChanged) return true;
  const age = Date.now() - (lastChanged instanceof Date ? lastChanged.getTime() : lastChanged);
  return age > maxAgeDays * 86400 * 1000;
}

module.exports = {
  validatePassword,
  generateSecurePassword,
  needsRotation,
  MIN_LENGTH,
  MIN_UPPERCASE,
  MIN_LOWERCASE,
  MIN_DIGITS,
  MIN_SPECIAL,
};
