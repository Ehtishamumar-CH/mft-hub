import { CfnElement, SecretValue, Stack, Validations } from 'aws-cdk-lib';
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Partner } from '../partners';

export const PARTNER_SECRET_PREFIX = 'mft/partners/';

export interface PartnerAccessProps {
  readonly partners: readonly Partner[];
  readonly key: IKey;
  readonly landingBucket: IBucket;
  readonly processedBucket: IBucket;
  readonly quarantineBucket: IBucket;
}

/**
 * D4 / D13 / D20: per-partner identity records and the one IAM role that
 * Transfer Family assumes for every partner session.
 *
 * The role is the ceiling for all partners together. The IdP Lambda narrows
 * each session to one partner's prefixes with a session policy, so the
 * effective permission is role ∩ session policy.
 */
export class PartnerAccess extends Construct {
  public readonly role: Role;
  public readonly secrets: ReadonlyMap<string, Secret>;

  constructor(scope: Construct, id: string, props: PartnerAccessProps) {
    super(scope, id);
    const { account, region } = Stack.of(this);
    const { key, landingBucket, processedBucket, quarantineBucket } = props;

    this.role = new Role(this, 'Role', {
      description: 'Assumed by Transfer Family for partner SFTP sessions (scoped per session)',
      // Confused-deputy protection per the Transfer Family IAM guide.
      assumedBy: new ServicePrincipal('transfer.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:transfer:${region}:${account}:user/*` },
        },
      }),
      inlinePolicies: {
        PartnerData: new PolicyDocument({
          statements: [
            new PolicyStatement({
              sid: 'ListPartnerBuckets',
              actions: ['s3:ListBucket'],
              resources: [
                landingBucket.bucketArn,
                processedBucket.bucketArn,
                quarantineBucket.bucketArn,
              ],
            }),
            new PolicyStatement({
              sid: 'WriteInbound',
              actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
              resources: [landingBucket.arnForObjects('inbound/*')],
            }),
            new PolicyStatement({
              sid: 'ReadResults',
              actions: ['s3:GetObject', 's3:GetObjectVersion'],
              resources: [
                processedBucket.arnForObjects('*'),
                quarantineBucket.arnForObjects('rejected/*'),
              ],
            }),
            new PolicyStatement({
              sid: 'UseDataKeyViaS3',
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: [key.keyArn],
              conditions: { StringEquals: { 'kms:ViaService': `s3.${region}.amazonaws.com` } },
            }),
          ],
        }),
      },
    });
    const stack = Stack.of(this);
    const arnRef = (b: IBucket) => `<${stack.getLogicalId(b.node.defaultChild as CfnElement)}.Arn>`;
    for (const resource of [
      `${arnRef(landingBucket)}/inbound/*`,
      `${arnRef(processedBucket)}/*`,
      `${arnRef(quarantineBucket)}/rejected/*`,
    ]) {
      Validations.of(this.role).acknowledge({
        id: `AwsSolutions::AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          'Ceiling for all partners under a fixed prefix. The IdP Lambda narrows every session ' +
          'to one partner prefix with a session policy (D20).',
      });
    }

    const secrets = new Map<string, Secret>();
    for (const partner of props.partners) {
      const secret = new Secret(this, `Secret${partner.id}`, {
        secretName: `${PARTNER_SECRET_PREFIX}${partner.id}`,
        description: `MFT Hub SFTP identity for partner ${partner.id}`,
        encryptionKey: key,
        // Public keys and IP allowlists only: nothing here is confidential (D13).
        secretStringValue: SecretValue.unsafePlainText(
          JSON.stringify({
            partnerId: partner.id,
            name: partner.name,
            enabled: true,
            publicKeys: partner.sshPublicKeys,
            sourceIps: partner.sourceIps,
          }),
        ),
      });
      Validations.of(secret).acknowledge({
        id: 'AwsSolutions-SMG4',
        reason:
          'Holds public SSH keys, not credentials. Keys are rotated by a partners.json PR and cdk deploy (D13).',
      });
      secrets.set(partner.id, secret);
    }
    this.secrets = secrets;
  }
}
