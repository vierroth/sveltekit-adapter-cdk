import { Construct } from "constructs";
import { Duration, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import {
	AllowedMethods,
	CachePolicy,
	CfnOriginRequestPolicy,
	Distribution,
	Function,
	FunctionCode,
	FunctionEventType,
	HttpVersion,
	LambdaEdgeEventType,
	OriginRequestPolicy,
	ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
	FunctionUrlOrigin,
	S3BucketOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
	NodejsFunction,
	OutputFormat,
	type BundlingOptions,
} from "aws-cdk-lib/aws-lambda-nodejs";
import {
	BucketDeployment,
	CacheControl,
	Source,
} from "aws-cdk-lib/aws-s3-deployment";
import {
	Alias,
	Architecture,
	FunctionUrlAuthType,
	InvokeMode,
	Runtime,
	Tracing,
	type FunctionOptions,
} from "aws-cdk-lib/aws-lambda";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { fileURLToPath } from "node:url";

import { appPath, assets, base, prerendered } from "MANIFEST_DEST";

export interface SvelteKitProps extends FunctionOptions {
	readonly domainNames?: string[];
	readonly certificate?: ICertificate;
	readonly runtime?: Runtime;
	readonly bundling?: BundlingOptions;
}

export class SvelteKit extends Construct {
	public readonly function: NodejsFunction;
	public readonly functionAlias: Alias;
	public readonly cloudFront: Distribution;

	constructor(scope: Construct, id: string, props: SvelteKitProps) {
		super(scope, id);

		this.function = new NodejsFunction(this, "Server", {
			...props,
			entry: fileURLToPath(new URL("./server/handler.esm.js", import.meta.url)),
			bundling: {
				...props.bundling,
				minify: true,
				sourceMap: false,
				sourcesContent: false,
				metafile: true,
				loader: {
					".node": "file",
					...props.bundling?.loader,
				},
				format: OutputFormat.ESM,
				mainFields: ["module", "main"],
				esbuildArgs: {
					"--conditions": "module",
					...props.bundling?.esbuildArgs,
				},
			},
		});

		this.functionAlias = this.function.addAlias("Live");

		const clientBucket = new Bucket(this, "ClientBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		new BucketDeployment(this, "ClientBucketDeployment", {
			destinationBucket: clientBucket,
			ephemeralStorageSize: Size.gibibytes(5),
			memoryLimit: 1024,
			sources: [
				Source.asset(fileURLToPath(new URL("./client", import.meta.url))),
			],
			cacheControl: [
				CacheControl.setPublic(),
				CacheControl.maxAge(Duration.days(4)),
				CacheControl.sMaxAge(Duration.days(4)),
				CacheControl.immutable(),
			],
		});

		const prerenderedBucket = new Bucket(this, "PrerenderedBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		if (prerendered.size) {
			new BucketDeployment(this, "PrerenderedBucketDeployment", {
				destinationBucket: prerenderedBucket,
				ephemeralStorageSize: Size.gibibytes(5),
				memoryLimit: 1024,
				sources: [
					Source.asset(
						fileURLToPath(new URL("./prerendered", import.meta.url)),
					),
				],
				cacheControl: [
					CacheControl.setPublic(),
					CacheControl.maxAge(Duration.minutes(4)),
					CacheControl.sMaxAge(Duration.minutes(4)),
				],
			});
		}

		const clientBucketOrigin =
			S3BucketOrigin.withOriginAccessControl(clientBucket);
		const prerenderedBucketOrigin =
			S3BucketOrigin.withOriginAccessControl(prerenderedBucket);

		this.cloudFront = new Distribution(this, "CloudFront", {
			domainNames: props.domainNames,
			certificate: props.certificate,
			httpVersion: HttpVersion.HTTP2_AND_3,
			defaultBehavior: {
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
				allowedMethods: AllowedMethods.ALLOW_ALL,
				cachePolicy: CachePolicy.CACHING_DISABLED,
				origin: FunctionUrlOrigin.withOriginAccessControl(
					this.functionAlias.addFunctionUrl({
						authType: FunctionUrlAuthType.AWS_IAM,
						invokeMode: InvokeMode.RESPONSE_STREAM,
					}),
				),
				functionAssociations: [
					{
						eventType: FunctionEventType.VIEWER_REQUEST,
						function: new Function(this, "XForwardHost", {
							code: FunctionCode.fromInline(`
								function handler(event) {
									var request = event.request;
									request.headers["x-forwarded-host"] = { value: request.headers.host.value };
									return request;
								}
							`),
						}),
					},
				],
			},
		});

		this.cloudFront.addBehavior(`${appPath}/*`, clientBucketOrigin, {
			viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
			allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
		});

		assets.forEach((asset) => {
			const path = asset.replace(/^\/+/, "");
			if (path.toLowerCase() !== ".ds_store") {
				this.cloudFront.addBehavior(`${base}/${path}`, clientBucketOrigin, {
					viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
					originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
					allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
				});
			}
		});

		const rewritePrerenderPath = new Function(this, "RewritePrerenderPath", {
			code: FunctionCode.fromInline(`
				function handler(event) {
					var request = event.request;
					var lastSegment = request.uri.split("/").pop();
					if (lastSegment && lastSegment.includes(".")) {
						return request;
					}
					if (request.uri.endsWith("/")) {
						request.uri += "index";
					}
					request.uri += ".html";
					return request;
				}
			`),
		});

		prerendered.forEach((asset) => {
			this.cloudFront.addBehavior(asset, prerenderedBucketOrigin, {
				functionAssociations: [
					{
						eventType: FunctionEventType.VIEWER_REQUEST,
						function: rewritePrerenderPath,
					},
				],
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
				allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
			});
		});
	}
}

