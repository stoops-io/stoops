/**
 * Auth token system for stoops share links and session management.
 *
 * Two token types:
 * - Share tokens — embedded in URLs, map to an authority tier.
 *   Anyone with the link joins at that tier.
 * - Session tokens — issued on join, identify a participant + authority.
 *   Used for all subsequent API calls.
 */

import { randomBytes } from "node:crypto";
import type { AuthorityLevel } from "../core/types.js";

interface SessionData {
  participantId: string;
  authority: AuthorityLevel;
}

export class TokenManager {
  /** share token hash → authority level */
  private _shareTokens = new Map<string, AuthorityLevel>();
  /** session token → participant data */
  private _sessionTokens = new Map<string, SessionData>();

  /**
   * Generate a share token at the given authority tier.
   * Callers can only generate tokens at their own tier or below.
   */
  generateShareToken(callerAuthority: AuthorityLevel, targetAuthority: AuthorityLevel): string | null {
    if (!canGrant(callerAuthority, targetAuthority)) return null;
    const token = randomBytes(16).toString("hex");
    this._shareTokens.set(token, targetAuthority);
    return token;
  }

  /** Validate a share token and return its authority level. */
  validateShareToken(token: string): AuthorityLevel | null {
    return this._shareTokens.get(token) ?? null;
  }

  /** Create a session token for a participant. */
  createSessionToken(participantId: string, authority: AuthorityLevel): string {
    const token = randomBytes(16).toString("hex");
    this._sessionTokens.set(token, { participantId, authority });
    return token;
  }

  /** Validate a session token and return participant data. */
  validateSessionToken(token: string): SessionData | null {
    return this._sessionTokens.get(token) ?? null;
  }

  /** Revoke a session token (on disconnect). */
  revokeSessionToken(token: string): void {
    this._sessionTokens.delete(token);
  }

  /** Find a session token by participant ID (for cleanup). */
  findSessionByParticipant(participantId: string): string | null {
    for (const [token, data] of this._sessionTokens) {
      if (data.participantId === participantId) return token;
    }
    return null;
  }
}

/** Authority tier ordering: admin > participant > observer. */
const TIER_ORDER: Record<AuthorityLevel, number> = {
  admin: 2,
  participant: 1,
  observer: 0,
};

/** Can a caller at `callerLevel` grant authority at `targetLevel`? */
function canGrant(callerLevel: AuthorityLevel, targetLevel: AuthorityLevel): boolean {
  return TIER_ORDER[callerLevel] >= TIER_ORDER[targetLevel];
}

/** Build a share URL from a base URL and token. */
export function buildShareUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Extract a token from a share URL. */
export function extractToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}
