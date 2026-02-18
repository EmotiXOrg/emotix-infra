import logging
import os
import secrets
import string

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

cognito = boto3.client("cognito-idp")
dynamodb = boto3.client("dynamodb")
USERS_TABLE_NAME = os.environ["USERS_TABLE_NAME"]


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _provider_name_from_username(username: str) -> str | None:
    if not username or "_" not in username:
        return None
    raw = username.split("_", 1)[0]
    mapping = {
        "google": "Google",
        "facebook": "Facebook",
        "signinwithapple": "SignInWithApple",
    }
    return mapping.get(raw.lower())


def _provider_subject(event: dict) -> str | None:
    username = event.get("userName") or ""
    if "_" in username:
        return username.split("_", 1)[1]
    attrs = event.get("request", {}).get("userAttributes", {})
    return attrs.get("sub")


def _random_temporary_password() -> str:
    alphabet = string.ascii_letters + string.digits
    core = "".join(secrets.choice(alphabet) for _ in range(20))
    return f"Aa{core}9"


def _get_destination_user_by_email(user_pool_id: str, normalized_email: str) -> str | None:
    resp = cognito.list_users(
        UserPoolId=user_pool_id,
        Filter=f'email = "{normalized_email}"',
        Limit=5,
    )
    users = resp.get("Users", [])
    if not users:
        return None

    native = next((u for u in users if "_" not in (u.get("Username") or "")), None)
    chosen = native or users[0]
    return chosen.get("Username")


def _exists_in_users_table(normalized_email: str) -> bool:
    resp = dynamodb.query(
        TableName=USERS_TABLE_NAME,
        IndexName="normalized_email-index",
        KeyConditionExpression="normalized_email = :email",
        ExpressionAttributeValues={":email": {"S": normalized_email}},
        Limit=1,
    )
    return len(resp.get("Items", [])) > 0


def _auto_heal_native_user(user_pool_id: str, normalized_email: str) -> str:
    username = normalized_email
    try:
        cognito.admin_create_user(
            UserPoolId=user_pool_id,
            Username=username,
            UserAttributes=[
                {"Name": "email", "Value": normalized_email},
                {"Name": "email_verified", "Value": "true"},
            ],
            TemporaryPassword=_random_temporary_password(),
            MessageAction="SUPPRESS",
        )
        logger.info("Auto-healed missing Cognito native user from Dynamo metadata")
        return username
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "Unknown")
        if code == "UsernameExistsException":
            return username
        raise


def handler(event, _context):
    if event.get("triggerSource") != "PreSignUp_ExternalProvider":
        return event

    user_pool_id = event.get("userPoolId")
    if not user_pool_id:
        raise Exception("Missing userPoolId in authentication flow.")

    attrs = event.get("request", {}).get("userAttributes", {})
    email = attrs.get("email")
    provider_name = _provider_name_from_username(event.get("userName") or "")
    provider_subject = _provider_subject(event)

    if not email:
        raise Exception(
            f"We were not able to get your email from {provider_name or 'social provider'}, please try again or use another login option."
        )
    if not provider_name or not provider_subject:
        raise Exception("Unable to resolve social provider identity, please try again.")

    normalized_email = _normalize_email(email)
    destination_username = _get_destination_user_by_email(user_pool_id, normalized_email)

    if not destination_username and _exists_in_users_table(normalized_email):
        destination_username = _auto_heal_native_user(user_pool_id, normalized_email)

    if not destination_username:
        logger.info("No existing account found, external provider user will be created by Cognito")
        return event

    try:
        cognito.admin_link_provider_for_user(
            UserPoolId=user_pool_id,
            DestinationUser={
                "ProviderName": "Cognito",
                "ProviderAttributeValue": destination_username,
            },
            SourceUser={
                "ProviderName": provider_name,
                "ProviderAttributeName": "Cognito_Subject",
                "ProviderAttributeValue": provider_subject,
            },
        )
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "Unknown")
        if code in {"AliasExistsException", "ResourceConflictException"}:
            raise Exception(
                "This email is already linked to another account. Use your original sign-in method or contact support."
            )
        if code == "InvalidParameterException":
            # Already linked to the same destination in repeat flows; continue.
            return event
        raise

    return event
