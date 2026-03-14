import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'
import type { DepartmentTree } from '@aice/shared'

const DEFAULT_TEMPLATE = `Halo bapak/ibu mitra aice {{no}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat di Jakarta ingin konfirmasi. Apakah benar pada bulan {{bulan}} toko bapak/ibu ada melakukan penukaran Stick ke distributor? 
Terimakasih atas konfirmasinya, 
Have an aice day!`

export default function NewCampaign() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [bulan, setBulan] = useState('')
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const [tree, setTree] = useState<DepartmentTree[]>([])
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<DepartmentTree[]>('/api/files/scan').then(setTree).catch(console.error)
  }, [])

  // Fetch department IDs from the API (we need DB ids not folder names)
  // For now we use dept names — the API upserts by name
  function toggleDept(deptName: string) {
    setSelectedDepts((prev) => {
      const next = new Set(prev)
      if (next.has(deptName)) next.delete(deptName)
      else next.add(deptName)
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name || !bulan || !template || selectedDepts.size === 0) {
      setError('All fields are required and at least one department must be selected')
      return
    }

    setLoading(true)
    setError(null)
    try {
      // Fetch department IDs
      const departments = await apiFetch<Array<{ id: string; name: string }>>('/api/contacts?limit=0')
        .catch(() => [] as Array<{ id: string; name: string }>)

      // Fallback: create campaign with department names and let server resolve
      const campaign = await apiFetch<{ id: string }>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name,
          template,
          bulan,
          departmentIds: Array.from(selectedDepts), // TODO: resolve to DB IDs
        }),
      })
      navigate(`/campaigns/${campaign.id}`)
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">New Campaign</h2>
        <p className="text-muted-foreground">Configure and launch a WhatsApp campaign</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="camp-name" className="text-sm font-medium">Campaign name</label>
          <input
            id="camp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. December 2025 Confirmation"
            className="w-full border rounded-md px-3 py-2 text-sm bg-background"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="camp-bulan" className="text-sm font-medium">Month (bulan)</label>
          <input
            id="camp-bulan"
            value={bulan}
            onChange={(e) => setBulan(e.target.value)}
            placeholder='e.g. "12" or "Desember"'
            className="w-full border rounded-md px-3 py-2 text-sm bg-background"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="camp-template" className="text-sm font-medium">Message template</label>
          <textarea
            id="camp-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={6}
            className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono resize-y"
          />
          <p className="text-xs text-muted-foreground">
            Variables: {'{{no}}'} {'{{nama_toko}}'} {'{{bulan}}'} {'{{department}}'} {'{{area}}'}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Target departments</p>
          <div className="rounded-lg border divide-y max-h-64 overflow-y-auto">
            {tree.map((dept) => (
              <label key={dept.name} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-accent transition-colors">
                <input
                  type="checkbox"
                  checked={selectedDepts.has(dept.name)}
                  onChange={() => toggleDept(dept.name)}
                  className="rounded"
                />
                <span className="text-sm">{dept.name}</span>
                <span className="text-xs text-muted-foreground ml-auto">{dept.areas.length} areas</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="bg-primary text-primary-foreground text-sm px-5 py-2 rounded-md disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Campaign'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/campaigns')}
            className="text-sm px-5 py-2 rounded-md border"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
