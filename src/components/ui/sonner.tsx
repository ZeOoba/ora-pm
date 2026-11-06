import { Toaster as Sonner, type ToasterProps } from 'sonner'

// ORA-themed toaster: navy text on white card, gold ring accents. No dark mode in P1.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--color-popover)',
          '--normal-text': 'var(--color-popover-foreground)',
          '--normal-border': 'var(--color-border)',
          '--success-bg': 'var(--color-popover)',
          '--success-text': 'var(--color-status-active)',
          '--success-border': 'var(--color-border)',
          '--error-bg': 'var(--color-popover)',
          '--error-text': 'var(--color-status-danger)',
          '--error-border': 'var(--color-border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
