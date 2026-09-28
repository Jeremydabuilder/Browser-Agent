// Google sign-in for Gmail and Google Classroom using chrome.identity.launchWebAuthFlow
// (works in both Chrome and Edge). Each service is a SEPARATE connection with its own scopes,
// requested only when the user clicks "Connect" for it. Access tokens are kept in session storage
// (memory only, cleared when the browser closes) and are never sent to Groq.
import { getSettings } from './settings.js';
import { getItem, setItem, removeItem } from './storage.js';

export const GOOGLE_SERVICES = {
  gmailRead: {
    label: 'Gmail: read the threads you pick',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    explain: 'Lets Satchel list your recent threads and open the ones you select so you can summarize them or draft a reply. Satchel only opens a thread when you choose it, and never saves email content.',
  },
  gmailSend: {
    label: 'Gmail: send replies you approve',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    explain: 'Lets Satchel send an email only after you review the recipients, subject, and complete message and press "Send" on the confirmation screen. Satchel cannot read your mail with this permission.',
  },
  classroom: {
    label: 'Google Classroom: read your classes and coursework',
    scopes: ['https://www.googleapis.com/auth/classroom.courses.readonly', 'https://www.googleapis.com/auth/classroom.coursework.me.readonly'],
    explain: 'Lets Satchel import assignments and due dates from your Google Classroom classes into the School view. Read-only; Satchel cannot turn in or change work.',
  },
};

const BASE_SCOPES = ['openid', 'email'];
const TOKEN_KEY = 'googleToken';
const CONNECTIONS_KEY = 'googleConnections';

export class GoogleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
  }
}

export function redirectUri() {
  return chrome.identity.getRedirectURL();
}

export function explainAuthError(code, description = '') {
  switch (code) {
    case 'admin_policy_enforced':
      return new GoogleError('admin_blocked', 'Your Google Workspace administrator (school IT) has blocked this app from accessing your account. Everything else in Satchel still works. To use this feature, ask your school IT to allow the app\'s OAuth client ID, or connect a personal Google account.');
    case 'org_internal':
      return new GoogleError('org_internal', 'This Google Cloud app is restricted to users in its own organization. Change the OAuth consent screen to "External" and add yourself as a test user.');
    case 'access_denied':
      return new GoogleError('access_denied', 'Access was not granted. Either you pressed Cancel, or Google showed "Access blocked" (common with school accounts, where IT must approve third-party apps, and with apps in Testing mode where your address is not listed as a test user). Everything else in Satchel still works.');
    case 'invalid_client':
    case 'unauthorized_client':
      return new GoogleError('setup', 'Google did not recognize the OAuth client ID. Check the client ID in Satchel Settings (it must be a "Web application" client).');
    case 'redirect_uri_mismatch':
      return new GoogleError('setup', `Google rejected the redirect address. Add ${redirectUri()} as an "Authorized redirect URI" on your OAuth client.`);
    case 'interaction_required':
    case 'login_required':
    case 'consent_required':
      return new GoogleError('reconnect', 'Please reconnect your Google account (click Connect).');
    default:
      return new GoogleError('auth_failed', `Google sign-in failed${code ? ` (${code})` : ''}${description ? `: ${description}` : ''}.`);
  }
}

export function parseAuthResponse(responseUrl, expectedState) {
  const url = new URL(responseUrl);
  const params = new URLSearchParams(url.hash.replace(/^#/, '') || url.search.replace(/^\?/, ''));
  if (params.get('error')) throw explainAuthError(params.get('error'), params.get('error_description') || '');
  if (expectedState && params.get('state') !== expectedState) throw new GoogleError('auth_failed', 'Google sign-in response did not match the request. Please try again.');
  const accessToken = params.get('access_token');
  if (!accessToken) throw new GoogleError('auth_failed', 'Google did not return an access token.');
  const expiresIn = Number(params.get('expires_in') || 3600);
  return { accessToken, expiresAt: Date.now() + expiresIn * 1000, scopes: (params.get('scope') || '').split(/\s+/).filter(Boolean) };
}

export async function getConnections() {
  return getItem(CONNECTIONS_KEY, {});
}

async function currentToken() {
  return getItem(TOKEN_KEY, null, 'session');
}

function hasScopes(token, scopes) {
  return !!token && scopes.every((s) => token.scopes.includes(s));
}

async function runAuthFlow(scopes, interactive) {
  const { googleClientId } = await getSettings();
  if (!googleClientId) {
    throw new GoogleError('setup', 'Google is not set up yet. Open Satchel Settings → Google and paste your OAuth client ID (the guide there walks you through creating one).');
  }
  if (!chrome.identity?.launchWebAuthFlow) {
    throw new GoogleError('setup', 'The "identity" permission has not been granted. Click Connect again and allow it.');
  }
  const state = crypto.randomUUID();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', googleClientId.trim());
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', [...new Set([...BASE_SCOPES, ...scopes])].join(' '));
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', interactive ? 'consent' : 'none');
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive });
  } catch (err) {
    const msg = String(err?.message || err);
    if (!interactive) throw new GoogleError('reconnect', 'Your Google session expired. Click Connect to sign in again.');
    if (/did not approve|closed|cancel/i.test(msg)) throw explainAuthError('access_denied');
    throw new GoogleError('auth_failed', `Google sign-in could not start: ${msg}`);
  }
  return parseAuthResponse(responseUrl, state);
}

