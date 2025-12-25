import { Adapter } from "@sveltejs/kit";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";

export interface AdapterProps {
	out?: string;
	precompress?: boolean;
	envPrefix?: string;
}

export default function (props: AdapterProps) {
	const { out = "./dist", precompress = false, envPrefix = "" } = props;

	return {
		name: "@flit/sveltekit-adapter-cdk",
		supports: {
			instrumentation: () => true,
		},
		async adapt(builder) {
			const tmp = builder.getBuildDirectory("adapter-cdk");

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor("Copying assets");
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(
				`${out}/prerendered${builder.config.kit.paths.base}`,
			);

			if (precompress) {
				builder.log.minor("Compressing assets");
				await Promise.all([
					builder.compress(`${out}/client`),
					builder.compress(`${out}/prerendered`),
				]);
			}

			builder.log.minor("Building server");
			builder.writeServer(`${out}/server`);

			if (builder.hasServerInstrumentationFile()) {
				builder.log.minor("Wiring server instrumentation");

				builder.instrument({
					entrypoint: `${out}/server/index.js`,
					instrumentation: `${out}/server/instrumentation.server.js`,
					module: { exports: ["Server"] },
				});
			}

			writeFileSync(
				`${out}/server/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({
						relativePath: "./",
					})};`,
					`export const prerendered = new Set(${JSON.stringify(
						builder.prerendered.paths,
					)});`,
					`export const base = ${JSON.stringify(
						builder.config.kit.paths.base,
					)};`,
				].join("\n\n"),
			);

			builder.copy(
				fileURLToPath(new URL("./handler.esm.js", import.meta.url).href),
				`${out}/server/handler.esm.js`,
				{
					replace: {
						MANIFEST_DEST: "./manifest.js",
						SERVER_DEST: "./index.js",
						ENV_PREFIX_DEST: JSON.stringify(envPrefix),
					},
				},
			);

			builder.copy(
				fileURLToPath(new URL("./edge-handler.esm.js", import.meta.url).href),
				`${out}/server/edge-handler.esm.js`,
				{
					replace: {
						MANIFEST_DEST: "./manifest.js",
						SERVER_DEST: "./index.js",
						ENV_PREFIX_DEST: JSON.stringify(envPrefix),
					},
				},
			);

			builder.copy(
				fileURLToPath(new URL("./cdk.js", import.meta.url).href),
				`${out}/index.js`,
				{
					replace: {
						MANIFEST_DEST: "./server/manifest.js",
					},
				},
			);

			builder.copy(
				fileURLToPath(new URL("./cdk.d.ts", import.meta.url).href),
				`${out}/index.d.ts`,
				{
					replace: {
						MANIFEST_DEST: "./server/manifest.js",
					},
				},
			);
		},
	} satisfies Adapter;
}
