import { buttonClasses, type ButtonVariant } from './button-variants'

export function Button({
  variant = 'navy',
  className = '',
  ...props
}: { variant?: ButtonVariant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${buttonClasses(variant)} ${className}`} />
}
