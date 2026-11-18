import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FileUp, Loader2, Search, Trash2, Type } from 'lucide-react'
import { deleteFont, listFonts, uploadFont, uploadTrueType } from './device.js'
import { convert, downloadFamily, familyName, googleFonts, localFamily, trueTypeFiles } from './fonts/google.js'
import { cpfontFamilies, crossPointFonts, downloadPrebuilt, forgetFont, isPrebuilt, readFont, saveFont, savedFonts } from './fonts/saved.js'
import ImportedAssets from './ImportedAssets.jsx'
import { groupFontEntries, sendImportedFonts } from './fonts/sendImported.js'
import { ActionSheet, EmptyState, filesOnly, notify, Toggle } from './ui.jsx'

// X3/X4 (ESP32-C3, no external RAM) need .cpfont; ESP32-S3 readers load TrueType directly.
export const loadsTrueType = (device) => !!device && !['X3', 'X4'].includes(device)

const PAGE = 30 // Google Fonts rows shown at a time
const mb = (files) => `${(files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)} MB`
// Saved files back into styles for the converter (names come from trueTypeFiles).
const asStyles = (files) => localFamily(files.map((f) => ({ name: f.name, arrayBuffer: async () => f.data })))
const LOCAL = 'Your files'
const rowButton = 'h-9 shrink-0 rounded-lg px-2 text-sm font-semibold text-brand-600 active:bg-stone-100 disabled:opacity-40'
const iconButton = '-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100 disabled:opacity-40'

