import { Match, Template } from 'aws-cdk-lib/assertions';
import { POWERTOOLS_LAYER_VERSION } from '../lib/constructs/powertools';
import { MftCoreStack } from '../lib/mft-core-stack';
import { loadPartners } from '../lib/partners';
import { testApp } from './helpers';

const ENV = { account: '111111111111', region: 'eu-central-2' };

describe('Phase 4 observability (D14, D21)', () => {
  const core = new MftCoreStack(testApp(), 'Core', { env: ENV, partners: loadPartners() });
  const t = Template.fromStack(core);
  const topicRef = { Ref: core.getLogicalId(core.alertTopic.node.defaultChild as never) };

  test('four alarms, each notifying the alert topic on ALARM and OK', () => {
    const alarms = t.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms)).toHaveLength(4);
    for (const a of Object.values(alarms)) {
      expect(a.Properties.AlarmActions).toEqual([topicRef]);
      expect(a.Properties.OKActions).toEqual([topicRef]);
      expect(a.Properties.TreatMissingData).toBe('notBreaching');
    }
    const names = Object.values(alarms)
      .map((a) => a.Properties.AlarmName)
      .sort();
    expect(names).toEqual([
      'mft-hub-dlq-not-empty',
      'mft-hub-processing-queue-stuck',
      'mft-hub-processor-errors',
      'mft-hub-rejected-file-rate',
    ]);
  });

  test('DLQ alarm fires on the first message', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'mft-hub-dlq-not-empty',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  test('rejected-file rate uses the processor metrics with a minimum volume', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'mft-hub-rejected-file-rate',
      Threshold: 50,
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: Match.stringLikeRegexp('>= 3') }),
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: {
              Namespace: 'MftHub',
              MetricName: 'FilesRejected',
              Dimensions: [{ Name: 'service', Value: 'file-processor' }],
            },
          }),
        }),
      ]),
    });
  });

  test('CloudWatch may publish to the encrypted topic, scoped to this account alarms', () => {
    const conditions = {
      StringEquals: { 'aws:SourceAccount': ENV.account },
      ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:eu-central-2:${ENV.account}:alarm:*` },
    };
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudWatchAlarmsPublish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: 'sns:Publish',
            Condition: conditions,
          }),
        ]),
      },
    });
    t.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudWatchForAlertTopic',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Condition: conditions,
          }),
        ]),
      },
    });
  });

  test('processor: active tracing and the pinned Powertools layer', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'mft_lambdas.processor.handler',
      TracingConfig: { Mode: 'Active' },
      Layers: [
        `arn:aws:lambda:eu-central-2:017000801446:layer:AWSLambdaPowertoolsPythonV3-python312-arm64:${POWERTOOLS_LAYER_VERSION}`,
      ],
    });
  });

  test('only the X-Ray actions use a "*" resource in the processor policy', () => {
    const roles = t.findResources('AWS::IAM::Role', {
      Properties: { Description: Match.stringLikeRegexp('file processor') },
    });
    const [policy] = Object.values(
      t.findResources('AWS::IAM::Policy', {
        Properties: { Roles: [{ Ref: Object.keys(roles)[0] }] },
      }),
    );
    const star = (
      policy.Properties.PolicyDocument.Statement as {
        Action: string | string[];
        Resource: unknown;
      }[]
    )
      .filter((s) => s.Resource === '*')
      .flatMap((s) => [s.Action].flat());
    expect(star.sort()).toEqual(['xray:PutTelemetryRecords', 'xray:PutTraceSegments']);
  });

  test('outputs for the smoke-test and redrive scripts', () => {
    for (const name of [
      'LandingBucketName',
      'ProcessedBucketName',
      'QuarantineBucketName',
      'TransfersTableName',
      'ProcessingQueueArn',
      'DeadLetterQueueArn',
    ]) {
      t.hasOutput(name, {});
    }
  });
});
