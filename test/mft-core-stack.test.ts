import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { MonthlyBudget } from '../lib/constructs/monthly-budget';
import { MftCoreStack } from '../lib/mft-core-stack';
import { testApp } from './helpers';

const ENV = { account: '111111111111', region: 'eu-central-2' };

function synth(alertEmail?: string): { stack: MftCoreStack; template: Template } {
  const app = testApp();
  const stack = new MftCoreStack(app, 'Core', { env: ENV, alertEmail });
  return { stack, template: Template.fromStack(stack) };
}

type Resource = { Properties: Record<string, unknown>; DeletionPolicy?: string };

function bucketsById(template: Template): Record<string, Resource> {
  return template.findResources('AWS::S3::Bucket') as Record<string, Resource>;
}

function logicalId(stack: Stack, construct: { node: { defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as never);
}

describe('MftCoreStack', () => {
  const { stack, template } = synth();

  test('one KMS key with annual rotation, retained on delete (D11)', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResource('AWS::KMS::Key', {
      Properties: { EnableKeyRotation: true, RotationPeriodInDays: 365 },
      DeletionPolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/mft-hub' });
  });

  test('four buckets, all private, owner-enforced, versioned and retained (D19)', () => {
    const buckets = bucketsById(template);
    expect(Object.keys(buckets)).toHaveLength(4);
    for (const b of Object.values(buckets)) {
      expect(b.DeletionPolicy).toBe('Retain');
      expect(b.Properties).toMatchObject({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        VersioningConfiguration: { Status: 'Enabled' },
      });
      const rules = (b.Properties.LifecycleConfiguration as { Rules: object[] }).Rules;
      expect(rules).toContainEqual(
        expect.objectContaining({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }),
      );
    }
  });

  test('data buckets use the CMK with bucket keys and log to the access-log bucket', () => {
    const buckets = bucketsById(template);
    const keyId = logicalId(stack, stack.key);
    const logsId = logicalId(stack, stack.accessLogsBucket);
    for (const bucket of [stack.landingBucket, stack.processedBucket, stack.quarantineBucket]) {
      const props = buckets[logicalId(stack, bucket)].Properties;
      expect(props.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [
          {
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
              KMSMasterKeyID: { 'Fn::GetAtt': [keyId, 'Arn'] },
            },
          },
        ],
      });
      expect(props.LoggingConfiguration).toMatchObject({
        DestinationBucketName: { Ref: logsId },
      });
    }
  });

  test('access-log bucket uses SSE-S3 (S3 cannot deliver logs to SSE-KMS buckets)', () => {
    const props = bucketsById(template)[logicalId(stack, stack.accessLogsBucket)].Properties;
    expect(props.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    });
    expect(props.LoggingConfiguration).toBeUndefined();
  });

  test('every bucket policy denies non-TLS and TLS < 1.2', () => {
    const policies = template.findResources('AWS::S3::BucketPolicy');
    expect(Object.keys(policies)).toHaveLength(4);
    for (const p of Object.values(policies) as Resource[]) {
      const doc = p.Properties.PolicyDocument as { Statement: object[] };
      expect(doc.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          expect.objectContaining({
            Effect: 'Deny',
            Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } },
          }),
        ]),
      );
    }
  });

  test('lifecycle: processed tiers to IA at 30d and Glacier at 180d (D19)', () => {
    const props = bucketsById(template)[logicalId(stack, stack.processedBucket)].Properties;
    expect((props.LifecycleConfiguration as { Rules: object[] }).Rules).toContainEqual(
      expect.objectContaining({
        Status: 'Enabled',
        Transitions: [
          { StorageClass: 'STANDARD_IA', TransitionInDays: 30 },
          { StorageClass: 'GLACIER', TransitionInDays: 180 },
        ],
      }),
    );
  });

  test('lifecycle: quarantine rejected/ expires after 30d (D19)', () => {
    const props = bucketsById(template)[logicalId(stack, stack.quarantineBucket)].Properties;
    expect((props.LifecycleConfiguration as { Rules: object[] }).Rules).toContainEqual(
      expect.objectContaining({ Prefix: 'rejected/', ExpirationInDays: 30, Status: 'Enabled' }),
    );
  });

  test('alert topic is KMS-encrypted, TLS-only, and Budgets may publish only for this account', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: { 'Fn::GetAtt': [logicalId(stack, stack.key), 'Arn'] },
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          Match.objectLike({
            Sid: 'AllowBudgetsPublish',
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'sns:Publish',
            Condition: {
              StringEquals: { 'aws:SourceAccount': ENV.account },
              ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${ENV.account}:*` },
            },
          }),
        ]),
      },
    });
  });

  test('key policy lets Budgets use the key, scoped to this account', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowBudgetsForAlertTopic',
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: ['kms:Decrypt', 'kms:GenerateDataKey*'], // CDK sorts actions
            Condition: Match.objectLike({
              StringEquals: { 'aws:SourceAccount': ENV.account },
            }),
          }),
        ]),
      },
    });
  });

  test('no email subscription unless alertEmail context is given (D14)', () => {
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    synth('ops@example.com').template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  test('$10 monthly budget with 50/80/100% actual and 100% forecast alerts to the topic', () => {
    const [budget] = Object.values(template.findResources('Custom::MonthlyBudget')) as Resource[];
    const create = JSON.stringify(budget.Properties.Create);
    expect(create).toContain('\\"action\\":\\"CreateBudget\\"');
    expect(create).toContain('\\"region\\":\\"us-east-1\\"');
    expect(create).toContain('\\"BudgetLimit\\":{\\"Amount\\":\\"10\\",\\"Unit\\":\\"USD\\"}');
    for (const [type, t] of [
      ['ACTUAL', 50],
      ['ACTUAL', 80],
      ['ACTUAL', 100],
      ['FORECASTED', 100],
    ] as const) {
      expect(create).toContain(`\\"NotificationType\\":\\"${type}\\",`);
      expect(create).toContain(`\\"Threshold\\":${t},`);
    }
    expect((create.match(/SubscriptionType/g) ?? []).length).toBe(4);
    expect(JSON.stringify(budget.Properties.Delete)).toContain('DeleteBudget');
  });
});

describe('MonthlyBudget', () => {
  const make = (limitUsd: number) => {
    const stack = new Stack(testApp(), 'S', { env: ENV });
    return new MonthlyBudget(stack, 'B', {
      namePrefix: 'test',
      limitUsd,
      actualThresholds: [80],
      forecastThresholds: [],
      topic: new Topic(stack, 'T'),
    });
  };

  test('budget name is stable for the same config and changes when config changes', () => {
    expect(make(10).budgetName).toBe(make(10).budgetName);
    expect(make(10).budgetName).not.toBe(make(20).budgetName);
    expect(make(10).budgetName).toMatch(/^test-[0-9a-f]{8}$/);
  });
});
