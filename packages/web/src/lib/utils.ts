import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const json = await apiFetchEnvelope<T>(path, init)
  return json.data
}

// Same as apiFetch, but keeps top-level envelope fields (pagination meta,
// aggregate stats, facets) next to `data`.
export async function apiFetchEnvelope<T, M = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T } & M> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error ?? 'API error')
  return json as { data: T } & M
}
