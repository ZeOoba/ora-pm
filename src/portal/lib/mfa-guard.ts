export type AuthenticatorAssuranceLevel = 'aal1' | 'aal2' | null

export interface AalStatus {
  currentLevel: AuthenticatorAssuranceLevel
  nextLevel: AuthenticatorAssuranceLevel
}

export type AalGuardResult = 'challenge required' | 'session OK'

/**
 * Pure decision function for the portal's post-login AAL2 guard (OI-045).
 *
 * Shaped directly around Supabase's `mfa.getAuthenticatorAssuranceLevel()` response:
 * `nextLevel` comes back as `'aal2'` whenever the user has at least one *verified*
 * TOTP factor enrolled, regardless of whether the current session has actually
 * completed an MFA challenge yet. So `nextLevel === 'aal2' && currentLevel !== 'aal2'`
 * means "a verified factor exists, but this session hasn't cleared it" -- the tenant
 * must complete a challenge/verify step before the session is treated as fully
 * authenticated. A tenant with no verified factor never sees `nextLevel` rise above
 * `currentLevel`, so this guard is a no-op for them.
 */
export function checkAal2Guard({ currentLevel, nextLevel }: AalStatus): AalGuardResult {
  if (nextLevel === 'aal2' && currentLevel !== 'aal2') {
    return 'challenge required'
  }
  return 'session OK'
}
