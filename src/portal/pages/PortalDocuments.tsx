import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import type { Document } from '../lib/portal-api'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/QueryState'

export function PortalDocuments() {
  const query = useQuery({ queryKey: ['portal-documents'], queryFn: portalApi.getDocuments })
  const docs = (query.data?.data ?? []) as Document[]

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <h1 className="font-display text-2xl text-navy">Documents</h1>
      <p className="text-sm text-status-neutral">Contact your property manager to request copies of documents not shown here.</p>
      <QueryState query={query}>
        {docs.length === 0 ? (
          <p className="text-status-neutral text-sm">No documents on file yet.</p>
        ) : (
          <Card className="divide-y divide-border">
            {docs.map(doc => (
              <div key={doc.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-navy">{doc.file_name}</p>
                  <p className="text-xs text-status-neutral capitalize">
                    {doc.document_type.replace(/_/g, ' ')} · Uploaded {doc.uploaded_at.slice(0, 10)}
                  </p>
                </div>
                <span className="text-xs text-status-neutral bg-muted px-2 py-1 rounded">PDF</span>
              </div>
            ))}
          </Card>
        )}
      </QueryState>
    </div>
  )
}
