declare module "ENV_DEST" {
	export function env(key: string, fallback?: any): string;
}

declare module "MANIFEST_DEST" {
	import { SSRManifest } from "@sveltejs/kit";
	export const base: string;
	export const manifest: SSRManifest;
	export const prerendered: Set<string>;
}

declare module "SERVER_DEST" {
	export { Server } from "@sveltejs/kit";
}

declare namespace App {
	export interface Platform {
		req: import("http").IncomingMessage;
	}
}
