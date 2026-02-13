import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { createSpaRouterFunction } from "./cloudfront/spa-router-function";

export interface WebStackProps extends cdk.StackProps {
    // DNS / TLS
    domainName: string;      // "test.emotix.net"
    zoneName: string;        // "test.emotix.net"
    certificateArn: string;  // ACM ARN in us-east-1

    /**
     * Bucket retention defaults (TEST-friendly).
     * For PROD you will override:
     *   - removalPolicy: RETAIN
     *   - autoDeleteObjects: false
     */
    removalPolicy?: cdk.RemovalPolicy;   // default: DESTROY
    autoDeleteObjects?: boolean;         // default: true

    /**
     * CloudFront access logging.
     * Default: disabled (test).
     * For PROD set enableLogging=true (optionally set logBucketNamePrefix).
     */
    enableLogging?: boolean;             // default: false
    logBucketNamePrefix?: string;        // optional prefix, default: "<stack>-cf-logs"

    /**
     * WAF (AWS WAFv2) Web ACL ARN (for CloudFront, scope must be CLOUDFRONT).
     * Default: undefined (no WAF in test).
     * For PROD provide webAclArn.
     */
    webAclArn?: string;
}

export class WebStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: WebStackProps) {
        super(scope, id, props);

        // ---- Defaults: good for TEST, can be overridden for PROD
        const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;
        const autoDeleteObjects = props.autoDeleteObjects ?? true;
        const enableLogging = props.enableLogging ?? false;
        const logBucketNamePrefix = props.logBucketNamePrefix ?? `${id.toLowerCase()}-cf-logs`;

        /**
         * 1) Private S3 bucket for website assets.
         * CloudFront will access it via OAC (no public access).
         */
        const siteBucket = new s3.Bucket(this, "EmotiX_WebSite", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,

            // TEST defaults:
            // - DESTROY + autoDeleteObjects = easier cleanup
            // PROD override:
            // - RETAIN + false
            removalPolicy,
            autoDeleteObjects,
        });

        /**
         * 2) Security headers policy for CloudFront.
         * This gives a solid baseline for modern web security.
         * - HSTS
         * - X-Content-Type-Options
         * - X-Frame-Options
         * - Referrer-Policy
         * - X-XSS-Protection (legacy but harmless)
         * CSP is optional; adding strict CSP too early can break apps.
         */
        const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
            this,
            "SecurityHeadersPolicy",
            {
                comment: "EmotiX baseline security headers",
                securityHeadersBehavior: {
                    strictTransportSecurity: {
                        accessControlMaxAge: cdk.Duration.days(365),
                        includeSubdomains: true,
                        preload: true,
                        override: true,
                    },
                    contentTypeOptions: { override: true },
                    frameOptions: {
                        frameOption: cloudfront.HeadersFrameOption.DENY,
                        override: true,
                    },
                    referrerPolicy: {
                        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                        override: true,
                    },
                    xssProtection: {
                        protection: true,
                        modeBlock: true,
                        override: true,
                    },
                    // Content Security Policy is powerful but can break JS apps if too strict.
                    // Add later when you know your frontend resources & domains.
                    // contentSecurityPolicy: {
                    //   contentSecurityPolicy: "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self';",
                    //   override: true,
                    // },
                },
            }
        );

        /**
         * 3) Optional CloudFront logs bucket (only if enabled).
         * For PROD you usually want this (and then ship logs to Athena/SIEM).
         */
        let logsBucket: s3.IBucket | undefined;
        if (enableLogging) {
            logsBucket = new s3.Bucket(this, "CloudFrontLogsBucket", {
                bucketName: undefined, // let AWS generate a unique name
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,

                // Logs are usually retained even in test, but we follow the same defaults pattern.
                removalPolicy,
                autoDeleteObjects,
            });

            // Optional: prefix for log object keys
            new cdk.CfnOutput(this, "CloudFrontLogsBucketName", { value: logsBucket.bucketName });
        }

        /**
         * 4) Certificate (must be us-east-1 for CloudFront)
         */
        const cert = acm.Certificate.fromCertificateArn(this, "Cert", props.certificateArn);

        /**
         * 5) CloudFront distribution
         * - OAC for S3
         * - HTTPS redirect
         * - security headers policy
         * - optional WAF
         * - optional access logging
         */
        const spaRouterFn = createSpaRouterFunction(this);
        const distribution = new cloudfront.Distribution(this, "Distribution", {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                responseHeadersPolicy: securityHeadersPolicy,
                functionAssociations: [
                    {
                        function: spaRouterFn,
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    },
                ],
            },

            domainNames: [props.domainName],
            certificate: cert,
            defaultRootObject: "index.html",
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,

            // WAF is off by default; enable in prod by passing webAclArn
            webAclId: props.webAclArn,

            // Logging off by default; enable in prod
            enableLogging,
            logBucket: logsBucket,
            logFilePrefix: `${logBucketNamePrefix}/`,
        });

        /**
         * 6) Route53: Alias A/AAAA to CloudFront
         */
        const zone = route53.HostedZone.fromLookup(this, "Zone", {
            domainName: props.zoneName,
        });

        new route53.ARecord(this, "AliasA", {
            zone,
            recordName: props.domainName,
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
            ttl: cdk.Duration.minutes(1),
        });

        new route53.AaaaRecord(this, "AliasAAAA", {
            zone,
            recordName: props.domainName,
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
            ttl: cdk.Duration.minutes(1),
        });

        /**
         * 7) Outputs
         */
        new cdk.CfnOutput(this, "CloudFrontDistributionId", {
            value: distribution.distributionId,
        });
        new cdk.CfnOutput(this, "CloudFrontDomainName", { value: distribution.domainName });
        new cdk.CfnOutput(this, "BucketName", { value: siteBucket.bucketName });
    }
}
