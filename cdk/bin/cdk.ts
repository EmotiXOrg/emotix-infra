import * as cdk from "aws-cdk-lib";
import { TestDnsStack } from "../lib/test-dns-stack";
import { ManagementDnsStack } from "../lib/management-dns-stack";
import { CertStack } from "../lib/global/cert-stack";
import { WebStack } from "../lib/web-stack";
import { BillingGuardrailsStack } from "../lib/global/billing-guardrails-stack";
import { AWS_MGMT_EMAIL, EU_CENTRAL_1_REGION, MGMT_ACCOUNT_ID, PROD_ACCOUNT_ID, TEST_ACCOUNT_ID, US_EAST_1_REGION } from "../constants";

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
});

new CertStack(app, "EmotixTestCertStack", {
  env: { account: TEST_ACCOUNT_ID, region: US_EAST_1_REGION },
  zoneName: "test.emotix.net",
  domainName: "test.emotix.net",
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

  testMonthlyBudgetUsd: 1,
  prodMonthlyBudgetUsd: 1,
  alertThresholdsPercent: [25, 50, 80, 100],

  attachScpToAccounts: true,
  defaultAnomalyMonitorArn: "arn:aws:ce::170145218709:anomalymonitor/dda76256-5e70-499e-bba1-ce1b01af265c",
});

