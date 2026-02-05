import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as org from "aws-cdk-lib/aws-organizations";

export interface BillingGuardrailsStackProps extends cdk.StackProps {
    notificationEmail: string;

    testAccountId: string;
    prodAccountId: string;

    // Monthly limits in USD
    testMonthlyBudgetUsd?: number; // default 1
    prodMonthlyBudgetUsd?: number; // default 1

    alertThresholdsPercent?: number[]; // default [50, 80, 100]
    attachScpToAccounts?: boolean; // default true
}


/**
 * BillingGuardrailsStack
 * - Budgets per linked account (ACTUAL spend)
 * - SNS notifications (email + future integrations)
 * - Cost Anomaly Detection (service-level)
 * - SCP: Deny expensive services + restrict EC2 instance types
 *
 * Deploy from the AWS Organizations Management (payer) account.
 */
export class BillingGuardrailsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: BillingGuardrailsStackProps) {
        super(scope, id, props);

        const testLimit = props.testMonthlyBudgetUsd ?? 1;
        const prodLimit = props.prodMonthlyBudgetUsd ?? 1;
        const thresholds = props.alertThresholdsPercent ?? [20, 50, 80, 100];
        const attachScp = props.attachScpToAccounts ?? true;

        const assertBudget = (v: number, name: string) => {
            if (v <= 0 || v > 20) {
                throw new Error(`${name} budget must be between 0 and 20 USD`);
            }
        };

        assertBudget(testLimit, "test");
        assertBudget(prodLimit, "prod");


        // Central SNS topic for budgets + anomalies
        const alertsTopic = new sns.Topic(this, "BillingAlertsTopic", {
            displayName: "Billing Alerts (Budgets + Anomalies)",
            topicName: "billing-alerts",
        });

        // Email subscription to SNS
        alertsTopic.addSubscription(new subs.EmailSubscription(props.notificationEmail));

        // Helper: build budget notifications (email + SNS)
        const buildNotifications = (): budgets.CfnBudget.NotificationWithSubscribersProperty[] => {
            return thresholds.map((t) => ({
                notification: {
                    notificationType: "ACTUAL",
                    comparisonOperator: "GREATER_THAN",
                    threshold: t,
                    thresholdType: "PERCENTAGE",
                },
                subscribers: [
                    { subscriptionType: "EMAIL", address: props.notificationEmail },
                    { subscriptionType: "SNS", address: alertsTopic.topicArn },
                ],
            }));
        };

        // ===== Budgets: TEST ($1/month) =====
        new budgets.CfnBudget(this, "TestAccountMonthlyBudget", {
            budget: {
                budgetName: `test-monthly-actual-${testLimit}usd`,
                budgetType: "COST",
                timeUnit: "MONTHLY",
                budgetLimit: { amount: testLimit, unit: "USD" },
                costFilters: {
                    LinkedAccount: [props.testAccountId],
                },
            },
            notificationsWithSubscribers: buildNotifications(),
        });

        // ===== Budgets: PROD ($1/month) =====
        new budgets.CfnBudget(this, "ProdAccountMonthlyBudget", {
            budget: {
                budgetName: `prod-monthly-actual-${prodLimit}usd`,
                budgetType: "COST",
                timeUnit: "MONTHLY",
                budgetLimit: { amount: prodLimit, unit: "USD" },
                costFilters: {
                    LinkedAccount: [props.prodAccountId],
                },
            },
            notificationsWithSubscribers: buildNotifications(),
        });

        // ===== Cost Anomaly Detection =====
        // Monitor anomalies by SERVICE (org-wide visibility in payer account)
        const anomalyMonitor = new ce.CfnAnomalyMonitor(this, "OrgServiceAnomalyMonitor", {
            monitorName: "org-service-anomalies",
            monitorType: "DIMENSIONAL",
            monitorDimension: "SERVICE",
        });

        // Subscription: daily anomalies -> SNS + email
        new ce.CfnAnomalySubscription(this, "OrgAnomalySubscription", {
            subscriptionName: "org-anomalies-to-sns",
            frequency: "DAILY",
            monitorArnList: [anomalyMonitor.attrMonitorArn],
            subscribers: [
                { type: "SNS", address: alertsTopic.topicArn },
                { type: "EMAIL", address: props.notificationEmail },
            ],
            threshold: 1, // USD absolute anomaly threshold
        });

