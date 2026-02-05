import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";

interface CertStackProps extends cdk.StackProps {
    zoneName: string;
    domainName: string;
}

export class CertStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CertStackProps) {
        super(scope, id, props);

        const zone = route53.HostedZone.fromLookup(this, "Zone", {
            domainName: props.zoneName,
        });

        const cert = new acm.Certificate(this, "Cert", {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        new cdk.CfnOutput(this, "CertificateArn", {
            value: cert.certificateArn,
        });
    }
}
