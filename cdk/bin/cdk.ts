import * as cdk from "aws-cdk-lib";
import { TestDnsStack } from "../lib/test-dns-stack";
import { ManagementDnsStack } from "../lib/management-dns-stack";
import { CertStack } from "../lib/global/cert-stack";
import { WebStack } from "../lib/web-stack";
import { BillingGuardrailsStack } from "../lib/global/billing-guardrails-stack";
import { AWS_MGMT_EMAIL, EU_CENTRAL_1_REGION, MGMT_ACCOUNT_ID, PROD_ACCOUNT_ID, TEST_ACCOUNT_ID, US_EAST_1_REGION } from "../constants";
import { AuthStack } from "../lib/auth-stack";

const app = new cdk.App();

// 1) Test DNS zone stack
new TestDnsStack(app, "EmotixTestDnsStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },
});

// 2) Management delegation stack
// NS values добавим после первого deploy test зоны
const delegatedNs = (app.node.tryGetContext("testNs") as string[] | undefined) ?? [];

new ManagementDnsStack(app, "EmotixManagementDnsStack", {
  env: { account: MGMT_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },
  parentZoneName: "emotix.net",
  delegatedSubdomain: "test.emotix.net",
  delegatedNameServers: delegatedNs,
  mxRecords: [
    {
      hostName: "mx.zoho.eu",
      priority: 10
    },
    {
      hostName: "mx2.zoho.eu",
      priority: 20
    },
    {
      hostName: "mx3.zoho.eu",
      priority: 50
    },
  ],
  spfValue: "v=spf1 include:zohomail.eu ~all",
  dmarcValue: "v=DMARC1; p=none; rua=mailto:dmarc@emotix.net; ruf=mailto:dmarc@emotix.net; sp=none; adkim=r; aspf=r; pct=50",
  dkimTxts: [
    {
      name: "zmail._domainkey",
      value: "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCntmhjaDxeIJ8cStbbkqHdY/j6B2E5MPaNE7EA+AsD5LSXfgloBfwzHlGIY5CmVvxUZjay8Ybm7eWjt7FTlmV2sevWMUnlEoQcIffvQ/3OidQsgYdosZv/+dUERmDPPD4ZYCi5elFBpgQXrvG6K7w4OHP0UETa67OG3G0FTdGRXwIDAQAB"
    }
  ]
});

new CertStack(app, "EmotixTestCertStack", {
  env: { account: TEST_ACCOUNT_ID, region: US_EAST_1_REGION },
  zoneName: "test.emotix.net",
  domainName: "test.emotix.net",
  authDomainName: "auth.test.emotix.net"
});

const testCertArn = app.node.tryGetContext("testCertArn") as string;
if (!testCertArn) {
  throw new Error("Missing context.testCertArn in cdk.json");
}

new WebStack(app, "EmotixTestWebStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },
  domainName: "test.emotix.net",
  zoneName: "test.emotix.net",
  certificateArn: testCertArn,
});

/*

const testCertArn = app.node.tryGetContext("prodCertArn") as string;
if (!prodCertArn) {
  throw new Error("Missing context.prodCertArn in cdk.json");
}

new WebStack(app, "EmotixProdWebStack", {
  env: { account: PROD_ID, region: EU_CENTRAL_1_REGION },
  domainName: "emotix.net",
  zoneName: "emotix.net",
  certificateArn: prodCertArn,

  removalPolicy: cdk.RemovalPolicy.RETAIN,
  autoDeleteObjects: false,

  enableLogging: true,
  logBucketNamePrefix: "emotix-prod",

  webAclArn: "arn:aws:wafv2:us-east-1:PROD_ID:global/webacl/....", // пример
});

*/

new BillingGuardrailsStack(app, "BillingGuardrailsStack", {
  env: {
    account: MGMT_ACCOUNT_ID,
    region: US_EAST_1_REGION,
  },

  notificationEmail: AWS_MGMT_EMAIL,
  testAccountId: TEST_ACCOUNT_ID,
  prodAccountId: PROD_ACCOUNT_ID,

  testMonthlyBudgetUsd: 3,
  prodMonthlyBudgetUsd: 3,
  alertThresholdsPercent: [25, 50, 80, 100],

  attachScpToAccounts: true,
  defaultAnomalyMonitorArn: "arn:aws:ce::170145218709:anomalymonitor/dda76256-5e70-499e-bba1-ce1b01af265c",
});

const authTestCertArn = app.node.tryGetContext("authTestCertArn") as string;
if (!authTestCertArn) {
  throw new Error("Missing context.authTestCertArn in cdk.json");
}

new AuthStack(app, "EmotixTestAuthStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },

  zoneName: "test.emotix.net",
  authDomainName: "auth.test.emotix.net",
  authCertificateArn: authTestCertArn,

  callbackUrls: ["https://test.emotix.net/auth/callback"],
  logoutUrls: ["https://test.emotix.net/logout"],

  // SSM paths (you said they are already filled)
  googleClientIdParam: "/emotix/test/auth/google/client-id",
  googleClientSecretParam: "/emotix/test/auth/google/client-secret",
  facebookAppIdParam: "/emotix/test/auth/facebook/app-id",
  facebookAppSecretParam: "/emotix/test/auth/facebook/app-secret",
});


