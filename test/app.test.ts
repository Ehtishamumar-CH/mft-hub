import { App, Stack, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildApp } from '../lib/app';
import { MftCoreStack } from '../lib/mft-core-stack';

describe('MFT Hub app', () => {
  test('synthesizes with cdk-nag AwsSolutions and no findings', () => {
    const app = buildApp();
    expect(() => app.synth()).not.toThrow();
  });

  test('core stack targets eu-central-2 and is tagged', () => {
    const app = buildApp();
    const stack = app.node.findChild('MftCoreStack') as MftCoreStack;
    app.synth(); // tags are applied by an Aspect during synthesis
    expect(stack.region).toBe('eu-central-2');
    expect(stack.terminationProtection).toBe(true);
    expect(stack.tags.tagValues()).toMatchObject({
      Project: 'mft-hub',
      Environment: 'demo',
    });
    Template.fromStack(stack); // template renders
  });

  test('cdk-nag gate fails synth on a non-compliant resource', () => {
    // Guards against the gate silently being disabled.
    const app = new App();
    const stack = new Stack(app, 'NagCanary');
    new Bucket(stack, 'InsecureBucket');
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow();
  });
});
