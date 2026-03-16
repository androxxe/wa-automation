import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/utils'
import type { ContactTypeTree, ColumnMapping, ParsedSheet } from '@aice/shared'

type ImportStep = 'scan' | 'parse' | 'mapping' | 'done'

interface ImportState {
  step:              ImportStep
  selectedFile?:     { deptName: string; areaName: string; filePath: string; contactType: string }
  parsed?:           ParsedSheet
  confirmedMapping?: ColumnMapping
  result?:           { imported: number; invalid: number; duplicates: number }
}

const TYPE_BADGE: Record<string, string> = {
  STIK:   'bg-blue-100 text-blue-700',
  KARDUS: 'bg-orange-100 text-orange-700',
}

export default function Import() {
  const [tree, setTree]     = useState<ContactTypeTree[]>([])
  const [state, setState]   = useState<ImportState>({ step: 'scan' })
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    apiFetch<ContactTypeTree[]>('/api/files/scan')
      .then(setTree)
      .catch((e) => setError(String(e)))
  }, [])

  async function handleSelectFile(
    deptName:    string,
    areaName:    string,
    filePath:    string,
    contactType: string,
  ) {
    setLoading(true)
    setError(null)
    try {
      const parsed = await apiFetch<ParsedSheet>('/api/files/parse', {
        method: 'POST',
        body:   JSON.stringify({ filePath }),
      })
      setState({ step: 'parse', selectedFile: { deptName, areaName, filePath, contactType }, parsed })
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }

  async function handleSuggestMapping() {
    if (!state.parsed || !state.selectedFile) return
    setLoading(true)
    try {
      const mapping = await apiFetch<ColumnMapping>('/api/analyze/headers', {
        method: 'POST',
        body:   JSON.stringify({ headers: state.parsed.headers, sampleRows: state.parsed.sampleRows }),
      })
      setState((s) => ({ ...s, step: 'mapping', confirmedMapping: mapping }))
    } catch (e) { setError(String(e)) }
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
          body:   JSON.stringify({
            filePath:       state.selectedFile.filePath,
            departmentName: state.selectedFile.deptName,
            areaName:       state.selectedFile.areaName,
            contactType:    state.selectedFile.contactType,
            mapping:        state.confirmedMapping,
          }),
        },
      )
      setState((s) => ({ ...s, step: 'done', result }))
    } catch (e) { setError(String(e)) }
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

      {/* 3-level file tree: Type → Dept → Area */}
      {state.step === 'scan' && (
        <div className="rounded-lg border divide-y">
          {tree.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No xlsx files found in DATA_FOLDER
            </p>
          )}
          {tree.map((typeNode) => (
            <div key={typeNode.contactType}>
              {/* Type header */}
              <div className="px-4 py-2 bg-muted/80 flex items-center gap-2">
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${TYPE_BADGE[typeNode.contactType] ?? 'bg-gray-100'}`}>
                  {typeNode.contactType}
                </span>
              </div>

              {typeNode.departments.map((dept) => (
                <div key={dept.name}>
                  <p className="px-6 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/40">
                    {dept.name}
                  </p>
                  {dept.areas.map((area) => (
                    <button
                      key={area.filePath}
                      type="button"
                      onClick={() => handleSelectFile(dept.name, area.name, area.filePath, typeNode.contactType)}
                      disabled={loading}
                      className="w-full text-left px-10 py-2.5 text-sm hover:bg-accent transition-colors flex justify-between items-center"
                    >
                      <span>{area.name}</span>
                      <span className="text-xs text-muted-foreground">{area.fileName}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Parse result */}
      {state.step === 'parse' && state.parsed && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{state.selectedFile?.areaName}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE[state.selectedFile?.contactType ?? ''] ?? 'bg-gray-100'}`}>
                {state.selectedFile?.contactType}
              </span>
            </div>
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
            {loading ? 'Asking Claude…' : 'Suggest Column Mapping with Claude'}
          </button>
        </div>
      )}

      {/* Mapping confirmation */}
      {state.step === 'mapping' && state.confirmedMapping && (
        <div className="space-y-4">
          {/* File summary */}
          <div className="rounded-lg border p-4 space-y-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{state.selectedFile?.areaName}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE[state.selectedFile?.contactType ?? ''] ?? 'bg-gray-100'}`}>
                {state.selectedFile?.contactType}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {state.selectedFile?.deptName}
            </p>
            <p className="text-sm font-semibold">
              {state.parsed?.totalRows ?? 0} rows to import
            </p>
          </div>

          {/* Sample data preview */}
          {state.parsed && state.parsed.sampleRows.length > 0 && (() => {
            const mappedCols = Object.entries(state.confirmedMapping!).filter(([, h]) => h !== null) as [string, string][]
            return (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Sample rows (first {state.parsed.sampleRows.length})</p>
                <div className="rounded-lg border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50">
                        {mappedCols.map(([field]) => (
                          <th key={field} className="text-left font-mono font-medium px-3 py-2 whitespace-nowrap text-muted-foreground">
                            {field}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {state.parsed.sampleRows.map((row) => (
                        <tr key={JSON.stringify(row)}>
                          {mappedCols.map(([field, header]) => (
                            <td key={field} className="px-3 py-2 whitespace-nowrap">
                              {String(row[header] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

          {/* Column mapping table */}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Column mapping</p>
            <div className="rounded-lg border divide-y">
              {Object.entries(state.confirmedMapping).map(([field, header]) => (
                <div key={field} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-xs font-mono w-32 text-muted-foreground">{field}</span>
                  <span className="text-sm flex-1">{header ?? <span className="text-muted-foreground italic">(not mapped)</span>}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={handleImport}
            disabled={loading}
            className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md disabled:opacity-50"
          >
            {loading ? 'Importing…' : 'Confirm and Import'}
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
