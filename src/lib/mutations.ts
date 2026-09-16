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
  onError?: (err: Error) => void
}) {
  const qc = useQueryClient()
  // TError pinned to Error explicitly — without it, adding the optional
  // onError above widens inference to `unknown` for every existing caller
  // (mutation.error becomes `unknown`, breaking `.message` reads across every
  // page using this hook, not just the one adding onError).
  return useMutation<{ data: TResult }, Error, unknown>({
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
    onError: opts.onError,
  })
}
