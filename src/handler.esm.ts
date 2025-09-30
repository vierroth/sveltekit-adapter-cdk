import { Server } from "SERVER_DEST";
import { manifest } from "MANIFEST_DEST";

const HOP_BY_HOP = new Set([
	"connection",
	"transfer-encoding",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"upgrade",
	"content-length",
]);

const SERVER = new Server(manifest);
await SERVER.init({ env: process.env as any });

export const handler = awslambda.streamifyResponse(
	async (event, responseStream) => {
		const method = event.requestContext.http.method;

		const url = new URL(
			`${event.rawPath}${
				event.rawQueryString ? `?${event.rawQueryString}` : ""
			}`,
			`${event.headers["x-forwarded-proto"] || "https"}://${
				event.headers["x-forwarded-host"] || event.headers.host
			}`,
		);

		let body: any = undefined;
		if (method !== "GET" && method !== "DELETE" && event.body != null) {
			body = event.isBase64Encoded
				? Buffer.from(event.body, "base64")
				: event.body;
		}

		const requestHeaders = new Headers();
		for (const [k, v] of Object.entries(event.headers || {})) {
			if (!HOP_BY_HOP.has(k.toLowerCase()))
				requestHeaders.append(k, v as string);
		}

		const request = new Request(url, { method, body, headers: requestHeaders });

		const response = await SERVER.respond(request, {
			getClientAddress: () => event.requestContext.http.sourceIp,
		});

		const responseHeaders: Record<string, string> = {};
		for (const [k, v] of response.headers) {
			const name = k.toLowerCase();
			if (HOP_BY_HOP.has(name)) continue;
			if (name === "set-cookie") continue;
			responseHeaders[name] = v;
		}

		const responseCookies =
			typeof response.headers.getSetCookie === "function"
				? response.headers.getSetCookie()
				: [];

		responseStream = awslambda.HttpResponseStream.from(responseStream, {
			statusCode: response.status,
			headers: responseHeaders,
			cookies: responseCookies,
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
