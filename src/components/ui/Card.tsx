import { cn } from '@/lib/utils'
import { cardClasses, type CardVariant } from './card-variants'

export function Card({
  variant = 'default',
  className,
  children,
}: {
  variant?: CardVariant
  className?: string
  children: React.ReactNode
}) {
  return <div className={cn(cardClasses(variant), className)}>{children}</div>
}
