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

    alertThresholdsPercent?: number[]; // default [20, 50, 80, 100]
    attachScpToAccounts?: boolean; // default true
    defaultAnomalyMonitorArn?: string; // optional: use existing AWS-managed monitor
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

        // ===== Budgets: TEST =====
        new budgets.CfnBudget(this, "TestAccountMonthlyBudget", {
            budget: {
                budgetName: `test-monthly-actual-${testLimit}usd`,
                budgetType: "COST",
                timeUnit: "MONTHLY",
                budgetLimit: { amount: testLimit, unit: "USD" }, // keep number as requested
                costFilters: {
                    LinkedAccount: [props.testAccountId],
                },
            },
            notificationsWithSubscribers: buildNotifications(),
        });

        // ===== Budgets: PROD =====
        new budgets.CfnBudget(this, "ProdAccountMonthlyBudget", {
            budget: {
                budgetName: `prod-monthly-actual-${prodLimit}usd`,
                budgetType: "COST",
                timeUnit: "MONTHLY",
                budgetLimit: { amount: prodLimit, unit: "USD" }, // keep number as requested
                costFilters: {
                    LinkedAccount: [props.prodAccountId],
                },
            },
            notificationsWithSubscribers: buildNotifications(),
        });

        // ===== Cost Anomaly Detection =====
        // Some accounts already have AWS-managed Default-Services-Monitor.
        // Creating another SERVICE monitor can fail with AlreadyExists.
        // If defaultAnomalyMonitorArn is provided, we only create a subscription for it.

        let monitorArnToUse: string;

        if (props.defaultAnomalyMonitorArn && props.defaultAnomalyMonitorArn.trim().length > 0) {
            monitorArnToUse = props.defaultAnomalyMonitorArn.trim();
        } else {
            const anomalyMonitor = new ce.CfnAnomalyMonitor(this, "OrgServiceAnomalyMonitor", {
                monitorName: `org-service-anomalies`,
                monitorType: "DIMENSIONAL",
                monitorDimension: "SERVICE",
            });

            monitorArnToUse = anomalyMonitor.attrMonitorArn;
        }

        new ce.CfnAnomalySubscription(this, "OrgAnomalySubscription", {
            subscriptionName: `org-anomalies-email`,
            frequency: "DAILY",
            monitorArnList: [monitorArnToUse],
            subscribers: [
                { type: "EMAIL", address: props.notificationEmail },
            ],
            threshold: 1, // USD
        });


        // ===== SCP: Deny expensive services =====
        const denyExpensiveServicesPolicyDoc = {
            Version: "2012-10-17",
            Statement: [
                {
                    Sid: "DenyNatGatewaysAndEipOps",
                    Effect: "Deny",
                    Action: [
                        "ec2:CreateNatGateway",
                        "ec2:DeleteNatGateway",
                        "ec2:AllocateAddress",
                        "ec2:AssociateAddress",
                    ],
                    Resource: "*",
                },
                {
                    Sid: "DenyRdsRedshiftElastiCache",
                    Effect: "Deny",
                    Action: ["rds:*", "redshift:*", "elasticache:*", "neptune:*", "timestream:*"],
                    Resource: "*",
                },
                {
                    Sid: "DenyOpenSearchAndBigData",
                    Effect: "Deny",
                    Action: ["es:*", "emr:*", "athena:CreateWorkGroup", "glue:*", "databrew:*"],
                    Resource: "*",
                },
                {
                    Sid: "DenySageMakerAndBedrock",
                    Effect: "Deny",
                    Action: ["sagemaker:*", "bedrock:*"],
                    Resource: "*",
                },
                {
                    Sid: "DenyEKS",
                    Effect: "Deny",
                    Action: ["eks:*"],
                    Resource: "*",
                },
                {
                    Sid: "DenyMarketplace",
                    Effect: "Deny",
                    Action: ["aws-marketplace:*", "aws-marketplace-management:*", "pricing:*"],
                    Resource: "*",
                },
                {
                    Sid: "DenyEC2NonAllowlistedInstanceTypes",
                    Effect: "Deny",
                    Action: ["ec2:RunInstances"],
                    Resource: "*",
                    Condition: {
                        StringNotEquals: {
                            "ec2:InstanceType": ["t3.micro", "t4g.micro", "t3.nano", "t4g.nano"],
                        },
                    },
                },
                {
                    Sid: "DenyLargeEbsVolumesOver30GiB",
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

        // CloudFormation does NOT support AWS::Organizations::PolicyAttachment.
        // Attach SCP via targetIds directly on AWS::Organizations::Policy.
        const scp = new org.CfnPolicy(this, "DenyExpensiveServicesSCP", {
            name: "DenyExpensiveServices",
            description:
                "Guardrail SCP to prevent common high-cost services and restrict EC2 instance types.",
            type: "SERVICE_CONTROL_POLICY",
            content: denyExpensiveServicesPolicyDoc as any,
            targetIds: attachScp ? [props.testAccountId, props.prodAccountId] : undefined,
        });

        new cdk.CfnOutput(this, "BillingAlertsTopicArn", { value: alertsTopic.topicArn });
        new cdk.CfnOutput(this, "DenyExpensiveServicesScpId", { value: scp.attrId });
    }
}
