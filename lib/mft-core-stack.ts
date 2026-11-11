import { Stack } from 'aws-cdk-lib';

/**
 * D9: persistent, near-free stack (KMS, buckets, DynamoDB, EventBridge,
 * processing Lambda, DLQ, alarms, partner secrets, budget).
 *
 * Phase 0 ships it empty so CI, cdk-nag and synth are wired end to end.
 * Resources (and an explicit constructor) land in Phase 1.
 */
export class MftCoreStack extends Stack {}
