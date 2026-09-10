// ─── Campaign template variants + body rendering ────────────────────────────
// Pure module (no DB/queue imports) so it can be unit-tested standalone.
//
// A campaign carries `template` (primary, backward compatible) plus optional
// `templateVariants` (JSON string[]). At enqueue time one variant is picked at
// random PER CONTACT, then {{variables}} are rendered. Contacts across the same
// campaign therefore receive structurally different texts.

export interface CampaignLike {
  template: string
  templateVariants: unknown
  bulan: string
  campaignType: string
}

export interface ContactLike {
  seqNo: string | null
  storeName: string
  departmentId: string
}

const BULAN_WORDS = [
  'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI',
  'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER',
] as const

/** Effective variant list: templateVariants when valid, else [template]. */
export function variantList(campaign: CampaignLike): string[] {
  const v = campaign.templateVariants
  if (Array.isArray(v)) {
    const cleaned = v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    if (cleaned.length > 0) return cleaned
  }
  return [campaign.template]
}

/** Pick one variant at random. Returns the variant + its index. */
export function pickVariant(campaign: CampaignLike): { text: string; index: number } {
  const list = variantList(campaign)
  const index = Math.floor(Math.random() * list.length)
  return { text: list[index], index }
}

export function renderTemplate(
  raw: string,
  contact: ContactLike,
  campaign: Pick<CampaignLike, 'bulan' | 'campaignType'>,
  areaName: string,
): string {
  const tipe = campaign.campaignType.charAt(0).toUpperCase() +
               campaign.campaignType.slice(1).toLowerCase()
  // Stored `bulan` is numeric ("9") — messages use the word ("September").
  // Non-numeric values (old campaigns like "Desember" / "JULI 2026") pass through.
  const bulanWord = (() => {
    const n = parseInt(campaign.bulan)
    if (!Number.isNaN(n) && n >= 1 && n <= 12) {
      const w = BULAN_WORDS[n - 1].toLowerCase()
      return w.charAt(0).toUpperCase() + w.slice(1)
    }
    return campaign.bulan
  })()
  return raw
    .replace(/\{\{no\}\}/g,          contact.seqNo ?? '')
    .replace(/\{\{nama_toko\}\}/g,   contact.storeName)
    .replace(/\{\{bulan\}\}/g,       bulanWord)
    .replace(/\{\{area\}\}/g,        areaName)
    .replace(/\{\{department\}\}/g,  contact.departmentId)
    .replace(/\{\{tipe\}\}/g,        tipe)
}

/** Pick a random variant AND render it for one contact. */
export function renderBody(
  campaign: CampaignLike,
  contact: ContactLike,
  areaName: string,
): { body: string; variantIndex: number } {
  const { text, index } = pickVariant(campaign)
  return { body: renderTemplate(text, contact, campaign, areaName), variantIndex: index }
}
