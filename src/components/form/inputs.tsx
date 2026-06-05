import { forwardRef } from 'react'

const base =
  'w-full border border-navy/15 rounded-md px-3 py-2 text-sm text-navy placeholder:text-status-neutral/50 focus:outline-none focus:ring-2 focus:ring-gold focus:border-transparent disabled:bg-parchment/40 disabled:text-status-neutral'

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => <input ref={ref} type="text" {...props} className={`${base} ${props.className ?? ''}`} />
)
TextInput.displayName = 'TextInput'

export const NumberInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => <input ref={ref} type="number" step="any" {...props} className={`${base} ${props.className ?? ''}`} />
)
NumberInput.displayName = 'NumberInput'

export const DateInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => <input ref={ref} type="date" {...props} className={`${base} ${props.className ?? ''}`} />
)
DateInput.displayName = 'DateInput'

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  (props, ref) => <textarea ref={ref} rows={3} {...props} className={`${base} ${props.className ?? ''}`} />
)
Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ children, ...props }, ref) => (
    <select ref={ref} {...props} className={`${base} ${props.className ?? ''}`}>
      {children}
    </select>
  )
)
Select.displayName = 'Select'

export function Checkbox({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex items-center gap-2 text-sm text-navy mb-4 cursor-pointer">
      <input type="checkbox" {...props} className="h-4 w-4 rounded border-navy/20 text-navy focus:ring-gold" />
      {label}
    </label>
  )
}
