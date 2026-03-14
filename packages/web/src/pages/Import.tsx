import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/utils'
import type { DepartmentTree, ColumnMapping, ParsedSheet } from '@aice/shared'

type ImportStep = 'scan' | 'parse' | 'mapping' | 'confirm' | 'done'

interface ImportState {
  step: ImportStep
  selectedFile?: { deptName: string; areaName: string; filePath: string }
  parsed?: ParsedSheet
  suggestedMapping?: ColumnMapping
  confirmedMapping?: ColumnMapping
  result?: { imported: number; invalid: number; duplicates: number }
}

export default function Import() {
  const [tree, setTree] = useState<DepartmentTree[]>([])
  const [state, setState] = useState<ImportState>({ step: 'scan' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<DepartmentTree[]>('/api/files/scan')
      .then(setTree)
      .catch((e) => setError(String(e)))
  }, [])

  async function handleSelectFile(deptName: string, areaName: string, filePath: string) {
    setLoading(true)
    setError(null)
    try {
      const parsed = await apiFetch<ParsedSheet>('/api/files/parse', {
        method: 'POST',
        body: JSON.stringify({ filePath }),
      })
      setState({ step: 'parse', selectedFile: { deptName, areaName, filePath }, parsed })
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  async function handleSuggestMapping() {
    if (!state.parsed || !state.selectedFile) return
    setLoading(true)
    try {
      const mapping = await apiFetch<ColumnMapping>('/api/analyze/headers', {
        method: 'POST',
        body: JSON.stringify({ headers: state.parsed.headers, sampleRows: state.parsed.sampleRows }),
      })
      setState((s) => ({ ...s, step: 'mapping', suggestedMapping: mapping, confirmedMapping: mapping }))
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  async function handleImport() {
    if (!state.selectedFile || !state.confirmedMapping) return
    setLoading(true)
    try {
      const result = await apiFetch<{ imported: number; invalid: number; duplicates: number }>(
        '/api/files/import',
        {
          method: 'POST',
          body: JSON.stringify({
            filePath: state.selectedFile.filePath,
            departmentName: state.selectedFile.deptName,
            areaName: state.selectedFile.areaName,
            mapping: state.confirmedMapping,
          }),
        },
      )
      setState((s) => ({ ...s, step: 'done', result }))
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Import Contacts</h2>
        <p className="text-muted-foreground">Select an xlsx file and confirm the column mapping</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* File tree */}
      {state.step === 'scan' && (
        <div className="rounded-lg border divide-y">
          {tree.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No xlsx files found in DATA_FOLDER
            </p>
          )}
          {tree.map((dept) => (
            <div key={dept.name}>
              <p className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted">
                {dept.name}
              </p>
              {dept.areas.map((area) => (
                <button
                  key={area.filePath}
                  type="button"
                  onClick={() => handleSelectFile(dept.name, area.name, area.filePath)}
                  disabled={loading}
                  className="w-full text-left px-6 py-2.5 text-sm hover:bg-accent transition-colors flex justify-between items-center"
                >
                  <span>{area.name}</span>
                  <span className="text-xs text-muted-foreground">{area.fileName}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Parse result */}
      {state.step === 'parse' && state.parsed && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <p className="text-sm font-medium">{state.selectedFile?.areaName}</p>
            <p className="text-xs text-muted-foreground">
              {state.parsed.totalRows} rows — {state.parsed.headers.length} columns
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {state.parsed.headers.map((h) => (
                <span key={h} className="text-xs bg-muted px-2 py-0.5 rounded">{h}</span>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={handleSuggestMapping}
            disabled={loading}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {loading ? 'Asking Claude...' : 'Suggest Column Mapping with Claude'}
          </button>
        </div>
      )}

      {/* Mapping confirmation */}
      {(state.step === 'mapping' || state.step === 'confirm') && state.confirmedMapping && (
        <div className="space-y-4">
          <p className="text-sm font-medium">Confirm column mapping</p>
          <div className="rounded-lg border divide-y">
            {Object.entries(state.confirmedMapping).map(([field, header]) => (
              <div key={field} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-xs font-mono w-32 text-muted-foreground">{field}</span>
                <span className="text-sm flex-1">{header ?? '(not mapped)'}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={handleImport}
            disabled={loading}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {loading ? 'Importing...' : 'Confirm and Import'}
          </button>
        </div>
      )}

      {/* Done */}
      {state.step === 'done' && state.result && (
        <div className="rounded-lg border p-6 space-y-3 bg-card">
          <p className="font-semibold">Import complete</p>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-green-600">{state.result.imported}</p>
              <p className="text-xs text-muted-foreground">Imported</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-500">{state.result.invalid}</p>
              <p className="text-xs text-muted-foreground">Invalid phones</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-500">{state.result.duplicates}</p>
              <p className="text-xs text-muted-foreground">Duplicates</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setState({ step: 'scan' })}
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            Import another file
          </button>
        </div>
      )}
    </div>
  )
}
