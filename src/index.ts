import { Adapter } from "@sveltejs/kit";
import { readFileSync, writeFileSync } from "fs";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { fileURLToPath } from "url";
import { builtinModules } from "module";

export interface AdapterProps {
	out?: string;
	precompress?: boolean;
	envPrefix?: string;
}

export default function (props: AdapterProps) {
	const { out = "./dist", precompress = false, envPrefix = "" } = props;

	return {
		name: "@flit/sveltekit-adapter-cdk",
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

			builder.writeServer(`${tmp}/server`);
			writeFileSync(
				`${tmp}/server/manifest.js`,
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

			builder.copy(
				fileURLToPath(new URL("./handler.esm.js", import.meta.url).href),
				`${tmp}/index.esm.js`,
				{
					replace: {
						ENV_DEST: "./env.js",
						MANIFEST_DEST: "./server/manifest.js",
						SERVER_DEST: "./server/index.js",
						SHIMS_DEST: "./shims.js",
						ENV_PREFIX_DEST: JSON.stringify(envPrefix),
					},
				},
			);

			const pkg = JSON.parse(readFileSync("package.json", "utf8"));

			const bundle = await rollup({
				input: {
					"index.esm": `${tmp}/index.esm.js`,
					manifest: `${tmp}/server/manifest.js`,
				},
				external: [
					...builtinModules,
					...Object.keys(pkg.dependencies || {}).map(
						(d) => new RegExp(`^${d}(\\/.*)?$`),
					),
				],
				plugins: [
					nodeResolve({ exportConditions: ["node"] }),
					commonjs({
						transformMixedEsModules: false,
						ignoreDynamicRequires: true,
						ignoreGlobal: true,
					}),
					json(),
				],
			});

			await bundle.write({
				dir: `${out}/server`,
				format: "esm",
				sourcemap: false,
				chunkFileNames: "chunks/[name]-[hash].js",
			});
		},
	} satisfies Adapter;
}
