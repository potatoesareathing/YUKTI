/**
 * Catalyst CLI 1.27 Slate pack ignores .catalystignore (AppSail does not).
 * Run once after `npm i -g zcatalyst-cli` so monorepo deploys stay small:
 *   node scripts/patch-slate-pack-ignore.js
 */
const fs = require('fs')
const path = require('path')

const target = path.join(
  process.env.APPDATA || '',
  'npm',
  'node_modules',
  'zcatalyst-cli',
  'lib',
  'slate-utils.js',
)

if (!fs.existsSync(target)) {
  console.error('zcatalyst-cli not found at', target)
  process.exit(1)
}

let src = fs.readFileSync(target, 'utf8')
if (src.includes('slate pack exclude patterns')) {
  console.log('Already patched:', target)
  process.exit(0)
}

const needle = `    pack: (source) => __awaiter(void 0, void 0, void 0, function* () {
        const excludePatterns = [
            '**/.DS_Store',
            '**/.catalyst',
            '**/.vscode/**/*',
            '**/node_modules',
            \`**/\${constants_1.FILENAME.log}\`,
            \`**/\${constants_1.FILENAME.config}\`,
            \`**/\${constants_1.FILENAME.rc}\`,
            \`**/\${constants_1.FILENAME.app_config}\`,
            \`**/\${constants_1.FILENAME.catalyst_ignore}\`,
            \`**/\${constants_1.FILENAME.cli_config}\`
        ];
        const slateZip = yield fs_1.ASYNC.walk(source, {
            filter: {
                exclude: (path) => __awaiter(void 0, void 0, void 0, function* () {
                    return !!excludePatterns.find((glob) => (0, minimatch_1.default)(path.replace(source + path_1.sep, ''), glob, { dot: true }));
                }),
                excludeDir: true
            }
        });`

const replacement = `    pack: (source) => __awaiter(void 0, void 0, void 0, function* () {
        const ignoreFile = yield fs_1.ASYNC.readFile((0, path_1.join)(source, constants_1.FILENAME.catalyst_ignore));
        const excludePatterns = [
            '**/.DS_Store',
            '**/.catalyst',
            '**/.vscode/**/*',
            '**/node_modules',
            '**/.git',
            '**/.git/**',
            \`**/\${constants_1.FILENAME.log}\`,
            \`**/\${constants_1.FILENAME.config}\`,
            \`**/\${constants_1.FILENAME.rc}\`,
            \`**/\${constants_1.FILENAME.app_config}\`,
            \`**/\${constants_1.FILENAME.catalyst_ignore}\`,
            \`**/\${constants_1.FILENAME.cli_config}\`,
            ...((ignoreFile === null || ignoreFile === void 0 ? void 0 : ignoreFile.split('\\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) || [])
        ];
        (0, logger_1.debug)('slate pack exclude patterns: ' + JSON.stringify(excludePatterns));
        const slateZip = yield fs_1.ASYNC.walk(source, {
            filter: {
                exclude: (path) => __awaiter(void 0, void 0, void 0, function* () {
                    const rel = path.replace(source + path_1.sep, '').split(path_1.sep).join('/');
                    return !!excludePatterns.find((glob) => (0, minimatch_1.default)(rel, glob, { dot: true }));
                }),
                excludeDir: true
            }
        });
        (0, logger_1.debug)('slate pack file count: ' + slateZip.length);`

if (!src.includes(needle)) {
  console.error('Unexpected slate-utils.js contents; patch manually.')
  process.exit(1)
}

fs.writeFileSync(target, src.replace(needle, replacement))
console.log('Patched', target)
