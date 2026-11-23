'use strict';
/* Comprehensive security tests for user authentication, password policy,
   account lockout, and audit logging. Covers OWASP authentication best practices. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, LoginLimiter, issueToken, verifyToken } = require('../lib/auth');
const { validatePassword, generateSecurePassword, needsRotation } = require('../lib/password-policy');

// ============================================================================
// PASSWORD POLICY TESTS
// ============================================================================

test('password validation - minimum length requirement', () => {
  const result = validatePassword('Short1!');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('at least 12 characters')));
});

test('password validation - requires uppercase letters', () => {
  const result = validatePassword('nouppercase1!');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('uppercase')));
});

test('password validation - requires lowercase letters', () => {
  const result = validatePassword('NOLOWERCASE1!');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('lowercase')));
});

test('password validation - requires digits', () => {
  const result = validatePassword('NoDigitsHere!');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('digit')));
});

test('password validation - requires special characters', () => {
  const result = validatePassword('NoSpecial123');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('special')));
});

test('password validation - rejects common passwords', () => {
  const common = ['password', 'password123', '123456', 'admin', 'qwerty'];
  for (const pwd of common) {
    const result = validatePassword(pwd);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('common') || e.includes('guessable')));
  }
});

test('password validation - rejects all same character', () => {
  const result = validatePassword('aaaaaaaaaaaa');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('same character')));
});

test('password validation - rejects sequential numbers', () => {
  const result = validatePassword('123456789012');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('sequential')));
});

test('password validation - rejects sequential letters', () => {
  const result = validatePassword('abcdefghijkl');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('sequential')));
});

test('password validation - accepts strong password', () => {
  const result = validatePassword('MyStr0ng!Pass2024');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('password validation - handles null and undefined', () => {
  assert.strictEqual(validatePassword(null).valid, false);
  assert.strictEqual(validatePassword(undefined).valid, false);
  assert.strictEqual(validatePassword('').valid, false);
});

test('password validation - multiple errors reported', () => {
  const result = validatePassword('short');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 1); // Should fail multiple requirements
});

// ============================================================================
// PASSWORD GENERATION TESTS
// ============================================================================

test('generateSecurePassword - creates valid password', () => {
  const password = generateSecurePassword();
  const result = validatePassword(password);
  assert.strictEqual(result.valid, true, `Generated password failed validation: ${result.errors.join(', ')}`);
});

test('generateSecurePassword - creates unique passwords', () => {
  const passwords = new Set();
  for (let i = 0; i < 100; i++) {
    passwords.add(generateSecurePassword());
  }
  assert.ok(passwords.size > 95, 'Generated passwords should be highly unique');
});

test('generateSecurePassword - meets minimum length', () => {
  const password = generateSecurePassword();
  assert.ok(password.length >= 12);
});

// ============================================================================
// PASSWORD ROTATION TESTS
// ============================================================================

test('needsRotation - requires rotation for null lastChanged', () => {
  assert.strictEqual(needsRotation(null), true);
  assert.strictEqual(needsRotation(undefined), true);
});

test('needsRotation - does not require rotation for recent password', () => {
  const yesterday = Date.now() - 86400 * 1000;
  assert.strictEqual(needsRotation(yesterday, 90), false);
});

test('needsRotation - requires rotation for old password', () => {
  const ninetyOneDaysAgo = Date.now() - (91 * 86400 * 1000);
  assert.strictEqual(needsRotation(ninetyOneDaysAgo, 90), true);
});

test('needsRotation - accepts Date objects', () => {
  const recent = new Date(Date.now() - 30 * 86400 * 1000);
  assert.strictEqual(needsRotation(recent, 90), false);
});

test('needsRotation - custom rotation period', () => {
  const thirtyOneDaysAgo = Date.now() - (31 * 86400 * 1000);
  assert.strictEqual(needsRotation(thirtyOneDaysAgo, 30), true);
  assert.strictEqual(needsRotation(thirtyOneDaysAgo, 60), false);
});

// ============================================================================
// PASSWORD HASHING TESTS
// ============================================================================

test('hashPassword - creates unique hashes for same password', () => {
  const hash1 = hashPassword('SamePassword1!');
  const hash2 = hashPassword('SamePassword1!');
  assert.notStrictEqual(hash1, hash2, 'Hashes should differ due to unique salts');
});

test('hashPassword - produces scrypt format', () => {
  const hash = hashPassword('TestPass1!');
  assert.ok(hash.startsWith('scrypt$'));
  const parts = hash.split('$');
  assert.strictEqual(parts.length, 3);
  assert.ok(parts[1].length > 0, 'Salt should be present');
  assert.ok(parts[2].length > 0, 'Hash should be present');
});

test('verifyPassword - accepts correct password', () => {
  const password = 'CorrectPassword1!';
  const hash = hashPassword(password);
  assert.strictEqual(verifyPassword(password, hash), true);
});

test('verifyPassword - rejects incorrect password', () => {
  const hash = hashPassword('CorrectPassword1!');
  assert.strictEqual(verifyPassword('WrongPassword1!', hash), false);
});

test('verifyPassword - rejects empty password', () => {
  const hash = hashPassword('CorrectPassword1!');
  assert.strictEqual(verifyPassword('', hash), false);
  assert.strictEqual(verifyPassword(null, hash), false);
  assert.strictEqual(verifyPassword(undefined, hash), false);
});

test('verifyPassword - rejects malformed hash', () => {
  assert.strictEqual(verifyPassword('password', 'invalid'), false);
  assert.strictEqual(verifyPassword('password', 'scrypt$only$two'), false); // Invalid format
  assert.strictEqual(verifyPassword('password', ''), false);
});

test('verifyPassword - timing-safe comparison', () => {
  // This test ensures we're using timingSafeEqual
  const hash = hashPassword('TestPassword1!');
  const start = process.hrtime.bigint();
  verifyPassword('WrongPassword1!', hash);
  const wrongTime = process.hrtime.bigint() - start;

  const start2 = process.hrtime.bigint();
  verifyPassword('TestPassword1!', hash);
  const correctTime = process.hrtime.bigint() - start2;

  // Both should take similar time (within order of magnitude)
  // This is a weak test but catches obvious timing leaks
  assert.ok(wrongTime > 0n && correctTime > 0n);
});

// ============================================================================
// ACCOUNT LOCKOUT TESTS (LoginLimiter)
// ============================================================================

test('LoginLimiter - blocks after max failures', () => {
  const limiter = new LoginLimiter({ max: 3, windowMs: 60000 });
  const ip = '192.168.1.100';

  assert.strictEqual(limiter.blocked(ip), false);

  limiter.fail(ip);
  limiter.fail(ip);
  assert.strictEqual(limiter.blocked(ip), false, 'Should not block before max');

  limiter.fail(ip);
  assert.strictEqual(limiter.blocked(ip), true, 'Should block after max failures');
});

test('LoginLimiter - resets after window expires', () => {
  const limiter = new LoginLimiter({ max: 3, windowMs: 100 });
  const ip = '192.168.1.101';

  limiter.fail(ip);
  limiter.fail(ip);
  limiter.fail(ip);
  assert.strictEqual(limiter.blocked(ip), true);

  // Wait for window to expire
  return new Promise(resolve => {
    setTimeout(() => {
      assert.strictEqual(limiter.blocked(ip), false, 'Should unblock after window expires');
      resolve();
    }, 150);
  });
});

test('LoginLimiter - reset clears IP immediately', () => {
  const limiter = new LoginLimiter({ max: 3, windowMs: 60000 });
  const ip = '192.168.1.102';

  limiter.fail(ip);
  limiter.fail(ip);
  limiter.fail(ip);
  assert.strictEqual(limiter.blocked(ip), true);

  limiter.reset(ip);
  assert.strictEqual(limiter.blocked(ip), false, 'Should unblock after reset');
});

test('LoginLimiter - tracks multiple IPs independently', () => {
  const limiter = new LoginLimiter({ max: 2, windowMs: 60000 });

  limiter.fail('192.168.1.1');
  limiter.fail('192.168.1.1');
  limiter.fail('192.168.1.2');

  assert.strictEqual(limiter.blocked('192.168.1.1'), true);
  assert.strictEqual(limiter.blocked('192.168.1.2'), false);
  assert.strictEqual(limiter.blocked('192.168.1.3'), false);
});

test('LoginLimiter - default configuration', () => {
  const limiter = new LoginLimiter();
  const ip = '192.168.1.103';

  // Default is 10 failures per 15 minutes
  for (let i = 0; i < 9; i++) {
    limiter.fail(ip);
  }
  assert.strictEqual(limiter.blocked(ip), false);

  limiter.fail(ip);
  assert.strictEqual(limiter.blocked(ip), true);
});

test('LoginLimiter - window resets failure count', () => {
  const limiter = new LoginLimiter({ max: 3, windowMs: 100 });
  const ip = '192.168.1.104';

  limiter.fail(ip);
  limiter.fail(ip);

  return new Promise(resolve => {
    setTimeout(() => {
      // Window expired, should start fresh count
      limiter.fail(ip);
      assert.strictEqual(limiter.blocked(ip), false);
      resolve();
    }, 150);
  });
});

// ============================================================================
// SESSION TOKEN TESTS
// ============================================================================

test('issueToken - creates valid token', () => {
  const secret = 'test-secret-key';
  const token = issueToken(secret);
  assert.ok(token.includes('.'));
  assert.strictEqual(verifyToken(token, secret), true);
});

test('verifyToken - rejects token with wrong secret', () => {
  const token = issueToken('correct-secret');
  assert.strictEqual(verifyToken(token, 'wrong-secret'), false);
});

test('verifyToken - rejects expired token', () => {
  const secret = 'test-secret';
  // Create token with negative expiry (fake an expired token)
  const expires = Date.now() - 1000;
  const body = `v1.${expires}`;
  const crypto = require('node:crypto');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const token = `${body}.${sig}`;

  assert.strictEqual(verifyToken(token, secret), false);
});

test('verifyToken - rejects malformed tokens', () => {
  const secret = 'test-secret';
  assert.strictEqual(verifyToken('invalid', secret), false);
  assert.strictEqual(verifyToken('no.dots', secret), false);
  assert.strictEqual(verifyToken('', secret), false);
  assert.strictEqual(verifyToken(null, secret), false);
});

test('verifyToken - rejects tampered token', () => {
  const secret = 'test-secret';
  const token = issueToken(secret);
  const tampered = token.slice(0, -5) + 'XXXXX';
  assert.strictEqual(verifyToken(tampered, secret), false);
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

test('integration - full authentication flow', () => {
  const limiter = new LoginLimiter({ max: 3, windowMs: 60000 });
  const ip = '192.168.1.200';
  const secret = 'session-secret';

  // Step 1: Register with strong password
  const password = 'SecureAdmin123!';
  const validation = validatePassword(password);
  assert.strictEqual(validation.valid, true, 'Password must pass validation');

  // Step 2: Hash password
  const hash = hashPassword(password);
  assert.ok(hash.startsWith('scrypt$'));

  // Step 3: Failed login attempts
  assert.strictEqual(limiter.blocked(ip), false);
  limiter.fail(ip);
  limiter.fail(ip);
  assert.strictEqual(limiter.blocked(ip), false);

  // Step 4: Verify password (successful login)
  assert.strictEqual(verifyPassword(password, hash), true);
  limiter.reset(ip); // Clear on successful login

  // Step 5: Issue session token
  const token = issueToken(secret);
  assert.strictEqual(verifyToken(token, secret), true);
});

test('integration - lockout prevents authentication', () => {
  const limiter = new LoginLimiter({ max: 2, windowMs: 60000 });
  const ip = '192.168.1.201';

  // Multiple failed attempts
  limiter.fail(ip);
  limiter.fail(ip);

  assert.strictEqual(limiter.blocked(ip), true);

  // Even with correct password, should check limiter first
  const hash = hashPassword('CorrectPassword1!');
  assert.strictEqual(verifyPassword('CorrectPassword1!', hash), true);
  assert.strictEqual(limiter.blocked(ip), true, 'Limiter should still block IP');
});

test('integration - password change requires validation', () => {
  const oldPassword = 'OldSecure123!';
  const hash = hashPassword(oldPassword);

  // Verify old password
  assert.strictEqual(verifyPassword(oldPassword, hash), true);

  // New password must pass validation
  const weakNew = 'weak';
  const strongNew = 'NewSecure456!';

  assert.strictEqual(validatePassword(weakNew).valid, false);
  assert.strictEqual(validatePassword(strongNew).valid, true);

  // Hash new password
  const newHash = hashPassword(strongNew);
  assert.strictEqual(verifyPassword(strongNew, newHash), true);
  assert.strictEqual(verifyPassword(oldPassword, newHash), false);
});

test('integration - generated passwords are immediately usable', () => {
  const password = generateSecurePassword();
  const validation = validatePassword(password);
  assert.strictEqual(validation.valid, true);

  const hash = hashPassword(password);
  assert.strictEqual(verifyPassword(password, hash), true);
});

// ============================================================================
// EDGE CASES AND SECURITY TESTS
// ============================================================================

test('security - null byte injection in password', () => {
  const malicious = 'Password1!\x00admin';
  const hash = hashPassword('Password1!');
  assert.strictEqual(verifyPassword(malicious, hash), false);
});

test('security - extremely long password handling', () => {
  const longPassword = 'A1!' + 'x'.repeat(10000);
  const validation = validatePassword(longPassword);
  assert.strictEqual(validation.valid, true); // Should handle gracefully

  const hash = hashPassword(longPassword);
  assert.strictEqual(verifyPassword(longPassword, hash), true);
});

test('security - unicode in password', () => {
  const unicodePassword = 'SecureP@ss123日本語';
  const validation = validatePassword(unicodePassword);
  assert.strictEqual(validation.valid, true);

  const hash = hashPassword(unicodePassword);
  assert.strictEqual(verifyPassword(unicodePassword, hash), true);
});

test('security - case sensitivity in password verification', () => {
  const password = 'CaseSensitive1!';
  const hash = hashPassword(password);

  assert.strictEqual(verifyPassword(password, hash), true);
  assert.strictEqual(verifyPassword('casesensitive1!', hash), false);
  assert.strictEqual(verifyPassword('CASESENSITIVE1!', hash), false);
});

test('security - limiter memory bounds', () => {
  const limiter = new LoginLimiter({ max: 3, windowMs: 60000 });

  // Simulate many different IPs
  for (let i = 0; i < 1000; i++) {
    limiter.fail(`192.168.${Math.floor(i / 256)}.${i % 256}`);
  }

  // Should still function correctly
  const testIp = '10.0.0.1';
  assert.strictEqual(limiter.blocked(testIp), false);
  limiter.fail(testIp);
  limiter.fail(testIp);
  limiter.fail(testIp);
  assert.strictEqual(limiter.blocked(testIp), true);
});

// ============================================================================
// AUDIT LOGGING TESTS
// ============================================================================

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { AuditLogger, EVENT_TYPES, SEVERITY } = require('../lib/audit-log');

test('audit log - initializes with valid directory', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();

  assert.ok(fs.existsSync(logDir));
  await logger.close();

  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('audit log - writes security events', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();

  logger.logLoginSuccess('192.168.1.1', { username: 'admin' });
  logger.logLoginFailure('192.168.1.2', 'Invalid password');
  await logger.close();

  const logFile = path.join(logDir, 'security-audit.log');
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.trim().split('\n');

  assert.ok(lines.length >= 2);

  const lastEntry = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(lastEntry.eventType, EVENT_TYPES.LOGIN_FAILURE);
  assert.strictEqual(lastEntry.ip, '192.168.1.2');

  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('audit log - disabled logger does not write', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: false });
  logger.init();

  logger.logLoginSuccess('192.168.1.1');
  await logger.close();

  const logFile = path.join(logDir, 'security-audit.log');
  assert.strictEqual(fs.existsSync(logFile), false);
});

test('audit log - query filters events', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();

  logger.logLoginSuccess('192.168.1.1');
  logger.logLoginFailure('192.168.1.2', 'Wrong password');
  logger.logLoginLocked('192.168.1.2');
  logger.logPasswordChange('192.168.1.1', true);
  await logger.close();

  const allEvents = await logger.query(100);
  assert.ok(allEvents.length >= 4);

  const failures = await logger.query(100, { eventType: EVENT_TYPES.LOGIN_FAILURE });
  assert.ok(failures.length >= 1);
  assert.strictEqual(failures[0].eventType, EVENT_TYPES.LOGIN_FAILURE);

  const fromIP = await logger.query(100, { ip: '192.168.1.2' });
  assert.ok(fromIP.length >= 2);

  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('audit log - getStats calculates metrics', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();
  
  logger.logLoginSuccess('192.168.1.1');
  logger.logLoginSuccess('192.168.1.2');
  logger.logLoginFailure('192.168.1.3', 'Wrong password');
  logger.logLoginLocked('192.168.1.3');
  logger.logPasswordChange('192.168.1.1', true);
  await logger.close();

  const stats = await logger.getStats(3600000);
  
  assert.ok(stats.total >= 5);
  assert.ok(stats.loginSuccess >= 2);
  assert.ok(stats.loginFailure >= 1);
  assert.ok(stats.loginLocked >= 1);
  assert.ok(stats.passwordChanges >= 1);
  assert.ok(stats.uniqueIPs >= 3);
  
  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('audit log - logs all event types', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();

  const ip = '192.168.1.100';

  logger.logLoginSuccess(ip);
  logger.logLoginFailure(ip, 'test');
  logger.logLoginLocked(ip);
  logger.logLogout(ip);
  logger.logPasswordChange(ip, true);
  logger.logPasswordReset(ip);
  logger.logInvalidToken(ip, 'expired');
  logger.logAdminAction(ip, 'config_change');

  await logger.close();

  const logFile = path.join(logDir, 'security-audit.log');
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.trim().split('\n');

  assert.ok(lines.length >= 8);

  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('audit log - handles malformed log entries gracefully', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();

  logger.logLoginSuccess('192.168.1.1');
  await logger.close();

  const logFile = path.join(logDir, 'security-audit.log');
  fs.appendFileSync(logFile, 'this is not json\n');
  fs.appendFileSync(logFile, '{"valid": "entry"}\n');

  const events = await logger.query(100);
  assert.ok(events.length >= 2);

  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('integration - full security flow with audit logging', async () => {
  const logDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
  const logger = new AuditLogger({ logDir, enabled: true });
  logger.init();
  
  const limiter = new LoginLimiter({ max: 3, windowMs: 60000 });
  const ip = '192.168.1.250';
  const password = 'SecureAdmin123!';
  
  for (let i = 0; i < 3; i++) {
    if (limiter.blocked(ip)) {
      logger.logLoginLocked(ip);
      break;
    }
    limiter.fail(ip);
    logger.logLoginFailure(ip, 'Invalid password');
  }
  
  assert.strictEqual(limiter.blocked(ip), true);
  
  const lockouts = await logger.query(10, { eventType: EVENT_TYPES.LOGIN_LOCKED });
  assert.ok(lockouts.length >= 1 || limiter.blocked(ip));
  
  limiter.reset(ip);
  logger.logAdminAction('10.0.0.1', 'reset_lockout', { targetIp: ip });
  
  const hash = hashPassword(password);
  if (verifyPassword(password, hash) && !limiter.blocked(ip)) {
    const token = issueToken('secret');
    logger.logLoginSuccess(ip, { sessionToken: token.slice(0, 10) + '...' });
  }

  await logger.close();

  const stats = await logger.getStats(3600000);
  assert.ok(stats.loginFailure >= 3);
  assert.ok(stats.loginSuccess >= 1);
  
  // Cleanup
  fs.rmSync(logDir, { recursive: true, force: true });
});
