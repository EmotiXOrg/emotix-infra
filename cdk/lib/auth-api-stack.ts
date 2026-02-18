import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "node:path";

import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";

export interface AuthApiStackProps extends cdk.StackProps {
    zoneName: string;
    apiDomainName: string;
    regionalCertificateArn: string;
    allowedOrigins: string[];

    userPoolId: string;
    userPoolClientId: string;
    usersTableName: string;
    userAuthMethodsTableName: string;
    authAuditLogTableName: string;
}

export class AuthApiStack extends cdk.Stack {
    public readonly apiBaseUrl: string;

    constructor(scope: Construct, id: string, props: AuthApiStackProps) {
        super(scope, id, props);

        const userPool = cognito.UserPool.fromUserPoolId(this, "AuthApiUserPool", props.userPoolId);
        const userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
            this,
            "AuthApiUserPoolClient",
            props.userPoolClientId
        );

        const userAuthMethodsTable = dynamodb.Table.fromTableName(
            this,
            "AuthApiUserAuthMethodsTable",
            props.userAuthMethodsTableName
        );
        const authAuditLogTable = dynamodb.Table.fromTableName(
            this,
            "AuthApiAuthAuditLogTable",
            props.authAuditLogTableName
        );

        const discoverFn = new lambda.Function(this, "DiscoverAuthFn", {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "auth-api", "discover")),
            timeout: cdk.Duration.seconds(10),
            environment: {
                USER_POOL_ID: props.userPoolId,
                USER_AUTH_METHODS_TABLE_NAME: props.userAuthMethodsTableName,
                LOG_LEVEL: "INFO",
            },
        });

        const setPasswordFn = new lambda.Function(this, "SetPasswordAuthFn", {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "auth-api", "set-password")),
            timeout: cdk.Duration.seconds(10),
            environment: {
                USER_POOL_ID: props.userPoolId,
                USER_AUTH_METHODS_TABLE_NAME: props.userAuthMethodsTableName,
                AUTH_AUDIT_LOG_TABLE_NAME: props.authAuditLogTableName,
                LOG_LEVEL: "INFO",
            },
        });

        const methodsFn = new lambda.Function(this, "GetMethodsAuthFn", {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "auth-api", "methods")),
            timeout: cdk.Duration.seconds(10),
            environment: {
                USER_AUTH_METHODS_TABLE_NAME: props.userAuthMethodsTableName,
                USER_POOL_ID: props.userPoolId,
                LOG_LEVEL: "INFO",
            },
        });

        const passwordSetupStartFn = new lambda.Function(this, "PasswordSetupStartFn", {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "auth-api", "password-setup-start")),
            timeout: cdk.Duration.seconds(10),
            environment: {
                USER_POOL_ID: props.userPoolId,
                USER_POOL_CLIENT_ID: props.userPoolClientId,
                LOG_LEVEL: "INFO",
            },
        });

        const passwordSetupCompleteFn = new lambda.Function(this, "PasswordSetupCompleteFn", {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "auth-api", "password-setup-complete")),
            timeout: cdk.Duration.seconds(10),
            environment: {
                USER_POOL_ID: props.userPoolId,
                USER_POOL_CLIENT_ID: props.userPoolClientId,
                USER_AUTH_METHODS_TABLE_NAME: props.userAuthMethodsTableName,
                AUTH_AUDIT_LOG_TABLE_NAME: props.authAuditLogTableName,
                LOG_LEVEL: "INFO",
            },
        });

        discoverFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "DiscoverReadCognitoUsers",
                actions: ["cognito-idp:ListUsers"],
                resources: [userPool.userPoolArn],
            })
        );
        userAuthMethodsTable.grantReadData(discoverFn);

        setPasswordFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "SetPasswordAdminFlow",
                actions: ["cognito-idp:AdminSetUserPassword"],
                resources: [userPool.userPoolArn],
            })
        );
        userAuthMethodsTable.grantWriteData(setPasswordFn);
        authAuditLogTable.grantWriteData(setPasswordFn);

        userAuthMethodsTable.grantReadData(methodsFn);
        methodsFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "MethodsReadCognitoUsers",
                actions: ["cognito-idp:ListUsers"],
                resources: [userPool.userPoolArn],
            })
        );

        passwordSetupStartFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "PasswordSetupStartCognitoAccess",
                actions: ["cognito-idp:SignUp", "cognito-idp:ResendConfirmationCode"],
                resources: ["*"],
            })
        );

        passwordSetupCompleteFn.addToRolePolicy(
            new iam.PolicyStatement({
                sid: "PasswordSetupCompleteCognitoAccess",
                actions: [
                    "cognito-idp:ConfirmSignUp",
                    "cognito-idp:AdminSetUserPassword",
                    "cognito-idp:ListUsers",
                ],
                resources: ["*"],
            })
        );
        userAuthMethodsTable.grantWriteData(passwordSetupCompleteFn);
        authAuditLogTable.grantWriteData(passwordSetupCompleteFn);

        const userPoolAuthorizer = new authorizers.HttpUserPoolAuthorizer("UserPoolAuthorizer", userPool, {
            userPoolClients: [userPoolClient],
        });

        const httpApi = new apigwv2.HttpApi(this, "AuthHttpApi", {
            corsPreflight: {
                allowOrigins: props.allowedOrigins,
                allowMethods: [
                    apigwv2.CorsHttpMethod.GET,
                    apigwv2.CorsHttpMethod.POST,
                    apigwv2.CorsHttpMethod.OPTIONS,
                ],
                allowHeaders: ["authorization", "content-type"],
                maxAge: cdk.Duration.hours(1),
            },
        });

        httpApi.addRoutes({
            path: "/auth/discover",
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration("DiscoverAuthIntegration", discoverFn),
        });

        httpApi.addRoutes({
            path: "/auth/set-password",
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration("SetPasswordAuthIntegration", setPasswordFn),
            authorizer: userPoolAuthorizer,
        });

        httpApi.addRoutes({
            path: "/auth/methods",
            methods: [apigwv2.HttpMethod.GET],
            integration: new integrations.HttpLambdaIntegration("GetMethodsAuthIntegration", methodsFn),
            authorizer: userPoolAuthorizer,
        });

        httpApi.addRoutes({
            path: "/auth/password-setup/start",
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration("PasswordSetupStartIntegration", passwordSetupStartFn),
        });

        httpApi.addRoutes({
            path: "/auth/password-setup/complete",
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration("PasswordSetupCompleteIntegration", passwordSetupCompleteFn),
        });

        const cert = acm.Certificate.fromCertificateArn(this, "AuthApiRegionalCert", props.regionalCertificateArn);
        const domainName = new apigwv2.DomainName(this, "AuthApiDomainName", {
            domainName: props.apiDomainName,
            certificate: cert,
        });

        new apigwv2.ApiMapping(this, "AuthApiMapping", {
            api: httpApi,
            domainName,
            stage: httpApi.defaultStage,
        });

        const zone = route53.HostedZone.fromLookup(this, "AuthApiZone", {
            domainName: props.zoneName,
        });

        new route53.ARecord(this, "AuthApiAliasA", {
            zone,
            recordName: props.apiDomainName.endsWith(`.${props.zoneName}`)
                ? props.apiDomainName.slice(0, -(props.zoneName.length + 1))
                : props.apiDomainName,
            target: route53.RecordTarget.fromAlias(
                new targets.ApiGatewayv2DomainProperties(
                    domainName.regionalDomainName,
                    domainName.regionalHostedZoneId
                )
            ),
        });

        new route53.AaaaRecord(this, "AuthApiAliasAAAA", {
            zone,
            recordName: props.apiDomainName.endsWith(`.${props.zoneName}`)
                ? props.apiDomainName.slice(0, -(props.zoneName.length + 1))
                : props.apiDomainName,
            target: route53.RecordTarget.fromAlias(
                new targets.ApiGatewayv2DomainProperties(
                    domainName.regionalDomainName,
                    domainName.regionalHostedZoneId
                )
            ),
        });

        /**
         * Baseline API/handler alarms.
         */
        const discoverErrorsAlarm = new cloudwatch.Alarm(this, "DiscoverAuthFnErrorsAlarm", {
            metric: discoverFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "sum" }),
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "Discover auth Lambda errors.",
        });
        const setPasswordErrorsAlarm = new cloudwatch.Alarm(this, "SetPasswordAuthFnErrorsAlarm", {
            metric: setPasswordFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "sum" }),
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "Set-password Lambda errors.",
        });
        const methodsErrorsAlarm = new cloudwatch.Alarm(this, "GetMethodsAuthFnErrorsAlarm", {
            metric: methodsFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "sum" }),
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "Get-methods Lambda errors.",
        });
        const passwordSetupStartErrorsAlarm = new cloudwatch.Alarm(this, "PasswordSetupStartFnErrorsAlarm", {
            metric: passwordSetupStartFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "sum" }),
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "Password setup start Lambda errors.",
        });
        const passwordSetupCompleteErrorsAlarm = new cloudwatch.Alarm(this, "PasswordSetupCompleteFnErrorsAlarm", {
            metric: passwordSetupCompleteFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "sum" }),
            threshold: 1,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "Password setup complete Lambda errors.",
        });
        const api5xxAlarm = new cloudwatch.Alarm(this, "AuthApi5xxAlarm", {
            metric: httpApi.metricServerError({ period: cdk.Duration.minutes(5), statistic: "sum" }),
            threshold: 5,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: "Auth API 5xx responses exceeded threshold.",
        });

        this.apiBaseUrl = `https://${props.apiDomainName}`;

        new cdk.CfnOutput(this, "AuthApiBaseUrl", { value: this.apiBaseUrl });
        new cdk.CfnOutput(this, "AuthHttpApiId", { value: httpApi.httpApiId });
        new cdk.CfnOutput(this, "DiscoverAuthFnErrorsAlarmName", { value: discoverErrorsAlarm.alarmName });
        new cdk.CfnOutput(this, "SetPasswordAuthFnErrorsAlarmName", { value: setPasswordErrorsAlarm.alarmName });
        new cdk.CfnOutput(this, "GetMethodsAuthFnErrorsAlarmName", { value: methodsErrorsAlarm.alarmName });
        new cdk.CfnOutput(this, "PasswordSetupStartFnErrorsAlarmName", { value: passwordSetupStartErrorsAlarm.alarmName });
        new cdk.CfnOutput(this, "PasswordSetupCompleteFnErrorsAlarmName", { value: passwordSetupCompleteErrorsAlarm.alarmName });
        new cdk.CfnOutput(this, "AuthApi5xxAlarmName", { value: api5xxAlarm.alarmName });
    }
}
