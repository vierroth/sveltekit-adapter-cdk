import { Construct } from "constructs";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
	Distribution,
	ViewerProtocolPolicy,
	OriginRequestPolicy,
	AllowedMethods,
	CachePolicy,
	HttpVersion,
	FunctionEventType,
	FunctionCode,
	Function,
	LambdaEdgeEventType,
} from "aws-cdk-lib/aws-cloudfront";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
	FunctionUrlOrigin,
	S3StaticWebsiteOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import {
	BlockPublicAccess,
	Bucket,
	BucketAccessControl,
	HttpMethods,
	ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import {
	BundlingOptions,
	NodejsFunction,
	OutputFormat,
} from "aws-cdk-lib/aws-lambda-nodejs";
import {
	BucketDeployment,
	CacheControl,
	Source,
} from "aws-cdk-lib/aws-s3-deployment";
import {
	Alias,
	Architecture,
	FunctionOptions,
	FunctionUrlAuthType,
	InvokeMode,
	Runtime,
	Tracing,
} from "aws-cdk-lib/aws-lambda";
import { fileURLToPath } from "url";

import { manifest, prerendered } from "MANIFEST_DEST";
import { LogGroup } from "aws-cdk-lib/aws-logs";

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
			entry: fileURLToPath(
				new URL("./server/handler.esm.js", import.meta.url).href,
			),
			bundling: {
				...props.bundling,
				minify: true,
				sourcesContent: false,
				loader: {
					".node": "file",
				},
				target: "esnext",
				format: OutputFormat.ESM,
				mainFields: ["module", "main"],
				esbuildArgs: {
					"--conditions": "module",
				},
			},
		});

		this.functionAlias = this.function.addAlias("Live");

		const clientBucket = new Bucket(this, "ClientBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			websiteIndexDocument: "index.html",
			publicReadAccess: true,
			objectOwnership: ObjectOwnership.OBJECT_WRITER,
			blockPublicAccess: new BlockPublicAccess({
				blockPublicAcls: false,
				blockPublicPolicy: false,
				ignorePublicAcls: false,
				restrictPublicBuckets: false,
			}),
			cors: [
				{
					allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
					allowedOrigins: ["*"],
				},
			],
		});

		new BucketDeployment(this, "ClientBucketDeployment", {
			destinationBucket: clientBucket,
			accessControl: BucketAccessControl.PUBLIC_READ,
			sources: [
				Source.asset(fileURLToPath(new URL("./client", import.meta.url).href)),
			],
			cacheControl: [
				CacheControl.setPublic(),
				CacheControl.maxAge(Duration.days(4)),
				CacheControl.sMaxAge(Duration.days(4)),
				CacheControl.fromString("immutable"),
			],
		});

		const prerenderedBucket = new Bucket(this, "PrerenderedBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			websiteIndexDocument: "index.html",
			publicReadAccess: true,
			objectOwnership: ObjectOwnership.OBJECT_WRITER,
			blockPublicAccess: new BlockPublicAccess({
				blockPublicAcls: false,
				blockPublicPolicy: false,
				ignorePublicAcls: false,
				restrictPublicBuckets: false,
			}),
			cors: [
				{
					allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
					allowedOrigins: ["*"],
				},
			],
		});

		if (prerendered.size) {
			new BucketDeployment(this, "PrerenderedBucketDeployment", {
				destinationBucket: prerenderedBucket,
				accessControl: BucketAccessControl.PUBLIC_READ,
				sources: [
					Source.asset(
						fileURLToPath(new URL("./prerendered", import.meta.url).href),
					),
				],
				cacheControl: [
					CacheControl.setPublic(),
					CacheControl.maxAge(Duration.minutes(4)),
					CacheControl.sMaxAge(Duration.minutes(4)),
				],
			});
		}

		const clientBucketOrigin = new S3StaticWebsiteOrigin(clientBucket);
		const prerenderedBucketOrigin = new S3StaticWebsiteOrigin(
			prerenderedBucket,
		);

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

		this.cloudFront.addBehavior(`${manifest.appDir}/*`, clientBucketOrigin, {
			viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
			allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
		});

		manifest.assets.forEach((asset) => {
			if (asset.toLowerCase() !== ".ds_store") {
				this.cloudFront.addBehavior(asset, clientBucketOrigin, {
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
       		if (request.uri.endsWith('/')) {
            return request;
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
			environment: undefined,
			tracing: Tracing.DISABLED,
			entry: fileURLToPath(
				new URL("./server/edge-handler.esm.js", import.meta.url).href,
			),
			bundling: {
				...props.bundling,
				minify: true,
				sourcesContent: false,
				loader: {
					".node": "file",
				},
				target: "esnext",
				format: OutputFormat.ESM,
				mainFields: ["module", "main"],
				esbuildArgs: {
					"--conditions": "module",
				},
			},
		});

		const clientBucket = new Bucket(this, "ClientBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			websiteIndexDocument: "index.html",
			publicReadAccess: true,
			objectOwnership: ObjectOwnership.OBJECT_WRITER,
			blockPublicAccess: new BlockPublicAccess({
				blockPublicAcls: false,
				blockPublicPolicy: false,
				ignorePublicAcls: false,
				restrictPublicBuckets: false,
			}),
			cors: [
				{
					allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
					allowedOrigins: ["*"],
				},
			],
		});

		new BucketDeployment(this, "ClientBucketDeployment", {
			destinationBucket: clientBucket,
			accessControl: BucketAccessControl.PUBLIC_READ,
			sources: [
				Source.asset(fileURLToPath(new URL("./client", import.meta.url).href)),
			],
			cacheControl: [
				CacheControl.setPublic(),
				CacheControl.maxAge(Duration.days(4)),
				CacheControl.sMaxAge(Duration.days(4)),
				CacheControl.fromString("immutable"),
			],
		});

		const prerenderedBucket = new Bucket(this, "PrerenderedBucket", {
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			websiteIndexDocument: "index.html",
			publicReadAccess: true,
			objectOwnership: ObjectOwnership.OBJECT_WRITER,
			blockPublicAccess: new BlockPublicAccess({
				blockPublicAcls: false,
				blockPublicPolicy: false,
				ignorePublicAcls: false,
				restrictPublicBuckets: false,
			}),
			cors: [
				{
					allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
					allowedOrigins: ["*"],
				},
			],
		});

		if (prerendered.size) {
			new BucketDeployment(this, "PrerenderedBucketDeployment", {
				destinationBucket: prerenderedBucket,
				accessControl: BucketAccessControl.PUBLIC_READ,
				sources: [
					Source.asset(
						fileURLToPath(new URL("./prerendered", import.meta.url).href),
					),
				],
				cacheControl: [
					CacheControl.setPublic(),
					CacheControl.maxAge(Duration.minutes(4)),
					CacheControl.sMaxAge(Duration.minutes(4)),
				],
			});
		}

		const clientBucketOrigin = new S3StaticWebsiteOrigin(clientBucket);
		const prerenderedBucketOrigin = new S3StaticWebsiteOrigin(
			prerenderedBucket,
		);

		this.cloudFront = new Distribution(this, "CloudFront", {
			domainNames: props.domainNames,
			certificate: props.certificate,
			httpVersion: HttpVersion.HTTP2_AND_3,
			defaultBehavior: {
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
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

		this.cloudFront.addBehavior(`${manifest.appDir}/*`, clientBucketOrigin, {
			viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
			allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
		});

		manifest.assets.forEach((asset) => {
			if (asset.toLowerCase() !== ".ds_store") {
				this.cloudFront.addBehavior(asset, clientBucketOrigin, {
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
       		if (request.uri.endsWith('/')) {
            return request;
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
