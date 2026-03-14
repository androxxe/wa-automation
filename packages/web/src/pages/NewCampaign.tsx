import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '@/lib/utils'

const DEFAULT_TEMPLATE = `Halo bapak/ibu mitra aice {{area}} toko {{nama_toko}}, saya dari tim inspeksi aice pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran Stick ke distributor?`

interface AreaItem {
  id: string
  name: string
}

interface DeptWithAreas {
  id: string
  name: string
  areas: AreaItem[]
}

export default function NewCampaign() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [bulan, setBulan] = useState('')
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  const [depts, setDepts] = useState<DeptWithAreas[]>([])
  const [selectedAreas, setSelectedAreas] = useState<Set<string>>(new Set())
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<DeptWithAreas[]>('/api/files/areas')
      .then((data) => {
        setDepts(data)
        // Expand all departments by default
        setExpandedDepts(new Set(data.map((d) => d.id)))
      })
      .catch(console.error)
  }, [])

  function toggleArea(areaId: string) {
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      if (next.has(areaId)) next.delete(areaId)
      else next.add(areaId)
      return next
    })
  }

  function toggleDept(dept: DeptWithAreas) {
    const allSelected = dept.areas.every((a) => selectedAreas.has(a.id))
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        for (const a of dept.areas) next.delete(a.id)
      } else {
        for (const a of dept.areas) next.add(a.id)
      }
      return next
    })
  }

  function toggleExpand(deptId: string) {
    setExpandedDepts((prev) => {
      const next = new Set(prev)
      if (next.has(deptId)) next.delete(deptId)
      else next.add(deptId)
      return next
    })
  }

  const totalSelected = selectedAreas.size

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name || !bulan || !template || selectedAreas.size === 0) {
      setError('All fields are required and at least one area must be selected')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const campaign = await apiFetch<{ id: string }>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name,
          template,
          bulan,
          areaIds: Array.from(selectedAreas),
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
            rows={5}
            className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono resize-y"
          />
          <p className="text-xs text-muted-foreground">
            Variables: {'{{nama_toko}}'} {'{{bulan}}'} {'{{department}}'} {'{{area}}'}
          </p>
        </div>

        {/* Department → Area tree */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Target areas</p>
            {totalSelected > 0 && (
              <span className="text-xs text-primary font-medium">{totalSelected} area{totalSelected !== 1 ? 's' : ''} selected</span>
            )}
          </div>

          {depts.length === 0 ? (
            <div className="rounded-lg border px-4 py-6 text-sm text-muted-foreground text-center">
              No areas found — import contacts first
            </div>
          ) : (
            <div className="rounded-lg border divide-y max-h-80 overflow-y-auto">
              {depts.map((dept) => {
                const allSelected = dept.areas.length > 0 && dept.areas.every((a) => selectedAreas.has(a.id))
                const someSelected = dept.areas.some((a) => selectedAreas.has(a.id))
                const expanded = expandedDepts.has(dept.id)

                return (
                  <div key={dept.id}>
                    {/* Department row */}
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/50">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
                        onChange={() => toggleDept(dept)}
                        className="rounded"
                      />
                      <button
                        type="button"
                        onClick={() => toggleExpand(dept.id)}
                        className="flex-1 flex items-center gap-2 text-left"
                      >
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{dept.name}</span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {dept.areas.filter((a) => selectedAreas.has(a.id)).length}/{dept.areas.length}
                        </span>
                        <span className="text-xs text-muted-foreground">{expanded ? '▲' : '▼'}</span>
                      </button>
                    </div>

                    {/* Area rows */}
                    {expanded && dept.areas.map((area) => (
                      <label
                        key={area.id}
                        className="flex items-center gap-3 pl-8 pr-4 py-2 cursor-pointer hover:bg-accent transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedAreas.has(area.id)}
                          onChange={() => toggleArea(area.id)}
                          className="rounded"
                        />
                        <span className="text-sm">{area.name}</span>
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
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
