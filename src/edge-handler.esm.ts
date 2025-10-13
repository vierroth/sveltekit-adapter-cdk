import type {
	CloudFrontHeaders,
	CloudFrontRequestEvent,
	CloudFrontRequestResult,
} from "aws-lambda";
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

export const handler = async (
	event: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> => {
	const req = event.Records[0].cf.request;

	const url = new URL(
		`${req.uri}${req.querystring ? `?${req.querystring}` : ""}`,
		`${req.headers["cloudfront-forwarded-proto"]?.[0]?.value}://${req.headers["cloudfront-forwarded-host"]?.[0]?.value}`,
	);

	const method = req.method;

	const headers = new Headers();
	for (const [k, e] of Object.entries(req.headers || {})) {
		if (!HOP_BY_HOP.has(k.toLowerCase())) {
			for (const { value } of e) headers.append(k, value);
		}
	}

	let body: any = undefined;
	if (method !== "GET" && method !== "HEAD") {
		body = Buffer.from(
			req.body?.data ?? "",
			req.body?.encoding === "base64" ? "base64" : "utf8",
		);
	}

	const request = new Request(url, { method, headers, body });

	const response = await SERVER.respond(request, {
		getClientAddress: () => req.clientIp,
	});

	const responseHeaders: Record<string, string> = {};
	for (const [k, v] of response.headers) {
		const name = k.toLowerCase();
		if (HOP_BY_HOP.has(name)) continue;
		if (name === "set-cookie") continue;
		responseHeaders[name] = v;
	}

	const cfHeaders: CloudFrontHeaders = {};
	for (const [name, value] of response.headers) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || lower === "set-cookie") continue;
		const canonical = name
			.split("-")
			.map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
			.join("-");
		(cfHeaders[lower] ??= []).push({ key: canonical, value });
	}

	const setCookies: string[] =
		typeof (response.headers as any).getSetCookie === "function"
			? (response.headers as any).getSetCookie()
			: (() => {
					const sc = response.headers.get("set-cookie");
					return sc ? [sc] : [];
			  })();

	if (setCookies.length) {
		cfHeaders["set-cookie"] = setCookies.map((value) => ({
			key: "Set-Cookie",
			value,
		}));
	}

	const contentType =
		response.headers.get("content-type") ?? "text/html; charset=utf-8";
	const baseCt = contentType.split(";")[0].trim().toLowerCase();
	const isText =
		baseCt.startsWith("text/") ||
		baseCt === "application/json" ||
		baseCt === "application/javascript" ||
		baseCt === "application/xml" ||
		baseCt.endsWith("+json") ||
		baseCt.endsWith("+xml");

	let bodyData = "";
	let bodyEncoding: "base64" | undefined;

	if (method !== "HEAD" && response.body) {
		if (isText) {
			bodyData = await response.text();
		} else {
			const buf = Buffer.from(await response.arrayBuffer());
			bodyData = buf.toString("base64");
			bodyEncoding = "base64";
		}
	}

	return {
		status: String(response.status),
		statusDescription: response.statusText || undefined,
		headers: cfHeaders,
		body: bodyData,
		...(bodyEncoding ? { bodyEncoding } : {}),
	};
};
