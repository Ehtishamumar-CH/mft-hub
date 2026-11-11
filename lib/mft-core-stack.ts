import { Annotations, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  LifecycleRule,
  ObjectOwnership,
  StorageClass,
} from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { PROJECT } from './config';
import { FilePipeline } from './constructs/file-pipeline';
import { MonthlyBudget } from './constructs/monthly-budget';
import { PartnerAccess } from './constructs/partner-access';
import { Partner } from './partners';

export interface MftCoreStackProps extends StackProps {
  /** D14: alert email, passed at deploy time with `-c alertEmail=...`. Never committed. */
  readonly alertEmail?: string;
  /** D13: onboarded partners (config/partners.json). */
  readonly partners?: readonly Partner[];
}

/** D19: every bucket aborts incomplete multipart uploads after 7 days. */
const ABORT_MPU: LifecycleRule = {
  id: 'abort-incomplete-multipart-uploads',
  abortIncompleteMultipartUploadAfter: Duration.days(7),
};

/**
 * D9: persistent, near-free stack: the KMS key, data buckets with lifecycle
 * rules, the access-log bucket, the alert topic, the monthly budget, partner
 * records (Phase 2) and the file pipeline with its audit table (Phase 3).
 * Alarms land in Phase 4.
 */
export class MftCoreStack extends Stack {
  public readonly key: Key;
  public readonly accessLogsBucket: Bucket;
  public readonly landingBucket: Bucket;
  public readonly processedBucket: Bucket;
  public readonly quarantineBucket: Bucket;
  public readonly alertTopic: Topic;
  public readonly budget: MonthlyBudget;
  public readonly partnerAccess: PartnerAccess;
  public readonly pipeline: FilePipeline;
  /** Transfer Family structured logs. Here, not in MftSftpStack, so they outlive teardowns (D9). */
  public readonly transferLogGroup: LogGroup;

  constructor(scope: Construct, id: string, props: MftCoreStackProps = {}) {
    super(scope, id, props);

    // D11: one customer-managed key with annual rotation. RETAIN, because
    // deleting the key makes everything it encrypted unreadable.
    this.key = new Key(this, 'DataKey', {
      alias: `alias/${PROJECT}`,
      description: 'MFT Hub data key for S3, DynamoDB, SQS, SNS and Secrets Manager',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // S3 delivers server access logs only to SSE-S3 buckets (not SSE-KMS).
    this.accessLogsBucket = new Bucket(this, 'AccessLogsBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        ABORT_MPU,
        {
          id: 'expire-access-logs',
          expiration: Duration.days(90),
          noncurrentVersionExpiration: Duration.days(7),
        },
      ],
    });
    Validations.of(this.accessLogsBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason:
        'This bucket is the access-log destination. AWS advises against logging a log bucket to itself (loop).',
    });

    const dataBucket = (id: string, logPrefix: string, rules: LifecycleRule[]): Bucket =>
      new Bucket(this, id, {
        encryption: BucketEncryption.KMS,
        encryptionKey: this.key,
        bucketKeyEnabled: true, // fewer KMS requests, lower cost
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
        enforceSSL: true,
        minimumTLSVersion: 1.2,
        versioned: true,
        removalPolicy: RemovalPolicy.RETAIN,
        serverAccessLogsBucket: this.accessLogsBucket,
        serverAccessLogsPrefix: `${logPrefix}/`,
        lifecycleRules: [ABORT_MPU, ...rules],
      });

    // Landing: files move out after processing (D6), so only short-lived
    // noncurrent versions remain.
    this.landingBucket = dataBucket('LandingBucket', 'landing', [
      {
        id: 'expire-noncurrent',
        noncurrentVersionExpiration: Duration.days(7),
        expiredObjectDeleteMarker: true,
      },
    ]);

    // Processed: Standard-IA at 30 days, Glacier Flexible Retrieval at 180 days (D19).
    this.processedBucket = dataBucket('ProcessedBucket', 'processed', [
      {
        id: 'tier-down',
        transitions: [
          { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
          { storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(180) },
        ],
        noncurrentVersionExpiration: Duration.days(30),
      },
    ]);

    // Quarantine: rejected/ expires after 30 days (D19).
    this.quarantineBucket = dataBucket('QuarantineBucket', 'quarantine', [
      { id: 'expire-rejected', prefix: 'rejected/', expiration: Duration.days(30) },
      {
        id: 'expire-noncurrent',
        noncurrentVersionExpiration: Duration.days(7),
        expiredObjectDeleteMarker: true,
      },
    ]);

    // D14: one alert topic, KMS-encrypted and TLS-only.
    this.alertTopic = new Topic(this, 'AlertTopic', {
      displayName: 'MFT Hub alerts',
      masterKey: this.key,
      enforceSSL: true,
    });
    if (props.alertEmail) {
      this.alertTopic.addSubscription(new EmailSubscription(props.alertEmail));
    } else {
      Annotations.of(this.alertTopic).addInfo(
        'No alertEmail context. The alert topic has no subscribers. Deploy with -c alertEmail=<address>.',
      );
    }

    // Budgets publishes to the topic, scoped to this account's budgets
    // (confused-deputy protection, per the AWS Budgets SNS guide).
    const budgetsPrincipal = new ServicePrincipal('budgets.amazonaws.com');
    const budgetsConditions = {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${this.account}:*` },
    };
    this.alertTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowBudgetsPublish',
        principals: [budgetsPrincipal],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: budgetsConditions,
      }),
    );
    // The topic is SSE-KMS, so Budgets must also be able to use the key.
    this.key.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowBudgetsForAlertTopic',
        principals: [budgetsPrincipal],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'], // in a key policy, "*" means this key
        conditions: budgetsConditions,
      }),
    );

    // D4/D13/D20: partner identity records and the shared partner access role.
    this.partnerAccess = new PartnerAccess(this, 'PartnerAccess', {
      partners: props.partners ?? [],
      key: this.key,
      landingBucket: this.landingBucket,
      processedBucket: this.processedBucket,
      quarantineBucket: this.quarantineBucket,
    });

    this.transferLogGroup = new LogGroup(this, 'TransferLogGroup', {
      retention: RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // D6/D12/D17/D18: landing -> EventBridge -> SQS -> processor -> DynamoDB.
    this.pipeline = new FilePipeline(this, 'FilePipeline', {
      key: this.key,
      landingBucket: this.landingBucket,
      processedBucket: this.processedBucket,
      quarantineBucket: this.quarantineBucket,
    });

    // Defaults: $10/month, ACTUAL at 50/80/100 % and FORECASTED at 100 %.
    this.budget = new MonthlyBudget(this, 'MonthlyBudget', {
      namePrefix: `${PROJECT}-monthly`,
      limitUsd: 10,
      actualThresholds: [50, 80, 100],
      forecastThresholds: [100],
      topic: this.alertTopic,
    });
  }
}
