import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";

export interface TlsCertStackProps extends cdk.StackProps {
    /**
     * Hosted zone name, e.g. "test.emotix.net"
     * Must exist (created by your TestDnsStack).
     */
    zoneName: string;

    /**
     * Base domain we want covered, e.g. "test.emotix.net"
     * We'll also cover wildcard "*.test.emotix.net"
     */
    baseDomainName: string;

    /**
     * If true, we retain the ACM cert on stack deletion (recommended for safety).
     */
    retainOnDelete?: boolean;
}

export class TlsCertStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props: TlsCertStackProps) {
        super(scope, id, props);

        const zone = route53.HostedZone.fromLookup(this, "Zone", {
            domainName: props.zoneName,
        });

        // One cert that covers both:
        // - test.emotix.net
        // - *.test.emotix.net
        const cert = new acm.Certificate(this, "TlsCert", {
            domainName: props.baseDomainName,
            subjectAlternativeNames: [`*.${props.baseDomainName}`],
            validation: acm.CertificateValidation.fromDns(zone),
        });

        if (props.retainOnDelete ?? true) {
            cert.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        }

        new cdk.CfnOutput(this, "CertificateArn", {
            value: cert.certificateArn,
        });
    }
}
