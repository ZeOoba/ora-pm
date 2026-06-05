import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import type { Document } from '../lib/portal-api'

export function PortalDocuments() {
  const { data, isLoading } = useQuery({ queryKey: ['portal-documents'], queryFn: portalApi.getDocuments })
  const docs = (data?.data ?? []) as Document[]

  if (isLoading) return <div className="p-6 text-gray-500">Loading…</div>

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <h1 className="text-2xl font-serif" style={{ color: '#1B2A4A' }}>Documents</h1>
      <p className="text-sm text-gray-500">Contact your property manager to request copies of documents not shown here.</p>
      {docs.length === 0 ? (
        <p className="text-gray-500 text-sm">No documents on file yet.</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {docs.map(doc => (
            <div key={doc.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{doc.file_name}</p>
                <p className="text-xs text-gray-500 capitalize">
                  {doc.document_type.replace(/_/g, ' ')} · Uploaded {doc.uploaded_at.slice(0, 10)}
                </p>
              </div>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">PDF</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
