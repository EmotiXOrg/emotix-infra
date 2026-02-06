import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";

interface ManagementDnsStackProps extends cdk.StackProps {
    parentZoneName: string;            // emotix.net
    delegatedSubdomain: string;        // test.emotix.net
    delegatedNameServers: string[];    // NS from test zone

    // Email DNS (for emotix.net root)
    mxRecords?: { hostName: string; priority: number }[];
    spfValue?: string;                // e.g. "v=spf1 include:... ~all"
    dmarcValue?: string;              // e.g. "v=DMARC1; p=none; rua=mailto:..."
    dkimTxts?: { name: string; value: string }[]; // selectors as CNAMEs
    verificationTxt?: { name: string; value: string }[]; // provider-specific
}

export class ManagementDnsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ManagementDnsStackProps) {
        super(scope, id, props);

        const parentZone = route53.HostedZone.fromLookup(this, "ParentZone", {
            domainName: props.parentZoneName,
        });

        // Delegate test.emotix.net to the test account hosted zone
        new route53.NsRecord(this, "DelegateTestSubdomain", {
            zone: parentZone,
            recordName: "test",
            values: props.delegatedNameServers,
            ttl: cdk.Duration.minutes(5),
        });

        // --- Email records for emotix.net (root) ---

        if (props.mxRecords?.length) {
            new route53.MxRecord(this, "MxRoot", {
                zone: parentZone,
                recordName: "", // root of emotix.net
                values: props.mxRecords.map(r => ({
                    hostName: r.hostName,
                    priority: r.priority,
                })),
                ttl: cdk.Duration.minutes(5),
            });
        }

        if (props.spfValue) {
            new route53.TxtRecord(this, "SpfRoot", {
                zone: parentZone,
                recordName: "", // root
                values: [props.spfValue],
                ttl: cdk.Duration.minutes(5),
            });
        }

        if (props.dmarcValue) {
            new route53.TxtRecord(this, "Dmarc", {
                zone: parentZone,
                recordName: "_dmarc",
                values: [props.dmarcValue],
                ttl: cdk.Duration.minutes(5),
            });
        }

        if (props.dkimTxts?.length) {
            props.dkimTxts.forEach((dkim, idx) => {
                new route53.TxtRecord(this, `DkimTxt${idx + 1}`, {
                    zone: parentZone,
                    recordName: dkim.name,           // zmail._domainkey
                    values: [dkim.value],            // v=DKIM1; k=rsa; p=...
                    ttl: cdk.Duration.minutes(5),
                });
            });
        }

        if (props.verificationTxt?.length) {
            props.verificationTxt.forEach((v, idx) => {
                new route53.TxtRecord(this, `VerificationTxt${idx + 1}`, {
                    zone: parentZone,
                    recordName: v.name, // some providers require specific hostnames
                    values: [v.value],
                    ttl: cdk.Duration.minutes(5),
                });
            });
        }
    }
}
