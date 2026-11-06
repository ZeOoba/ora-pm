import { Slot } from '@radix-ui/react-slot'
import { cn } from '@/lib/utils'
import { buttonClasses, type ButtonVariant } from './button-variants'

export function Button({
  variant = 'navy',
  className,
  asChild = false,
  ...props
}: {
  variant?: ButtonVariant
  asChild?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const Comp = asChild ? Slot : 'button'
  return <Comp {...props} className={cn(buttonClasses(variant), className)} />
}
