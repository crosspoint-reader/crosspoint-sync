import { useEffect, useRef, useState } from 'react'
import {
  BookUp,
  FilePen,
  ChevronRight,
  FolderPlus,
  Pencil,
  CircleAlert,
  CircleCheck,
  FileText,
  Folder,
  ImageDown,
  Loader2,
  RefreshCw,
  Send as SendIcon,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { isApp } from './api.js'
import { DEFAULT_HOST, EXTENSIONS, connect, deleteFiles, folders, isBook, joinPath, listFiles, loadDevicePrefs, makeFolder, renameFile, saveDevicePrefs } from './device.js'
import { downloads as listDownloads, removeDownload, sendDownload, sendFile } from './catalogs.js'
import { Card, Eyebrow } from './ui.jsx'

const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
// Android's picker filters by MIME type and has none for .md, so let it show everything there.
const ACCEPT = /android/i.test(navigator.userAgent) ? undefined : EXTENSIONS.map((e) => `.${e}`).join(',')

// Shared "what's happening" line for a send, from Rust progress events.
export function progressLabel(p) {
  if (!p) return 'Sending…'
  if (p.stage === 'downloading') return p.total ? `Downloading ${Math.round((p.done / p.total) * 100)}%` : `Downloading ${size(p.done)}`
  if (p.stage === 'optimizing') return p.total ? `Shrinking images ${p.done}/${p.total}` : 'Shrinking images…'
  return 'Sending to reader…'
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${checked ? 'bg-brand-500' : 'bg-stone-300'}`}
    >
      <span className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition-all ${checked ? 'left-[1.4rem]' : 'left-0.5'}`} />
    </button>
  )
}

