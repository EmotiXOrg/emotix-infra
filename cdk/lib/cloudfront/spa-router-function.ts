import * as path from "path";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";

export function createSpaRouterFunction(scope: Construct): cloudfront.Function {
    return new cloudfront.Function(scope, "SpaRouterFunction", {
        comment:
            "EmotiX SPA router + legal routes (/privacy, /terms, /data-deletion)",
        code: cloudfront.FunctionCode.fromFile({
            filePath: path.join(__dirname, "spa-router.js"),
        }),
    });
}