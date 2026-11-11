import { Stack, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildApp } from '../lib/app';
import { MftCoreStack } from '../lib/mft-core-stack';
import { testApp, testAppProps } from './helpers';

describe('MFT Hub app', () => {
  test('synthesizes with cdk-nag AwsSolutions and no findings', () => {
    const app = buildApp(testAppProps());
    expect(() => app.synth()).not.toThrow();
  });

  test('core stack targets eu-central-2 and is tagged', () => {
    const app = buildApp(testAppProps());
    const stack = app.node.findChild('MftCoreStack') as MftCoreStack;
    expect(stack.region).toBe('eu-central-2');
    expect(stack.terminationProtection).toBe(true);
    // Tags are applied by an Aspect during synthesis; check a real resource.
    Template.fromStack(stack).hasResourceProperties('AWS::KMS::Key', {
      Tags: Match.arrayWith([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'Ehtishamumar-CH' },
        { Key: 'Project', Value: 'mft-hub' },
      ]),
    });
  });

  test('cdk-nag gate fails synth on a non-compliant resource', () => {
    // Guards against the gate silently being disabled.
    const app = testApp();
    const stack = new Stack(app, 'NagCanary');
    new Bucket(stack, 'InsecureBucket');
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow();
  });
});
