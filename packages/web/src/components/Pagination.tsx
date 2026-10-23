// ─── Shared pagination controls ───────────────────────────────────────────────

interface PaginationProps {
  page:      number
  pages:     number
  total:     number
  limit:     number
  onPageChange: (page: number) => void
  itemLabel?:   string
}

function pageWindow(page: number, pages: number): Array<number | '…'> {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, i) => i + 1)
  }

  const wanted = new Set([1, pages, page - 1, page, page + 1])
  const visible = [...wanted].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b)

  const out: Array<number | '…'> = []
  for (let i = 0; i < visible.length; i++) {
    if (i > 0 && visible[i] - visible[i - 1] > 1) out.push('…')
    out.push(visible[i])
  }
  return out
}

export default function Pagination({
  page,
  pages,
  total,
  limit,
  onPageChange,
  itemLabel = 'items',
}: PaginationProps) {
  if (pages <= 1) return null

  const start = total === 0 ? 0 : (page - 1) * limit + 1
  const end   = Math.min(page * limit, total)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>
        {start}–{end} of {total} {itemLabel}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="px-3 py-1 rounded-md border disabled:opacity-40 hover:bg-accent"
        >
          ‹ Prev
        </button>
        {pageWindow(page, pages).map((p, i, all) =>
          p === '…' ? (
            <span key={`gap-${all[i - 1]}`} className="px-1">…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`px-3 py-1 rounded-md border hover:bg-accent ${
                p === page ? 'bg-accent font-medium text-foreground' : ''
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPageChange(Math.min(pages, page + 1))}
          disabled={page >= pages}
          className="px-3 py-1 rounded-md border disabled:opacity-40 hover:bg-accent"
        >
          Next ›
        </button>
      </div>
    </div>
  )
}
