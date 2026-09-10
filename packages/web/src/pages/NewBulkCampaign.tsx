import { useState, useEffect, useCallback, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/utils"
import type { AppConfigData, BulkCreateCampaignResult } from "@aice/shared"

// Same defaults as NewCampaign — one shared set applied to every bulk campaign.
const DEFAULT_TEMPLATES: Record<string, string[]> = {
  STIK: [
    `Halo bapak/ibu mitra AICE {{area}} toko {{nama_toko}}, saya dari tim inspeksi AICE pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah melakukan penukaran Stik ke distributor?`,
    `Halo bapak/ibu {{nama_toko}} di {{area}}, saya dari tim inspeksi AICE pusat Jakarta. Boleh saya meminta konfirmasi, apakah pada bulan {{bulan}} toko bapak/ibu sudah melakukan penukaran Stik bersama distributor?`,
    `Halo bapak/ibu, saya dari tim AICE pusat Jakarta. Terkait toko {{nama_toko}} di wilayah {{area}}, kami ingin mengkonfirmasi apakah pada bulan {{bulan}} sudah dilakukan penukaran Stik ke distributor? Mohon konfirmasinya, terima kasih.`,
  ],
  KARDUS: [
    `Halo bapak/ibu mitra AICE {{area}} toko {{nama_toko}}, saya dari tim inspeksi AICE pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu telah menukarkan kupon Kardus ke distributor dan menerima hadiahnya (Yoyic Botol / Yoyic Sachet / Crispy Balls)? terimakasih`,
    `Halo bapak/ibu {{nama_toko}} di {{area}}, saya dari tim inspeksi AICE pusat Jakarta. Boleh saya meminta konfirmasi, apakah pada bulan {{bulan}} toko bapak/ibu sudah menukarkan kupon Kardus ke distributor dan sudah menerima salah satu hadiahnya — Yoyic Botol, Yoyic Sachet, atau Crispy Balls? terimakasih`,
    `Halo bapak/ibu, saya dari tim AICE pusat Jakarta. Terkait toko {{nama_toko}} di wilayah {{area}}, kami ingin mengkonfirmasi apakah pada bulan {{bulan}} sudah dilakukan penukaran kupon Kardus ke distributor dengan hadiah Yoyic Botol / Yoyic Sachet / Crispy Balls? terimakasih`,
  ],
  YOYIC: [
    `Halo bapak/ibu mitra AICE {{area}} toko {{nama_toko}}, saya dari tim inspeksi AICE pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} toko bapak/ibu mendapatkan Yoyic bubuk atau botol dari aice? Terimakasih`,
    `Halo bapak/ibu {{nama_toko}} di {{area}}, saya dari tim inspeksi AICE pusat Jakarta. Boleh saya meminta konfirmasi, apakah pada bulan {{bulan}} toko bapak/ibu sudah dapat Yoyic bubuk atau botol dari aice? Terimakasih`,
    `Halo bapak/ibu, saya dari tim AICE pusat Jakarta. Terkait toko {{nama_toko}} di wilayah {{area}}, kami ingin mengkonfirmasi apakah pada bulan {{bulan}} sudah mendapatkan Yoyic bubuk atau botol dari aice? Mohon konfirmasinya, terima kasih.`,
  ],
  CRISPY_BALLS: [
    `Halo bapak/ibu mitra AICE {{area}} toko {{nama_toko}}, saya dari tim inspeksi AICE pusat Jakarta ingin melakukan konfirmasi. Apakah benar bahwa pada bulan {{bulan}} atau 3 toko bapak/ibu mendapatkan 2pcs Crispy Balls gratis dari aice? Terimakasih`,
    `Halo bapak/ibu {{nama_toko}} di {{area}}, saya dari tim inspeksi AICE pusat Jakarta. Boleh saya meminta konfirmasi, apakah pada bulan {{bulan}} atau 3 toko bapak/ibu sudah dapat 2pcs Crispy Balls gratis dari aice? Terimakasih`,
    `Halo bapak/ibu, saya dari tim AICE pusat Jakarta. Terkait toko {{nama_toko}} di wilayah {{area}}, kami ingin mengkonfirmasi apakah pada bulan {{bulan}} atau 3 sudah mendapatkan 2pcs Crispy Balls gratis dari aice? Mohon konfirmasinya, terima kasih.`,
  ],
}

function pickTemplate(type: string, exclude: string[] = []): string {
  const pool = DEFAULT_TEMPLATES[type] ?? DEFAULT_TEMPLATES["STIK"]
  const fresh = pool.filter((t) => !exclude.includes(t))
  const src = fresh.length > 0 ? fresh : pool
  return src[Math.floor(Math.random() * src.length)]
}

const MAX_VARIANTS = 5

type CampaignType = "STIK" | "KARDUS" | "YOYIC" | "CRISPY_BALLS"

interface AreaItem {
  id: string
  name: string
  contactType: string
  _count?: { contacts: number }
  validContacts?: number
}

interface DeptWithAreas {
  id: string
  name: string
  areas: AreaItem[]
}

const TYPE_BADGE: Record<string, string> = {
  STIK: "bg-blue-100 text-blue-700",
  KARDUS: "bg-orange-100 text-orange-700",
  YOYIC: "bg-green-100 text-green-700",
  CRISPY_BALLS: "bg-purple-100 text-purple-700",
}

const MONTHS = [
  "JANUARI",
  "FEBRUARI",
  "MARET",
  "APRIL",
  "MEI",
  "JUNI",
  "JULI",
  "AGUSTUS",
  "SEPTEMBER",
  "OKTOBER",
  "NOVEMBER",
  "DESEMBER",
] as const

const CURRENT_YEAR = new Date().getFullYear()

// Mirrors backend default namePattern "{area} {type} - {bulan} {tahun}" (uppercased)
// e.g. "GROBONGAN KARDUS - SEPTEMBER 2026". Stored `bulan` stays numeric ("9").
function bulkName(area: string, type: string, monthWord: string, year: string): string {
  return `${area} ${type} - ${monthWord || "{bulan}"} ${year}`.toUpperCase()
}

export default function NewBulkCampaign() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [month, setMonth] = useState<number>(() => new Date().getMonth() + 1)
  const [year, setYear] = useState<string>(() => String(CURRENT_YEAR))
  const tahun = String(parseInt(year) || CURRENT_YEAR)
  const bulan = String(month) // numeric — stored as-is in DB
  const monthWord = MONTHS[month - 1] ?? ""
  const [campaignType, setCampaignType] = useState<CampaignType>("STIK")
  const [templates, setTemplates] = useState<string[]>(() => [...DEFAULT_TEMPLATES["STIK"]])
  const [templatesEdited, setTemplatesEdited] = useState(false)
  const [targetReplies, setTargetReplies] = useState<string>("")
  const [replyRate, setReplyRate] = useState<string>("")
  const [targetReplyMode, setTargetReplyMode] = useState<"ALL" | "YES" | "YES_NO">("YES")
  const [config, setConfig] = useState<AppConfigData | null>(null)

  const [allDepts, setAllDepts] = useState<DeptWithAreas[]>([])
  const [selectedAreas, setSelectedAreas] = useState<Set<string>>(new Set())
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set())

  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const { data: configData } = useQuery<AppConfigData>({
    queryKey: ["config"],
    queryFn: () => apiFetch<AppConfigData>("/api/config"),
  })

  const { data: areasData = [] } = useQuery<DeptWithAreas[]>({
    queryKey: ["files-areas"],
    queryFn: () => apiFetch<DeptWithAreas[]>("/api/files/areas"),
  })

  useEffect(() => {
    if (configData) setConfig(configData)
  }, [configData])
  useEffect(() => {
    if (areasData.length > 0) {
      setAllDepts(areasData)
      setExpandedDepts(new Set(areasData.map((d) => d.id)))
    }
  }, [areasData])

  const bulkMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<BulkCreateCampaignResult>("/api/campaigns/bulk", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] })
      if (result.warnings.length > 0) {
        setWarnings(result.warnings)
        setError(null)
      }
      navigate("/campaigns")
    },
    onError: (e) => setError(String(e)),
  })

  const depts = allDepts
    .map((d) => ({
      ...d,
      areas: d.areas.filter((a) => a.contactType === campaignType),
    }))
    .filter((d) => d.areas.length > 0)

  const handleTypeChange = useCallback(
    (t: CampaignType) => {
      setCampaignType(t)
      setSelectedAreas(new Set())
      if (!templatesEdited) setTemplates([...(DEFAULT_TEMPLATES[t] ?? DEFAULT_TEMPLATES["STIK"])])
    },
    [templatesEdited],
  )

  function updateVariant(i: number, value: string) {
    setTemplates((prev) => prev.map((t, idx) => (idx === i ? value : t)))
    setTemplatesEdited(true)
  }

  function rerollVariant(i: number) {
    setTemplates((prev) =>
      prev.map((t, idx) => (idx === i ? pickTemplate(campaignType, prev) : t)),
    )
  }

  function addVariant() {
    setTemplates((prev) =>
      prev.length >= MAX_VARIANTS ? prev : [...prev, pickTemplate(campaignType, prev)],
    )
    setTemplatesEdited(true)
  }

  function removeVariant(i: number) {
    setTemplates((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)))
    setTemplatesEdited(true)
  }

  function toggleArea(areaId: string) {
    setSelectedAreas((prev) => {
      const next = new Set(prev)
      if (next.has(areaId)) next.delete(areaId)
      else next.add(areaId)
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

  const preview = useMemo(() => {
    const rows: { areaId: string; dept: string; area: string; name: string; total: number; valid: number }[] = []
    for (const d of depts) {
      for (const a of d.areas) {
        if (selectedAreas.has(a.id)) {
          rows.push({
            areaId: a.id,
            dept: d.name,
            area: a.name,
            name: bulkName(a.name, campaignType, monthWord, tahun),
            total: a._count?.contacts ?? 0,
            valid: a.validContacts ?? 0,
          })
        }
      }
    }
    return rows
  }, [depts, selectedAreas, month, year, campaignType])

  const effectiveTarget =
    parseInt(targetReplies) || config?.defaultTargetRepliesPerArea || 20
  const effectiveRate =
    parseFloat(replyRate) / 100 || config?.defaultExpectedReplyRate || 0.5
  const sendPerArea = Math.ceil(effectiveTarget / effectiveRate)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const cleanTemplates = templates.map((t) => t.trim()).filter((t) => t.length > 0)
    if (cleanTemplates.length === 0 || selectedAreas.size === 0) {
      setError("At least one template variant and at least one area are required")
      return
    }
    setError(null)
    setWarnings([])
    bulkMutation.mutate({
      bulan,
      tahun,
      campaignType,
      areaIds: Array.from(selectedAreas),
      templates: cleanTemplates,
      ...(targetReplies && { targetRepliesPerArea: parseInt(targetReplies) }),
      ...(replyRate && { expectedReplyRate: parseFloat(replyRate) / 100 }),
      ...(targetReplyMode !== "ALL" && { targetReplyMode }),
    })
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">New Campaign</h2>
        <p className="text-muted-foreground">
          Select areas, input month — creates 1 campaign per area
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 px-4 py-3 text-sm">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}

        {/* Bulan + tahun (shared for all) */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="bulk-month" className="text-sm font-medium">
              Bulan — shared for all campaigns
            </label>
            <select
              id="bulk-month"
              value={month}
              onChange={(e) => setMonth(parseInt(e.target.value) || 1)}
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {i + 1} - {m}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="bulk-year" className="text-sm font-medium">
              Tahun
            </label>
            <input
              id="bulk-year"
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder={String(CURRENT_YEAR)}
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
            />
          </div>
        </div>

        {/* Campaign type */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Campaign type</p>
          <div className="flex gap-3">
            {(["STIK", "KARDUS", "YOYIC", "CRISPY_BALLS"] as CampaignType[]).map((t) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="campaignType"
                  value={t}
                  checked={campaignType === t}
                  onChange={() => handleTypeChange(t)}
                />
                <span className={`text-sm px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE[t]}`}>
                  {t}
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Only areas imported as {campaignType} will be shown below.
          </p>
        </div>

        {/* Templates (shared) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">
              Message templates — shared for all ({templates.length})
            </label>
            <button
              type="button"
              onClick={addVariant}
              disabled={templates.length >= MAX_VARIANTS}
              className="text-xs text-muted-foreground hover:text-foreground border rounded px-2 py-0.5 disabled:opacity-40"
              title={`Add a variant (max ${MAX_VARIANTS})`}
            >
              + Add variant
            </button>
          </div>
          {templates.map((t, i) => (
            <div key={i} className="space-y-1.5 rounded-md border p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Variant {i + 1}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => rerollVariant(i)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title="Replace with a different default variant"
                  >
                    ↺ Re-roll
                  </button>
                  {templates.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeVariant(i)}
                      className="text-xs text-destructive/70 hover:text-destructive"
                      title="Remove this variant"
                    >
                      ✕ Remove
                    </button>
                  )}
                </div>
              </div>
              <textarea
                id={`bulk-template-${i}`}
                value={t}
                onChange={(e) => updateVariant(i, e.target.value)}
                rows={4}
                className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono resize-y"
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Variables: {"{{nama_toko}}"} {"{{bulan}}"} {"{{department}}"}{" "}
            {"{{area}}"} {"{{tipe}}"}
          </p>
        </div>

        {/* Target areas */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Target areas ({campaignType})</p>
            {selectedAreas.size > 0 && (
              <span className="text-xs text-primary font-medium">
                {selectedAreas.size} selected → {selectedAreas.size} campaigns
              </span>
            )}
          </div>
          {depts.length === 0 ? (
            <div className="rounded-lg border px-4 py-6 text-sm text-muted-foreground text-center">
              No {campaignType} areas imported — import contacts first
            </div>
          ) : (
            <div className="rounded-lg border divide-y max-h-80 overflow-y-auto">
              {depts.map((dept) => {
                const allSel =
                  dept.areas.length > 0 &&
                  dept.areas.every((a) => selectedAreas.has(a.id))
                const someSel = dept.areas.some((a) => selectedAreas.has(a.id))
                const expanded = expandedDepts.has(dept.id)
                return (
                  <div key={dept.id}>
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/50">
                      <input
                        type="checkbox"
                        checked={allSel}
                        ref={(el) => {
                          if (el) el.indeterminate = someSel && !allSel
                        }}
                        onChange={() => toggleDept(dept)}
                        className="rounded"
                      />
                      <button
                        type="button"
                        onClick={() => toggleExpand(dept.id)}
                        className="flex-1 flex items-center gap-2 text-left"
                      >
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          {dept.name}
                        </span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {dept.areas.filter((a) => selectedAreas.has(a.id)).length}
                          /{dept.areas.length}
                        </span>
                        <span className="text-xs">{expanded ? "▲" : "▼"}</span>
                      </button>
                    </div>
                    {expanded &&
                      dept.areas.map((area) => (
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
                          <span className="text-xs text-muted-foreground ml-auto">
                            {area._count?.contacts ?? 0} total ·{" "}
                            {area.validContacts ?? 0} valid
                          </span>
                        </label>
                      ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Preview */}
        {preview.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              Preview — {preview.length} campaign{preview.length > 1 ? "s" : ""} will be created
            </p>
            <div className="rounded-lg border divide-y max-h-60 overflow-y-auto">
              {preview.map((r) => (
                <div key={r.areaId} className="px-3 py-2">
                  <div className="text-sm font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.dept} · {r.total} total · {r.valid} valid contacts
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Name format: {"{Area} {Type} - {Bulan} {Tahun}"} (uppercase), bulan tersimpan sebagai angka
            </p>
          </div>
        )}

        {/* Send configuration (shared) */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
          <p className="text-sm font-semibold">Send Configuration — shared for all</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="bulk-target-replies"
                className="text-xs font-medium text-muted-foreground"
              >
                Target replies per area
              </label>
              <input
                id="bulk-target-replies"
                type="number"
                min={1}
                value={targetReplies}
                onChange={(e) => setTargetReplies(e.target.value)}
                placeholder={String(config?.defaultTargetRepliesPerArea ?? 20)}
                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="bulk-reply-rate"
                className="text-xs font-medium text-muted-foreground"
              >
                Expected reply rate (%)
              </label>
              <input
                id="bulk-reply-rate"
                type="number"
                min={1}
                max={100}
                value={replyRate}
                onChange={(e) => setReplyRate(e.target.value)}
                placeholder={String(
                  Math.round((config?.defaultExpectedReplyRate ?? 0.5) * 100),
                )}
                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
              />
            </div>
          </div>
          <div className="text-sm text-muted-foreground bg-background rounded border px-3 py-2">
            Messages to send per area:{" "}
            <span className="font-semibold text-foreground">{sendPerArea}</span>{" "}
            = ceil({effectiveTarget} ÷ {Math.round(effectiveRate * 100)}%)
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Which replies count toward the target?
            </p>
            <div className="flex flex-col gap-2">
              {(
                [
                  { value: "ALL", label: "Any reply", desc: "Every reply counts, regardless of YES/NO" },
                  { value: "YES", label: "Only YES", desc: "Only replies classified as YES (jawaban = 1)" },
                  { value: "YES_NO", label: "YES or NO", desc: "Replies YES or NO — excludes unclear/null" },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                    targetReplyMode === opt.value
                      ? "border-primary bg-primary/5"
                      : "hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="targetReplyMode"
                    value={opt.value}
                    checked={targetReplyMode === opt.value}
                    onChange={() => setTargetReplyMode(opt.value)}
                    className="mt-1"
                  />
                  <span className="text-sm">
                    <span className="font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {opt.desc}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={bulkMutation.isPending}
            className="bg-primary text-primary-foreground text-sm px-5 py-2 rounded-md disabled:opacity-50"
          >
            {bulkMutation.isPending
              ? "Creating…"
              : preview.length > 0
                ? `Create ${preview.length} Campaigns`
                : "Create Campaigns"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/campaigns")}
            className="text-sm px-5 py-2 rounded-md border"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
