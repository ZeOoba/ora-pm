import { Link } from 'react-router'

export function FormActions({
  submitLabel = 'Save',
  cancelTo,
  pending,
  error,
}: {
  submitLabel?: string
  cancelTo: string
  pending?: boolean
  error?: string | null
}) {
  return (
    <div className="mt-6">
      {error && (
        <p className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded p-2 mb-3">{error}</p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-navy hover:bg-navy-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link to={cancelTo} className="text-sm text-status-neutral hover:text-navy">
          Cancel
        </Link>
      </div>
    </div>
  )
}
