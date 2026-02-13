import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface StaticAssetsStackProps extends cdk.StackProps {
    /**
     * Root hosted zone, e.g. "emotix.net"
     */
    zoneName: string;

    /**
     * Full subdomain, e.g. "static.test.emotix.net"
     */
    staticDomainName: string;

    /**
     * ACM cert ARN (MUST be in us-east-1 for CloudFront).
     * You already store it in cdk.json as context.globalTestTlsCertArn.
     */
    globalCertArnUsEast1: string;
}

export class StaticAssetsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: StaticAssetsStackProps) {
        super(scope, id, props);

        const zone = route53.HostedZone.fromLookup(this, "HostedZone", {
            domainName: props.zoneName,
        });

        const bucket = new s3.Bucket(this, "StaticAssetsBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,

            // keep static bucket content safe by default
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: false,
        });

        const certificate = acm.Certificate.fromCertificateArn(
            this,
            "GlobalCertUsEast1",
            props.globalCertArnUsEast1
        );

        const distribution = new cloudfront.Distribution(this, "StaticAssetsDistribution", {
            comment: `Static assets CDN for ${props.staticDomainName}`,
            domainNames: [props.staticDomainName],
            certificate,

            // Static CDN: no SPA rewrite, no default root object needed.
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                compress: true,

                // Great default for static content. You can override per-path later if needed.
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                // If you later want CORS headers for fonts/etc, add a responseHeadersPolicy here.
            },

            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        });

        // recordName for Route53 should be relative to zone.
        // "static.test.emotix.net" -> "static.test"
        const recordRelative =
            props.staticDomainName.endsWith(`.${props.zoneName}`)
                ? props.staticDomainName.slice(0, -(props.zoneName.length + 1))
                : props.staticDomainName;

        new route53.ARecord(this, "StaticAliasA", {
            zone,
            recordName: recordRelative,
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
        });

        new route53.AaaaRecord(this, "StaticAliasAAAA", {
            zone,
            recordName: recordRelative,
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
        });

        new cdk.CfnOutput(this, "StaticBucketName", { value: bucket.bucketName });
        new cdk.CfnOutput(this, "StaticDistributionId", { value: distribution.distributionId });
        new cdk.CfnOutput(this, "StaticUrl", { value: `https://${props.staticDomainName}` });
    }
}
