import adapterCdk from "@flit/sveltekit-adapter-cdk";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
	preprocess: vitePreprocess(),
	kit: {
		outDir: "dist/.svelte-kit",
		adapter: adapterCdk({ out: "./dist/cdk" }),
	},
};
