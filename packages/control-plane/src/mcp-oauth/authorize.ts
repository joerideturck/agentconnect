/**
 * The authorization request, and the check that must pass before its response is acted on.
 *
 * RFC 9207 issuer identification is the part worth reading twice. The client records the
 * authorization server's `issuer` BEFORE redirecting, alongside the PKCE verifier, and
 * compares it to the `iss` the response carries. That is what defeats a mix-up attack: an
 * authorization server the user was quietly redirected to cannot have its code redeemed at
 * the server we think we are talking to. The comparison is simple string equality — no
 * scheme or host case folding, no default-port elision, no trailing-slash or percent-encoding
 * normalization — and it applies to ERROR responses too, so a mismatched error is never
 * displayed or acted on.
 *
 * The four-way table is the spec's, including its deliberate third row: a present `iss` is
 * always compared, even when the server never advertised the capability, to accommodate
 * servers that emit it before updating their metadata.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AuthServerMetadata } from './discovery.js'

/** A PKCE pair. S256 only — OAuth 2.1 removes `plain`, and every MCP server supports S256. */
export interface PkcePair {
  verifier: string
  challenge: string
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export interface AuthorizeRequest {
  metadata: AuthServerMetadata
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /** Empty ⇒ no `scope` parameter at all, which is what the spec asks for when none is known. */
  scopes: string[]
  /** The RFC 8707 audience, verbatim from protected-resource metadata. */
  resource: string
}

/** Build the authorization URL. `resource` rides here as well as on the token request. */
export function buildAuthorizeUrl(req: AuthorizeRequest): string {
  const url = new URL(req.metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', req.clientId)
  url.searchParams.set('redirect_uri', req.redirectUri)
  url.searchParams.set('state', req.state)
  url.searchParams.set('code_challenge', req.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', req.resource)
  if (req.scopes.length > 0) url.searchParams.set('scope', req.scopes.join(' '))
  for (const [k, v] of Object.entries(refreshTokenRequestParams(req.metadata.issuer))) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * Parameters some authorization servers need before they will issue a REFRESH token at all.
 * The relay binding lives on a refresh token (refresher.ts): a grant without one works for
 * exactly one access-token lifetime and then lands in `reauth_required`, so this is not a
 * nicety. RFC 6749 §3.1 obliges every server to ignore parameters it does not recognize, which
 * is what makes `access_type=offline` safe to send everywhere.
 *
 *  - Google (`accounts.google.com`) returns a refresh token only for `access_type=offline`, and
 *    only on the FIRST authorization of a client unless `prompt=consent` forces a new consent
 *    screen — without it a re-connect after disconnect silently comes back refresh-less.
 *    `prompt` is an OIDC parameter with its own meaning elsewhere, so it stays Google-only.
 */
export function refreshTokenRequestParams(issuer: string): Record<string, string> {
  let host: string
  try {
    host = new URL(issuer).host
  } catch {
    return { access_type: 'offline' }
  }
  return host === 'accounts.google.com' ? { access_type: 'offline', prompt: 'consent' } : { access_type: 'offline' }
}

/**
 * RFC 9207 §2.4, as the spec tabulates it. False ⇒ the response must be discarded without
 * redeeming its code, and without showing its error.
 */
export function issuerResponseValid(input: {
  /** `authorization_response_iss_parameter_supported` from the validated metadata. */
  advertised: boolean
  /** The `iss` the response carried, if any. */
  present: string | undefined
  /** The issuer recorded before the redirect, from the validated metadata. */
  expected: string
}): boolean {
  if (input.present !== undefined) return input.present === input.expected
  return !input.advertised
}
