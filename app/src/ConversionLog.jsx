import { useId, useState } from 'react'

export default function ConversionLog({ entries, children }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const toggle = entries?.length ? (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-1.5 text-stone-500">
      <span aria-hidden="true" className="leading-none">·</span>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="-my-1 py-1 font-medium underline-offset-2 hover:underline focus-visible:underline"
      >
        Details
      </button>
    </span>
  ) : null
  return (
    <>
      {children(toggle)}
      {!!entries?.length && (
        <ol id={id} hidden={!open} aria-label="Conversion log" className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg bg-stone-100 p-3 font-mono text-[0.65rem]/5 text-stone-600 select-text">
          {entries.map((entry, i) => (
            <li key={i} className={`whitespace-pre-wrap break-words ${entry.tag === 'ERROR' ? 'text-red-600' : ''}`}>
              <span className="text-stone-400">[{entry.elapsed.toFixed(1)}s]</span> {entry.tag}: {entry.message}
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
