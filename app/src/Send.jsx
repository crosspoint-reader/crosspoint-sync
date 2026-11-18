import { useEffect, useRef, useState } from 'react'
import {
  BookUp,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  CircleAlert,
  CircleCheck,
  FileText,
  Folder,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import { isApp } from './api.js'
import { DEFAULT_HOST, connect, deleteFiles, folders, isBook, joinPath, listFiles, loadDevicePrefs, makeFolder, renameFile, saveDevicePrefs } from './device.js'
import { downloads as listDownloads, removeDownload, sendDownload, sendFile } from './catalogs.js'
import { ActionSheet, EmptyState, filesOnly, folderLabel, notify, Tabs, Toggle } from './ui.jsx'
import ConversionLog from './ConversionLog.jsx'
import { importKind } from './importTypes.js'
import { listImports, addImport, readImport, removeImport } from './importQueue.js'
import Plugins from './Plugins.jsx'
import ReaderFonts from './ReaderFonts.jsx'
import Wallpaper from './Wallpaper.jsx'
import { transferProgress } from './epub/log.js'

const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
// Shared progress from the WebView optimizer and native transfers.
export function progressLabel(p) {
  if (!p) return 'Sending…'
  if (p.stage === 'downloading') return p.total ? `Downloading ${Math.round((p.done / p.total) * 100)}%` : `Downloading ${size(p.done)}`
  if (p.stage === 'repairing') return 'Fixing cover and details…'
  if (p.stage === 'optimizing') return p.total ? `Optimizing EPUB ${Math.round(p.done / p.total * 100)}%` : 'Optimizing EPUB…'
  return 'Sending to reader…'
}

const settingRow = 'flex min-h-12 items-center gap-3 py-2'

// One line under the tabs: is the reader there, and where files will land. Opens to the transfer settings.
// `books` adds what only applies to sending books: the destination folder and the EPUB options.
function Device({ prefs, setPrefs, device, onRetry, books }) {
  const [editing, setEditing] = useState(false)
  const [host, setHost] = useState(prefs.host)
  const { state, status, error, dirs } = device
  return (
    <details className="group border-b border-stone-200">
      <summary className="flex list-none items-center gap-2.5 py-3 text-sm [&::-webkit-details-marker]:hidden">
        {state === 'searching' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-stone-400" />
        ) : (
          <span className={`mx-[3px] size-2 shrink-0 rounded-full ${state === 'ok' ? 'bg-brand-500' : 'bg-red-500'}`} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-stone-500">
            <span className="font-medium text-stone-900">
              {state === 'searching' ? `Looking for ${prefs.host}…` : state === 'ok' ? `CrossPoint ${status.device ?? ''}`.trim() : 'Reader not found'}
            </span>
            {state === 'ok' && books && ` · ${folderLabel(prefs.folder)}`}
          </span>
          {state === 'error' && <span className="block text-xs/5 text-stone-500">Open File Transfer on your reader, on the same Wi-Fi.</span>}
        </span>
        {state === 'error' && (
          <button
            onClick={(e) => {
              e.preventDefault()
              onRetry()
            }}
            className="h-9 rounded-lg px-2 font-semibold text-brand-600 active:bg-stone-100"
          >
            Retry
          </button>
        )}
        <ChevronDown className="size-4 shrink-0 text-stone-400 transition group-open:rotate-180" />
      </summary>

      <div className="divide-y divide-stone-100 pb-1 text-sm text-stone-900">
        {books && <label className={settingRow}>
          <span className="flex-1">Save to</span>
          <select
            value={prefs.folder}
            onChange={(e) => setPrefs({ ...prefs, folder: e.target.value })}
            className="h-9 max-w-[60%] min-w-0 bg-transparent text-stone-600 outline-none"
          >
            {[...new Set(['/', ...dirs.map((d) => `/${d}`), prefs.folder])].map((f) => (
              <option key={f} value={f}>
                {folderLabel(f)}
              </option>
            ))}
          </select>
        </label>}
        {editing ? (
          <form
            className={settingRow}
            onSubmit={(e) => {
              e.preventDefault()
              setPrefs({ ...prefs, host: host.trim() || DEFAULT_HOST })
              setEditing(false)
            }}
          >
            <input
              autoFocus
              aria-label="Reader address"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="crosspoint.local or 192.168.1.40"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-lg bg-surface px-3 font-mono text-sm ring-1 ring-stone-950/10 outline-none focus:ring-2 focus:ring-brand-500/60"
            />
            <button className="h-9 rounded-lg bg-brand-500 px-3 font-semibold text-white">Save</button>
          </form>
        ) : (
          <div className={settingRow}>
            <span className="flex-1">Reader address</span>
            <button onClick={() => setEditing(true)} className="h-9 truncate font-mono text-stone-600 underline decoration-stone-300 underline-offset-4">
              {prefs.host}
            </button>
          </div>
        )}
        {books && <><div className={settingRow}>
          <div className="min-w-0 flex-1">
            <p>Optimize EPUB</p>
            <p className="text-xs/5 text-stone-500">Grayscale images sized for your reader, no embedded fonts.</p>
          </div>
          <Toggle label="Optimize EPUB" checked={prefs.optimize} onChange={(optimize) => setPrefs({ ...prefs, optimize })} />
        </div>
        {prefs.optimize && (
          <label className={settingRow}>
            Image quality
            <input
              type="range"
              min="30"
              max="95"
              step="5"
              value={prefs.quality}
              onChange={(e) => setPrefs({ ...prefs, quality: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-brand-500"
            />
            <span className="w-6 text-right font-mono text-xs text-stone-600">{prefs.quality}</span>
          </label>
        )}
        {prefs.optimize && (
          <div className={settingRow}>
            <div className="min-w-0 flex-1">
              <p>Fix cover and details</p>
              <p className="text-xs/5 text-stone-500">Uploads the book to metadata.dev to repair its cover, title, author and file name.</p>
            </div>
            <Toggle label="Fix cover and details" checked={!!prefs.fixMetadata} onChange={(fixMetadata) => setPrefs({ ...prefs, fixMetadata })} />
          </div>
        )}
        <div className={settingRow}>
          <div className="min-w-0 flex-1">
            <p>Rename from metadata</p>
            <p className="text-xs/5 text-stone-500">Title - Author.epub</p>
          </div>
          <Toggle
            label="Rename from book metadata"
            checked={prefs.renameFromMetadata}
            onChange={(renameFromMetadata) => setPrefs({ ...prefs, renameFromMetadata })}
          />
        </div></>}
        {state === 'ok' && <p className="py-3 font-mono text-xs text-stone-400">{status.ip ?? prefs.host} · firmware {status.version}</p>}
        {state === 'error' && error && <p className="py-3 font-mono text-xs break-all text-stone-400">{error}</p>}
      </div>
    </details>
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
    set({ state: 'sending', error: null, progress: null, logs: [] })
    try {
      const used = await sendDownload(name, prefs, (event) => setJobs((jobs) => ({ ...jobs, [name]: transferProgress(jobs[name], event) })))
      set({ state: 'done', sentAs: used !== name ? used : null })
      notify({ title: 'Sent to your reader', detail: `${used} in ${folderLabel(prefs.folder)}` })
    } catch (e) {
      set({ state: 'error', error: String(e) })
      notify({ error: true, title: "Couldn't send that book", detail: String(e) })
    }
  }

  return (
    <section className="mt-10">
      <h2 className="font-display text-xl text-stone-900">Downloaded</h2>
      <div className="mt-1 divide-y divide-stone-200">
        {books.map((b) => {
          const job = jobs[b.name] ?? {}
          return (
            <div key={b.name} className="py-3">
              <ConversionLog entries={job.logs}>
                {(details) => (
                  <div className="flex items-center gap-3">
                    {b.meta?.cover ? (
                      <img src={b.meta.cover} alt="" className="aspect-[2/3] w-10 shrink-0 rounded object-cover ring-1 ring-stone-950/10" />
                    ) : (
                      <FileText className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-stone-900">{b.meta?.title ?? b.name}</p>
                      <p className="flex min-w-0 items-center text-xs text-stone-500">
                        <span className="truncate">
                          {job.state ? <Status {...job} /> : [b.meta?.author, size(b.size)].filter(Boolean).join(' · ')}
                        </span>
                        {details}
                      </p>
                    </div>
                    {job.state && job.state !== 'error' ? (
                      <StatusIcon state={job.state} />
                    ) : (
                      <>
                        <button
                          disabled={!ready}
                          onClick={() => send(b.name)}
                          className="h-9 rounded-lg px-2 text-sm font-semibold text-brand-600 active:bg-stone-100 disabled:opacity-40"
                        >
                          Send
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
                )}
              </ConversionLog>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// Browse and tidy the reader's SD card over its File Transfer server.
function ReaderFiles({ base, onFoldersChanged }) {
  const [path, setPath] = useState('/')
  const [files, setFiles] = useState(null)
  const [listError, setListError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [deleting, setDeleting] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [creatingIn, setCreatingIn] = useState(null)
  useEffect(() => {
    let live = true
    setFiles(null)
    setListError(null)
    listFiles(base, path).then(
      (f) => live && setFiles(f),
      (e) => live && setListError(e.message)
    )
    return () => {
      live = false
    }
  }, [base, path, tick])

  async function run(fn, foldersChanged) {
    setBusy(true)
    try {
      await fn()
      setTick((t) => t + 1)
      if (foldersChanged) onFoldersChanged()
    } finally {
      setBusy(false)
    }
  }
  const crumbs = path.split('/').filter(Boolean)
  const locked = busy || !!deleting || !!renaming || creatingIn !== null

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl text-stone-900">On your reader</h2>
        <button
          disabled={locked}
          onClick={() => setCreatingIn(path)}
          aria-label="New folder"
          className="-mr-2 grid size-9 place-items-center rounded-full text-stone-500 active:bg-stone-100"
        >
          <FolderPlus className="size-5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="-ml-1.5 flex flex-wrap items-center gap-1 text-sm">
        <button disabled={locked} onClick={() => setPath('/')} className="rounded-md px-1.5 py-0.5 font-medium text-brand-600 active:bg-stone-100">
          SD card
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-stone-300" />
            <button disabled={locked} onClick={() => setPath(`/${crumbs.slice(0, i + 1).join('/')}`)} className="rounded-md px-1.5 py-0.5 font-medium text-brand-600 active:bg-stone-100">
              {c}
            </button>
          </span>
        ))}
      </div>
      {listError && <p className="mt-2 text-sm text-red-600">{listError}</p>}
      <div className="mt-1 divide-y divide-stone-200 border-t border-stone-200">
        {!files ? (
          <div className="py-6">
            <Loader2 className="mx-auto size-5 animate-spin text-stone-400" />
          </div>
        ) : files.length === 0 ? (
          <EmptyState compact icon={Folder} title="This folder is empty" />
        ) : (
          files.map((f) => {
            const full = joinPath(path, f.name)
            return (
              <div key={f.name} className="flex items-center gap-3 py-2">
                <button
                  disabled={locked || !f.isDirectory}
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
                  disabled={locked}
                  onClick={() => setRenaming({ ...f, path: full })}
                  className="grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                  aria-label={`Rename ${f.name}`}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  disabled={locked}
                  onClick={() => setDeleting({ ...f, path: full })}
                  className="-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                  aria-label={`Delete ${f.name}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            )
          })
        )}
      </div>
      {creatingIn !== null && (
        <ActionSheet
          title="New folder"
          inputLabel="Folder name"
          actionLabel="Create folder"
          pendingLabel="Creating…"
          onClose={() => setCreatingIn(null)}
          onConfirm={(name) => run(() => makeFolder(base, creatingIn, name), true)}
        />
      )}
      {renaming && (
        <ActionSheet
          title={`Rename ${renaming.name}`}
          inputLabel="New name"
          initialValue={renaming.name}
          isValid={(value) => value !== renaming.name}
          actionLabel="Rename"
          pendingLabel="Renaming…"
          onClose={() => setRenaming(null)}
          onConfirm={(name) => run(() => renameFile(base, renaming.path, name), renaming.isDirectory)}
        />
      )}
      {deleting && (
        <ActionSheet
          title={`Delete ${deleting.name}?`}
          actionLabel="Delete"
          pendingLabel="Deleting…"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => run(() => deleteFiles(base, [deleting.path]), deleting.isDirectory)}
        >
          {deleting.isDirectory ? 'Delete this folder from your reader? The folder must be empty.' : 'Delete this file from your reader?'}
        </ActionSheet>
      )}
    </section>
  )
}

const activeImports = new Set()

const TABS = [
  ['', 'Books'],
  ['fonts', 'Fonts'],
  ['wallpaper', 'Sleep screens'],
  ['plugins', 'Plugins'],
]

export default function Send({ tab = '' }) {
  const [prefs, setPrefsState] = useState(loadDevicePrefs)
  const [device, setDevice] = useState({ state: 'searching', dirs: [] })
  const [attempt, setAttempt] = useState(0)
  const [files, setFiles] = useState([]) // { file, state: 'queued'|'sending'|'done'|'error', error }
  const [importCounts, setImportCounts] = useState({})
  const [skipped, setSkipped] = useState(0)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef(null)
  const queueRevision = useRef(0)
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

  useEffect(() => {
    if (!isApp) return
    let live = true, latest = 0, retry, reported = false
    const schedule = delay => {
      clearTimeout(retry)
      retry = setTimeout(load, delay)
    }
    const load = async () => {
      clearTimeout(retry)
      const request = ++latest
      const revision = queueRevision.current
      try {
        const all = await listImports()
        if (!live || request !== latest) return
        if (revision !== queueRevision.current) { schedule(0); return }
        reported = false
        const entries = all.filter(isBook)
        setImportCounts(all.reduce((counts, entry) => {
          const kind = importKind(entry)
          if (kind) counts[kind] = (counts[kind] ?? 0) + 1
          return counts
        }, {}))
        setFiles(cur => {
          if (revision !== queueRevision.current) return cur
          const byId = new Map(cur.map(item => [item.id, item]))
          return entries.map(entry => {
            const current = byId.get(entry.id)
            if (activeImports.has(entry.id)) return current ?? { id: entry.id, file: entry, state: 'sending' }
            return current?.state !== 'sending' && current ? current : { id: entry.id, file: entry, state: 'queued' }
          })
        })
      } catch (error) {
        if (!live || request !== latest) return
        if (!reported) notify({ error: true, title: "Couldn't load queued files", detail: String(error) })
        reported = true
        schedule(1000)
      }
    }
    load()
    window.addEventListener('crosspoint-imports-changed', load)
    return () => { live = false; clearTimeout(retry); window.removeEventListener('crosspoint-imports-changed', load) }
  }, [])

  async function add(list) {
    const all = [...list]
    const books = all.filter(isBook)
    setSkipped(all.length - books.length)
    for (const file of books) {
      try {
        const entry = await addImport(file)
        queueRevision.current += 1
        setFiles(cur => cur.some(item => item.id === entry.id) ? cur : [...cur, { id: entry.id, file: entry, state: 'queued' }])
        window.dispatchEvent(new Event('crosspoint-imports-changed'))
      } catch (error) {
        notify({ error: true, title: `Couldn't queue ${file.name}`, detail: String(error) })
      }
    }
  }

  async function remove(item) {
    try {
      await removeImport(item.id)
      queueRevision.current += 1
      setFiles(cur => cur.filter(f => f.id !== item.id))
      window.dispatchEvent(new Event('crosspoint-imports-changed'))
    } catch (error) {
      notify({ error: true, title: "Couldn't remove queued file", detail: String(error) })
    }
  }

  async function sendAll() {
    const batch = files.filter(item => item.state !== 'done' && !activeImports.has(item.id))
    if (!batch.length) return
    for (const item of batch) activeImports.add(item.id)
    setSending(true)
    const sent = []
    const failed = []
    for (const item of batch) {
      const update = (patch) => setFiles((cur) => cur.map((f) => (f.file === item.file ? { ...f, ...patch } : f)))
      update({ state: 'sending', error: null, progress: null, logs: [] })
      try {
        const file = await readImport({ ...item.file, id: item.id })
        const used = await sendFile(file, prefs, (event) => setFiles((cur) => cur.map((f) => f.file === item.file ? transferProgress(f, event) : f)))
        await removeImport(item.id)
        queueRevision.current += 1
        update({ state: 'done', sentAs: used !== item.file.name ? used : null })
        sent.push(used)
      } catch (e) {
        update({ state: 'error', error: String(e) })
        failed.push(String(e))
      } finally {
        activeImports.delete(item.id)
        window.dispatchEvent(new Event('crosspoint-imports-changed'))
      }
    }
    setSending(false)
    const books = (n) => `${n} book${n === 1 ? '' : 's'}`
    if (failed.length) {
      notify({
        error: true,
        title: sent.length ? `Sent ${books(sent.length)}, ${failed.length} failed` : `Couldn't send ${failed.length === 1 ? 'that book' : books(failed.length)}`,
        detail: failed[0],
      })
    } else if (sent.length) {
      notify({ title: sent.length === 1 ? 'Sent to your reader' : `Sent ${books(sent.length)} to your reader`, detail: `${sent.length === 1 ? `${sent[0]} in ` : 'In '}${folderLabel(prefs.folder)}` })
    }
  }

  const busy = sending || files.some(item => item.state === 'sending' || activeImports.has(item.id))
  const pending = files.filter((f) => f.state !== 'done').length

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Send to your reader</h1>

      {!isApp ? (
        <p className="mt-3 max-w-md text-sm/6 text-stone-500">
          Sending needs the CrossPoint Sync app: a browser can&apos;t reach your reader on the local network.
        </p>
      ) : (
        <>
          <Tabs route="send" tabs={TABS.map(([key, label]) => [key, importCounts[key || 'books'] ? `${label} (${importCounts[key || 'books']})` : label])} tab={tab} />
          {tab === 'wallpaper' ? (
            <Wallpaper />
          ) : (
            <div className="max-w-3xl">
              <Device prefs={prefs} setPrefs={setPrefs} device={device} onRetry={() => setAttempt((a) => a + 1)} books={!tab} />
              {tab === 'fonts' ? (
                <ReaderFonts base={device.base} device={device.status?.device} />
              ) : tab === 'plugins' ? (
                <Plugins base={device.base} />
              ) : (
                <div>
                  <input
                    ref={input}
                    type="file"
                    multiple
                    accept={filesOnly('.epub,.md,.txt,.acsm')}
                    // Other platforms take any file; add() checks the extension after selection.
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
                    className={`mt-5 flex w-full items-center gap-3 rounded-xl border border-dashed p-4 text-left transition active:scale-[0.99] ${
                      dragging ? 'border-brand-400 bg-brand-50' : 'border-stone-300 md:hover:border-stone-400'
                    }`}
                  >
                    <BookUp className="size-6 shrink-0 text-brand-500" strokeWidth={1.5} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-stone-900">Add books</span>
                      <span className="block font-mono text-xs text-stone-500">epub · md · txt · acsm</span>
                    </span>
                    <span className="hidden text-xs text-stone-400 md:block">or drop them here</span>
                  </button>
                  {skipped > 0 && (
                    <p className="mt-2 text-xs text-stone-500">
                      Skipped {skipped} file{skipped === 1 ? '' : 's'}: choose EPUB, Markdown, text or ACSM files.
                    </p>
                  )}

                  {files.length > 0 && (
                    <div className="mt-2 divide-y divide-stone-200">
                      {files.map(({ id, file, state, error, sentAs, progress, logs }) => (
                        <div key={id} className="py-3">
                          <ConversionLog entries={logs}>
                            {(details) => (
                              <div className="flex items-center gap-3">
                                <FileText className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium text-stone-900">{file.name}</p>
                                  <p className="flex min-w-0 items-center text-xs text-stone-500">
                                    <span className="truncate">
                                      {state === 'queued' ? size(file.size) : <Status state={state} error={error} sentAs={sentAs} progress={progress} />}
                                    </span>
                                    {details}
                                  </p>
                                </div>
                                {state === 'queued' || state === 'error' ? (
                                  !busy && (
                                    <button
                                      onClick={() => remove({ id })}
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
                            )}
                          </ConversionLog>
                        </div>
                      ))}
                    </div>
                  )}

                  {pending > 0 && (
                    <button
                      disabled={busy || device.state !== 'ok'}
                      onClick={sendAll}
                      className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-500 text-base font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 md:hover:bg-brand-600"
                    >
                      {sending ? <Loader2 className="size-5 animate-spin" /> : `Send ${pending} book${pending === 1 ? '' : 's'}`}
                    </button>
                  )}

                  <Shelf prefs={prefs} ready={device.state === 'ok'} />
                  {device.state === 'ok' && <ReaderFiles base={device.base} onFoldersChanged={() => folders(device.base).then((dirs) => setDevice((d) => ({ ...d, dirs })), () => {})} />}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
