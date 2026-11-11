import { Duration } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  IAlarmAction,
  MathExpression,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { ITopic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { PROJECT } from '../config';
import { FilePipeline } from './file-pipeline';

/** Must match lambdas/src/mft_lambdas/processor.py. */
export const METRICS_NAMESPACE = 'MftHub';
export const PROCESSOR_SERVICE = 'file-processor';

/** Rejected-file rate alarm: > 50 % of files in one hour, once at least 3 files arrived. */
export const REJECTED_RATE_PERCENT = 50;
export const REJECTED_RATE_MIN_FILES = 3;
/** A message older than this means the pipeline has stopped consuming. */
export const QUEUE_AGE_THRESHOLD = Duration.hours(1);

export interface PipelineAlarmsProps {
  readonly pipeline: FilePipeline;
  readonly topic: ITopic;
}

/**
 * D14: pipeline alarms to the alert topic, with OK notifications so a
 * recovery is visible too. Every alarm treats missing data as not breaching:
 * no traffic is normal for a demo.
 */
export class PipelineAlarms extends Construct {
  public readonly alarms: Alarm[];

  constructor(scope: Construct, id: string, props: PipelineAlarmsProps) {
    super(scope, id);
    const { pipeline } = props;
    const period = Duration.minutes(5);
    const custom = (metricName: string) =>
      new Metric({
        namespace: METRICS_NAMESPACE,
        metricName,
        dimensionsMap: { service: PROCESSOR_SERVICE },
        statistic: 'Sum',
        period: Duration.hours(1),
      });

    const dlq = new Alarm(this, 'DeadLetterQueueNotEmpty', {
      alarmName: `${PROJECT}-dlq-not-empty`,
      alarmDescription:
        'Files failed processing 3 times or could not be delivered. Inspect the DLQ, fix the cause, then run scripts/redrive-dlq.sh.',
      metric: pipeline.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period,
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const errors = new Alarm(this, 'ProcessorErrors', {
      alarmName: `${PROJECT}-processor-errors`,
      alarmDescription:
        'The file processor crashed or timed out. Per-file failures are retried and show up in the DLQ alarm.',
      metric: pipeline.processor.metricErrors({ statistic: 'Sum', period }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const stuck = new Alarm(this, 'ProcessingQueueStuck', {
      alarmName: `${PROJECT}-processing-queue-stuck`,
      alarmDescription:
        'The oldest message in the processing queue is over 1 hour old: the processor is not consuming.',
      metric: pipeline.queue.metricApproximateAgeOfOldestMessage({
        statistic: 'Maximum',
        period,
      }),
      threshold: QUEUE_AGE_THRESHOLD.toSeconds(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const rejectedRate = new Alarm(this, 'RejectedFileRate', {
      alarmName: `${PROJECT}-rejected-file-rate`,
      alarmDescription:
        `More than ${REJECTED_RATE_PERCENT} % of files were rejected in the last hour ` +
        `(at least ${REJECTED_RATE_MIN_FILES} files). Check FilesRejected by reason.`,
      metric: new MathExpression({
        label: 'Rejected file rate (%)',
        expression:
          `IF((FILL(v, 0) + FILL(r, 0)) >= ${REJECTED_RATE_MIN_FILES}, ` +
          '100 * FILL(r, 0) / (FILL(v, 0) + FILL(r, 0)), 0)',
        usingMetrics: { v: custom('FilesValidated'), r: custom('FilesRejected') },
        period: Duration.hours(1),
      }),
      threshold: REJECTED_RATE_PERCENT,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    this.alarms = [dlq, errors, stuck, rejectedRate];
    const action: IAlarmAction = new SnsAction(props.topic);
    for (const alarm of this.alarms) {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }
  }
}
