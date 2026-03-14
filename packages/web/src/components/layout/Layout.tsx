import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import WaValidationBanner from './WaValidationBanner'

export default function Layout() {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <WaValidationBanner />
        <main className="flex-1 overflow-y-auto">
          <div className="container mx-auto max-w-7xl p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
