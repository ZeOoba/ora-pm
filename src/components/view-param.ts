import { useSearchParams } from 'react-router'

/**
 * Current alternate view of a page, stored in `?view=` so a view is linkable and survives
 * reload. The first option is the default (no param).
 */
export function useView<T extends string>(options: readonly T[]): [T, (v: T) => void] {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get('view') as T | null
  const view = raw && options.includes(raw) ? raw : options[0]
  const set = (v: T) => {
    const next = new URLSearchParams(sp)
    if (v === options[0]) next.delete('view')
    else next.set('view', v)
    setSp(next, { replace: true })
  }
  return [view, set]
}
