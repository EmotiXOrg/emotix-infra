import * as cdk from "aws-cdk-lib";
import { TestDnsStack } from "../lib/test-dns-stack";
import { ManagementDnsStack } from "../lib/management-dns-stack";
import { TlsCertStack } from "../lib/global/tls-cert-stack";
import { WebStack } from "../lib/web-stack";
import { BillingGuardrailsStack } from "../lib/global/billing-guardrails-stack";
import { AWS_MGMT_EMAIL, DOMAINS, EU_CENTRAL_1_REGION, MAIN_DOMAIN, MGMT_ACCOUNT_ID, PROD_ACCOUNT_ID, TEST_ACCOUNT_ID, US_EAST_1_REGION } from "../constants";
import { AuthStack } from "../lib/auth-stack";
import { AuthApiStack } from "../lib/auth-api-stack";
import { StaticAssetsStack } from "../lib/static-assets-stack";

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
  parentZoneName: MAIN_DOMAIN,
  delegatedSubdomain: DOMAINS.TEST,
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

// Global/Edge cert (required for CloudFront + Cognito custom domain, and other worldwide services)
export const emotixTestGlobalCert = new TlsCertStack(app, "EmotixTestGlobalCertStack", {
  env: { account: TEST_ACCOUNT_ID, region: US_EAST_1_REGION },
  zoneName: DOMAINS.TEST,
  baseDomainName: DOMAINS.TEST,
  retainOnDelete: true,
});

// Regional cert (required for API Gateway regional domains + ALB in region, and other regional services)
export const emotixTestRegionalCert = new TlsCertStack(app, "EmotixTestRegionalCertStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },
  zoneName: DOMAINS.TEST,
  baseDomainName: DOMAINS.TEST,
  retainOnDelete: true,
});


const globalCertArn = app.node.tryGetContext("globalTestTlsCertArn") as string;
if (!globalCertArn) {
  throw new Error("Missing context.globalTestTlsCertArn in cdk.json");
}
const regionalCertArn = app.node.tryGetContext("regionalTestTlsCertArn") as string;
if (!regionalCertArn) {
  throw new Error("Missing context.regionalTestTlsCertArn in cdk.json");
}

new WebStack(app, "EmotixTestWebStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },
  domainName: DOMAINS.TEST,
  zoneName: DOMAINS.TEST,
  certificateArn: globalCertArn,
});

new StaticAssetsStack(app, "EmotixTestStaticAssetsStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },

  zoneName: DOMAINS.TEST, // "emotix.net"
  staticDomainName: `static.${DOMAINS.TEST}`, // "static.test.emotix.net"
  globalCertArnUsEast1: globalCertArn,
});

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

const authStack = new AuthStack(app, "EmotixTestAuthStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },

  zoneName: DOMAINS.TEST,
  authDomainName: "auth." + DOMAINS.TEST,
  authCertificateArn: globalCertArn,

  callbackUrls: ["https://" + DOMAINS.TEST + "/auth/callback"],
  logoutUrls: [
    "https://" + DOMAINS.TEST + "/logout",
    "https://" + DOMAINS.TEST + "/auth",
  ],

  // SSM paths (you said they are already filled)
  googleClientIdParam: "/emotix/test/auth/google/client-id",
  googleClientSecretParam: "/emotix/test/auth/google/client-secret",
  facebookAppIdParam: "/emotix/test/auth/facebook/app-id",
  facebookAppSecretParam: "/emotix/test/auth/facebook/app-secret",
});

new AuthApiStack(app, "EmotixTestAuthApiStack", {
  env: { account: TEST_ACCOUNT_ID, region: EU_CENTRAL_1_REGION },

  zoneName: DOMAINS.TEST,
  apiDomainName: "api." + DOMAINS.TEST,
  regionalCertificateArn: regionalCertArn,
  allowedOrigins: ["https://" + DOMAINS.TEST],

  userPoolId: authStack.userPoolId,
  userPoolClientId: authStack.userPoolClientId,
  usersTableName: authStack.usersTableName,
  userAuthMethodsTableName: authStack.userAuthMethodsTableName,
  authAuditLogTableName: authStack.authAuditLogTableName,
});
