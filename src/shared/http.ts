import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

/** Parse a JSON body, handling base64 encoding. Returns undefined on bad JSON. */
export function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> | undefined {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Real viewer IP. Behind CloudFront the source IP is CloudFront's, so prefer its viewer header. */
export function viewerIp(event: APIGatewayProxyEventV2): string {
  const viaCf = event.headers?.['cloudfront-viewer-address'];
  if (viaCf) return viaCf.replace(/:\d+$/, '');
  return event.requestContext?.http?.sourceIp ?? '';
}