function Device({ prefs, setPrefs, device, onRetry }) {
  const [editing, setEditing] = useState(false)
  const [host, setHost] = useState(prefs.host)
  const { state, status, error, dirs } = device
  return (
    <Card className="mt-6 p-4">
      <div className="flex items-start gap-3">
        <div className={`grid size-10 shrink-0 place-items-center rounded-full ${state === 'ok' ? 'bg-brand-50 text-brand-600' : 'bg-stone-100 text-stone-500'}`}>
          {state === 'searching' ? <Loader2 className="size-5 animate-spin" /> : state === 'ok' ? <Wifi className="size-5" /> : <WifiOff className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-stone-900">
            {state === 'searching' ? `Looking for ${prefs.host}…` : state === 'ok' ? `CrossPoint ${status.device ?? ''}`.trim() : 'Reader not found'}
          </p>
          <p className="mt-0.5 text-sm/6 text-stone-500">
            {state === 'ok'
              ? `${status.ip ?? prefs.host} · firmware ${status.version}`
              : state === 'error'
                ? 'On your reader, open File Transfer and keep it on the same Wi-Fi as this device.'
                : 'Make sure File Transfer is open on your reader.'}
          </p>
          {state === 'error' && error && <p className="mt-1 font-mono text-[0.7rem] break-all text-stone-400">{error}</p>}
        </div>
        <button onClick={onRetry} className="grid size-10 place-items-center rounded-full text-stone-500 active:bg-stone-100" aria-label="Retry">
          <RefreshCw className="size-5" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 border-t border-stone-100 pt-4 sm:grid-cols-2">
        <label className="block text-xs font-medium text-stone-500">
          Save to folder
          <div className="mt-1 flex h-11 items-center gap-2 rounded-xl bg-stone-50 px-3 ring-1 ring-stone-950/10">
            <Folder className="size-4 text-stone-400" />
            <select
              value={prefs.folder}
              onChange={(e) => setPrefs({ ...prefs, folder: e.target.value })}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none"
            >
              {[...new Set(['/', ...dirs.map((d) => `/${d}`), prefs.folder])].map((f) => (
                <option key={f} value={f}>
                  {f === '/' ? 'SD card (top level)' : f}
                </option>
              ))}
            </select>
          </div>
        </label>
        <div className="text-xs font-medium text-stone-500">
          Reader address
          {editing ? (
            <form
              className="mt-1 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setPrefs({ ...prefs, host: host.trim() || DEFAULT_HOST })
                setEditing(false)
              }}
            >
              <input
                autoFocus
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="crosspoint.local or 192.168.1.40"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-xl bg-white px-3 text-sm text-stone-900 ring-1 ring-stone-950/10 outline-none focus:ring-2 focus:ring-brand-500/60"
              />
              <button className="h-11 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white">Save</button>
            </form>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="mt-1 flex h-11 w-full items-center justify-between rounded-xl bg-stone-50 px-3 font-mono text-sm text-stone-700 ring-1 ring-stone-950/10"
            >
              {prefs.host}
              <span className="font-sans text-xs font-semibold text-brand-600">Change</span>
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 border-t border-stone-100 pt-4">
        <div className="flex items-center gap-3">
          <ImageDown className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-900">Shrink EPUB images</p>
            <p className="text-xs/5 text-stone-500">Re-encodes pictures as JPEG so books take less space and open faster.</p>
          </div>
          <Toggle label="Shrink EPUB images" checked={prefs.optimize} onChange={(optimize) => setPrefs({ ...prefs, optimize })} />
        </div>
        {prefs.optimize && (
          <label className="mt-3 flex items-center gap-3 pl-8 text-xs text-stone-500">
            Quality
            <input
              type="range"
              min="30"
              max="95"
              step="5"
              value={prefs.quality}
              onChange={(e) => setPrefs({ ...prefs, quality: Number(e.target.value) })}
              className="flex-1 accent-brand-500"
            />
            <span className="w-8 text-right font-mono text-stone-700">{prefs.quality}</span>
          </label>
        )}
        <div className="mt-4 flex items-center gap-3">
          <FilePen className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-900">Rename from book metadata</p>
            <p className="text-xs/5 text-stone-500">Use Title - Author.epub when available.</p>
          </div>
          <Toggle
            label="Rename from book metadata"
            checked={prefs.renameFromMetadata}
            onChange={(renameFromMetadata) => setPrefs({ ...prefs, renameFromMetadata })}
          />
        </div>
      </div>
    </Card>
  )
}

function Status({ state, error, progress, sentAs }) {
  if (state === 'sending') return <span className="text-stone-500">{progressLabel(progress)}</span>
  if (state === 'done') return <span className="text-brand-600">{sentAs ? `Sent as ${sentAs}` : 'Sent'}</span>
  if (state === 'error') return <span className="text-red-600">{error}</span>
  return null
}

function StatusIcon({ state }) {
  if (state === 'sending') return <Loader2 className="size-5 animate-spin text-brand-500" />
  if (state === 'done') return <CircleCheck className="size-5 text-brand-500" />
  if (state === 'error') return <CircleAlert className="size-5 text-red-500" />
  return null
}

// Books downloaded from catalogs (Browse), ready to send.
function Shelf({ prefs, ready }) {
  const [books, setBooks] = useState(null)
  const [jobs, setJobs] = useState({}) // name -> { state, error, progress }
  const reload = () => listDownloads().then(setBooks, () => setBooks([]))
  useEffect(() => {
    reload()
  }, [])
  if (!books?.length) return null

  async function send(name) {
    const set = (patch) => setJobs((j) => ({ ...j, [name]: { ...j[name], ...patch } }))
    set({ state: 'sending', error: null, progress: null })
    try {
      const used = await sendDownload(name, prefs, (progress) => set({ progress }))
      set({ state: 'done', sentAs: used !== name ? used : null })
    } catch (e) {
      set({ state: 'error', error: String(e) })
    }
  }

  return (
    <section className="mt-8">
      <h2 className="font-display text-xl font-semibold text-stone-900">Downloaded books</h2>
      <Card className="mt-3 divide-y divide-stone-100">
        {books.map((b) => {
          const job = jobs[b.name] ?? {}
          return (
            <div key={b.name} className="flex items-center gap-3 px-4 py-3">
              {b.meta?.cover ? (
                <img src={b.meta.cover} alt="" className="aspect-[2/3] w-10 shrink-0 rounded object-cover ring-1 ring-stone-950/10" />
              ) : (
                <FileText className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-stone-900">{b.meta?.title ?? b.name}</p>
                <p className="truncate text-xs text-stone-500">
                  {job.state ? <Status {...job} /> : [b.meta?.author, size(b.size)].filter(Boolean).join(' · ')}
                </p>
              </div>
              {job.state && job.state !== 'error' ? (
                <StatusIcon state={job.state} />
              ) : (
                <>
                  <button
                    disabled={!ready}
                    onClick={() => send(b.name)}
                    className="flex h-9 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-sm font-semibold text-brand-700 active:bg-brand-100 disabled:opacity-40"
                  >
                    <SendIcon className="size-4" /> Send
                  </button>
                  <button
                    onClick={() => removeDownload(b.name).then(reload)}
                    className="-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                    aria-label={`Delete ${b.name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </Card>
    </section>
  )
}

// Browse and tidy the reader's SD card over its File Transfer server.
function ReaderFiles({ base, onFoldersChanged }) {
  const [path, setPath] = useState('/')
  const [files, setFiles] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setFiles(null)
    setError(null)
    listFiles(base, path).then(
      (f) => live && setFiles(f),
      (e) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [base, path, tick])

  async function run(fn, foldersChanged) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setTick((t) => t + 1)
      if (foldersChanged) onFoldersChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const crumbs = path.split('/').filter(Boolean)

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold text-stone-900">On your reader</h2>
        <button
          disabled={busy}
          onClick={() => {
            const name = prompt('New folder name')?.trim()
            if (name) run(() => makeFolder(base, path, name), true)
          }}
          className="flex h-9 items-center gap-1.5 rounded-full bg-white px-3 text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100"
        >
          <FolderPlus className="size-4" /> New folder
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 text-sm">
        <button onClick={() => setPath('/')} className="rounded-md px-1.5 py-0.5 font-medium text-brand-600 active:bg-stone-100">
          SD card
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-stone-300" />
            <button onClick={() => setPath(`/${crumbs.slice(0, i + 1).join('/')}`)} className="rounded-md px-1.5 py-0.5 font-medium text-brand-600 active:bg-stone-100">
              {c}
            </button>
          </span>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <Card className="mt-3 divide-y divide-stone-100">
        {!files ? (
          <div className="py-6">
            <Loader2 className="mx-auto size-5 animate-spin text-stone-400" />
          </div>
        ) : files.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-stone-500">This folder is empty.</p>
        ) : (
          files.map((f) => {
            const full = joinPath(path, f.name)
            return (
              <div key={f.name} className="flex items-center gap-3 px-4 py-2.5">
                <button
                  disabled={!f.isDirectory}
                  onClick={() => setPath(full)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  {f.isDirectory ? <Folder className="size-5 shrink-0 text-brand-500" strokeWidth={1.75} /> : <FileText className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-stone-900">{f.name}</span>
                    {!f.isDirectory && <span className="block text-xs text-stone-500">{size(f.size)}</span>}
                  </span>
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    const name = prompt(`Rename "${f.name}" to`, f.name)?.trim()
                    if (name && name !== f.name) run(() => renameFile(base, full, name), f.isDirectory)
                  }}
                  className="grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                  aria-label={`Rename ${f.name}`}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    confirm(`Delete "${f.name}"${f.isDirectory ? ' and everything in it' : ''} from your reader?`) &&
                    run(() => deleteFiles(base, [full]), f.isDirectory)
                  }
                  className="-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                  aria-label={`Delete ${f.name}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            )
          })
        )}
      </Card>
    </section>
  )
}

export default function Send() {
  const [prefs, setPrefsState] = useState(loadDevicePrefs)
  const [device, setDevice] = useState({ state: 'searching', dirs: [] })
  const [attempt, setAttempt] = useState(0)
  const [files, setFiles] = useState([]) // { file, state: 'queued'|'sending'|'done'|'error', error }
  const [skipped, setSkipped] = useState(0)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef(null)
  const setPrefs = (p) => {
    setPrefsState(p)
    saveDevicePrefs(p)
  }

  useEffect(() => {
    if (!isApp) return
    let live = true
    setDevice({ state: 'searching', dirs: [] })
    connect(prefs.host)
      .then(async ({ base, status }) => {
        const dirs = await folders(base).catch(() => [])
        if (live) setDevice({ state: 'ok', base, status, dirs })
      })
      .catch((e) => live && setDevice({ state: 'error', error: e.message, dirs: [] }))
    return () => {
      live = false
    }
  }, [prefs.host, attempt])

  function add(list) {
    const all = [...list]
    const books = all.filter(isBook)
    setSkipped(all.length - books.length)
    setFiles((cur) => [
      ...cur.filter((f) => f.state !== 'done'),
      ...books.filter((b) => !cur.some((f) => f.file.name === b.name)).map((file) => ({ file, state: 'queued' })),
    ])
  }

  async function sendAll() {
    setSending(true)
    for (const item of files) {
      if (item.state === 'done') continue
      const update = (patch) => setFiles((cur) => cur.map((f) => (f.file === item.file ? { ...f, ...patch } : f)))
      update({ state: 'sending', error: null })
      try {
        const used = await sendFile(item.file, prefs)
        update({ state: 'done', sentAs: used !== item.file.name ? used : null })
      } catch (e) {
        update({ state: 'error', error: String(e) })
      }
    }
    setSending(false)
  }

  const pending = files.filter((f) => f.state !== 'done').length

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <Eyebrow className="md:hidden">Send to reader</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Send books</h1>
      <p className="mt-2 max-w-xl text-sm/6 text-stone-500">
        Copy EPUB, Markdown and text files to your CrossPoint over Wi-Fi, from this device or from catalogs in Browse.
      </p>

      {!isApp ? (
        <Card className="mt-6 p-4 text-sm/6 text-stone-600">
          Sending books needs the CrossPoint Sync app: a browser can&apos;t talk to your reader on the local network.
        </Card>
      ) : (
        <div className="md:grid md:grid-cols-2 md:items-start md:gap-8">
          <Device prefs={prefs} setPrefs={setPrefs} device={device} onRetry={() => setAttempt((a) => a + 1)} />

          <div>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                add(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                add(e.dataTransfer.files)
              }}
              className={`mt-6 flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition active:scale-[0.99] ${
                dragging ? 'border-brand-400 bg-brand-50' : 'border-stone-300 bg-white/60'
              }`}
            >
              <BookUp className="size-8 text-brand-500" strokeWidth={1.5} />
              <span className="font-semibold text-stone-900">Choose books from this device</span>
              <span className="text-xs text-stone-500">
                .epub, .md or .txt <span className="hidden md:inline">· or drop them here</span>
              </span>
            </button>
            {skipped > 0 && (
              <p className="mt-2 text-xs text-stone-500">
                Skipped {skipped} file{skipped === 1 ? '' : 's'}: your reader only takes EPUB, Markdown and text.
              </p>
            )}

            {files.length > 0 && (
              <Card className="mt-4 divide-y divide-stone-100">
                {files.map(({ file, state, error, sentAs }) => (
                  <div key={file.name} className="flex items-center gap-3 px-4 py-3">
                    <FileText className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-stone-900">{file.name}</p>
                      <p className="truncate text-xs text-stone-500">
                        {state === 'queued' ? size(file.size) : <Status state={state} error={error} sentAs={sentAs} />}
                      </p>
                    </div>
                    {state === 'queued' ? (
                      !sending && (
                        <button
                          onClick={() => setFiles((cur) => cur.filter((f) => f.file !== file))}
                          className="-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="size-4" />
                        </button>
                      )
                    ) : (
                      <StatusIcon state={state} />
                    )}
                  </div>
                ))}
              </Card>
            )}

            {pending > 0 && (
              <button
                disabled={sending || device.state !== 'ok'}
                onClick={sendAll}
                className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-base font-semibold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-50"
              >
                {sending ? <Loader2 className="size-5 animate-spin" /> : `Send ${pending} book${pending === 1 ? '' : 's'}`}
              </button>
            )}

            <Shelf prefs={prefs} ready={device.state === 'ok'} />
            {device.state === 'ok' && <ReaderFiles base={device.base} onFoldersChanged={() => folders(device.base).then((dirs) => setDevice((d) => ({ ...d, dirs })), () => {})} />}
          </div>
        </div>
      )}
    </div>
  )
}
