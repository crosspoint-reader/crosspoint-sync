import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Download, FileUp, Loader2, Search, Send as SendIcon, Trash2, Type } from 'lucide-react'
import { deleteFont, listFonts, uploadFont, uploadTrueType } from './device.js'
import { convert, downloadFamily, familyName, googleFonts, localFamily, trueTypeFiles } from './fonts/google.js'
import { crossPointFonts, downloadPrebuilt, forgetFont, isPrebuilt, readFont, saveFont, savedFonts } from './fonts/saved.js'
import { ActionSheet, Card, EmptyState, notify, Toggle } from './ui.jsx'

// X3/X4 (ESP32-C3, no external RAM) need .cpfont; ESP32-S3 readers load TrueType directly.
export const loadsTrueType = (device) => !!device && !['X3', 'X4'].includes(device)

const MAX_RESULTS = 8
const mb = (files) => `${(files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)} MB`
// Saved files back into styles for the converter (names come from trueTypeFiles).
const asStyles = (files) => localFamily(files.map((f) => ({ name: f.name, arrayBuffer: async () => f.data })))
const LOCAL = 'Your files'
const rowButton = 'flex h-9 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-sm font-semibold text-brand-700 active:bg-brand-100 disabled:opacity-40'
const iconButton = '-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100 disabled:opacity-40'

