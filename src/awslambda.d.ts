import type { APIGatewayProxyEventV2, Context, Handler } from "aws-lambda";
import type { Writable } from "stream";

declare global {
	namespace awslambda {
		interface ResponseStream extends Writable {}

		type StreamifyHandler = (
			event: APIGatewayProxyEventV2,
			responseStream: ResponseStream,
			context: Context,
		) => Promise<void>;

		function streamifyResponse(
			handler: StreamifyHandler,
		): Handler<APIGatewayProxyEventV2, void>;

		namespace HttpResponseStream {
			function from(
				stream: Writable,
				options: {
					statusCode: number;
					headers?: Record<string, string>;
					cookies?: string[];
				},
			): Writable;
		}
	}
}
