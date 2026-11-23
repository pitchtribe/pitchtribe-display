'use strict';
/* Security audit logging for authentication events, password changes,
   account lockouts, and administrative actions. GDPR-compliant: logs
   actions and IPs but no credentials or personal data. */

const fs = require('node:fs');
const path = require('node:path');

/** Security event types that should be logged */
const EVENT_TYPES = {
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGIN_LOCKED: 'login_locked',
  LOGOUT: 'logout',
  PASSWORD_CHANGE: 'password_change',
  PASSWORD_RESET: 'password_reset',
  SESSION_EXPIRED: 'session_expired',
  INVALID_TOKEN: 'invalid_token',
  ADMIN_ACTION: 'admin_action',
};

/** Severity levels for security events */
const SEVERITY = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  CRITICAL: 'critical',
};

/**
 * AuditLogger records security-relevant events to disk.
 * Logs are append-only JSON lines (JSONL format) for easy parsing.
 */
class AuditLogger {
  constructor({ logDir, enabled = true } = {}) {
    this.logDir = logDir;
    this.enabled = enabled;
    this.stream = null;
  }

  /**
   * Initialize the logger and ensure log directory exists.
   */
  init() {
    if (!this.enabled || !this.logDir) return;

    try {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o750 });

      // Open log file in append mode with restrictive permissions
      const logFile = path.join(this.logDir, 'security-audit.log');
      this.stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o640 });

      this.stream.on('error', () => { this.enabled = false; });
      this.log(EVENT_TYPES.ADMIN_ACTION, {
        severity: SEVERITY.INFO,
        message: 'Audit logging initialized',
      });
    } catch (err) {
      console.error('Failed to initialize audit logger:', err);
      this.enabled = false;
    }
  }

  /**
   * Log a security event.
   * @param {string} eventType - Type of event (use EVENT_TYPES constants)
   * @param {Object} details - Event details
   * @param {string} details.severity - Severity level (use SEVERITY constants)
   * @param {string} details.ip - Client IP address
   * @param {string} details.message - Human-readable event description
   * @param {Object} details.metadata - Additional event-specific metadata
   */
  log(eventType, { severity = SEVERITY.INFO, ip, message, metadata = {} } = {}) {
    if (!this.enabled || !this.stream) return;

    const entry = {
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      ip: ip || 'unknown',
      message,
      ...metadata,
    };

    try {
      this.stream.write(JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('Failed to write audit log:', err);
    }
  }

  /**
   * Log successful login attempt.
   */
  logLoginSuccess(ip, metadata = {}) {
    this.log(EVENT_TYPES.LOGIN_SUCCESS, {
      severity: SEVERITY.INFO,
      ip,
      message: 'User logged in successfully',
      metadata,
    });
  }

  /**
   * Log failed login attempt.
   */
  logLoginFailure(ip, reason, metadata = {}) {
    this.log(EVENT_TYPES.LOGIN_FAILURE, {
      severity: SEVERITY.WARN,
      ip,
      message: `Login failed: ${reason}`,
      metadata: { reason, ...metadata },
    });
  }

  /**
   * Log account lockout event.
   */
  logLoginLocked(ip, metadata = {}) {
    this.log(EVENT_TYPES.LOGIN_LOCKED, {
      severity: SEVERITY.ERROR,
      ip,
      message: 'Account locked due to too many failed attempts',
      metadata,
    });
  }

  /**
   * Log user logout.
   */
  logLogout(ip, metadata = {}) {
    this.log(EVENT_TYPES.LOGOUT, {
      severity: SEVERITY.INFO,
      ip,
      message: 'User logged out',
      metadata,
    });
  }

  /**
   * Log password change.
   */
  logPasswordChange(ip, success, metadata = {}) {
    this.log(EVENT_TYPES.PASSWORD_CHANGE, {
      severity: success ? SEVERITY.INFO : SEVERITY.WARN,
      ip,
      message: success ? 'Password changed successfully' : 'Password change failed',
      metadata: { success, ...metadata },
    });
  }

  /**
   * Log password reset initiation.
   */
  logPasswordReset(ip, metadata = {}) {
    this.log(EVENT_TYPES.PASSWORD_RESET, {
      severity: SEVERITY.INFO,
      ip,
      message: 'Password reset initiated',
      metadata,
    });
  }

  /**
   * Log invalid or expired session token usage.
   */
  logInvalidToken(ip, reason, metadata = {}) {
    this.log(EVENT_TYPES.INVALID_TOKEN, {
      severity: SEVERITY.WARN,
      ip,
      message: `Invalid token: ${reason}`,
      metadata: { reason, ...metadata },
    });
  }

  /**
   * Log administrative action.
   */
  logAdminAction(ip, action, metadata = {}) {
    this.log(EVENT_TYPES.ADMIN_ACTION, {
      severity: SEVERITY.INFO,
      ip,
      message: `Admin action: ${action}`,
      metadata: { action, ...metadata },
    });
  }

  /**
   * Close the log stream gracefully.
   * Returns a promise that resolves when the stream is fully flushed.
   */
  close() {
    return new Promise((resolve) => {
      if (this.stream) {
        this.stream.end(() => {
          this.stream = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Query recent log entries (for security dashboard/monitoring).
   * Returns last N entries matching optional filter.
   * @param {number} limit - Maximum number of entries to return
   * @param {Object} filter - Filter criteria (eventType, severity, ip)
   * @returns {Array<Object>} - Array of log entries
   */
  async query(limit = 100, filter = {}) {
    if (!this.enabled || !this.logDir) return [];

    const logFile = path.join(this.logDir, 'security-audit.log');

    try {
      const content = await fs.promises.readFile(logFile, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);

      let entries = lines
        .reverse() // Most recent first
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // Apply filters
      if (filter.eventType) {
        entries = entries.filter(e => e.eventType === filter.eventType);
      }
      if (filter.severity) {
        entries = entries.filter(e => e.severity === filter.severity);
      }
      if (filter.ip) {
        entries = entries.filter(e => e.ip === filter.ip);
      }

      return entries.slice(0, limit);
    } catch (err) {
      if (err.code === 'ENOENT') return []; // No log file yet
      console.error('Failed to query audit log:', err);
      return [];
    }
  }

  /**
   * Get security statistics for monitoring dashboard.
   * @param {number} windowMs - Time window in milliseconds (default: 1 hour)
   * @returns {Object} - Statistics object
   */
  async getStats(windowMs = 3600000) {
    const entries = await this.query(10000); // Large sample
    const cutoff = Date.now() - windowMs;

    const recent = entries.filter(e => new Date(e.timestamp).getTime() > cutoff);

    return {
      total: recent.length,
      loginSuccess: recent.filter(e => e.eventType === EVENT_TYPES.LOGIN_SUCCESS).length,
      loginFailure: recent.filter(e => e.eventType === EVENT_TYPES.LOGIN_FAILURE).length,
      loginLocked: recent.filter(e => e.eventType === EVENT_TYPES.LOGIN_LOCKED).length,
      passwordChanges: recent.filter(e => e.eventType === EVENT_TYPES.PASSWORD_CHANGE).length,
      invalidTokens: recent.filter(e => e.eventType === EVENT_TYPES.INVALID_TOKEN).length,
      criticalEvents: recent.filter(e => e.severity === SEVERITY.CRITICAL).length,
      uniqueIPs: new Set(recent.map(e => e.ip)).size,
    };
  }
}

module.exports = {
  AuditLogger,
  EVENT_TYPES,
  SEVERITY,
};
