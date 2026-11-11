import { Stack } from 'aws-cdk-lib';
import { ILayerVersion, LayerVersion } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * D21: AWS-managed Powertools for AWS Lambda (Python) V3 layer, arm64, Python 3.12.
 * Version 40 is Powertools 3.37.0 (published 2026-10-22), the same version
 * lambdas/requirements-dev.txt pins for tests. Checked in eu-central-2 on 2026-11-11.
 */
export const POWERTOOLS_LAYER_ACCOUNT = '017000801446';
export const POWERTOOLS_LAYER_VERSION = 40;

export function powertoolsLayer(scope: Construct, id = 'PowertoolsLayer'): ILayerVersion {
  const { region } = Stack.of(scope);
  return LayerVersion.fromLayerVersionArn(
    scope,
    id,
    `arn:aws:lambda:${region}:${POWERTOOLS_LAYER_ACCOUNT}:layer:` +
      `AWSLambdaPowertoolsPythonV3-python312-arm64:${POWERTOOLS_LAYER_VERSION}`,
  );
}
