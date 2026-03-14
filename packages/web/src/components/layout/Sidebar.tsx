import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  Users,
  Megaphone,
  MessageSquareText,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/responses', label: 'Responses', icon: MessageSquareText },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r bg-card flex flex-col">
      <div className="px-5 py-4 border-b">
        <h1 className="text-sm font-semibold tracking-tight">AICE Automation</h1>
        <p className="text-xs text-muted-foreground">WhatsApp Campaign Manager</p>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
