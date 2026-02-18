import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";

export interface SesStackProps extends cdk.StackProps {
    zoneName: string;
    domainName: string;
    fromEmailAddress: string;
    replyToEmailAddress?: string;
    fromName?: string;
    mailFromDomain?: string;
}

export class SesStack extends cdk.Stack {
    public readonly identityArn: string;
    public readonly fromEmailAddress: string;
    public readonly replyToEmailAddress?: string;
    public readonly fromName?: string;

    constructor(scope: Construct, id: string, props: SesStackProps) {
        super(scope, id, props);

        const zone = route53.HostedZone.fromLookup(this, "SesZone", {
            domainName: props.zoneName,
        });

        const identity = new ses.EmailIdentity(this, "SesIdentity", {
            identity: ses.Identity.publicHostedZone(zone),
            mailFromDomain: props.mailFromDomain,
        });

        this.identityArn = identity.emailIdentityArn;
        this.fromEmailAddress = props.fromEmailAddress;
        this.replyToEmailAddress = props.replyToEmailAddress;
        this.fromName = props.fromName;

        new cdk.CfnOutput(this, "SesIdentityArn", { value: this.identityArn });
    }
}
