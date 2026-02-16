import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["USER_POOL_ID"]


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


def _get_destination_user_by_email(normalized_email: str) -> str | None:
    resp = cognito.list_users(
        UserPoolId=USER_POOL_ID,
        Filter=f'email = "{normalized_email}"',
        Limit=5,
    )
    users = resp.get("Users", [])
    if not users:
        return None

    # Prefer native Cognito user if present; else the first match.
    native = next((u for u in users if "_" not in (u.get("Username") or "")), None)
    chosen = native or users[0]
    return chosen.get("Username")


def handler(event, _context):
    if event.get("triggerSource") != "PreSignUp_ExternalProvider":
        return event

    attrs = event.get("request", {}).get("userAttributes", {})
    email = attrs.get("email")
    email_verified = str(attrs.get("email_verified", "")).lower() == "true"
    provider_name = _provider_name_from_username(event.get("userName") or "")
    provider_subject = _provider_subject(event)

    if not email or not email_verified:
        logger.info("Skip linking: missing or unverified email")
        return event
    if not provider_name or not provider_subject:
        logger.info("Skip linking: could not resolve provider name/subject")
        return event

    normalized_email = _normalize_email(email)
    destination_username = _get_destination_user_by_email(normalized_email)
    if not destination_username:
        logger.info("No existing user for normalized email; no linking needed")
        return event

    try:
        cognito.admin_link_provider_for_user(
            UserPoolId=USER_POOL_ID,
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
        logger.info(
            "Linked provider to existing user",
            extra={
                "destination": destination_username,
                "provider_name": provider_name,
                "normalized_email": normalized_email,
            },
        )
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "Unknown")
        message = err.response.get("Error", {}).get("Message", "")
        # Idempotent behavior: linking may already exist.
        if code in {"AliasExistsException", "InvalidParameterException", "ResourceConflictException"}:
            logger.info(
                "Linking already established or in conflicting state, continuing",
                extra={"code": code, "message": message},
            )
            return event

        logger.error(
            "Failed linking external provider",
            extra={"code": code, "message": message, "event": json.dumps(event)},
        )
        raise

    return event
