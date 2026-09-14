import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'out',
		'.perf/**',
		'vendor/**',
		'esbuild.config.mjs',
		'scripts/*.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		// test/ 是浏览器探针与 node runner，不参与插件打包；
		// 探针里的夹具样式/HTML 不守插件规则，纳入 lint 只会淹掉真错误。
		'test/**',
		'src/foliate-js.d.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	// 上架检查跑的是它自己的一套规则集，核心是 obsidianmd recommended +
	// no-unsanitized。@typescript-eslint 的类型严格类规则官方**不检查**，
	// 本仓 0.2.x 存量代码大量依赖断言压 foliate 的弱类型，全修会引爆回归面，
	// 所以降为 warn：CI 绿线只钉官方会拒的那些。
	{
		rules: {
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-argument': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
			'@typescript-eslint/no-floating-promises': 'warn',
			'@typescript-eslint/no-misused-promises': 'warn',
			'@typescript-eslint/no-base-to-string': 'warn',
			'@typescript-eslint/unbound-method': 'warn',
			'@typescript-eslint/no-require-imports': 'warn',
			'@typescript-eslint/no-deprecated': 'warn',
			'no-alert': 'warn',
			'no-irregular-whitespace': ['error', { skipComments: true }],
		},
	},
);