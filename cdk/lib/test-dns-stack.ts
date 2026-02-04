import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";

export class TestDnsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const zone = new route53.PublicHostedZone(this, "TestZone", {
            zoneName: "test.emotix.net",
        });

        const cfnZone = zone.node.defaultChild as route53.CfnHostedZone;

        new cdk.CfnOutput(this, "TestZoneId", { value: zone.hostedZoneId });

        new cdk.CfnOutput(this, "TestZoneNameServers", {
            value: cdk.Fn.join(",", cfnZone.attrNameServers),
        });
    }
}
