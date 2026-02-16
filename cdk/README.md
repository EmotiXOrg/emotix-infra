# EmotiX CDK (Infrastructure)

This folder defines AWS infrastructure stacks for EmotiX.

## Auth Identity Foundations (Step 2)

`lib/auth-stack.ts` now provisions:

- Cognito User Pool with Google/Facebook Hosted UI
- Lambda trigger: `PreSignUp_ExternalProvider`
  - Links external provider to existing Cognito user by normalized verified email
  - Uses `AdminLinkProviderForUser`
- Lambda trigger: `PostConfirmation`
  - Creates profile metadata seed in DynamoDB
  - Stores native auth method seed (`METHOD#COGNITO`)
  - Writes auth audit event
- DynamoDB tables:
  - `users` style table (`pk`)
  - `user_auth_methods` style table (`pk`, `sk`)
  - `auth_audit_log` style table (`pk`, `sk`)

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
