import { join } from 'node:path';
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Token,
  Validations,
} from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnServer } from 'aws-cdk-lib/aws-transfer';
import { Construct } from 'constructs';
import { PARTNER_SECRET_PREFIX } from './constructs/partner-access';
import { MftCoreStack } from './mft-core-stack';

/** Newest non-FIPS SFTP policy in eu-central-2 (checked 2026-11-11). */
export const SFTP_SECURITY_POLICY = 'TransferSecurityPolicy-2025-03';

export interface MftSftpStackProps extends StackProps {
  readonly core: MftCoreStack;
}

/**
 * D9: the ephemeral, billable stack (~$0.30/h while it exists): the public
 * SFTP endpoint (D10) and its Lambda identity provider (D4). Tear it down
 * after demos; partner records, data and logs stay in MftCoreStack.
 */
export class MftSftpStack extends Stack {
  public readonly server: CfnServer;
  public readonly identityProvider: LambdaFunction;

  constructor(scope: Construct, id: string, props: MftSftpStackProps) {
    super(scope, id, props);
    const { core } = props;

    const idpLogGroup = new LogGroup(this, 'IdentityProviderLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Own role instead of AWSLambdaBasicExecutionRole: logs to one group only.
    const idpRole = new Role(this, 'IdentityProviderRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'MFT Hub SFTP identity provider: read partner records, write own logs',
    });
    idpLogGroup.grantWrite(idpRole);
    const partnerSecretsArn = this.formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: `${PARTNER_SECRET_PREFIX}*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    idpRole.addToPolicy(
      new PolicyStatement({
        sid: 'ReadPartnerRecords',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [partnerSecretsArn],
      }),
    );
    idpRole.addToPolicy(
      new PolicyStatement({
        sid: 'DecryptPartnerRecords',
        actions: ['kms:Decrypt'],
        resources: [core.key.keyArn],
        conditions: {
          StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` },
        },
      }),
    );
    Validations.of(idpRole).acknowledge({
      // cdk-nag renders an unresolved account token as <AWS::AccountId>.
      id:
        'AwsSolutions::AwsSolutions-IAM5[Resource::arn:aws:secretsmanager:' +
        `${this.region}:${Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account}` +
        `:secret:${PARTNER_SECRET_PREFIX}*]`,
      reason:
        'Fixed partner prefix mft/partners/*: any onboarded partner may log in, so the IdP must read any partner record.',
    });

    this.identityProvider = new LambdaFunction(this, 'IdentityProvider', {
      description: 'Transfer Family custom identity provider (SSH keys from Secrets Manager)',
      runtime: Runtime.PYTHON_3_12,
      architecture: Architecture.ARM_64,
      handler: 'mft_lambdas.idp.handler',
      code: Code.fromAsset(join(__dirname, '..', 'lambdas', 'src'), {
        exclude: ['**/__pycache__', '**/*.pyc'],
      }),
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: idpRole,
      logGroup: idpLogGroup,
      environment: {
        PARTNER_SECRET_PREFIX,
        PARTNER_ROLE_ARN: core.partnerAccess.role.roleArn,
        LANDING_BUCKET: core.landingBucket.bucketName,
        PROCESSED_BUCKET: core.processedBucket.bucketName,
        QUARANTINE_BUCKET: core.quarantineBucket.bucketName,
        KMS_KEY_ARN: core.key.keyArn,
      },
    });
    Validations.of(this.identityProvider).acknowledge({
      id: 'AwsSolutions-L1',
      reason:
        'D3 pins Python 3.12 so Lambda, CI and local tests match; revisit with the runtime upgrade.',
    });

    this.server = new CfnServer(this, 'Server', {
      endpointType: 'PUBLIC', // D10: VPC endpoint + IP allowlisting is a later phase
      protocols: ['SFTP'],
      domain: 'S3',
      identityProviderType: 'AWS_LAMBDA',
      identityProviderDetails: {
        function: this.identityProvider.functionArn,
        sftpAuthenticationMethods: 'PUBLIC_KEY', // D4: SSH keys only, no passwords
      },
      securityPolicyName: SFTP_SECURITY_POLICY,
      structuredLogDestinations: [core.transferLogGroup.logGroupArn],
      s3StorageOptions: { directoryListingOptimization: 'ENABLED' },
    });

    // Only this server may invoke the IdP (confused-deputy protection).
    this.identityProvider.addPermission('AllowTransferInvoke', {
      principal: new ServicePrincipal('transfer.amazonaws.com'),
      sourceArn: this.server.attrArn,
      sourceAccount: this.account,
    });

    new CfnOutput(this, 'ServerId', { value: this.server.attrServerId });
    new CfnOutput(this, 'SftpEndpoint', {
      value: `${this.server.attrServerId}.server.transfer.${this.region}.amazonaws.com`,
    });
  }
}
