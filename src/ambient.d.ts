declare module "ENV_DEST" {
	export function env(key: string, fallback?: any): string;
}

declare module "MANIFEST_DEST" {
	export const base: string;
	export const appPath: string;
	export const assets: string[];
	export const prerendered: Set<string>;
}

declare module "SERVER_DEST" {
	export const server: import("@sveltejs/kit").Server;
}

declare namespace App {
	export interface Platform {
		req: import("http").IncomingMessage;
	}
}
