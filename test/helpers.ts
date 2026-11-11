import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, AppProps } from 'aws-cdk-lib';

/**
 * Feature flags from cdk.json. The CDK CLI injects them at synth time, but
 * `new App()` in Jest does not, so tests load them explicitly to synthesize
 * the same templates a real deploy would.
 */
export const CDK_CONTEXT: Record<string, unknown> = (
  JSON.parse(readFileSync(join(__dirname, '..', 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

export function testAppProps(extra: Record<string, unknown> = {}): AppProps {
  return { context: { ...CDK_CONTEXT, ...extra } };
}

export function testApp(extra: Record<string, unknown> = {}): App {
  return new App(testAppProps(extra));
}