// Get fonts onto this phone any time (Google Fonts or your own files), send them when a reader is connected.
export default function ReaderFonts({ base, device }) {
  const [trueType, setTrueType] = useState(() => loadsTrueType(device))
  useEffect(() => setTrueType(loadsTrueType(device)), [device])
  const picker = useRef(null)
  const [saved, setSaved] = useState([])
  const [installed, setInstalled] = useState() // undefined loading, string error
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState(null)
  const [prebuilt, setPrebuilt] = useState(null) // { baseUrl, families } once browsed
  const [prebuiltError, setPrebuiltError] = useState(null)
  const [job, setJob] = useState(null) // { family, label }
  const [deleting, setDeleting] = useState(null)

  const reloadSaved = () => savedFonts().then(setSaved, () => setSaved([]))
  useEffect(() => {
    reloadSaved()
  }, [])

  useEffect(() => {
    if (!base) return
    let live = true
    setInstalled(undefined)
    listFonts(base).then(
      (f) => live && setInstalled(f ?? "This reader's firmware can't list fonts. Update it to manage fonts here."),
      (e) => live && setInstalled(`Couldn't list the reader's fonts: ${e.message}`)
    )
    return () => {
      live = false
    }
  }, [base, tick])

  useEffect(() => {
    if (!query || catalog) return
    googleFonts().then(setCatalog, (e) => setCatalogError(e.message))
  }, [query, catalog])

  const q = query.trim().toLowerCase()
  const results = q && catalog ? catalog.filter((f) => f.family.toLowerCase().includes(q)).sort((a, b) => b.family.toLowerCase().startsWith(q) - a.family.toLowerCase().startsWith(q)).slice(0, MAX_RESULTS) : []
  const savedNames = new Set(saved.map((f) => f.family))
  const onReader = new Set((Array.isArray(installed) ? installed : []).map((f) => f.name))

  async function run(family, fn, failure) {
    try {
      await fn((label) => setJob({ family, label }))
    } catch (e) {
      notify({ error: true, title: failure, detail: e.message })
    } finally {
      setJob(null)
    }
  }

  // source: a Google Fonts entry, or font files picked on this device.
  const get = (source) =>
    run(source.family ?? LOCAL, async (set) => {
      set(source.files ? 'Reading files…' : 'Downloading…')
      const picked = source.files && (await localFamily(source.files))
      const styles = picked?.styles ?? (await downloadFamily(source))
      if (!styles.regular) throw new Error('Choose .ttf or .otf files')
      const family = familyName(picked?.family ?? source.family) || 'CustomFont'
      await saveFont(family, trueTypeFiles(family, styles))
      await reloadSaved()
      notify({ title: `Saved ${family}`, detail: base ? 'Ready to send to your reader' : 'Send it when your reader is connected' })
    }, `Couldn't get ${source.family ?? 'those fonts'}`)

  const getPrebuilt = (font) =>
    run(font.name, async (set) => {
      await saveFont(font.name, await downloadPrebuilt(prebuilt.baseUrl, font, set))
      await reloadSaved()
      notify({ title: `Saved ${font.name}`, detail: base ? 'Ready to send to your reader' : 'Send it when your reader is connected' })
    }, `Couldn't get ${font.name}`)

  // Prebuilt .cpfont families go as-is; TrueType families go raw or get converted, per the toggle.
  const send = (font) =>
    run(font.family, async (set) => {
      const { family } = font
      const raw = !isPrebuilt(font) && trueType
      let files = await readFont(font)
      if (!isPrebuilt(font) && !trueType) {
        set('Converting…')
        files = await convert(family, (await asStyles(files)).styles)
      }
      for (const [i, file] of files.entries()) {
        set(`Sending ${i + 1} of ${files.length}…`)
        await (raw ? uploadTrueType : uploadFont)(base, family, file)
      }
      notify({ title: `Sent ${family}`, detail: 'Pick it in Settings › Reader › Font Family' })
      setTick((t) => t + 1)
    }, `Couldn't send ${family}`)

  const status = (family, fallback) => (job?.family === family ? job.label : fallback)

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold text-stone-900">Fonts</h2>
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...e.target.files].filter((f) => /\.(ttf|otf)$/i.test(f.name))
            e.target.value = ''
            if (files.length) get({ files })
            else notify({ error: true, title: 'Choose .ttf or .otf files' })
          }}
        />
        <button
          disabled={!!job}
          onClick={() => picker.current?.click()}
          className="flex h-9 items-center gap-1.5 rounded-full bg-surface px-3 text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-40"
        >
          {job?.family === LOCAL ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />} Add files
        </button>
      </div>
      {job?.family === LOCAL && <p className="mt-2 text-sm text-stone-500">{job.label}</p>}

      <label className="mt-3 flex h-11 items-center gap-2 rounded-xl bg-surface px-3 ring-1 ring-stone-950/10 focus-within:ring-2 focus-within:ring-brand-500/60">
        <Search className="size-4 text-stone-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fonts"
          aria-label="Search Google Fonts"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none"
        />
      </label>
      {catalogError && <p className="mt-2 text-sm text-red-600">{catalogError}</p>}
      {q && catalog && !results.length && <p className="mt-2 text-sm text-stone-500">No Google Fonts match “{query.trim()}”.</p>}
      {results.length > 0 && (
        <>
          <link rel="stylesheet" href={`https://fonts.googleapis.com/css2?${results.map((f) => `family=${encodeURIComponent(f.family)}`).join('&')}&display=swap`} />
          <Card className="mt-3 divide-y divide-stone-100">
            {results.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg text-stone-900" style={{ fontFamily: `'${f.family}', serif` }}>
                    {f.family}
                  </span>
                  <span className="block text-xs text-stone-500 capitalize">{status(f.family, `${f.category} · ${f.styles.includes('italic') ? 'with italics' : 'no italics'}`)}</span>
                </span>
                {job?.family === f.family ? (
                  <Loader2 className="size-5 animate-spin text-brand-500" />
                ) : (
                  <button disabled={!!job} onClick={() => get(f)} className={rowButton}>
                    <Download className="size-4" /> {savedNames.has(familyName(f.family)) ? 'Saved' : 'Get'}
                  </button>
                )}
              </div>
            ))}
          </Card>
        </>
      )}

      <details
        className="group mt-3"
        onToggle={(e) => e.currentTarget.open && !prebuilt && crossPointFonts().then(setPrebuilt, (err) => setPrebuiltError(err.message))}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1 py-2 text-sm font-semibold text-brand-600">
          <ChevronRight className="size-4 transition group-open:rotate-90" /> Browse CrossPoint fonts
        </summary>
        <p className="text-xs/5 text-stone-500">Ready-made .cpfont families from the CrossPoint project, the same list as Settings › Manage Fonts on your reader.</p>
        {prebuiltError && <p className="mt-2 text-sm text-red-600">{prebuiltError}</p>}
        <Card className="mt-2 divide-y divide-stone-100">
          {!prebuilt ? (
            !prebuiltError && (
              <div className="py-6">
                <Loader2 className="mx-auto size-5 animate-spin text-stone-400" />
              </div>
            )
          ) : (
            prebuilt.families
              .filter((f) => !q || `${f.name} ${f.description}`.toLowerCase().includes(q))
              .map((f) => (
                <div key={f.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-900">{f.name}</span>
                    <span className="block text-xs/5 text-stone-500">{status(f.name, `${f.description} · ${mb(f.files)}`)}</span>
                  </span>
                  {job?.family === f.name ? (
                    <Loader2 className="size-5 animate-spin text-brand-500" />
                  ) : (
                    <button disabled={!!job} onClick={() => getPrebuilt(f)} className={rowButton}>
                      <Download className="size-4" /> {savedNames.has(f.name) ? 'Saved' : 'Get'}
                    </button>
                  )}
                </div>
              ))
          )}
        </Card>
      </details>

      {saved.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold text-stone-600">On this phone</h3>
          <Card className="mt-2 divide-y divide-stone-100">
            {saved.map((f) => (
              <div key={f.family} className="flex items-center gap-3 px-4 py-2.5">
                <Type className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900">{f.family}</span>
                  <span className="block text-xs text-stone-500">{status(f.family, `${isPrebuilt(f) ? `.cpfont · ${f.files.length} sizes` : `TrueType · ${f.files.length} style${f.files.length === 1 ? '' : 's'}`}${onReader.has(f.family) ? ' · on your reader' : ''}`)}</span>
                </span>
                {job?.family === f.family ? (
                  <Loader2 className="size-5 animate-spin text-brand-500" />
                ) : (
                  <>
                    <button disabled={!!job || !base} onClick={() => send(f)} className={rowButton}>
                      <SendIcon className="size-4" /> Send
                    </button>
                    <button disabled={!!job} onClick={() => forgetFont(f.family).then(reloadSaved)} className={iconButton} aria-label={`Remove ${f.family} from this phone`}>
                      <Trash2 className="size-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </Card>
          <div className="mt-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-stone-900">Send as TrueType</p>
              <p className="text-xs/5 text-stone-500">{trueType ? 'Copies the .ttf files as-is. Needs an ESP32-S3 reader.' : 'Converts to .cpfont at 12-18 pt. Works on every reader, including X3 and X4.'} CrossPoint fonts are always sent as .cpfont.</p>
            </div>
            <Toggle label="Send as TrueType" checked={trueType} onChange={setTrueType} />
          </div>
        </>
      )}

      <h3 className="mt-5 text-sm font-semibold text-stone-600">On your reader</h3>
      <Card className="mt-2 divide-y divide-stone-100">
        {!base ? (
          <p className="px-4 py-3 text-sm text-stone-500">Connect your reader to see and send fonts. You can get fonts now and send them later.</p>
        ) : typeof installed === 'string' ? (
          <p className="px-4 py-3 text-sm text-red-600">{installed}</p>
        ) : installed === undefined ? (
          <div className="py-6">
            <Loader2 className="mx-auto size-5 animate-spin text-stone-400" />
          </div>
        ) : installed.length === 0 ? (
          <EmptyState compact icon={Type} title="No extra fonts yet" />
        ) : (
          installed.map((f) => (
            <div key={f.name} className="flex items-center gap-3 px-4 py-2.5">
              <Type className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-stone-900">{f.name}</span>
                <span className="block text-xs text-stone-500">{f.sizes.includes(0) ? 'TrueType' : `${f.sizes.join(', ')} pt`}</span>
              </span>
              <button disabled={!!job} onClick={() => setDeleting(f.name)} className={iconButton} aria-label={`Delete ${f.name} from your reader`}>
                <Trash2 className="size-4" />
              </button>
            </div>
          ))
        )}
      </Card>

      {deleting && (
        <ActionSheet
          title={`Delete ${deleting}?`}
          actionLabel="Delete"
          pendingLabel="Deleting…"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteFont(base, deleting).then(() => setTick((t) => t + 1))}
        >
          Remove this font family from your reader? It stays on this phone if you saved it here.
        </ActionSheet>
      )}
    </section>
  )
}
