export type CardVariant = 'flat' | 'default' | 'raised'

export function cardClasses(variant: CardVariant = 'default'): string {
  const map: Record<CardVariant, string> = {
    flat:    'bg-white rounded-card',
    default: 'bg-white rounded-card border border-navy/10 shadow-sm',
    raised:  'bg-white rounded-card shadow-lg',
  }
  return map[variant]
}