        // ===== SCP: Deny expensive services =====
        // IMPORTANT:
        // - SCPs are "guardrails": they deny actions even if IAM allows them.
        // - This policy is intentionally conservative: it blocks common cost bombs.
        //
        // You can loosen it later as you scale, or maintain different SCPs per OU.
        const denyExpensiveServicesPolicyDoc = {
            Version: "2012-10-17",
            Statement: [
                // --- Networking cost bombs ---
                {
                    Sid: "DenyNatGateways",
                    Effect: "Deny",
                    Action: [
                        "ec2:CreateNatGateway",
                        "ec2:DeleteNatGateway",
                        "ec2:AllocateAddress", // EIP can cost if unused/attached patterns
                        "ec2:AssociateAddress",
                    ],
                    Resource: "*",
                },

                // --- Managed databases / data warehouses / caches ---
                {
                    Sid: "DenyRdsRedshiftElastiCache",
                    Effect: "Deny",
                    Action: ["rds:*", "redshift:*", "elasticache:*", "neptune:*", "timestream:*"],
                    Resource: "*",
                },

                // --- Search/analytics clusters & big compute platforms ---
                {
                    Sid: "DenyOpenSearchAndBigData",
                    Effect: "Deny",
                    Action: [
                        "es:*", // OpenSearch / legacy ES
                        "emr:*",
                        "athena:CreateWorkGroup",
                        "glue:*",
                        "databrew:*",
                    ],
                    Resource: "*",
                },

                // --- ML / expensive managed compute ---
                {
                    Sid: "DenySageMaker",
                    Effect: "Deny",
                    Action: ["sagemaker:*", "bedrock:*"],
                    Resource: "*",
                },

                // --- Kubernetes control plane costs ---
                {
                    Sid: "DenyEKS",
                    Effect: "Deny",
                    Action: ["eks:*"],
                    Resource: "*",
                },

                // --- Marketplace (avoid paid AMIs/subscriptions by mistake) ---
                {
                    Sid: "DenyMarketplace",
                    Effect: "Deny",
                    Action: [
                        "aws-marketplace:*",
                        "aws-marketplace-management:*",
                        "pricing:*", // optional; remove if you rely on Pricing API
                    ],
                    Resource: "*",
                },

                // --- Restrict EC2 instance types to keep within cheap/free patterns ---
                // Allows only the listed instance types; everything else is denied.
                {
                    Sid: "DenyEC2NonAllowlistedInstanceTypes",
                    Effect: "Deny",
                    Action: ["ec2:RunInstances"],
                    Resource: "*",
                    Condition: {
                        StringNotEquals: {
                            "ec2:InstanceType": [
                                "t3.micro",
                                "t4g.micro",
                                "t3.nano",
                                "t4g.nano",
                            ],
                        },
                    },
                },

                // --- Optional: block creating large EBS volumes (common hidden cost) ---
                {
                    Sid: "DenyLargeEbsVolumes",
                    Effect: "Deny",
                    Action: ["ec2:CreateVolume"],
                    Resource: "*",
                    Condition: {
                        NumericGreaterThan: {
                            "ec2:VolumeSize": "30",
                        },
                    },
                },
            ],
        };

        const scp = new org.CfnPolicy(this, "DenyExpensiveServicesSCP", {
            name: "DenyExpensiveServices",
            description:
                "Guardrail SCP to prevent common high-cost services and restrict EC2 instance types.",
            type: "SERVICE_CONTROL_POLICY",
            content: denyExpensiveServicesPolicyDoc as any,
        });

        if (attachScp) {
            // Attach to TEST and PROD accounts directly (simple & safe for now).
            new cdk.CfnResource(this, "AttachScpToTestAccount", {
                type: "AWS::Organizations::PolicyAttachment",
                properties: {
                    PolicyId: scp.attrId,
                    TargetId: props.testAccountId,
                },
            });

            new cdk.CfnResource(this, "AttachScpToProdAccount", {
                type: "AWS::Organizations::PolicyAttachment",
                properties: {
                    PolicyId: scp.attrId,
                    TargetId: props.prodAccountId,
                },
            });
        }

        new cdk.CfnOutput(this, "BillingAlertsTopicArn", { value: alertsTopic.topicArn });
        new cdk.CfnOutput(this, "DenyExpensiveServicesScpId", { value: scp.attrId });
    }
}
