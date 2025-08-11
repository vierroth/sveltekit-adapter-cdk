import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	clearScreen: false,
	plugins: [sveltekit()],
	server: {
		strictPort: true,
		host: false,
		port: 5173,
	},
});
