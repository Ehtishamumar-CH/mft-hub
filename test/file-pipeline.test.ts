import { Match, Template } from 'aws-cdk-lib/assertions';
import { MAX_RECEIVE_COUNT, STATUS_INDEX } from '../lib/constructs/file-pipeline';
import { MftCoreStack } from '../lib/mft-core-stack';
import { loadPartners } from '../lib/partners';
import { testApp } from './helpers';

const ENV = { account: '111111111111', region: 'eu-central-2' };

function build() {
  const core = new MftCoreStack(testApp(), 'Core', { env: ENV, partners: loadPartners() });
  return { core, t: Template.fromStack(core) };
}

describe('FilePipeline (D6, D12, D17, D18)', () => {
  const { core, t } = build();
  const id = (c: { node: { defaultChild?: unknown } }) =>
    core.getLogicalId(c.node.defaultChild as never);
  const keyRef = { 'Fn::GetAtt': [id(core.key), 'Arn'] };

  test('landing bucket sends events to EventBridge natively (no custom resource)', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
    });
    t.resourceCountIs('Custom::S3BucketNotifications', 0);
  });

  test('rule matches only Object Created under inbound/ in the landing bucket', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
        detail: {
          bucket: { name: [{ Ref: id(core.landingBucket) }] },
          object: { key: [{ prefix: 'inbound/' }] },
        },
      },
      Targets: [
        Match.objectLike({
          Arn: { 'Fn::GetAtt': [id(core.pipeline.queue), 'Arn'] },
          DeadLetterConfig: { Arn: { 'Fn::GetAtt': [id(core.pipeline.deadLetterQueue), 'Arn'] } },
        }),
      ],
    });
  });

  test('both queues are KMS-encrypted and TLS-only; DLQ after 3 receives', () => {
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::SQS::Queue', {
      KmsMasterKeyId: keyRef,
      VisibilityTimeout: 1800,
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [id(core.pipeline.deadLetterQueue), 'Arn'] },
        maxReceiveCount: MAX_RECEIVE_COUNT,
      },
    });
    t.hasResourceProperties('AWS::SQS::Queue', {
      KmsMasterKeyId: keyRef,
      MessageRetentionPeriod: 14 * 24 * 3600,
    });
    const policies = JSON.stringify(t.findResources('AWS::SQS::QueuePolicy'));
    expect(policies).toContain('"aws:SecureTransport":"false"');
  });

  test('only EventBridge rules in this account may send to the queues', () => {
    t.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
            Principal: { Service: 'events.amazonaws.com' },
            Condition: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  test('audit table: keys, status GSI, on-demand, CMK, PITR, protected and retained', () => {
    t.hasResource('AWS::DynamoDB::GlobalTable', {
      Properties: Match.objectLike({
        KeySchema: [
          { AttributeName: 'partnerId', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: 'KMS' }),
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: STATUS_INDEX,
            KeySchema: [
              { AttributeName: 'status', KeyType: 'HASH' },
              { AttributeName: 'transferTs', KeyType: 'RANGE' },
            ],
          }),
        ],
        Replicas: [
          Match.objectLike({
            DeletionProtectionEnabled: true,
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ],
      }),
      DeletionPolicy: 'Retain',
    });
  });

  test('processor: Python 3.12 arm64, 512 MB, 5 min, partial batch failures', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'mft_lambdas.processor.handler',
      Runtime: 'python3.12',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 300,
    });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BatchSize: 10,
      ScalingConfig: { MaximumConcurrency: 2 },
    });
  });

  test('processor role: delete only in landing inbound/, no managed policies', () => {
    const roles = t.findResources('AWS::IAM::Role', {
      Properties: { Description: Match.stringLikeRegexp('file processor') },
    });
    expect(Object.keys(roles)).toHaveLength(1);
    expect(JSON.stringify(roles)).not.toContain('ManagedPolicyArns');

    const [policy] = Object.values(
      t.findResources('AWS::IAM::Policy', {
        Properties: { Roles: [{ Ref: Object.keys(roles)[0] }] },
      }),
    );
    const statements = policy.Properties.PolicyDocument.Statement as {
      Action: string | string[];
      Resource: unknown;
      Condition?: unknown;
    }[];
    const deletes = statements.filter((s) =>
      [s.Action].flat().some((a) => a.startsWith('s3:Delete')),
    );
    expect(deletes).toHaveLength(1);
    expect(JSON.stringify(deletes[0].Resource)).toContain('/inbound/*');
    // KMS is conditioned to S3 and DynamoDB. The one exception is the
    // kms:Decrypt that CDK's SqsEventSource adds to read the queue: decrypt
    // only, so the role can never generate data keys outside those services.
    const kms = statements.filter((s) => [s.Action].flat().some((a) => a.startsWith('kms:')));
    const unconditioned = kms.filter(
      (s) => !JSON.stringify(s.Condition ?? {}).includes('kms:ViaService'),
    );
    expect(unconditioned.map((s) => s.Action)).toEqual(['kms:Decrypt']);
    expect(kms.length).toBe(3);
  });
});
