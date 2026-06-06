export type ButtonVariant = 'navy' | 'gold' | 'ghost' | 'danger'

const BASE = 'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

const VARIANT: Record<ButtonVariant, string> = {
  navy:   'bg-navy text-white hover:bg-navy-700',
  gold:   'bg-gold text-navy hover:bg-gold-600',
  ghost:  'text-navy hover:bg-parchment',
  danger: 'bg-status-danger text-white hover:opacity-90',
}

export function buttonClasses(variant: ButtonVariant = 'navy'): string {
  return `${BASE} ${VARIANT[variant]}`
}
