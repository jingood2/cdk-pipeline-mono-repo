import * as apigwv2 from '@aws-cdk/aws-apigatewayv2';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import { Tracing } from '@aws-cdk/aws-lambda';
import * as awslog from '@aws-cdk/aws-logs';
import * as s3 from '@aws-cdk/aws-s3';
import { App, CfnOutput, CfnParameter, Construct, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // ###################################################
    // CloudFormation Parameters
    // ###################################################
    const githubWebhookSecret = new CfnParameter(this, 'GitHubSecret', {
      type: 'String',
      description: 'GitHub Webhook HMAC Secret',
      default: 'webhooksecret',
    });
    const cgS3BucketName = new CfnParameter(this, 'ConfigStorageS3BucketName', {
      type: 'String',
      description: 'S3 bucket name for storage of configuration',
      default: `${this.stackName}-tools-monorepo-configuration`,
    });
    const cgS3Prefix = new CfnParameter(this, 'ConfigStoragePrefix', {
      type: 'String',
      description: 'S3 Object Prefix',
      default: 'mono-repo/config',
    });

    /* const accountName = new CfnParameter(this, 'AccountName', {
      type: 'String',
      description: 'AWS Account Name for prefixing things',
      default: 'tools',
    });
 */
    // ###################################################
    // S3 Bucket
    // ###################################################
    const cgStorageBucket = new s3.Bucket(this, 'ConfigStorageBucket', {
      bucketName: cgS3BucketName.valueAsString,
      removalPolicy: RemovalPolicy.RETAIN,
    });


    // ###################################################
    // Lambda Functions
    // ###################################################

    /* gitHubWebhookFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [],
      actions: [],
    })); */

    const gitHubEventEvalFn = new lambda.Function(this, 'GitHubEventEvalFunction', {
      runtime: lambda.Runtime.PYTHON_3_8, // required
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda-fns/eval'),
      tracing: Tracing.ACTIVE,
      environment: {
        S3_BUCKET: cgS3BucketName.valueAsString,
        S3_PREFIX: cgS3Prefix.valueAsString,
      },
    });

    gitHubEventEvalFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: ['codepipeline:*'],
    }));
    gitHubEventEvalFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [`${cgStorageBucket.bucketArn}/*`],
      actions: ['s3:*'],
    }));

    const gitHubWebhookFn = new lambda.Function(this, 'GitHubWebhookFunction', {
      runtime: lambda.Runtime.PYTHON_3_8, // required
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda-fns/webhook'),
      tracing: Tracing.ACTIVE,
      environment: {
        GITHUB_SECRET: githubWebhookSecret.valueAsString,
        EVAL_FUNCTION_ARN: gitHubEventEvalFn.functionArn,
      },
    });

    gitHubWebhookFn.node.addDependency(gitHubEventEvalFn);


    gitHubEventEvalFn.grantInvoke(gitHubWebhookFn);


    const monoRepoS3Role = new iam.Role(this, 'MonoRepoS3Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    monoRepoS3Role.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'events:*',
        'logs:*',
      ],
      resources: ['*'],
    }));
    monoRepoS3Role.addToPolicy(new iam.PolicyStatement({
      sid: 'S3Access',
      effect: iam.Effect.ALLOW,
      actions: ['s3:*'],
      resources: [`${cgStorageBucket.bucketArn}/*`],
    }));

    const monorepoCfResourceFn = new lambda.Function(this, 'MonoRepoS3ConfigCloudFormationResourceFunction', {
      runtime: lambda.Runtime.PYTHON_3_8, // required
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/lambda-fns/invokepipeline'),
      tracing: Tracing.ACTIVE,
      environment: {
        S3_BUCKET: cgS3BucketName.valueAsString,
        S3_PREFIX: cgS3Prefix.valueAsString,
      },
      role: monoRepoS3Role,
    });


    // ###################################################
    // API Gateway and routes
    // ###################################################
    const accessLogs = new awslog.LogGroup(this, 'AccessLog', {
      logGroupName: '/aws/api/GitHubIntegrationS3',
      retention: 1,
    });

    const httpAPI = new apigwv2.HttpApi(this, 'HttpApi', { });

    const stage = httpAPI.defaultStage?.node.defaultChild as apigwv2.CfnStage;

    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        userAgent: '$context.identity.userAgent',
        sourceIp: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        requestTimeEpoch: '$context.requestTimeEpoch',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        domainName: '$context.domainName',
      }),
    };

    const role = new iam.Role(this, 'ApiGWLogWriterRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    const policy = new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
        'logs:PutLogEvents',
        'logs:GetLogEvents',
        'logs:FilterLogEvents',
      ],
      resources: ['*'],
    });

    role.addToPolicy(policy);
    accessLogs.grantWrite(role);

    const webhookIntegration = new HttpLambdaIntegration('WebhookIntegration', gitHubWebhookFn);

    httpAPI.addRoutes({
      path: '/jingood2/push',
      methods: [apigwv2.HttpMethod.POST],
      integration: webhookIntegration,
    });


    // ###################################################
    // CloudFormation Output
    // ###################################################
    new CfnOutput(this, 'GitHubWebhookEndpoint', {
      description: 'GitHub webhook endpoint URL',
      value: `https://${httpAPI.httpApiId}.execute-api.ap-northeast-2.amazonaws.com/jingood2/push`,
    });

    new CfnOutput(this, 'HttpApiId', {
      description: 'HTTP API Id',
      value: httpAPI.httpApiId,
    });

    new CfnOutput(this, 'MonoRepoS3RoleOut', {
      description: 'Role ARN for S3 CF resource',
      value: monoRepoS3Role.roleArn,
    });

    //cfnOutputRole.exportName( `${accountName.valueAsString}-MonoRepoTriggerRole`);

    new CfnOutput(this, 'MonoRepoS3ConfigCloudFormationResourceFunctionOutput', {
      description: 'Role ARN for mono repo cloud formation s3 config function',
      value: monorepoCfResourceFn.functionArn,
    });

    //cfnOutputResoureFunction.exportName(`${accountName.valueAsString}-MonoReporter`);

  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEPLOY_ACCOUNT,
  region: process.env.CDK_DEPLOY_REGION,
};

const app = new App();

new MyStack(app, 'my-stack-dev', { env: devEnv });
// new MyStack(app, 'my-stack-prod', { env: prodEnv });

app.synth();