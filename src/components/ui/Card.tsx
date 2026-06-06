import { cardClasses, type CardVariant } from './card-variants'

export function Card({
  variant = 'default',
  className = '',
  children,
}: {
  variant?: CardVariant
  className?: string
  children: React.ReactNode
}) {
  return <div className={`${cardClasses(variant)} ${className}`}>{children}</div>
}
