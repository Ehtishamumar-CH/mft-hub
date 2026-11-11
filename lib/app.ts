import { App, AppProps, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DEFAULT_TAGS, REGION } from './config';
import { MftCoreStack } from './mft-core-stack';
import { MftSftpStack } from './mft-sftp-stack';
import { loadPartners } from './partners';

/**
 * Builds the CDK app. Shared by bin/mft-hub.ts and the Jest tests so both
 * synthesize exactly the same tree, with cdk-nag attached (D22).
 */
export function buildApp(props?: AppProps): App {
  const app = new App(props);

  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: REGION,
  };

  const alertEmail: unknown = app.node.tryGetContext('alertEmail');

  const core = new MftCoreStack(app, 'MftCoreStack', {
    partners: loadPartners(),
    alertEmail: typeof alertEmail === 'string' && alertEmail ? alertEmail : undefined,
    env,
    description: 'MFT Hub - persistent core (KMS, S3, DynamoDB, pipeline, alarms)',
    terminationProtection: app.node.tryGetContext('terminationProtection') !== 'false',
  });

  // D9: ephemeral and billable. Not termination-protected so it can be torn down after demos.
  new MftSftpStack(app, 'MftSftpStack', {
    env,
    core,
    description:
      'MFT Hub - SFTP endpoint and identity provider (ephemeral, about 0.30 USD per hour)',
  });

  const owner: unknown = app.node.tryGetContext('owner');
  for (const [key, value] of Object.entries(DEFAULT_TAGS)) {
    Tags.of(app).add(key, value);
  }
  Tags.of(app).add('Owner', typeof owner === 'string' && owner ? owner : 'Ehtishamumar-CH');

  // D22: AwsSolutions pack runs on every synth; any unacknowledged finding fails it.
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

  return app;
}