/** Must be called from a click handler (the identity permission prompt needs a user gesture). */
export function requestIdentityPermission() {
  return chrome.permissions.request({ permissions: ['identity'] });
}

export async function connect(serviceKey) {
  const service = GOOGLE_SERVICES[serviceKey];
  if (!service) throw new GoogleError('setup', 'Unknown Google service.');
  const existing = await currentToken();
  const wanted = [...new Set([...(existing?.scopes || []).filter((s) => s.startsWith('https://')), ...service.scopes])];
  const token = await runAuthFlow(wanted, true);
  if (!hasScopes(token, service.scopes)) {
    throw new GoogleError('partial', `Google did not grant the permission for "${service.label}". If you unticked a box on the consent screen, connect again and leave it ticked.`);
  }
  token.email = await fetchEmail(token.accessToken).catch(() => existing?.email || '');
  await setItem(TOKEN_KEY, token, 'session');
  const connections = await getConnections();
  await setItem(CONNECTIONS_KEY, { ...connections, [serviceKey]: { connectedAt: new Date().toISOString(), email: token.email } });
  return token;
}

async function fetchEmail(accessToken) {
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return '';
  return (await r.json()).email || '';
}

/** Returns a valid access token for the service, refreshing silently if the user connected before. */
export async function getAccessToken(serviceKey) {
  const service = GOOGLE_SERVICES[serviceKey];
  const connections = await getConnections();
  if (!connections[serviceKey]) throw new GoogleError('not_connected', `Connect "${service.label}" first.`);
  const token = await currentToken();
  if (hasScopes(token, service.scopes) && token.expiresAt - 60000 > Date.now()) return token.accessToken;
  const scopes = [...new Set(Object.keys(connections).flatMap((k) => GOOGLE_SERVICES[k]?.scopes || []))];
  const fresh = await runAuthFlow(scopes, false);
  fresh.email = token?.email || connections[serviceKey].email || '';
  await setItem(TOKEN_KEY, fresh, 'session');
  if (!hasScopes(fresh, service.scopes)) throw new GoogleError('reconnect', `Please reconnect "${service.label}".`);
  return fresh.accessToken;
}

export async function disconnect(serviceKey) {
  const connections = await getConnections();
  delete connections[serviceKey];
  await setItem(CONNECTIONS_KEY, connections);
  if (!Object.keys(connections).length) await disconnectAll();
}

/** Revokes Google's grant for this app entirely and forgets all tokens. */
export async function disconnectAll() {
  const token = await currentToken();
  if (token?.accessToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token.accessToken)}`, { method: 'POST' });
    } catch { /* offline: token will still expire within an hour */ }
  }
  await removeItem(TOKEN_KEY, 'session');
  await setItem(CONNECTIONS_KEY, {});
}

/** Maps Google API error payloads to messages that tell the user what to do. */
export function explainApiError(status, body, serviceLabel = 'Google') {
  let err = {};
  try { err = JSON.parse(body).error || {}; } catch { /* not JSON */ }
  const reasons = [
    ...(err.errors || []).map((e) => e.reason),
    ...(err.details || []).map((d) => d.reason),
    err.status,
  ].filter(Boolean).join(' ');
  const message = err.message || '';
  if (status === 401) return new GoogleError('reconnect', `Your ${serviceLabel} connection expired. Click Connect again.`);
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reasons) || /has not been used in project|is disabled/i.test(message)) {
    return new GoogleError('api_disabled', `The ${serviceLabel} API is not enabled in your Google Cloud project. Enable it in the Google Cloud console (APIs & Services → Library), wait a minute, and try again.`);
  }
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reasons)) {
    return new GoogleError('reconnect', `Satchel does not have permission for this ${serviceLabel} action. Connect it again and allow the requested access.`);
  }
  if (status === 403 && (/domain|administrator|admin|policy|ClassroomApiDisabled|@ProjectPermissionDenied|PERMISSION_DENIED/i.test(`${reasons} ${message}`))) {
    return new GoogleError('admin_blocked', `Your school's Google administrator does not allow this app to use ${serviceLabel}. Everything else in Satchel still works. Ask school IT to allow the app, or use the school website instead.`);
  }
  if (status === 429) return new GoogleError('rate_limited', `${serviceLabel} is limiting requests right now. Wait a minute and try again.`);
  if (status >= 500) return new GoogleError('server', `${serviceLabel} is having trouble (HTTP ${status}). Try again shortly.`);
  return new GoogleError('api_error', `${serviceLabel} returned an error (HTTP ${status})${message ? `: ${message}` : ''}.`);
}

export async function googleFetch(serviceKey, url, { method = 'GET', body, label = 'Google' } = {}) {
  let token = await getAccessToken(serviceKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.ok) return r.status === 204 ? null : r.json();
    const text = await r.text();
    if (r.status === 401 && attempt === 0) {
      await removeItem(TOKEN_KEY, 'session');
      token = await getAccessToken(serviceKey);
      continue;
    }
    throw explainApiError(r.status, text, label);
  }
  throw new GoogleError('api_error', `${label} request failed.`);
}
