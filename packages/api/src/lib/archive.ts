import archiver from 'archiver'

export interface ArchivePhoto {
  archivePath: string
  absPath: string
}

/**
 * Build a ZIP buffer containing an xlsx report at the root plus photo files
 * (renamed on the fly — disk files are never modified).
 */
export async function buildReportZip(
  xlsxBuffer: Buffer,
  xlsxName: string,
  photos: ArchivePhoto[],
): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 9 } })

  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on('error', reject)
    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
  })

  archive.append(xlsxBuffer, { name: xlsxName })

  // Dedupe by archive path (dept export can revisit the same campaign)
  const seen = new Set<string>()
  for (const photo of photos) {
    if (seen.has(photo.archivePath)) continue
    seen.add(photo.archivePath)
    archive.file(photo.absPath, { name: photo.archivePath })
  }

  await archive.finalize()
  return done
}
