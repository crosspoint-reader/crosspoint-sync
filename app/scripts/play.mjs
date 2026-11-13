// Google Play releases through the Play Developer API (androidpublisher v3).
//
//   node scripts/play.mjs upload <app.aab> <track> [name]   upload a signed AAB and release it on <track>
//   node scripts/play.mjs release <versionCode> <track> [name]   release an already-uploaded build on <track>
//   node scripts/play.mjs tracks   list every track's releases
//   node scripts/play.mjs apk <versionCode> <out.apk>   download Play's universal APK (Play-signed, so it updates with the store copy)
//
// Tracks: internal, alpha, beta, production. Upload to internal first, then
// `release` the same versionCode to production. Credentials: a service account
// JSON at $PLAY_CREDENTIALS (default ~/.android-keys/play-publisher.json).
// Never put that file in the repo.
import { readFileSync, writeFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { homedir } from 'node:os'

const PKG = 'com.crosspointreader.sync'
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`
const [command, arg, track, name] = process.argv.slice(2)

async function token() {
  const sa = JSON.parse(readFileSync(process.env.PLAY_CREDENTIALS ?? `${homedir()}/.android-keys/play-publisher.json`, 'utf8'))
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: sa.token_uri, iat: now, exp: now + 3600 }
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`token: ${JSON.stringify(body.error ?? body)}`)
  return body.access_token
}

const auth = { authorization: `Bearer ${await token()}` }
async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...auth, ...init.headers } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.replace(API, '')} ${res.status}: ${body.error?.message ?? JSON.stringify(body)}`)
  return body
}

// Every change happens in an edit, which only takes effect once committed.
const edit = await call(`${API}/edits`, { method: 'POST' })
const EDIT = `${API}/edits/${edit.id}`

if (command === 'tracks') {
  for (const t of (await call(`${EDIT}/tracks`)).tracks) {
    console.log(t.track.padEnd(11), (t.releases ?? []).map((r) => `${r.name ?? '-'} [${r.versionCodes ?? []}] ${r.status}`).join(', '))
  }
  await fetch(EDIT, { method: 'DELETE', headers: auth })
} else if ((command === 'upload' || command === 'release') && arg && track) {
  let versionCode = arg
  if (command === 'upload') {
    const bundle = await call(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}/edits/${edit.id}/bundles?uploadType=media`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: readFileSync(arg),
    })
    versionCode = String(bundle.versionCode)
    console.log('uploaded versionCode', versionCode)
  }
  const release = { versionCodes: [versionCode], status: 'completed', ...(name ? { name } : {}) }
  await call(`${EDIT}/tracks/${track}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track, releases: [release] }) })
  await call(`${EDIT}:commit`, { method: 'POST' })
  console.log(`released ${versionCode} on ${track}`)
} else if (command === 'apk' && arg && track) {
  const out = track
  const { generatedApks } = await call(`${API}/generatedApks/${arg}`)
  const id = generatedApks?.[0]?.generatedUniversalApk?.downloadId
  if (!id) throw new Error(`no universal APK for versionCode ${arg} yet`)
  const res = await fetch(`${API}/generatedApks/${arg}/downloads/${encodeURIComponent(id)}:download?alt=media`, { headers: auth })
  if (!res.ok) throw new Error(`download ${res.status}`)
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  console.log('saved', out)
  await fetch(EDIT, { method: 'DELETE', headers: auth })
} else {
  console.error('usage: play.mjs upload <app.aab> <track> [name] | release <versionCode> <track> [name] | tracks | apk <versionCode> <out.apk>')
  await fetch(EDIT, { method: 'DELETE', headers: auth })
  process.exit(1)
}
