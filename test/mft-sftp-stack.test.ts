import { Match, Template } from 'aws-cdk-lib/assertions';
import { MftCoreStack } from '../lib/mft-core-stack';
import { MftSftpStack, SFTP_SECURITY_POLICY } from '../lib/mft-sftp-stack';
import { loadPartners, parsePartners } from '../lib/partners';
import { testApp } from './helpers';

const ENV = { account: '111111111111', region: 'eu-central-2' };
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIoTVMmYTO3uNGowwziM0qw9tX/LHtw4AMRzt3JyCKd8 a@b';

function build() {
  const app = testApp();
  const core = new MftCoreStack(app, 'Core', { env: ENV, partners: loadPartners() });
  const sftp = new MftSftpStack(app, 'Sftp', { env: ENV, core });
  return { core, sftp, coreT: Template.fromStack(core), sftpT: Template.fromStack(sftp) };
}

describe('partners.json (D13)', () => {
  test('repo config is valid and has the demo partners', () => {
    const partners = loadPartners();
    expect(partners.map((p) => p.id)).toEqual(['ACMEBANK', 'GLOBEX']);
    for (const p of partners) expect(p.sshPublicKeys.length).toBeGreaterThan(0);
  });

  test('never contains a private key', () => {
    const raw = JSON.stringify(loadPartners());
    expect(raw).not.toMatch(/PRIVATE KEY/);
  });

  test.each([
    [{ id: 'acme', name: 'x', sshPublicKeys: [KEY] }, /id must match/],
    [{ id: '../X', name: 'x', sshPublicKeys: [KEY] }, /id must match/],
    [{ id: 'ACME', name: 'x', sshPublicKeys: [] }, /at least one key/],
    [{ id: 'ACME', name: 'x', sshPublicKeys: ['not a key'] }, /not an OpenSSH public key/],
    [{ id: 'ACME', name: 'x', sshPublicKeys: [KEY], sourceIps: ['nope'] }, /not an IP/],
    [{ id: 'ACME', name: '', sshPublicKeys: [KEY] }, /name is required/],
  ])('rejects invalid partner %#', (partner, message) => {
    expect(() => parsePartners({ partners: [partner] })).toThrow(message);
  });

  test('rejects duplicate IDs', () => {
    const p = { id: 'ACME', name: 'x', sshPublicKeys: [KEY] };
    expect(() => parsePartners({ partners: [p, p] })).toThrow(/duplicated/);
  });
});

describe('MftCoreStack partner access (D4, D20)', () => {
  const { coreT } = build();

  test('one KMS-encrypted secret per partner under mft/partners/', () => {
    coreT.resourceCountIs('AWS::SecretsManager::Secret', 2);
    for (const id of ['ACMEBANK', 'GLOBEX']) {
      coreT.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `mft/partners/${id}`,
        KmsKeyId: Match.anyValue(),
        SecretString: Match.stringLikeRegexp(`"partnerId":"${id}".*"enabled":true`),
      });
    }
  });

  test('partner role trusts only Transfer Family users in this account', () => {
    coreT.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'transfer.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': ENV.account },
              ArnLike: { 'aws:SourceArn': `arn:aws:transfer:eu-central-2:${ENV.account}:user/*` },
            },
          }),
        ],
      },
    });
  });

  test('partner role cannot delete objects and uses KMS only via S3', () => {
    const roles = coreT.findResources('AWS::IAM::Role', {
      Properties: { Description: Match.stringLikeRegexp('Transfer Family') },
    });
    const text = JSON.stringify(roles);
    expect(text).not.toMatch(/s3:Delete/);
    expect(text).toContain('"kms:ViaService":"s3.eu-central-2.amazonaws.com"');
  });

  test('Transfer log group is retained with a retention period', () => {
    coreT.hasResource('AWS::Logs::LogGroup', {
      Properties: { RetentionInDays: 365 },
      DeletionPolicy: 'Retain',
    });
  });
});

describe('MftSftpStack (D4, D9, D10)', () => {
  const { sftp, sftpT } = build();

  test('public SFTP-only server, Lambda IdP, SSH keys only, current security policy', () => {
    sftpT.resourceCountIs('AWS::Transfer::Server', 1);
    sftpT.hasResourceProperties('AWS::Transfer::Server', {
      EndpointType: 'PUBLIC',
      Protocols: ['SFTP'],
      Domain: 'S3',
      IdentityProviderType: 'AWS_LAMBDA',
      IdentityProviderDetails: Match.objectLike({ SftpAuthenticationMethods: 'PUBLIC_KEY' }),
      SecurityPolicyName: SFTP_SECURITY_POLICY,
      StructuredLogDestinations: [Match.anyValue()],
    });
  });

  test('IdP Lambda: Python 3.12 arm64, 128 MB, 10 s, all config from env', () => {
    sftpT.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Architectures: ['arm64'],
      Handler: 'mft_lambdas.idp.handler',
      MemorySize: 128,
      Timeout: 10,
      Environment: {
        Variables: {
          PARTNER_SECRET_PREFIX: 'mft/partners/',
          PARTNER_ROLE_ARN: Match.anyValue(),
          LANDING_BUCKET: Match.anyValue(),
          PROCESSED_BUCKET: Match.anyValue(),
          QUARANTINE_BUCKET: Match.anyValue(),
          KMS_KEY_ARN: Match.anyValue(),
        },
      },
    });
  });

  test('only this server may invoke the IdP', () => {
    sftpT.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'transfer.amazonaws.com',
      SourceAccount: ENV.account,
      SourceArn: {
        'Fn::GetAtt': [sftp.getLogicalId(sftp.server), 'Arn'],
      },
    });
  });

  test('IdP role reads only partner secrets and decrypts only via Secrets Manager', () => {
    sftpT.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Resource: `arn:aws:secretsmanager:eu-central-2:${ENV.account}:secret:mft/partners/*`,
          }),
          Match.objectLike({
            Action: 'kms:Decrypt',
            Condition: {
              StringEquals: { 'kms:ViaService': 'secretsmanager.eu-central-2.amazonaws.com' },
            },
          }),
        ]),
      },
    });
    sftpT.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    const roles = JSON.stringify(sftpT.findResources('AWS::IAM::Role'));
    expect(roles).not.toContain('ManagedPolicyArns');
  });

  test('SFTP stack is not termination-protected (D9 teardown)', () => {
    expect(sftp.terminationProtection).toBe(false);
  });
});
