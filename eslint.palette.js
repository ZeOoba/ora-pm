// Shared by eslint.config.js and tests/config/lint-palette-rule.test.ts.
// Bans raw Tailwind gray/blue/green/red palette utilities in src/ - use design tokens instead
// (bg-muted, text-muted-foreground, border-border, bg-primary, ...). See docs/design-system.md.
// Matches a utility at a class boundary (start, whitespace, or after a variant colon) so that
// e.g. "text-grayscale" does not trip it. Covers string literals and template-literal chunks,
// which includes className="...", cn()/clsx() string args, ternaries and class maps.
const RE = String.raw`(^|[\s:!])(bg|text|border|border-[tblrxyse]|divide|ring)-(gray|blue|green|red)-\d`

const MESSAGE =
  'Raw gray/blue/green/red palette classes are banned in src/. Use design tokens: bg-muted, text-muted-foreground, border-border, bg-primary, text-primary, text-status-active, text-status-danger, etc. (docs/design-system.md).'

export const PALETTE_RESTRICTED_SYNTAX = [
  { selector: `Literal[value=/${RE}/]`, message: MESSAGE },
  { selector: `TemplateElement[value.raw=/${RE}/]`, message: MESSAGE },
]
