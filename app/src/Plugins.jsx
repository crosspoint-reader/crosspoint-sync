import { useEffect, useState } from 'react'
import { Download, ExternalLink, Loader2, Puzzle, RefreshCw, Search, Trash2 } from 'lucide-react'
import { http } from './api.js'
import { deleteFiles, joinPath, listFiles, readText, uploadTo } from './device.js'
import { ActionSheet, Card, EmptyState, notify } from './ui.jsx'

// The same discovery the reader's Plugin Hub uses: its device.json names the catalog and extra lists.
const HUB = 'https://pluginhub.crosspointreader.com/device.json'
// Scanned by the firmware in this order; an existing copy is updated in place.
export const ROOTS = ['/.crosspoint/plugins', '/plugins', '/.plugins']
// Files that make a folder a plugin go last, so the reader never sees a half-copied one.
const DISCOVERY = ['manifest.json', 'device.json', 'plugin.js']
export const installOrder = (files) => [...files].sort((a, b) => DISCOVERY.includes(a) - DISCOVERY.includes(b))

async function json(url) {
  const res = await http(url)
  if (!res.ok) throw new Error(`Couldn't load the plugin list (${res.status})`)
  return res.json()
}

let hub
function hubCatalog() {
  hub ??= (async () => {
    const device = await json(HUB)
    const main = (await json(device.browse.url)).plugins ?? []
    const seen = new Set(main.map((p) => p.name))
    const extra = device.browse.lists_url ? ((await json(device.browse.lists_url).catch(() => ({}))).lists ?? []) : []
    const lists = await Promise.all(
      extra.map(async (l) => ({
        title: l.title,
        notice: l.notice?.message,
        plugins: ((await json(l.url).catch(() => ({}))).plugins ?? []).filter((p) => !seen.has(p.name)),
      }))
    )
    return { dest: device.download?.dest_dir ?? ROOTS[0], lists: [{ title: 'Plugin Hub', plugins: main }, ...lists.filter((l) => l.plugins.length)] }
  })().catch((e) => {
    hub = null
    throw e
  })
  return hub
}

// { name: { dir, version } } for plugin folders on the reader.
async function installedPlugins(base) {
  const found = {}
  for (const root of ROOTS) {
    for (const f of await listFiles(base, root).catch(() => [])) {
      if (f.isDirectory && !found[f.name]) found[f.name] = { dir: joinPath(root, f.name) }
    }
  }
  await Promise.all(
    Object.values(found).map(async (p) => {
      p.version = await readText(base, `${p.dir}/manifest.json`).then((t) => JSON.parse(t).version, () => null)
    })
  )
  return found
}

async function walk(base, dir) {
  const out = []
  for (const f of await listFiles(base, dir)) {
    const path = joinPath(dir, f.name)
    if (f.isDirectory) out.push(...(await walk(base, path)))
    out.push(path)
  }
  return out
}

