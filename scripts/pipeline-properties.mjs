// Property roster for scripts/import-from-pipeline.mjs, loaded from a machine-local file.
//
// The repository is public, so the owned-property roster (street addresses) and the list of
// pipeline labels that must never be imported (with the reason each is excluded) live in a
// gitignored file, never in source:
//
//   scripts/pipeline-properties.local.json            (gitignored; the real roster)
//   scripts/pipeline-properties.example.json          (committed; synthetic values, shape only)
//
// Copy the example to the .local.json name and fill it from the firm's source of record. The
// importer fails closed when the local file is missing, unreadable or malformed, and it rejects
// the committed example and Example/Sample values (any `_example` key; Example/Sample in a name,
// address or city; zip 00000). That is all it checks: it does not prove a roster is real.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_PROPERTIES_PATH = join(here, 'pipeline-properties.local.json')
export const EXAMPLE_PROPERTIES_PATH = join(here, 'pipeline-properties.example.json')

// Exactly the `properties` columns the importer inserts (total_sf is computed from the rent roll).
const META_KEYS = ['name', 'address', 'city', 'state', 'zip', 'property_type', 'entity_llc']

// Values the committed example uses; a real roster never contains them.
const SYNTHETIC = /\b(Example|Sample)\b/i

export class PropertyConfigError extends Error {}

function fail(path, why) {
  throw new PropertyConfigError(`property roster ${path}: ${why}`)
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * Validate a parsed roster object. Returns { PROPERTY_META, EXCLUDE } where EXCLUDE is a
 * Map(label -> reason). Throws PropertyConfigError on any shape problem.
 */
export function parsePropertyConfig(cfg, path = '<inline>', { allowExample = false } = {}) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) fail(path, 'must be a JSON object')
  // Any `_example` key, whatever its value, marks the committed example; a copy with the key
  // deleted is still caught by the synthetic-value check below.
  if (Object.prototype.hasOwnProperty.call(cfg, '_example') && !allowExample) {
    fail(path, 'is the committed example (synthetic values, "_example" key present); create the local roster instead')
  }
  const { properties, exclude = {} } = cfg
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    fail(path, '"properties" must be an object keyed by pipeline label')
  }
  if (Object.keys(properties).length === 0) fail(path, '"properties" is empty')

  const PROPERTY_META = {}
  for (const [label, meta] of Object.entries(properties)) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) fail(path, `"${label}" must be an object`)
    const extra = Object.keys(meta).filter((k) => !META_KEYS.includes(k))
    if (extra.length) fail(path, `"${label}" has unknown key(s) ${extra.join(', ')} (allowed: ${META_KEYS.join(', ')})`)
    for (const k of ['name', 'address', 'city', 'property_type']) {
      if (!isNonEmptyString(meta[k])) fail(path, `"${label}".${k} must be a non-empty string`)
    }
    if (typeof meta.state !== 'string' || !/^[A-Z]{2}$/.test(meta.state)) fail(path, `"${label}".state must be a 2-letter code`)
    if (!(meta.zip === null || meta.zip === undefined || /^\d{5}(-\d{4})?$/.test(String(meta.zip)))) {
      fail(path, `"${label}".zip must be null or a ZIP code`)
    }
    if (!(meta.entity_llc === null || meta.entity_llc === undefined || isNonEmptyString(meta.entity_llc))) {
      fail(path, `"${label}".entity_llc must be null or a non-empty string`)
    }
    if (!allowExample) {
      for (const k of ['name', 'address', 'city']) {
        if (SYNTHETIC.test(meta[k])) fail(path, `"${label}".${k} looks synthetic (Example/Sample); this is not a real roster`)
      }
      if (meta.zip === '00000') fail(path, `"${label}".zip 00000 is the example placeholder`)
    }
    PROPERTY_META[label] = { ...meta, zip: meta.zip ?? null, entity_llc: meta.entity_llc ?? null }
  }

  if (exclude === null || typeof exclude !== 'object' || Array.isArray(exclude)) {
    fail(path, '"exclude" must be an object of { "<pipeline label>": "<reason>" }')
  }
  const EXCLUDE = new Map()
  for (const [label, reason] of Object.entries(exclude)) {
    if (!isNonEmptyString(reason)) fail(path, `exclude "${label}" needs a non-empty reason`)
    if (PROPERTY_META[label]) fail(path, `"${label}" is both a property and excluded`)
    EXCLUDE.set(label, reason)
  }
  return { PROPERTY_META, EXCLUDE }
}

/** Read and validate the roster file. Throws PropertyConfigError (never falls back to anything). */
export function loadPropertyConfig(path = DEFAULT_PROPERTIES_PATH, opts = {}) {
  if (!existsSync(path)) {
    fail(
      path,
      'not found. The property roster is kept out of the public repo: copy ' +
        'scripts/pipeline-properties.example.json to scripts/pipeline-properties.local.json ' +
        '(gitignored), fill it from the firm\'s source of record, or pass --properties <path>.',
    )
  }
  let cfg
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(path, `is not readable JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  return parsePropertyConfig(cfg, path, opts)
}
