export type FileValidation = { ok: true } | { ok: false; error: string }

export function validateFile(
  file: { name: string; type: string; size: number },
  opts: { accept: string[]; maxBytes: number },
): FileValidation {
  if (opts.accept.length && !opts.accept.includes(file.type)) {
    return { ok: false, error: `Unsupported file type. Accepted: ${opts.accept.join(', ')}` }
  }
  if (file.size > opts.maxBytes) {
    return { ok: false, error: `File too large (max ${Math.round(opts.maxBytes / 1024 / 1024)} MB)` }
  }
  return { ok: true }
}
