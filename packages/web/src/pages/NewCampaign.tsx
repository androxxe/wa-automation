import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils'
import type { AppConfigData } from '@aice/shared'

// 3 template variants per type — structurally different so each campaign
// starts from a meaningfully different base. Claude varies each one further
// before send, giving effectively unlimited uniqueness across contacts.
const DEFAULT_TEMPLATES: Record<string, string[]> = {
  STIK: [
    `Halo bapak/ibu mitra AICE {{area}} toko {{nama_toko}}, saya dari tim inspeksi AICE pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran Stik ke distributor?`,
    `Halo bapak/ibu {{nama_toko}} di {{area}}, saya dari tim inspeksi AICE pusat Jakarta. Boleh saya meminta konfirmasi, apakah pada bulan {{bulan}} toko bapak/ibu sudah melakukan penukaran Stik bersama distributor?`,
    `Halo bapak/ibu, saya dari tim AICE pusat Jakarta. Terkait toko {{nama_toko}} di wilayah {{area}}, kami ingin mengkonfirmasi apakah pada bulan {{bulan}} sudah dilakukan penukaran Stik ke distributor? Mohon konfirmasinya, terima kasih.`,
  ],
  KARDUS: [
    `Halo bapak/ibu mitra AICE {{area}} toko {{nama_toko}}, saya dari tim inspeksi AICE pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran kupon Kardus?`,
    `Halo bapak/ibu {{nama_toko}} di {{area}}, saya dari tim inspeksi AICE pusat Jakarta. Boleh saya meminta konfirmasi, apakah pada bulan {{bulan}} toko bapak/ibu sudah melakukan penukaran kupon Kardus bersama distributor?`,
    `Halo bapak/ibu, saya dari tim AICE pusat Jakarta. Terkait toko {{nama_toko}} di wilayah {{area}}, kami ingin mengkonfirmasi apakah pada bulan {{bulan}} sudah dilakukan penukaran kupon Kardus? Mohon konfirmasinya, terima kasih.`,
  ],
}

function pickTemplate(type: string): string {
  const pool = DEFAULT_TEMPLATES[type] ?? DEFAULT_TEMPLATES['STIK']
  return pool[Math.floor(Math.random() * pool.length)]
}

type CampaignType = 'STIK' | 'KARDUS'

interface AreaItem {
  id:          string
  name:        string
  contactType: string
}

interface DeptWithAreas {
  id:    string
  name:  string
  areas: AreaItem[]
}

const TYPE_BADGE: Record<string, string> = {
  STIK:   'bg-blue-100 text-blue-700',
  KARDUS: 'bg-orange-100 text-orange-700',
}

