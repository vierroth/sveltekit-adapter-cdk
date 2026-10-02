import type {
	CloudFrontHeaders,
	CloudFrontRequestEvent,
	CloudFrontRequestResult,
} from "aws-lambda";
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

export const handler = async (
	event: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> => {
	const req = event.Records[0].cf.request;
	const method = req.method;

	if (req.body?.inputTruncated) {
		return {
			status: "413",
			statusDescription: "Payload Too Large",
		};
	}

	const origin = `${
		req.headers["cloudfront-forwarded-proto"]?.[0]?.value || "https"
	}://${
		req.headers["cloudfront-forwarded-host"]?.[0]?.value ||
		req.headers.host?.[0]?.value
	}`;

	const url = new URL(
		`${origin}${req.uri}${req.querystring ? `?${req.querystring}` : ""}`,
	);

	const headers = new Headers();
	const connectionHeaders = new Set(
		(req.headers.connection || [])
			.flatMap(({ value }) => value.split(","))
			.map((name: string) => name.trim().toLowerCase()),
	);

	for (const [k, entries] of Object.entries(req.headers)) {
		const name = k.toLowerCase();

		if (!HOP_BY_HOP.has(name) && !connectionHeaders.has(name)) {
			for (const { value } of entries) {
				headers.append(k, value);
			}
		}
	}

	let body: BodyInit | undefined;
	if (method !== "GET" && method !== "HEAD" && req.body) {
		body = Buffer.from(
			req.body.data,
			req.body.encoding === "base64" ? "base64" : "utf8",
		);
	}

	const request = new Request(url, { method, headers, body });

	const response: Response = await server.respond(request, {
		getClientAddress: () => req.clientIp,
	});

	const cfHeaders: CloudFrontHeaders = {};
	const responseConnectionHeaders = new Set(
		(response.headers.get("connection") || "")
			.split(",")
			.map((name: string) => name.trim().toLowerCase()),
	);

	for (const [name, value] of response.headers) {
		const lower = name.toLowerCase();

		if (
			HOP_BY_HOP.has(lower) ||
			responseConnectionHeaders.has(lower) ||
			lower === "set-cookie"
		) {
			continue;
		}

		cfHeaders[lower] = [{ value }];
	}

	const setCookies = response.headers.getSetCookie();

	if (setCookies.length) {
		cfHeaders["set-cookie"] = setCookies.map((value: string) => ({
			key: "Set-Cookie",
			value,
		}));
	}

	if (method === "HEAD") {
		await response.body?.cancel();

		return {
			status: String(response.status),
			statusDescription: response.statusText || undefined,
			headers: cfHeaders,
		};
	}

	return {
		status: String(response.status),
		statusDescription: response.statusText || undefined,
		headers: cfHeaders,
		...(response.body
			? {
					body: Buffer.from(await response.arrayBuffer()).toString("base64"),
					bodyEncoding: "base64" as const,
			  }
			: {}),
	};
};