export interface SvelteKitEdgeProps {
	readonly domainNames?: string[];
	readonly certificate?: ICertificate;
	readonly runtime?: Runtime;
	readonly memorySize?: number;
	readonly timeout?: Duration;
	readonly logGroup?: LogGroup;
	readonly reservedConcurrentExecutions?: number;
	readonly bundling?: BundlingOptions;
}

export class SvelteKitEdge extends Construct {
	public readonly function: NodejsFunction;
	public readonly cloudFront: Distribution;

	constructor(scope: Construct, id: string, props: SvelteKitEdgeProps) {
		super(scope, id);

		this.function = new NodejsFunction(this, "Server", {
			...props,
			architecture: Architecture.X86_64,
			tracing: Tracing.DISABLED,
			entry: fileURLToPath(
				new URL("./server/edge-handler.esm.js", import.meta.url),
			),
			bundling: {
				...props.bundling,
				minify: true,
				sourceMap: false,
				sourcesContent: false,
				metafile: true,
				loader: {
					".node": "file",
					...props.bundling?.loader,
				},
				format: OutputFormat.ESM,
				mainFields: ["module", "main"],
				esbuildArgs: {
					"--conditions": "module",
					...props.bundling?.esbuildArgs,
				},
			},
		});

		const clientBucket = new Bucket(this, "ClientBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		new BucketDeployment(this, "ClientBucketDeployment", {
			destinationBucket: clientBucket,
			ephemeralStorageSize: Size.gibibytes(5),
			memoryLimit: 1024,
			sources: [
				Source.asset(fileURLToPath(new URL("./client", import.meta.url))),
			],
			cacheControl: [
				CacheControl.setPublic(),
				CacheControl.maxAge(Duration.days(4)),
				CacheControl.sMaxAge(Duration.days(4)),
				CacheControl.immutable(),
			],
		});

		const prerenderedBucket = new Bucket(this, "PrerenderedBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		if (prerendered.size) {
			new BucketDeployment(this, "PrerenderedBucketDeployment", {
				destinationBucket: prerenderedBucket,
				ephemeralStorageSize: Size.gibibytes(5),
				memoryLimit: 1024,
				sources: [
					Source.asset(
						fileURLToPath(new URL("./prerendered", import.meta.url)),
					),
				],
				cacheControl: [
					CacheControl.setPublic(),
					CacheControl.maxAge(Duration.minutes(4)),
					CacheControl.sMaxAge(Duration.minutes(4)),
				],
			});
		}

		const clientBucketOrigin =
			S3BucketOrigin.withOriginAccessControl(clientBucket);
		const prerenderedBucketOrigin =
			S3BucketOrigin.withOriginAccessControl(prerenderedBucket);

		this.cloudFront = new Distribution(this, "CloudFront", {
			domainNames: props.domainNames,
			certificate: props.certificate,
			httpVersion: HttpVersion.HTTP2_AND_3,
			defaultBehavior: {
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				originRequestPolicy: OriginRequestPolicy.fromOriginRequestPolicyId(
					this,
					"AllViewerExceptHostHeaderRef",
					new CfnOriginRequestPolicy(this, "AllViewerExceptHostHeader", {
						originRequestPolicyConfig: {
							name: `${Stack.of(this).stackName}${
								Stack.of(this).region
							}${id}AllViewerExceptHostHeader`.slice(0, 128),
							comment:
								"Forwards all viewer request data except the Host header",
							headersConfig: {
								headerBehavior: "allExcept",
								headers: ["host"],
							},
							cookiesConfig: {
								cookieBehavior: "all",
							},
							queryStringsConfig: {
								queryStringBehavior: "all",
							},
						},
					}).attrId,
				),
				allowedMethods: AllowedMethods.ALLOW_ALL,
				cachePolicy: CachePolicy.CACHING_DISABLED,
				origin: clientBucketOrigin,
				edgeLambdas: [
					{
						eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
						functionVersion: this.function.currentVersion,
						includeBody: true,
					},
				],
				functionAssociations: [
					{
						eventType: FunctionEventType.VIEWER_REQUEST,
						function: new Function(this, "ForwardHost", {
							code: FunctionCode.fromInline(`
								function handler(event) {
									var request = event.request;
									request.headers["cloudfront-forwarded-host"] = { value: request.headers.host.value };
									return request;
								}
							`),
						}),
					},
				],
			},
		});

		this.cloudFront.addBehavior(`${appPath}/*`, clientBucketOrigin, {
			viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
			allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
		});

		assets.forEach((asset) => {
			const path = asset.replace(/^\/+/, "");
			if (path.toLowerCase() !== ".ds_store") {
				this.cloudFront.addBehavior(`${base}/${path}`, clientBucketOrigin, {
					viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
					originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
					allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
				});
			}
		});

		const rewritePrerenderPath = new Function(this, "RewritePrerenderPath", {
			code: FunctionCode.fromInline(`
				function handler(event) {
					var request = event.request;
					var lastSegment = request.uri.split("/").pop();
					if (lastSegment && lastSegment.includes(".")) {
						return request;
					}
					if (request.uri.endsWith("/")) {
						request.uri += "index";
					}
					request.uri += ".html";
					return request;
				}
			`),
		});

		prerendered.forEach((asset) => {
			this.cloudFront.addBehavior(asset, prerenderedBucketOrigin, {
				functionAssociations: [
					{
						eventType: FunctionEventType.VIEWER_REQUEST,
						function: rewritePrerenderPath,
					},
				],
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
				allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
			});
		});
	}
}
