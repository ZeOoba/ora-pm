import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

type Method = 'post' | 'put'

/**
 * Generic create/update mutation.
 * - method 'post' → api.post(path, body)
 * - method 'put'  → api.put(path, body)
 * On success, invalidates each queryKey in invalidate[] so lists/detail refetch.
 */
export function useSaveMutation<TResult = unknown>(opts: {
  method: Method
  path: string
  invalidate?: string[][]
  onSuccess?: (result: TResult) => void
}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: unknown) =>
      opts.method === 'post'
        ? api.post<{ data: TResult }>(opts.path, body)
        : api.put<{ data: TResult }>(opts.path, body),
    onSuccess: (res) => {
      for (const key of opts.invalidate ?? []) {
        qc.invalidateQueries({ queryKey: key })
      }
      opts.onSuccess?.(res.data)
    },
  })
}
