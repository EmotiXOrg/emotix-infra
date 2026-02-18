# CDK Stacks (Auth-focused)

This folder contains CDK stacks used by the auth/account-linking flow.

## Main stacks

- `auth-stack.ts`
  - Cognito User Pool + Hosted UI providers (Google, Facebook)
  - Cognito triggers:
    - `PreSignUp_ExternalProvider` for pre-login provider linking
    - `PostConfirmation` for profile/method/audit metadata seed
    - `PostAuthentication` for canonical-account auto-linking and method sync on successful login
  - DynamoDB metadata tables:
    - users
    - user auth methods
    - auth audit log

- `auth-api-stack.ts`
  - API Gateway HTTP API + Cognito authorizer
  - Lambda endpoints:
    - `POST /auth/discover`
    - `GET /auth/methods`
    - `POST /auth/set-password`
    - `POST /auth/password-setup/start`
    - `POST /auth/password-setup/complete`

## Deployment order

1. Deploy `AuthStack` first (identity and triggers)
2. Deploy `AuthApiStack` second (API endpoints and read/write flows)

For test env:

```bash
npx cdk deploy EmotixTestAuthStack --require-approval never --profile emotix-test
npx cdk deploy EmotixTestAuthApiStack --require-approval never --profile emotix-test
```

