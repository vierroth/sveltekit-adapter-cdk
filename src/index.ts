import type { Adapter } from "@sveltejs/kit";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export interface AdapterProps {
	out?: string;
	precompress?: boolean;
}

export default function ({
	out = "./dist",
	precompress = false,
}: AdapterProps = {}) {
	if (typeof out !== "string" || out.trim() === "") {
		throw new TypeError("out must be a nonempty directory path");
	}

	if (typeof precompress !== "boolean") {
		throw new TypeError("precompress must be a boolean");
	}

	return {
		name: "@flit/sveltekit-adapter-cdk",
		supports: {
			instrumentation: () => true,
			read: () => false,
		},
		async adapt(builder) {
			const paths = [
				resolve(out),
				process.cwd(),
				resolve(builder.config.outDir),
				resolve("src"),
				resolve("static"),
				resolve("node_modules"),
				fileURLToPath(import.meta.url),
			];

			for (let index = 0; index < paths.length; index += 1) {
				let ancestor = paths[index];
				const missing: string[] = [];

				while (true) {
					try {
						const stats = lstatSync(ancestor);

						if (index === 0 && stats.isSymbolicLink()) {
							throw new Error(
								`Output path must not traverse a symbolic link: ${ancestor}`,
							);
						}

						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
							throw error;
						}

						missing.unshift(basename(ancestor));
						const parent = dirname(ancestor);

						if (parent === ancestor) {
							throw error;
						}

						ancestor = parent;
					}
				}

				paths[index] = resolve(realpathSync(ancestor), ...missing);
			}

			const output = paths[0];

			for (let index = 1; index < paths.length; index += 1) {
				const protectedPath = paths[index];
				const fromOutput = relative(output, protectedPath);
				const toOutput = relative(protectedPath, output);

				const containsProtected =
					fromOutput === "" ||
					(!isAbsolute(fromOutput) &&
						fromOutput !== ".." &&
						!fromOutput.startsWith(`..${sep}`));

				const insideProtected =
					toOutput === "" ||
					(!isAbsolute(toOutput) &&
						toOutput !== ".." &&
						!toOutput.startsWith(`..${sep}`));

				if (containsProtected || (index > 1 && insideProtected)) {
					throw new Error(
						`Unsafe output directory "${output}": overlaps "${protectedPath}"`,
					);
				}
			}

			if (existsSync(output) && !lstatSync(output).isDirectory()) {
				throw new Error(`Output path is not a directory: ${output}`);
			}

			mkdirSync(dirname(output), { recursive: true });

			const workspace = mkdtempSync(
				join(dirname(output), `.${basename(output)}-build-`),
			);
			const staging = join(workspace, "output");
			const backup = join(workspace, "previous");
			const serverDirectory = join(staging, "server");
			const base = builder.config.paths.base;

			let preserveWorkspace = false;

			try {
				mkdirSync(join(staging, "client"), { recursive: true });
				mkdirSync(join(staging, "prerendered"), { recursive: true });

				builder.log.minor("Copying assets");
				builder.writeClient(`${staging}/client${base}`);
				builder.writePrerendered(`${staging}/prerendered${base}`);

				if (precompress) {
					builder.log.minor("Compressing assets");

					const results = await Promise.allSettled([
						builder.compress(join(staging, "client")),
						builder.compress(join(staging, "prerendered")),
					]);

					const errors: unknown[] = [];

					for (const result of results) {
						if (result.status === "rejected") {
							errors.push(result.reason);
						}
					}

					if (errors.length > 0) {
						throw new AggregateError(
							errors,
							"Failed to compress deployment assets",
						);
					}
				}

				builder.log.minor("Building server");
				builder.writeServer(serverDirectory);

				builder.generateServerInstance(join(serverDirectory, "server.js"), {
					serverDirectory,
				});

				if (builder.hasServerInstrumentationFile()) {
					builder.log.minor("Wiring server instrumentation");

					const initializer = builder.createInstrumentationInitializer({
						outputDirectory: serverDirectory,
						serverDirectory,
					});

					builder.instrument({
						entrypoint: join(serverDirectory, "server.js"),
						start: join(serverDirectory, "server.start.js"),
						instrumentation: join(serverDirectory, "instrumentation.server.js"),
						initializer,
						module: { exports: ["server"] },
					});
				}

				writeFileSync(
					join(serverDirectory, "manifest.js"),
					[
						`export const appPath = ${JSON.stringify(builder.getAppPath())};`,
						`export const assets = ${JSON.stringify(
							builder.manifest.assets.map((a) => a.path),
						)};`,
						`export const base = ${JSON.stringify(base)};`,
						`export const prerendered = new Set(${JSON.stringify(
							builder.prerendered.paths,
						)});`,
						"",
					].join("\n"),
					"utf8",
				);

				for (const filename of ["handler.esm.js", "edge-handler.esm.js"]) {
					builder.copy(
						fileURLToPath(new URL(`./${filename}`, import.meta.url)),
						join(serverDirectory, filename),
						{
							replace: {
								MANIFEST_DEST: "./manifest.js",
								SERVER_DEST: "./server.js",
							},
						},
					);
				}

				for (const [source, destination] of [
					["cdk.js", "index.js"],
					["cdk.d.ts", "index.d.ts"],
				]) {
					builder.copy(
						fileURLToPath(new URL(`./${source}`, import.meta.url)),
						join(staging, destination),
						{
							replace: {
								MANIFEST_DEST: "./server/manifest.js",
							},
						},
					);
				}

				builder.log.minor("Publishing build");

				const hadPreviousOutput = existsSync(output);

				if (hadPreviousOutput) {
					renameSync(output, backup);
				}

				try {
					renameSync(staging, output);
				} catch (error) {
					if (hadPreviousOutput) {
						try {
							renameSync(backup, output);
						} catch (rollbackError) {
							preserveWorkspace = true;

							throw new AggregateError(
								[error, rollbackError],
								`Publishing and rollback failed. Previous output remains at "${backup}"`,
							);
						}
					}

					throw error;
				}
			} finally {
				if (!preserveWorkspace) {
					try {
						rmSync(workspace, { recursive: true, force: true });
					} catch (error) {
						builder.log.warn(
							`Could not remove build workspace "${workspace}": ${String(
								error,
							)}`,
						);
					}
				}
			}
		},
	} satisfies Adapter;
}
