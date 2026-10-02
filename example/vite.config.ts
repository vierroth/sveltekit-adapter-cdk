import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import adapterCdk from "@flit/sveltekit-adapter-cdk";

export default defineConfig({
	clearScreen: false,
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			outDir: "dist/.svelte-kit",
			adapter: adapterCdk({ out: "./dist/cdk" }),
		}),
	],
	server: {
		strictPort: true,
		host: false,
		port: 5173,
	},
});
