import { Link } from 'react-router-dom'

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
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">{error}</p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link to={cancelTo} className="text-sm text-gray-600 hover:text-gray-900">
          Cancel
        </Link>
      </div>
    </div>
  )
}
