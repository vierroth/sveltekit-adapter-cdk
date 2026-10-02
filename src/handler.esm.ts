import { pipeline } from "node:stream/promises";
import { server } from "SERVER_DEST";

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

await server.init({ env: process.env });

export const handler = awslambda.streamifyResponse(
	async (event, responseStream) => {
		const method = event.requestContext.http.method;
		const headers = event.headers || {};

		const origin = `${headers["x-forwarded-proto"] || "https"}://${
			headers["x-forwarded-host"] || headers.host
		}`;

		const url = new URL(
			`${origin}${event.rawPath}${
				event.rawQueryString ? `?${event.rawQueryString}` : ""
			}`,
		);

		let body: BodyInit | undefined;
		if (method !== "GET" && method !== "HEAD" && event.body != null) {
			body = event.isBase64Encoded
				? Buffer.from(event.body, "base64")
				: event.body;
		}

		const requestHeaders = new Headers();
		const connectionHeaders = new Set(
			(headers.connection || "")
				.split(",")
				.map((name: string) => name.trim().toLowerCase()),
		);

		for (const [k, v] of Object.entries(headers)) {
			const name = k.toLowerCase();

			if (
				typeof v === "string" &&
				!HOP_BY_HOP.has(name) &&
				!connectionHeaders.has(name)
			) {
				requestHeaders.append(k, v);
			}
		}

		if (event.cookies?.length) {
			requestHeaders.set("cookie", event.cookies.join("; "));
		}

		const request = new Request(url, {
			method,
			body,
			headers: requestHeaders,
		});

		const response = await server.respond(request, {
			getClientAddress: () => event.requestContext.http.sourceIp,
		});

		const responseHeaders: Record<string, string> = {};
		const responseConnectionHeaders = new Set(
			(response.headers.get("connection") || "")
				.split(",")
				.map((name) => name.trim().toLowerCase()),
		);

		for (const [k, v] of response.headers) {
			const name = k.toLowerCase();

			if (
				HOP_BY_HOP.has(name) ||
				responseConnectionHeaders.has(name) ||
				name === "set-cookie"
			) {
				continue;
			}

			responseHeaders[name] = v;
		}

		responseStream = awslambda.HttpResponseStream.from(responseStream, {
			statusCode: response.status,
			headers: responseHeaders,
			cookies: response.headers.getSetCookie(),
		});

		responseStream.write("");

		if (method === "HEAD") {
			await response.body?.cancel();
			await pipeline([], responseStream);
			return;
		}

		await pipeline(response.body ?? [], responseStream);
	},
);
