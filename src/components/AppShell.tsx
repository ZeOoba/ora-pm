import { Fragment, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ChevronRight, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, User } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { NavList } from './NavList'
import { CommandMenu } from './CommandMenu'
import { breadcrumbFor } from './nav-config'

const RAIL_KEY = 'ora-pm.nav-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(RAIL_KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable (private mode / blocked): collapse state just isn't persisted */
  }
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn('border-b border-white/10 py-5', compact ? 'px-0 text-center' : 'px-5')}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gold">{compact ? 'ORA' : 'Oxford Realty'}</p>
      {!compact && <p className="mt-0.5 font-display text-sm">Property Manager</p>}
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // Lazy initializer: the first render already has the stored state, so the rail never flashes
  // expanded before collapsing. readCollapsed() swallows storage errors (private mode / blocked).
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    setIsMac(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent))
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => setEmail(s?.user.email ?? null))
    return () => subscription.unsubscribe()
  }, [])

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsed(next)
  }

  async function signOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  const crumbs = breadcrumbFor(pathname)
  const shortcut = isMac ? '⌘K' : 'Ctrl K'

  return (
    <div className="flex h-screen bg-background">
      {/* >= md: collapsible rail (240px expanded / 64px icons-only) */}
      <aside
        className={cn(
          'hidden shrink-0 flex-col bg-primary text-primary-foreground transition-[width] duration-200 md:flex',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <Brand compact={collapsed} />
        <NavList pathname={pathname} collapsed={collapsed} />
        <div className={cn('flex items-center border-t border-white/10 py-2', collapsed ? 'justify-center' : 'justify-between px-5')}>
          {!collapsed && <span className="font-mono text-[11px] text-white/40">ORA PM · v1</span>}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className="rounded p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-8">
          {/* < md: menu button opens the nav in a sheet */}
          <div className="md:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <button type="button" aria-label="Open navigation" className="rounded p-1.5 text-foreground hover:bg-muted">
                  <Menu className="size-5" />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-60 gap-0 border-r-0 bg-primary p-0 text-primary-foreground [&>button]:text-white">
                <SheetHeader className="sr-only">
                  <SheetTitle>Navigation</SheetTitle>
                  <SheetDescription>Main navigation</SheetDescription>
                </SheetHeader>
                <Brand />
                <NavList pathname={pathname} onNavigate={() => setMobileOpen(false)} />
              </SheetContent>
            </Sheet>
          </div>
          <span className="font-display text-sm font-semibold text-primary md:hidden">Property Manager</span>

          <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
            <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1
                return (
                  <Fragment key={`${c.label}-${i}`}>
                    {i > 0 && (
                      <li aria-hidden="true" className="flex">
                        <ChevronRight className="size-3.5 shrink-0" />
                      </li>
                    )}
                    <li className={cn('truncate', last && 'font-medium text-foreground')} aria-current={last ? 'page' : undefined}>
                      {c.to && !last ? (
                        <Link to={c.to} className="hover:text-foreground">
                          {c.label}
                        </Link>
                      ) : (
                        c.label
                      )}
                    </li>
                  </Fragment>
                )
              })}
            </ol>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Search"
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            >
              <Search className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded border border-border bg-muted px-1.5 font-mono text-[11px] sm:inline">{shortcut}</kbd>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="User menu" className="rounded-full border border-border bg-background p-1.5 text-foreground hover:bg-muted">
                  <User className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email ?? 'Signed in'}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut()}>
                  <LogOut className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto bg-background p-4 md:p-8">{children}</main>
      </div>
      <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  )
}