export default function NewCampaign() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [name, setName]             = useState('')
  const [bulan, setBulan]           = useState('')
  const [campaignType, setCampaignType] = useState<CampaignType>('STIK')
  const [template, setTemplate]         = useState(() => pickTemplate('STIK'))
  const [templateEdited, setTemplateEdited] = useState(false)
  const [targetReplies, setTargetReplies] = useState<string>('')
  const [replyRate, setReplyRate]   = useState<string>('')
  const [config, setConfig]         = useState<AppConfigData | null>(null)

  const [allDepts, setAllDepts]     = useState<DeptWithAreas[]>([])
  const [selectedAreas, setSelectedAreas] = useState<Set<string>>(new Set())
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set())

  const [error, setError] = useState<string | null>(null)

  const { data: configData } = useQuery<AppConfigData>({
    queryKey: ['config'],
    queryFn:  () => apiFetch<AppConfigData>('/api/config'),
  })

  const { data: areasData = [] } = useQuery<DeptWithAreas[]>({
    queryKey: ['files-areas'],
    queryFn:  () => apiFetch<DeptWithAreas[]>('/api/files/areas'),
  })

  // Sync config into local state
  useEffect(() => { if (configData) setConfig(configData) }, [configData])
  // Sync areas into local state
  useEffect(() => {
    if (areasData.length > 0) {
      setAllDepts(areasData)
      setExpandedDepts(new Set(areasData.map((d) => d.id)))
    }
  }, [areasData])

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ id: string }>('/api/campaigns', {
        method: 'POST',
        body:   JSON.stringify(body),
      }),
    onSuccess: (campaign) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      navigate(`/campaigns/${campaign.id}`)
    },
    onError:   (e) => setError(String(e)),
  })

  // Filter departments/areas to the selected campaign type
  const depts = allDepts.map((d) => ({
    ...d,
    areas: d.areas.filter((a) => a.contactType === campaignType),
  })).filter((d) => d.areas.length > 0)

  // Reset selected areas when type changes
  const handleTypeChange = useCallback((t: CampaignType) => {
    setCampaignType(t)
    setSelectedAreas(new Set())
    // Only switch the template if the user hasn't manually edited it
    if (!templateEdited) setTemplate(pickTemplate(t))
  }, [templateEdited])

  function toggleArea(areaId: string) {
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      if (next.has(areaId)) next.delete(areaId); else next.add(areaId)
      return next
    })
  }

  function toggleDept(dept: DeptWithAreas) {
    const allSel = dept.areas.every((a) => selectedAreas.has(a.id))
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      for (const a of dept.areas) allSel ? next.delete(a.id) : next.add(a.id)
      return next
    })
  }

  function toggleExpand(deptId: string) {
    setExpandedDepts((prev) => {
      const next = new Set(prev)
      next.has(deptId) ? next.delete(deptId) : next.add(deptId)
      return next
    })
  }

  const effectiveTarget = parseInt(targetReplies) || config?.defaultTargetRepliesPerArea || 20
  const effectiveRate   = parseFloat(replyRate) / 100 || config?.defaultExpectedReplyRate || 0.5
  const sendPerArea     = Math.ceil(effectiveTarget / effectiveRate)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name || !bulan || !template || selectedAreas.size === 0) {
      setError('All fields are required and at least one area must be selected')
      return
    }
    setError(null)
    createMutation.mutate({
      name,
      template,
      bulan,
      campaignType,
      areaIds: Array.from(selectedAreas),
      ...(targetReplies && { targetRepliesPerArea: parseInt(targetReplies) }),
      ...(replyRate     && { expectedReplyRate:    parseFloat(replyRate) / 100 }),
    })
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

        {/* Name */}
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

        {/* Bulan */}
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

        {/* Campaign type */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Campaign type</p>
          <div className="flex gap-3">
            {(['STIK', 'KARDUS'] as CampaignType[]).map((t) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="campaignType"
                  value={t}
                  checked={campaignType === t}
                  onChange={() => handleTypeChange(t)}
                />
                <span className={`text-sm px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE[t]}`}>{t}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Only areas imported as {campaignType} will be shown below.</p>
        </div>

         {/* Template */}
         <div className="space-y-1.5">
           <div className="flex items-center justify-between">
             <label htmlFor="camp-template" className="text-sm font-medium">Message template</label>
             <button
               type="button"
               onClick={() => { setTemplate(pickTemplate(campaignType)); setTemplateEdited(false) }}
               className="text-xs text-muted-foreground hover:text-foreground border rounded px-2 py-0.5 flex items-center gap-1"
               title={`Pick a different template (${DEFAULT_TEMPLATES[campaignType]?.length ?? 3} variants available)`}
             >
               ↺ Randomize
             </button>
           </div>
           <textarea
             id="camp-template"
             value={template}
             onChange={(e) => { setTemplate(e.target.value); setTemplateEdited(true) }}
             rows={5}
             className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono resize-y"
           />
           <p className="text-xs text-muted-foreground">
             Variables: {'{{nama_toko}}'} {'{{bulan}}'} {'{{department}}'} {'{{area}}'} {'{{tipe}}'}
           </p>
         </div>

        {/* Target areas */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Target areas ({campaignType})</p>
            {selectedAreas.size > 0 && (
              <span className="text-xs text-primary font-medium">{selectedAreas.size} selected</span>
            )}
          </div>
          {depts.length === 0 ? (
            <div className="rounded-lg border px-4 py-6 text-sm text-muted-foreground text-center">
              No {campaignType} areas imported — import contacts first
            </div>
          ) : (
            <div className="rounded-lg border divide-y max-h-80 overflow-y-auto">
              {depts.map((dept) => {
                const allSel  = dept.areas.length > 0 && dept.areas.every((a) => selectedAreas.has(a.id))
                const someSel = dept.areas.some((a) => selectedAreas.has(a.id))
                const expanded = expandedDepts.has(dept.id)
                return (
                  <div key={dept.id}>
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/50">
                      <input
                        type="checkbox"
                        checked={allSel}
                        ref={(el) => { if (el) el.indeterminate = someSel && !allSel }}
                        onChange={() => toggleDept(dept)}
                        className="rounded"
                      />
                      <button type="button" onClick={() => toggleExpand(dept.id)} className="flex-1 flex items-center gap-2 text-left">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{dept.name}</span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {dept.areas.filter((a) => selectedAreas.has(a.id)).length}/{dept.areas.length}
                        </span>
                        <span className="text-xs">{expanded ? '▲' : '▼'}</span>
                      </button>
                    </div>
                    {expanded && dept.areas.map((area) => (
                      <label key={area.id} className="flex items-center gap-3 pl-8 pr-4 py-2 cursor-pointer hover:bg-accent transition-colors">
                        <input type="checkbox" checked={selectedAreas.has(area.id)} onChange={() => toggleArea(area.id)} className="rounded" />
                        <span className="text-sm">{area.name}</span>
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Send configuration */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
          <p className="text-sm font-semibold">Send Configuration</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="target-replies" className="text-xs font-medium text-muted-foreground">
                Target replies per area
              </label>
              <input
                id="target-replies"
                type="number"
                min={1}
                value={targetReplies}
                onChange={(e) => setTargetReplies(e.target.value)}
                placeholder={String(config?.defaultTargetRepliesPerArea ?? 20)}
                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="reply-rate" className="text-xs font-medium text-muted-foreground">
                Expected reply rate (%)
              </label>
              <input
                id="reply-rate"
                type="number"
                min={1}
                max={100}
                value={replyRate}
                onChange={(e) => setReplyRate(e.target.value)}
                placeholder={String(Math.round((config?.defaultExpectedReplyRate ?? 0.5) * 100))}
                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
              />
            </div>
          </div>
          <div className="text-sm text-muted-foreground bg-background rounded border px-3 py-2">
            Messages to send per area:{' '}
            <span className="font-semibold text-foreground">{sendPerArea}</span>
            {' '}= ceil({effectiveTarget} ÷ {Math.round(effectiveRate * 100)}%)
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="submit"           disabled={createMutation.isPending} className="bg-primary text-primary-foreground text-sm px-5 py-2 rounded-md disabled:opacity-50">
            {createMutation.isPending ? 'Creating…' : 'Create Campaign'}
          </button>
          <button type="button" onClick={() => navigate('/campaigns')} className="text-sm px-5 py-2 rounded-md border">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
