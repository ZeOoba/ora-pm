import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NAV_GROUPS, isNavActive } from './nav-config'

/** Grouped nav links shared by the desktop rail and the mobile sheet. */
export function NavList({
  pathname,
  collapsed = false,
  onNavigate,
}: {
  pathname: string
  collapsed?: boolean
  onNavigate?: () => void
}) {
  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto py-3">
      {NAV_GROUPS.map((group) => (
        <div key={group.heading} className="mb-3">
          {collapsed ? (
            <div className="mx-3 mb-1 border-t border-white/10 first:hidden" />
          ) : (
            <p className="px-5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{group.heading}</p>
          )}
          {group.items.map(({ to, label, icon: Icon }) => {
            const active = isNavActive(pathname, to)
            const link = (
              <Link
                key={to}
                to={to}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                aria-label={collapsed ? label : undefined}
                className={cn(
                  'flex items-center gap-3 border-l-2 py-1.5 text-sm transition-colors',
                  collapsed ? 'justify-center px-0' : 'pl-5 pr-4',
                  active
                    ? 'border-gold bg-white/5 font-medium text-white'
                    : 'border-transparent text-white/70 hover:bg-white/5 hover:text-white',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {!collapsed && <span className="truncate">{label}</span>}
              </Link>
            )
            if (!collapsed) return link
            return (
              <Tooltip key={to}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
