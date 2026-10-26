import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		include: ['test/order.spec.js', 'test/migration.spec.js'],
		testTimeout: 30000,
		hookTimeout: 30000,
		poolOptions: {
			workers: {
				isolatedStorage: true,
				singleWorker: true,
				wrangler: { configPath: './test/wrangler.local.toml' },
			},
		},
	},
});
