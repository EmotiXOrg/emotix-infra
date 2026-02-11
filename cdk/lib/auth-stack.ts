import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface AuthStackProps extends cdk.StackProps {
    /** Root hosted zone for the environment, e.g. "test.emotix.net" */
    zoneName: string;

    /** Custom auth domain we want for Cognito, e.g. "auth.test.emotix.net" */
    authDomainName: string;

    authCertificateArn: string;

    /** Where Cognito will redirect back after login, e.g. "https://test.emotix.net/auth/callback" */
    callbackUrls: string[];

    /** Where Cognito will redirect after logout, e.g. "https://test.emotix.net/logout" */
    logoutUrls: string[];

    /** SSM Parameter paths */
    googleClientIdParam: string;
    googleClientSecretParam: string;
    facebookAppIdParam: string;
    facebookAppSecretParam: string;
    googleClientSecretVersion?: number;
    facebookAppSecretVersion?: number;
}

export class AuthStack extends cdk.Stack {
    public readonly userPoolId: string;
    public readonly userPoolClientId: string;
    public readonly authDomain: string;

    constructor(scope: Construct, id: string, props: AuthStackProps) {
        super(scope, id, props);

        /**
         * Route53 hosted zone (already created by TestDnsStack).
         */
        const zone = route53.HostedZone.fromLookup(this, "Zone", {
            domainName: props.zoneName,
        });

        /**
         * 1) Cognito User Pool
         * - Email sign-in
         * - Self-signup enabled for MVP (you can disable later)
         * - Email verification enabled
         */
        const userPool = new cognito.UserPool(this, "UserPool", {
            userPoolName: `${id}-user-pool`,
            signInAliases: { email: true },
            selfSignUpEnabled: true,
            autoVerify: { email: true },
            standardAttributes: {
                email: { required: true, mutable: true },
            },
            passwordPolicy: {
                minLength: 10,
                requireDigits: true,
                requireLowercase: true,
                requireUppercase: false,
                requireSymbols: false,
                tempPasswordValidity: cdk.Duration.days(7),
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // TEST-friendly; override for PROD
        });

        /**
         * 2) Read IdP secrets from SSM Parameter Store (Standard tier)
         */
        // Non-secret values (String) – this is fine
        const googleClientId = ssm.StringParameter.valueForStringParameter(
            this,
            props.googleClientIdParam
        );

        const facebookAppId = ssm.StringParameter.valueForStringParameter(
            this,
            props.facebookAppIdParam
        );

        // Secret values (now as String) – require version
        // TODO: Use Secret Manager when prod and scale
        const googleClientSecret = ssm.StringParameter.valueForStringParameter(
            this,
            props.googleClientSecretParam
        );

        const facebookAppSecret = ssm.StringParameter.valueForStringParameter(
            this,
            props.facebookAppSecretParam
        );

        /**
         * 3) Identity Providers
         *
         * IMPORTANT:
         * Google/Facebook must have redirect URI registered:
         *   https://auth.test.emotix.net/oauth2/idpresponse
         */
        const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
            userPool,
            clientId: googleClientId,
            clientSecretValue: cdk.SecretValue.unsafePlainText(googleClientSecret),
            scopes: ["openid", "email", "profile"],
            attributeMapping: {
                email: cognito.ProviderAttribute.GOOGLE_EMAIL,
                givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
                familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
                profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
            },
        });

        const facebookIdp = new cognito.UserPoolIdentityProviderFacebook(this, "Facebook", {
            userPool,
            clientId: facebookAppId,
            clientSecret: facebookAppSecret,
            scopes: ["public_profile", "email", "user_birthday"],
            attributeMapping: {
                email: cognito.ProviderAttribute.FACEBOOK_EMAIL,
                givenName: cognito.ProviderAttribute.FACEBOOK_FIRST_NAME,
                familyName: cognito.ProviderAttribute.FACEBOOK_LAST_NAME,
                profilePicture: cognito.ProviderAttribute.other("picture"),
            },
        });

        /**
         * 4) App Client (OAuth Code + PKCE)
         * - Public client (no secret) because this is a SPA
         */
        const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
            userPool,
            generateSecret: false,
            authFlows: {
                userPassword: true,
                userSrp: true,
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                },
                scopes: [
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE,
                ],
                callbackUrls: props.callbackUrls,
                logoutUrls: props.logoutUrls,
            },
            supportedIdentityProviders: [
                cognito.UserPoolClientIdentityProvider.COGNITO,
                cognito.UserPoolClientIdentityProvider.GOOGLE,
                cognito.UserPoolClientIdentityProvider.FACEBOOK,
            ],
            preventUserExistenceErrors: true,
        });

        // Ensure IdPs exist before client wiring
        userPoolClient.node.addDependency(googleIdp);
        userPoolClient.node.addDependency(facebookIdp);

        /**
         * 5) Custom auth domain (auth.test.emotix.net)
         * Cert MUST be in the SAME REGION as the user pool (eu-central-1).
         */
        const authCert = acm.Certificate.fromCertificateArn(
            this,
            "AuthDomainCert",
            props.authCertificateArn
        );

        const domain = userPool.addDomain("UserPoolDomain", {
            customDomain: {
                domainName: props.authDomainName,
                certificate: authCert,
            },
        });

        /**
         * 6) Route53: Alias A record -> Cognito domain CloudFront distribution
         */
        const authRecordName = props.authDomainName.endsWith(`.${props.zoneName}`)
            ? props.authDomainName.slice(0, -(props.zoneName.length + 1))
            : props.authDomainName;

        new route53.ARecord(this, "AuthAliasA", {
            zone,
            recordName: authRecordName,
            target: route53.RecordTarget.fromAlias(new targets.UserPoolDomainTarget(domain)),
            ttl: cdk.Duration.minutes(1),
        });

        /**
         * Outputs (used by frontend build/deploy)
         */
        this.userPoolId = userPool.userPoolId;
        this.userPoolClientId = userPoolClient.userPoolClientId;
        this.authDomain = `https://${props.authDomainName}`;

        new cdk.CfnOutput(this, "UserPoolId", { value: this.userPoolId });
        new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClientId });
        new cdk.CfnOutput(this, "AuthDomainUrl", { value: this.authDomain });
        new cdk.CfnOutput(this, "Region", { value: cdk.Stack.of(this).region });
    }
}
