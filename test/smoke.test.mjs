import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

assert.equal(pkg.type, 'module', 'package.json must use ESM')
assert.equal(typeof pkg.dsh?.bundle?.patch, 'string', 'dsh.bundle.patch is required')
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform must be web')
assert.equal(pkg.exports['./client'], './client.js', 'client export is required')
assert.equal(pkg.exports['./icon'], './icon.svg', 'icon export is required')

for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
  assert.ok(pkg.files.includes(file), `${file} must be listed in package.json files`)
}
assert.ok(pkg.files.includes('locale/*.json'), 'locale files must be listed in package.json files')

// The patch row, the client module id and the package name must agree, or the
// browser factory never registers under the slot.
assert.match(patch, /name: dsh-folder-sidebar/, 'patch must insert the package name')
assert.ok(client.includes(`id: '${pkg.name}'`), 'client module id must equal the package name')
assert.ok(client.includes("name: 'sidebar.workspaces'"), 'client must register into sidebar.workspaces')

// A slot can render us while the Host reconnects and props are briefly
// incomplete. Hooks must never be called conditionally: React reports the
// changed hook count as error #300, which is what the sidebar used to show.
assert.ok(
  !/typeof props\.use(Workspaces|Sessions|SessionStatus) === 'function'\s*\?/.test(client),
  'slot hooks must not be called in a ternary (conditional hook call)',
)
const outerStart = client.indexOf('function FolderSidebar(props) {')
const outerEnd = client.indexOf('function FolderSidebarConnected(props) {')
assert.ok(outerStart > 0 && outerEnd > outerStart, 'outer and connected components must exist')
const outerBody = client.slice(outerStart, outerEnd)
for (const pattern of [/React\.use/, /useWorkspaces\(/, /useSessions\(/, /useSessionStatus\(/]) {
  assert.ok(!pattern.test(outerBody), `outer FolderSidebar must not call hooks (${pattern})`)
}
assert.ok(
  /useWorkspaces\(\(state\) => state\.items\)/.test(client),
  'the connected component must call the slot hooks unconditionally',
)

// The narrow layout ("rail") returns early; a hook after that return makes the
// count differ between wide and narrow renders (mobile expand/collapse), which
// React reports as error #310.
const lines = client.split('\n')
const narrowLine = lines.findIndex((line) => line.trim().startsWith('if (!wide) {'))
assert.ok(narrowLine > 0, 'the narrow-layout branch must exist')
const lateHooks = lines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => /^\s+(React\.use[A-Za-z]+\(|useWorkspaces\(|useSessions\(|useSessionStatus\()/.test(line))
  .filter(({ index }) => index > narrowLine)
assert.deepEqual(
  lateHooks.map(({ index }) => index + 1),
  [],
  'no hook may be called after the narrow-layout early return',
)

// Display metadata is what the Plugin Manager and Settings list show.
for (const [locale, dict] of [['zh', zh], ['en', en]]) {
  assert.equal(typeof dict.meta?.title, 'string', `${locale}: meta.title is required`)
  assert.equal(typeof dict.meta?.description, 'string', `${locale}: meta.description is required`)
  assert.ok(dict.meta.title !== 'Plugin Template', `${locale}: title must not be template copy`)
}

console.log('folder-sidebar manifest OK')
