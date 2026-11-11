import { join } from 'node:path';
import { CfnElement, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import { AttributeType, Billing, TableEncryptionV2, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, CfnBucket } from 'aws-cdk-lib/aws-s3';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** Lambda timeout. The queue's visibility timeout is 6x this (AWS guidance for SQS sources). */
export const PROCESSOR_TIMEOUT = Duration.minutes(5);
export const MAX_RECEIVE_COUNT = 3;
export const STATUS_INDEX = 'status-index';

export interface FilePipelineProps {
  readonly key: IKey;
  readonly landingBucket: Bucket;
  readonly processedBucket: Bucket;
  readonly quarantineBucket: Bucket;
}

/**
 * D6 / D12 / D17 / D18: landing bucket -> EventBridge -> SQS -> processing
 * Lambda -> processed or quarantine bucket, with a DynamoDB audit record per
 * object version.
 */
export class FilePipeline extends Construct {
  public readonly table: TableV2;
  public readonly queue: Queue;
  public readonly deadLetterQueue: Queue;
  public readonly rule: Rule;
  public readonly processor: LambdaFunction;

  constructor(scope: Construct, id: string, props: FilePipelineProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { key, landingBucket, processedBucket, quarantineBucket } = props;

    // D12: audit table. Retained and deletion-protected: it is the audit trail.
    this.table = new TableV2(this, 'PartnerTransfers', {
      partitionKey: { name: 'partnerId', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      encryption: TableEncryptionV2.customerManagedKey(key),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: STATUS_INDEX,
          partitionKey: { name: 'status', type: AttributeType.STRING },
          sortKey: { name: 'transferTs', type: AttributeType.STRING },
        },
      ],
    });

    // D17: one DLQ for both failure paths (EventBridge delivery and processing).
    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(this.deadLetterQueue).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is the dead-letter queue; it has no DLQ of its own.',
    });

    this.queue = new Queue(this, 'ProcessingQueue', {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: key,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(PROCESSOR_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
    });

    // S3 -> EventBridge natively (CloudFormation NotificationConfiguration),
    // instead of CDK's eventBridgeEnabled, which adds a custom-resource Lambda.
    const cfnLanding = landingBucket.node.defaultChild as CfnBucket;
    cfnLanding.notificationConfiguration = {
      eventBridgeConfiguration: { eventBridgeEnabled: true },
    };

    this.rule = new Rule(this, 'InboundObjectCreated', {
      description: 'Partner uploads in the landing bucket inbound/ prefix to the processing queue',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [landingBucket.bucketName] },
          object: { key: [{ prefix: 'inbound/' }] },
        },
      },
      targets: [
        new SqsQueue(this.queue, {
          deadLetterQueue: this.deadLetterQueue,
          retryAttempts: 185, // the EventBridge maximum, over its 24 h window
          maxEventAge: Duration.hours(24),
        }),
      ],
    });

    const logGroup = new LogGroup(this, 'ProcessorLogs', {
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new Role(this, 'ProcessorRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'MFT Hub file processor: validate, route and record partner uploads',
    });
    logGroup.grantWrite(role);
    const s3ViaService = { StringEquals: { 'kms:ViaService': `s3.${stack.region}.amazonaws.com` } };
    role.addToPolicy(
      new PolicyStatement({
        sid: 'ListLanding', // HEAD on a missing key returns 404, not 403
        actions: ['s3:ListBucket'],
        resources: [landingBucket.bucketArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'ReadAndRemoveInbound',
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:DeleteObject'],
        resources: [landingBucket.arnForObjects('inbound/*')],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'WriteResults',
        actions: ['s3:PutObject', 's3:PutObjectTagging', 's3:AbortMultipartUpload'],
        resources: [
          processedBucket.arnForObjects('*'),
          quarantineBucket.arnForObjects('rejected/*'),
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'UseDataKeyViaS3',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [key.keyArn],
        conditions: s3ViaService,
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRecords',
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: 'UseDataKeyViaDynamoDB',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [key.keyArn],
        conditions: {
          StringEquals: { 'kms:ViaService': `dynamodb.${stack.region}.amazonaws.com` },
        },
      }),
    );
    const arnRef = (b: Bucket) => `<${stack.getLogicalId(b.node.defaultChild as CfnElement)}.Arn>`;
    for (const resource of [
      `${arnRef(landingBucket)}/inbound/*`,
      `${arnRef(processedBucket)}/*`,
      `${arnRef(quarantineBucket)}/rejected/*`,
    ]) {
      Validations.of(role).acknowledge({
        id: `AwsSolutions::AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          'The processor handles every partner, so it needs the whole inbound, processed and ' +
          'rejected prefixes. It has no delete outside inbound/ and no access to other buckets.',
      });
    }

    this.processor = new LambdaFunction(this, 'Processor', {
      description: 'Validates partner uploads, routes them and records the result (D5, D6)',
      runtime: Runtime.PYTHON_3_12,
      architecture: Architecture.ARM_64,
      handler: 'mft_lambdas.processor.handler',
      code: Code.fromAsset(join(__dirname, '..', '..', 'lambdas', 'src'), {
        exclude: ['**/__pycache__', '**/*.pyc'],
      }),
      memorySize: 512,
      timeout: PROCESSOR_TIMEOUT,
      role,
      logGroup,
      environment: {
        LANDING_BUCKET: landingBucket.bucketName,
        PROCESSED_BUCKET: processedBucket.bucketName,
        QUARANTINE_BUCKET: quarantineBucket.bucketName,
        TABLE_NAME: this.table.tableName,
      },
    });
    Validations.of(this.processor).acknowledge({
      id: 'AwsSolutions-L1',
      reason:
        'D3 pins Python 3.12 so Lambda, CI and local tests match; revisit with the runtime upgrade.',
    });
    this.processor.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        maxConcurrency: 2, // the minimum: plenty for demo volumes, protects account concurrency
      }),
    );
  }
}