export default function Plugins({ base }) {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState(null)
  const [installed, setInstalled] = useState({})
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [job, setJob] = useState(null) // { name, label }
  const [removing, setRemoving] = useState(null)

  useEffect(() => {
    hubCatalog().then(setCatalog, (e) => setError(e.message))
  }, [])
  useEffect(() => {
    if (!base) return setInstalled({})
    let live = true
    installedPlugins(base).then((p) => live && setInstalled(p), () => {})
    return () => {
      live = false
    }
  }, [base, tick])

  async function install(p) {
    const dir = installed[p.name]?.dir ?? joinPath(catalog.dest, p.name)
    const files = installOrder(p.files)
    try {
      for (const [i, file] of files.entries()) {
        setJob({ name: p.name, label: `Installing ${i + 1} of ${files.length}…` })
        const res = await http(p.base + file)
        if (!res.ok) throw new Error(`Couldn't download ${file}`)
        await uploadTo(base, `${dir}/${file}`, new Uint8Array(await res.arrayBuffer()))
      }
      notify({ title: `Installed ${p.title}`, detail: 'Find it under Home › Plugins on your reader' })
      setTick((t) => t + 1)
    } catch (e) {
      notify({ error: true, title: `Couldn't install ${p.title}`, detail: e.message })
    } finally {
      setJob(null)
    }
  }

  const q = query.trim().toLowerCase()
  const match = (p) => !q || `${p.title} ${p.description} ${p.author}`.toLowerCase().includes(q)

  return (
    <section className="mt-6">
      <p className="text-sm/6 text-stone-500">
        Plugins add services and tools to your reader. Turn on Settings › Connectivity › Plugins on the reader to use them.
      </p>
      <label className="mt-3 flex h-11 items-center gap-2 rounded-xl bg-surface px-3 ring-1 ring-stone-950/10 focus-within:ring-2 focus-within:ring-brand-500/60">
        <Search className="size-4 text-stone-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search plugins"
          aria-label="Search plugins"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none"
        />
      </label>
      {!base && <p className="mt-3 text-sm text-stone-500">Connect your reader to install plugins.</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {!catalog && !error && <Loader2 className="mx-auto mt-6 size-5 animate-spin text-stone-400" />}

      {catalog?.lists.map((list) => {
        const plugins = list.plugins.filter(match)
        if (!plugins.length) return null
        return (
          <div key={list.title} className="mt-5">
            <h3 className="text-sm font-semibold text-stone-600">{list.title}</h3>
            {list.notice && <p className="text-xs/5 text-stone-500">{list.notice}</p>}
            <Card className="mt-2 divide-y divide-stone-100">
              {plugins.map((p) => {
                const have = installed[p.name]
                const update = have && have.version && have.version !== p.version
                return (
                  <div key={p.name} className="flex items-start gap-3 px-4 py-3">
                    <Puzzle className="mt-0.5 size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-stone-900">{p.title}</p>
                      <p className="text-xs/5 text-stone-500">{job?.name === p.name ? job.label : p.description}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-stone-400">
                        <span>
                          {p.author} · v{p.version}
                          {have && ` · installed${have.version && update ? ` v${have.version}` : ''}`}
                        </span>
                        {p.repository && (
                          <a href={`https://github.com/${p.repository}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-600">
                            Details <ExternalLink className="size-3" />
                          </a>
                        )}
                      </p>
                    </div>
                    {job?.name === p.name ? (
                      <Loader2 className="size-5 animate-spin text-brand-500" />
                    ) : (
                      <div className="flex items-center">
                        {(!have || update) && (
                          <button
                            disabled={!!job || !base}
                            onClick={() => install(p)}
                            className="flex h-9 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-sm font-semibold text-brand-700 active:bg-brand-100 disabled:opacity-40"
                          >
                            {update ? <RefreshCw className="size-4" /> : <Download className="size-4" />} {update ? 'Update' : 'Install'}
                          </button>
                        )}
                        {have && (
                          <button
                            disabled={!!job}
                            onClick={() => setRemoving(p)}
                            className="-mr-2 grid size-9 place-items-center rounded-full text-stone-400 active:bg-stone-100 disabled:opacity-40"
                            aria-label={`Remove ${p.title}`}
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </Card>
          </div>
        )
      })}
      {catalog && q && !catalog.lists.some((l) => l.plugins.some(match)) && (
        <EmptyState compact icon={Puzzle} title="No plugins match">
          Try a different search.
        </EmptyState>
      )}

      {removing && (
        <ActionSheet
          title={`Remove ${removing.title}?`}
          actionLabel="Remove"
          pendingLabel="Removing…"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const dir = installed[removing.name].dir
            await deleteFiles(base, [...(await walk(base, dir)), dir])
            setTick((t) => t + 1)
          }}
        >
          Delete this plugin and its settings from your reader?
        </ActionSheet>
      )}
    </section>
  )
}
