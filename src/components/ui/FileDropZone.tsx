import { useRef, useState } from 'react'
import { validateFile } from './file-drop'

export function FileDropZone({
  onFile,
  accept = ['application/pdf'],
  maxBytes = 10 * 1024 * 1024,
  hint = 'Drop a lease PDF here, or click to browse',
}: {
  onFile: (file: File) => void
  accept?: string[]
  maxBytes?: number
  hint?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState('')

  function handle(file: File | undefined) {
    if (!file) return
    const v = validateFile(file, { accept, maxBytes })
    if (!v.ok) { setError(v.error); return }
    setError('')
    onFile(file)
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files?.[0]) }}
        className={`flex flex-col items-center justify-center rounded-card border-2 border-dashed px-6 py-12 text-center cursor-pointer transition-colors ${
          drag ? 'border-gold bg-gold/5' : 'border-navy/20 hover:border-gold hover:bg-parchment/40'
        }`}
      >
        <p className="font-display text-navy">{hint}</p>
        <p className="mt-1 text-xs text-status-neutral font-mono">PDF · max {Math.round(maxBytes / 1024 / 1024)} MB</p>
        <input
          ref={inputRef}
          type="file"
          accept={accept.join(',')}
          className="hidden"
          onChange={e => handle(e.target.files?.[0])}
        />
      </div>
      {error && <p className="mt-2 text-xs text-status-danger">{error}</p>}
    </div>
  )
}