// A collapsible font list. Searching opens every list so matches are visible.
function FontList({ title, note, open, onToggle, error, loading, children }) {
  return (
    <details className="group border-b border-stone-200" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="flex list-none items-center gap-3 py-3 text-sm font-medium text-stone-900 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown className="size-4 shrink-0 text-stone-400 transition group-open:rotate-180" />
      </summary>
      <p className="text-xs/5 text-stone-500">{note}</p>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-1 divide-y divide-stone-100 pb-1">
        {loading && !error ? (
          <div className="py-6">
            <Loader2 className="mx-auto size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          children
        )}
      </div>
    </details>
  )
}

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
  const [openGoogle, setOpenGoogle] = useState(false)
  const [openCrossPoint, setOpenCrossPoint] = useState(false)
  const [shown, setShown] = useState(PAGE)
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

  const q = query.trim().toLowerCase()
  useEffect(() => {
    if ((q || openGoogle) && !catalog) googleFonts().then(setCatalog, (e) => setCatalogError(e.message))
    if ((q || openCrossPoint) && !prebuilt) crossPointFonts().then(setPrebuilt, (e) => setPrebuiltError(e.message))
  }, [q, openGoogle, openCrossPoint, catalog, prebuilt])
  useEffect(() => setShown(PAGE), [q])

  const matches = catalog ? catalog.filter((f) => !q || f.family.toLowerCase().includes(q)).sort((a, b) => (q ? b.family.toLowerCase().startsWith(q) - a.family.toLowerCase().startsWith(q) : 0)) : []
  const results = matches.slice(0, shown)
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
  // Picked .cpfont files are already converted, so they're saved and sent as they are.
  const addCpfonts = (files) =>
    run(LOCAL, async (set) => {
      set('Reading files…')
      const families = Object.entries(await cpfontFamilies(files))
      for (const [family, fonts] of families) await saveFont(familyName(family) || 'CustomFont', fonts)
      await reloadSaved()
      notify({ title: `Saved ${families.map(([f]) => f).join(', ')}`, detail: base ? 'Ready to send to your reader' : 'Send it when your reader is connected' })
    }, "Couldn't add those .cpfont files")

  const get = (source) =>
    run(source.family ?? LOCAL, async (set) => {
      set(source.files ? 'Reading files…' : 'Downloading…')
      const picked = source.files && (await localFamily(source.files))
      const styles = picked?.styles ?? (await downloadFamily(source))
      if (!styles.regular) throw new Error('Choose .ttf, .otf or .cpfont files')
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
    }, `Couldn't send ${font.family}`)

  const sendShared = async (file, _entry, files) => {
    try {
      setJob({ family: file.name, label: 'Sending…' })
      await sendImportedFonts(files, { base, trueType, progress: label => setJob({ family: file.name, label }) })
      setTick(t => t + 1)
      notify({ title: `Sent ${file.name}`, detail: 'Pick it in Settings › Reader › Font Family' })
    } finally { setJob(null) }
  }

  const status = (family, fallback) => (job?.family === family ? job.label : fallback)

  return (
    <section className="mt-5">
      <ImportedAssets groupEntries={groupFontEntries} kind="fonts" actionLabel="Send" onAction={sendShared} actionDisabled={!base || !!job} />
      <div className="flex items-center gap-2">
        <input
          ref={picker}
          type="file"
          multiple
          accept={filesOnly('.ttf,.otf,.cpfont')}
          className="hidden"
          onChange={async (e) => {
            const picked = [...e.target.files]
            e.target.value = ''
            const cpfonts = picked.filter((f) => /\.cpfont$/i.test(f.name))
            const trueType = picked.filter((f) => /\.(ttf|otf)$/i.test(f.name))
            if (cpfonts.length) await addCpfonts(cpfonts)
            if (trueType.length) await get({ files: trueType })
            if (!cpfonts.length && !trueType.length) notify({ error: true, title: 'Choose .ttf, .otf or .cpfont files' })
          }}
        />
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-surface px-3 ring-1 ring-stone-950/10 focus-within:ring-2 focus-within:ring-brand-500/60">
        <Search className="size-4 text-stone-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fonts"
          aria-label="Search fonts"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none placeholder:text-stone-400"
        />
        </label>
        <button
          disabled={!!job}
          onClick={() => picker.current?.click()}
          aria-label="Add font files"
          className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-40"
        >
          {job?.family === LOCAL ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
        </button>
      </div>
      {job?.family === LOCAL && <p className="mt-2 text-sm text-stone-500">{job.label}</p>}
      <div className="mt-2 border-t border-stone-200" />
      <FontList
        title="Google Fonts"
        note="Over 1,800 open-source families, saved as TrueType."
        open={!!q || openGoogle}
        onToggle={setOpenGoogle}
        error={catalogError}
        loading={!catalog}
      >
        {results.length > 0 && <link rel="stylesheet" href={`https://fonts.googleapis.com/css2?${results.map((f) => `family=${encodeURIComponent(f.family)}`).join('&')}&display=swap`} />}
        {catalog && !results.length && <p className="py-3 text-sm text-stone-500">No Google Fonts match “{query.trim()}”.</p>}
        {results.map((f) => (
          <div key={f.id} className="flex items-center gap-3 py-2.5">
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
                {savedNames.has(familyName(f.family)) ? 'Saved' : 'Get'}
              </button>
            )}
          </div>
        ))}
        {matches.length > shown && (
          <button onClick={() => setShown((n) => n + PAGE)} className="w-full py-3 text-left text-sm font-semibold text-brand-600">
            Show more ({(matches.length - shown).toLocaleString()} left)
          </button>
        )}
      </FontList>

      <FontList
        title="CrossPoint fonts"
        note="Ready-made .cpfont families, the same list as Manage Fonts on your reader."
        open={!!q || openCrossPoint}
        onToggle={setOpenCrossPoint}
        error={prebuiltError}
        loading={!prebuilt}
      >
        {prebuilt?.families
          .filter((f) => !q || `${f.name} ${f.description}`.toLowerCase().includes(q))
          .map((f) => (
            <div key={f.name} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-stone-900">{f.name}</span>
                <span className="block text-xs/5 text-stone-500">{status(f.name, `${f.description} · ${mb(f.files)}`)}</span>
              </span>
              {job?.family === f.name ? (
                <Loader2 className="size-5 animate-spin text-brand-500" />
              ) : (
                <button disabled={!!job} onClick={() => getPrebuilt(f)} className={rowButton}>
                  {savedNames.has(f.name) ? 'Saved' : 'Get'}
                </button>
              )}
            </div>
          ))}
      </FontList>

      {saved.length > 0 && (
        <>
          <h3 className="mt-10 font-display text-xl text-stone-900">On this phone</h3>
          <div className="mt-1 divide-y divide-stone-200 border-b border-stone-200">
            {saved.map((f) => (
              <div key={f.family} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900">{f.family}</span>
                  <span className="block text-xs text-stone-500">{status(f.family, `${isPrebuilt(f) ? `.cpfont · ${f.files.length} sizes` : `TrueType · ${f.files.length} style${f.files.length === 1 ? '' : 's'}`}${onReader.has(f.family) ? ' · on your reader' : ''}`)}</span>
                </span>
                {job?.family === f.family ? (
                  <Loader2 className="size-5 animate-spin text-brand-500" />
                ) : (
                  <>
                    <button disabled={!!job || !base} onClick={() => send(f)} className={rowButton}>
                      Send
                    </button>
                    <button disabled={!!job} onClick={() => forgetFont(f.family).then(reloadSaved)} className={iconButton} aria-label={`Remove ${f.family} from this phone`}>
                      <Trash2 className="size-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex min-h-12 items-center gap-3 py-2">
        <p className="min-w-0 flex-1 text-sm text-stone-900">Convert to .cpfont when sending</p>
        <Toggle label="Convert to .cpfont" checked={!trueType} onChange={value => setTrueType(!value)} />
      </div>

      <h3 className="mt-8 font-display text-xl text-stone-900">On your reader</h3>
      <div className="mt-1 divide-y divide-stone-200">
        {!base ? (
          <p className="py-3 text-sm text-stone-500">Connect your reader to see its fonts. You can get fonts now and send them later.</p>
        ) : typeof installed === 'string' ? (
          <p className="py-3 text-sm text-red-600">{installed}</p>
        ) : installed === undefined ? (
          <div className="py-6">
            <Loader2 className="mx-auto size-5 animate-spin text-stone-400" />
          </div>
        ) : installed.length === 0 ? (
          <EmptyState compact icon={Type} title="No extra fonts yet" />
        ) : (
          installed.map((f) => (
            <div key={f.name} className="flex items-center gap-3 py-2.5">
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
      </div>

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
