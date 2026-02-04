import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";

interface ManagementDnsStackProps extends cdk.StackProps {
    parentZoneName: string;            // emotix.net
    delegatedSubdomain: string;        // test.emotix.net
    delegatedNameServers: string[];    // NS from test zone
}

export class ManagementDnsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ManagementDnsStackProps) {
        super(scope, id, props);

        const parentZone = route53.HostedZone.fromLookup(this, "ParentZone", {
            domainName: props.parentZoneName,
        });

        // Создаём NS record "test" в зоне emotix.net
        // Значение: NS серверы зоны test.emotix.net из test аккаунта
        new route53.NsRecord(this, "DelegateTestSubdomain", {
            zone: parentZone,
            recordName: "test", // => test.emotix.net
            values: props.delegatedNameServers,
            ttl: cdk.Duration.minutes(5),
        });
    }
}
