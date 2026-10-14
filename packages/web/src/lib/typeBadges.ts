import type { ContactType } from '@aice/shared'

// Web bundles resolve @aice/shared to its CJS build, which Rollup cannot named-import,
// so the option list is mirrored here instead of imported at runtime.
// Keep in sync with CONTACT_TYPES in @aice/shared — the guard below fails the build otherwise.
export const CONTACT_TYPE_OPTIONS = [
  'STIK',
  'KARDUS',
  'YOYIC',
  'CRISPY_BALLS',
  'NON_EVENT',
] as const satisfies readonly ContactType[]

// Compile-time guard: every ContactType from @aice/shared must be listed above.
type MissingContactType = Exclude<ContactType, (typeof CONTACT_TYPE_OPTIONS)[number]>
export type AssertAllContactTypesListed = MissingContactType extends never ? true : never

// Central badge colours for contact/campaign types.
export const TYPE_BADGE: Record<string, string> = {
  STIK:         'bg-blue-100 text-blue-700',
  KARDUS:       'bg-orange-100 text-orange-700',
  YOYIC:        'bg-green-100 text-green-700',
  CRISPY_BALLS: 'bg-purple-100 text-purple-700',
  NON_EVENT:    'bg-slate-200 text-slate-700',
}
