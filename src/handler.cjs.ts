import { Server } from "SERVER_DEST";
import { manifest } from "MANIFEST_DEST";
import type { awslambda as AwsLambda } from "@jill64/types-lambda";

declare const awslambda: typeof AwsLambda;

const SERVER = new Server(manifest);
let INIT = false;

export const handler = awslambda.streamifyResponse(
	async (event, responseStream) => {
		if (!INIT) {
			await SERVER.init({ env: process.env as any });
			INIT = true;
		}

		const method = event.requestContext.http.method;
		const encoding = event.isBase64Encoded
			? "base64"
			: event.headers["content-encoding"] || "utf-8";
		const body =
			method === "GET" || method === "DELETE"
				? undefined
				: Buffer.from(event.body, encoding as BufferEncoding);
		const request = new Request(
			new URL(
				`${event.rawPath}?${event.rawQueryString}`,
				`${event.headers["x-forwarded-proto"]}://${event.headers["x-forwarded-host"]}`,
			),
			{ method, body, headers: event.headers },
		);

		const response = await SERVER.respond(request, {
			getClientAddress: () => event.requestContext.http.sourceIp,
		});

		responseStream = awslambda.HttpResponseStream.from(responseStream, {
			statusCode: response.status,
			headers: Object.fromEntries(response.headers),
			cookies: response.headers.getSetCookie(),
		});

		responseStream.write("");

		if (!response.body) {
			responseStream.end();
			return;
		}

		if (response.body.locked) {
			responseStream.end();
			return;
		}

		const reader = response.body.getReader();

		for (
			let chunk = await reader.read();
			!chunk.done;
			chunk = await reader.read()
		) {
			responseStream.write(chunk.value);
		}

		responseStream.end();
	},
);
