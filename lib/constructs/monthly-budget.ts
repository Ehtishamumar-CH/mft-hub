import { createHash } from 'node:crypto';
import { Stack, Validations } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ITopic } from 'aws-cdk-lib/aws-sns';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  AwsSdkCall,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface MonthlyBudgetProps {
  /** Name prefix. A short config hash is appended, so any change replaces the budget. */
  readonly namePrefix: string;
  /** Monthly limit in USD. */
  readonly limitUsd: number;
  /** Percent thresholds on ACTUAL spend. */
  readonly actualThresholds: readonly number[];
  /** Percent thresholds on FORECASTED spend. */
  readonly forecastThresholds: readonly number[];
  /** Topic that receives every notification. It must allow budgets.amazonaws.com. */
  readonly topic: ITopic;
}

/**
 * An account-wide monthly cost budget.
 *
 * CloudFormation has no AWS::Budgets::Budget type in eu-central-2 or
 * eu-north-1, and the region SCP denies CloudFormation in us-east-1. The
 * Budgets API itself is global and allowed, so a custom resource calls it
 * directly (docs/DECISIONS.md, D26).
 */
export class MonthlyBudget extends Construct {
  public readonly budgetName: string;
  public readonly resource: AwsCustomResource;

  constructor(scope: Construct, id: string, props: MonthlyBudgetProps) {
    super(scope, id);
    const account = Stack.of(this).account;

    const notification = (type: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
      Notification: {
        NotificationType: type,
        ComparisonOperator: 'GREATER_THAN',
        Threshold: threshold,
        ThresholdType: 'PERCENTAGE',
      },
      Subscribers: [{ SubscriptionType: 'SNS', Address: props.topic.topicArn }],
    });

    const spec = {
      limit: props.limitUsd,
      actual: props.actualThresholds,
      forecast: props.forecastThresholds,
    };
    const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 8);
    this.budgetName = `${props.namePrefix}-${hash}`;

    const create: AwsSdkCall = {
      service: 'Budgets',
      action: 'CreateBudget',
      region: 'us-east-1', // Budgets is a global service served from us-east-1
      parameters: {
        AccountId: account,
        Budget: {
          BudgetName: this.budgetName,
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          BudgetLimit: { Amount: String(props.limitUsd), Unit: 'USD' },
        },
        NotificationsWithSubscribers: [
          ...props.actualThresholds.map((t) => notification('ACTUAL', t)),
          ...props.forecastThresholds.map((t) => notification('FORECASTED', t)),
        ],
      },
      physicalResourceId: PhysicalResourceId.of(this.budgetName),
      // Idempotent on retries and no-op updates: same name means same config.
      ignoreErrorCodesMatching: 'DuplicateRecordException',
    };

    this.resource = new AwsCustomResource(this, 'Resource', {
      resourceType: 'Custom::MonthlyBudget',
      installLatestAwsSdk: false,
      onCreate: create,
      onUpdate: create,
      onDelete: {
        service: 'Budgets',
        action: 'DeleteBudget',
        region: 'us-east-1',
        parameters: { AccountId: account, BudgetName: this.budgetName },
        ignoreErrorCodesMatching: 'NotFoundException',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ['budgets:ModifyBudget', 'budgets:ViewBudget'],
          resources: [`arn:aws:budgets::${account}:budget/${this.budgetName}`],
        }),
      ]),
    });

    // AwsCustomResource runs on a CDK-managed singleton Lambda whose role
    // carries AWSLambdaBasicExecutionRole (CloudWatch Logs write only).
    const provider = Stack.of(this).node.tryFindChild(
      `AWS${AwsCustomResource.PROVIDER_FUNCTION_UUID.replace(/-/g, '')}`,
    );
    if (provider) {
      Validations.of(provider).acknowledge({
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        reason:
          'CDK-managed custom-resource provider. The managed policy only grants CloudWatch Logs writes for its own log output.',
      });
    }
  }
}
